import test from "node:test";
import assert from "node:assert/strict";
import {
  laterOnTopic,
  taskHash,
  taskMessages,
  parseTasks,
  judgeBatch,
  extractTasks,
  refreshTasks,
  taskByConstruction,
} from "../../../src/agent/tasks.js";
import { taskList } from "../../../src/attention/reminders.js";
import { modelClient } from "../../../src/memory/model.js";

const entry = (id, fields = {}) => ({
  id,
  kind: "todo",
  topic: "shop",
  date: "2026-10-20",
  title: `Task ${id}`,
  context: "Context.",
  result: "Result.",
  next: `Do ${id}`,
  ...fields,
});

// A fake model: answers every entry in the batch with `verdict(n)`, and counts calls.
function fakeModel(verdict = () => ({ is_task: true, still_open: true, task: "Do it", who: null, personal: false })) {
  const calls = [];
  const complete = async (messages) => {
    calls.push(messages);
    const count = (messages.at(-1).content.match(/^\d+\. /gm) ?? []).length;
    return JSON.stringify({ items: Array.from({ length: count }, (_, i) => ({ n: i + 1, ...verdict(i + 1) })) });
  };
  return { complete, calls };
}

test("later notes on the same topic come oldest first, nearest the entry", () => {
  const sample = [
    { topic: "shop", title: "Newest" },
    { topic: "other", title: "Elsewhere" },
    { topic: "shop", title: "Next one" },
    { topic: "shop", title: "Task a" },
    { topic: "shop", title: "Older" },
  ];
  assert.deepEqual(laterOnTopic({ topic: "shop", title: "Task a" }, sample), ["Next one", "Newest"]);
  assert.deepEqual(laterOnTopic({ topic: "shop", title: "Newest" }, sample), []);
  assert.deepEqual(laterOnTopic({ topic: "shop", title: "Not in the sample" }, sample), []);
  assert.deepEqual(laterOnTopic({ topic: "shop", title: "Task a" }, sample, { later: 1 }), ["Next one"]);
});

test("a note from the same day is found by its words, wherever the sample put it", () => {
  const sample = [
    { topic: "grants", title: "Newest" },
    { topic: "grants", title: "Bootcamp application due 2026-11-09" },
    { topic: "grants", title: "Bootcamp application submitted" },
    { topic: "grants", title: "Unrelated older note" },
    { topic: "other", title: "Bootcamp application elsewhere" },
  ];
  assert.deepEqual(laterOnTopic({ topic: "grants", title: "Bootcamp application due 2026-11-09" }, sample), [
    "Newest",
    "Bootcamp application submitted",
  ]);
});

test("the hash changes with the entry's text and with its later notes", () => {
  const e = entry("a");
  assert.equal(taskHash(e, []), taskHash({ ...e }, []));
  assert.notEqual(taskHash(e, []), taskHash({ ...e, next: "Do something else" }, []));
  assert.notEqual(taskHash(e, []), taskHash(e, ["Task a was done"]));
});

test("each entry goes in with its fields and later notes, through clean", () => {
  const [system, user] = taskMessages(
    [
      { entry: entry("a", { context: "key sk-abc" }), later: ["Task a merged"] },
      { entry: entry("b"), later: [] },
    ],
    { clean: (s) => s.replace(/sk-\w+/, "[REDACTED]") },
  );
  assert.match(system.content, /is_task/);
  assert.match(user.content, /^1\. \[shop\] todo, 2026-10-20: Task a$/m);
  assert.match(user.content, /Context: key \[REDACTED\]/);
  assert.doesNotMatch(user.content, /sk-abc/);
  assert.match(user.content, /Other notes on this topic: "Task a merged"/);
  assert.match(user.content, /^2\. \[shop\]/m);
  assert.doesNotMatch(user.content.split("2. [shop]")[1], /Other notes/, "no later notes, no line");
});

test("a reply is parsed item by item; a bad item is left out, a bad reply throws", () => {
  const items = parseTasks(
    JSON.stringify({
      items: [
        { n: 1, is_task: true, still_open: true, task: "one two three four five six seven eight nine ten eleven" },
        { n: 2, is_task: "yes", still_open: true, task: "x" },
        { n: 3, is_task: true, still_open: true, task: "" },
        { n: 4, is_task: false, still_open: true, task: "", personal: true, who: "Ali" },
        { n: 9, is_task: true, still_open: true, task: "out of range" },
      ],
    }),
    4,
  );
  assert.deepEqual([...items.keys()], [1, 4]);
  assert.equal(items.get(1).task, "one two three four five six seven eight nine ten", "at most 10 words");
  assert.deepEqual(items.get(4), { isTask: false, open: true, task: "", who: "Ali", personal: true });
  assert.throws(() => parseTasks(JSON.stringify({ items: "no" }), 1), /items/);
  assert.throws(() => parseTasks(JSON.stringify({ items: [{ n: 1 }] }), 1), /no valid item/);
});

test("an invalid reply is asked once more; a model that fails leaves the batch unread", async () => {
  let n = 0;
  const flaky = async () => (n++ ? JSON.stringify({ items: [{ n: 1, is_task: false, still_open: true }] }) : "hm");
  const r = await judgeBatch(flaky, [{ entry: entry("a"), later: [] }]);
  assert.equal(r.source, "llm");
  assert.equal(r.verdicts.get(1).isTask, false);
  const down = await judgeBatch(async () => {
    throw new Error("503");
  }, [{ entry: entry("a"), later: [] }]);
  assert.equal(down.verdicts, null);
  assert.equal(down.source, "fallback");
  assert.equal(down.error, "503");
});

test("batches of 15; a second run asks only about new or changed entries", async () => {
  const candidates = Array.from({ length: 20 }, (_, i) => entry(`e${i}`));
  const sample = candidates.map(({ topic, title }) => ({ topic, title }));
  const first = fakeModel();
  const r1 = await extractTasks(first.complete, { candidates, sample });
  assert.equal(first.calls.length, 2);
  assert.equal(Object.keys(r1.cache).length, 20);
  assert.equal(r1.judged, 20);

  const second = fakeModel();
  const r2 = await extractTasks(second.complete, { candidates, sample, cache: r1.cache });
  assert.equal(second.calls.length, 0, "nothing new: no call");
  assert.deepEqual(r2.cache, r1.cache);

  const changed = candidates.map((e) => (e.id === "e3" ? { ...e, next: "Do it differently" } : e));
  const third = fakeModel();
  const r3 = await extractTasks(third.complete, { candidates: [...changed, entry("new")], sample, cache: r1.cache });
  assert.equal(third.calls.length, 1);
  assert.equal((third.calls[0].at(-1).content.match(/^\d+\. /gm) ?? []).length, 2, "the changed one and the new one");
  assert.equal(Object.keys(r3.cache).length, 21);
});

test("a note added later on the topic asks again about the entries it may have closed", async () => {
  const candidates = [entry("a"), entry("b", { topic: "garden" })];
  const before = [
    { topic: "shop", title: "Task a" },
    { topic: "garden", title: "Task b" },
  ];
  const r1 = await extractTasks(fakeModel().complete, { candidates, sample: before });
  const model = fakeModel();
  await extractTasks(model.complete, {
    candidates,
    sample: [{ topic: "shop", title: "Task a merged" }, ...before],
    cache: r1.cache,
  });
  assert.equal(model.calls.length, 1);
  assert.match(model.calls[0].at(-1).content, /Task a merged/);
  assert.doesNotMatch(model.calls[0].at(-1).content, /Task b/, "the other topic keeps its verdict");
});

test("a failed batch is not cached, so it is asked again next time", async () => {
  const candidates = [entry("a")];
  const sample = [{ topic: "shop", title: "Task a" }];
  const r = await extractTasks(
    async () => {
      throw new Error("down");
    },
    { candidates, sample },
  );
  assert.deepEqual(r.cache, {});
  assert.equal(r.failed, 1);
  assert.deepEqual(r.errors, ["down"]);
});

test("refreshTasks skips goals and answered loops, and stores the verdicts", async () => {
  const queue = [entry("a"), entry("goal", { source: "extension" }), entry("done"), entry("nope")];
  const memory = {
    taskQueue: async ({ limit }) => (assert.equal(limit, Infinity), queue),
    profileSample: async () => queue.map(({ topic, title }) => ({ topic, title })),
  };
  const stored = { loops: { done: { doneAt: 1 }, nope: { notTaskAt: 2 } } };
  const storage = {
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
    set: async (o) => Object.assign(stored, o),
  };
  const model = fakeModel();
  const r = await refreshTasks(model.complete, { memory, storage, today: "2026-11-02" });
  assert.equal(r.candidates, 1);
  assert.match(model.calls[0].at(-1).content, /Task a/);
  assert.doesNotMatch(model.calls[0].at(-1).content, /Task goal|Task done|Task nope/);
  assert.deepEqual(Object.keys(stored.taskVerdicts), ["a"]);
});

test("a Markdown checkbox is a task by construction: no model call, listed under its own title", async () => {
  const md = [entry("md:Vault|a", { source: "markdown" }), entry("md:Vault|b", { source: "markdown" })];
  const model = fakeModel();
  const r = await extractTasks(model.complete, { candidates: md, sample: [] });
  assert.equal(model.calls.length, 0);
  assert.equal(r.calls, 0);
  assert.ok(md.every(taskByConstruction));
  assert.deepEqual(
    taskList(md, { verdicts: r.cache }).map((e) => e.title),
    ["Task md:Vault|a", "Task md:Vault|b"],
  );
  // Next to another source's entry, only that one is sent.
  const mixed = await extractTasks(model.complete, { candidates: [...md, entry("brain-1")], sample: [] });
  assert.equal(mixed.calls, 1);
  assert.equal((model.calls[0].at(-1).content.match(/^\d+\. /gm) ?? []).length, 1);
});

// The real client on a fake API: cut(numberOfEntries) says which requests hit the limit.
function clientCutting(cut) {
  const sizes = [];
  const fetchImpl = async (_, init) => {
    const { messages } = JSON.parse(init.body);
    const ns = [...messages.at(-1).content.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    sizes.push(ns.length);
    const body = cut(ns.length, sizes.length)
      ? {
          choices: [{ message: { content: null }, finish_reason: "length" }],
          usage: { completion_tokens_details: { reasoning_tokens: 3998 } },
        }
      : {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: ns.map((n) => ({ n, is_task: true, still_open: true, task: "Do it", who: null })),
                }),
              },
              finish_reason: "stop",
            },
          ],
        };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { complete: modelClient({ provider: "meta", apiKey: "k" }, fetchImpl), sizes };
}

test("a batch cut at the limit is split and asked again, and its entries get verdicts", async () => {
  const candidates = ["a", "b", "c", "d"].map((id) => entry(id));
  const { complete, sizes } = clientCutting((_, call) => call === 1);
  const r = await extractTasks(complete, { candidates, sample: [], concurrency: 1 });
  assert.deepEqual(sizes, [4, 2, 2]);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.cache).sort(), ["a", "b", "c", "d"]);
});

test("a single entry still cut at the limit fails, and the error names the limit", async () => {
  const candidates = ["a", "b"].map((id) => entry(id));
  const { complete, sizes } = clientCutting((n) => n > 0);
  const r = await extractTasks(complete, { candidates, sample: [], concurrency: 1 });
  assert.deepEqual(sizes, [2, 1, 1]);
  assert.equal(r.failed, 2);
  assert.deepEqual(r.cache, {});
  assert.deepEqual(r.errors, ["reply cut at max_tokens (length): 3,998 reasoning tokens"]);
});

test("the node asks with a high cap, and sends reasoning_effort only when told to", async () => {
  const seen = [];
  const complete = async (_, opts) => (seen.push(opts), '{"items":[{"n":1,"is_task":false,"still_open":false}]}');
  await judgeBatch(complete, [{ entry: entry("a"), later: [] }]);
  await judgeBatch(complete, [{ entry: entry("a"), later: [] }], { effort: "low" });
  assert.equal(seen[0].maxTokens, 32000);
  assert.equal(seen[0].reasoningEffort, null);
  assert.equal(seen[1].reasoningEffort, "low");
});

test("refreshTasks keeps why a run failed, and clears it after one that works", async () => {
  const queue = [entry("a")];
  const memory = {
    taskQueue: async () => queue,
    profileSample: async () => queue.map(({ topic, title }) => ({ topic, title })),
  };
  const stored = {};
  const storage = {
    get: async () => ({ ...stored }),
    set: async (o) => Object.assign(stored, o),
  };
  await refreshTasks(
    async () => {
      throw new Error("down");
    },
    { memory, storage, today: "2026-11-02" },
  );
  assert.equal(stored.taskProblem, "down");
  await refreshTasks(fakeModel().complete, { memory, storage, today: "2026-11-02" });
  assert.equal(stored.taskProblem, null);
});

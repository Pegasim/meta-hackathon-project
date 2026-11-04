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
  candidatePairs,
  pairMessages,
  parsePairs,
  judgePairs,
} from "../../../src/agent/tasks.js";
import { taskList, pairKey } from "../../../src/attention/reminders.js";
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

const titles = (notes) => notes.map((n) => n.title);

test("later notes on the same topic come oldest first, nearest the entry", () => {
  const sample = [
    { topic: "shop", title: "Newest" },
    { topic: "other", title: "Elsewhere" },
    { topic: "shop", title: "Next one" },
    { topic: "shop", title: "Task a" },
    { topic: "shop", title: "Older" },
  ];
  assert.deepEqual(titles(laterOnTopic({ topic: "shop", title: "Task a" }, sample)), ["Next one", "Newest"]);
  assert.deepEqual(laterOnTopic({ topic: "shop", title: "Newest" }, sample), []);
  assert.deepEqual(laterOnTopic({ topic: "shop", title: "Not in the sample" }, sample), []);
  assert.deepEqual(titles(laterOnTopic({ topic: "shop", title: "Task a" }, sample, { later: 1 })), ["Next one"]);
});

test("a note from the same day is found by its words, wherever the sample put it", () => {
  const sample = [
    { topic: "grants", title: "Newest" },
    { topic: "grants", title: "Bootcamp application due 2026-11-09" },
    { topic: "grants", title: "Bootcamp application submitted" },
    { topic: "grants", title: "Unrelated older note" },
    { topic: "other", title: "Bootcamp application elsewhere" },
  ];
  assert.deepEqual(titles(laterOnTopic({ topic: "grants", title: "Bootcamp application due 2026-11-09" }, sample)), [
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
  assert.match(user.content, /Other notes on this topic:\n {3}- "Task a merged"$/m);
  assert.match(user.content, /^2\. \[shop\]/m);
  assert.doesNotMatch(user.content.split("2. [shop]")[1], /Other notes/, "no later notes, no line");
});

// #75, #76: a coding agent's steps are not the person's tasks, and the node knows who
// wrote each entry and when.
test("each entry says how long ago it was written and by whom", () => {
  const brain = (id, source, date) => entry(id, { source, date, path: `notes/log/2026/${id}.md` });
  const [, user] = taskMessages(
    [
      { entry: brain("a", "claude-code", "2026-10-15"), later: [] },
      { entry: brain("b", "manual", "2026-11-03"), later: [] },
      { entry: brain("c", "brain-distill", "2026-11-04"), later: [] },
      { entry: entry("d", { source: "markdown", origin: "md:Notes" }), later: [] },
    ],
    { today: "2026-11-04" },
  );
  assert.match(user.content, /^1\. .*\n {3}Written 20 days ago, by a coding agent, at the end of a session$/m);
  assert.match(user.content, /^ {3}Written yesterday, by them$/m);
  assert.match(user.content, /^ {3}Written today, by a summary job, from a conversation$/m);
  assert.match(user.content, /^4\. \[shop\] todo, 2026-10-20: Task d\n {3}Written 15 days ago, by them$/m);
});

test("the rules: commitments, not an agent's steps, and a lifted step names the larger thing", () => {
  const [system] = taskMessages([{ entry: entry("a"), later: [] }]);
  assert.match(system.content, /commitment they would write on their own to-do/);
  assert.match(system.content, /merge or review a pull request, run\s+tests or evals, rebase/);
  assert.match(system.content, /"Ship the Linux bridge", not "Merge PR #45"/);
  assert.match(system.content, /Steps of the same larger thing get the same match/);
});

test("a verdict is asked again when the entry ages into the next band, not every day", () => {
  const e = entry("a", { date: "2026-10-30" });
  assert.equal(taskHash(e, [], "2026-11-01"), taskHash(e, [], "2026-11-06"), "2 and 7 days: the same week");
  assert.notEqual(taskHash(e, [], "2026-11-06"), taskHash(e, [], "2026-11-07"), "past a week");
  assert.equal(taskHash(e, [], "2026-11-07"), taskHash(e, [], "2026-11-29"), "8 and 30 days: the same month");
  assert.notEqual(taskHash(e, [], "2026-11-29"), taskHash(e, [], "2026-11-30"), "past a month");
});

test("extractTasks asks again about an entry that aged past a week, and only that one", async () => {
  const candidates = [entry("old", { date: "2026-10-28" }), entry("new", { date: "2026-11-03" })];
  const sample = candidates.map(({ topic, title }) => ({ topic, title }));
  const first = fakeModel();
  const r1 = await extractTasks(first.complete, { candidates, sample, today: "2026-11-04" });
  const second = fakeModel();
  await extractTasks(second.complete, { candidates, sample, cache: r1.cache, today: "2026-11-05" });
  assert.equal(second.calls.length, 1);
  assert.match(second.calls[0].at(-1).content, /Task old/);
  assert.doesNotMatch(second.calls[0].at(-1).content, /Task new/);
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

test("the node asks with a high cap and low reasoning effort, unless told otherwise", async () => {
  const seen = [];
  const complete = async (_, opts) => (seen.push(opts), '{"items":[{"n":1,"is_task":false,"still_open":false}]}');
  await judgeBatch(complete, [{ entry: entry("a"), later: [] }]);
  await judgeBatch(complete, [{ entry: entry("a"), later: [] }], { effort: null });
  assert.equal(seen[0].maxTokens, 32000);
  assert.equal(seen[0].reasoningEffort, "low");
  assert.equal(seen[1].reasoningEffort, null);
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

// ---- One commitment, one row (#47) -------------------------------------------------

const listed = (id, task, fields = {}) => ({ key: id, entry: entry(id, fields), task });

test("candidate pairs: most words shared, or fewer with the same deadline; a word on many tasks counts for nothing", () => {
  const items = [
    listed("acc1", "Decide on the spring accelerator batch", { title: "Accelerator: apply on time?" }),
    listed("acc2", "Pick spring or autumn accelerator batch", {
      title: "Accelerator batches compared",
      topic: "startup",
    }),
    listed("grant1", "Write the grant budget", { title: "Grant budget", due: "2026-11-20" }),
    listed("grant2", "Finish the budget part", { title: "Budget part of the form", due: "2026-11-20", topic: "money" }),
    listed("dentist", "Book a dentist appointment", { title: "Dentist", topic: "health" }),
    listed("haircut", "Book a haircut appointment", { title: "Haircut", topic: "personal" }),
    listed("heat1", "Get the heating repaired", { title: "Heating", topic: "home" }),
    listed("heat2", "Radiator heating", { title: "Radiators", topic: "home", date: "2026-10-22" }),
  ];
  const keys = candidatePairs(items).map((p) => p.key);
  assert.ok(keys.includes(pairKey("acc1", "acc2")), "restated: shared words across topics");
  assert.ok(keys.includes(pairKey("grant1", "grant2")), "fewer shared words, the same deadline");
  assert.ok(!keys.includes(pairKey("dentist", "haircut")), "one word of two, other topics, no deadline: not asked");
  assert.ok(keys.includes(pairKey("heat1", "heat2")), "half the words, the same topic two days apart");
  const many = Array.from({ length: 10 }, (_, i) => listed(`e${i}`, `Errand ${i}`, { title: `Errand ${i}` }));
  assert.equal(candidatePairs(many).length, 0, "a word on most tasks says nothing about which task");
});

test("the pair prompt goes through clean and numbers each pair; a reply is read pair by pair", () => {
  const pairs = [
    { key: "a~b", a: listed("a", "Fix the login"), b: listed("b", "Fix the redirect", { origin: "md:Vault" }) },
  ];
  const messages = pairMessages(pairs, { clean: (s) => s.replace("login", "[x]") });
  assert.match(messages[0].content, /same commitment/);
  const user = messages[1].content;
  assert.match(user, /^1\.\n {3}A: \[shop\] todo, 2026-10-20: Task a/m);
  assert.match(user, /Task: Fix the \[x\]/);
  assert.match(user, /B: .*Task b/);
  const got = parsePairs('{"pairs":[{"n":1,"same":true},{"n":2,"same":"yes"},{"n":9,"same":false}]}', 2);
  assert.deepEqual([...got], [[1, true]], "only well-formed items in range");
  assert.throws(() => parsePairs('{"pairs":[]}', 1), /no valid/);
});

function pairModel(same = () => false) {
  const calls = [];
  const complete = async (messages) => {
    calls.push(messages);
    const count = (messages.at(-1).content.match(/^\d+\.$/gm) ?? []).length;
    return JSON.stringify({ pairs: Array.from({ length: count }, (_, i) => ({ n: i + 1, same: same(i + 1) })) });
  };
  return { complete, calls };
}

test("judgePairs asks only about new or changed pairs, at most `max` a run, in calls of up to 20", async () => {
  const items = Array.from({ length: 30 }, (_, i) => listed(`t${i}`, `Task ${i}`));
  const pairs = items.slice(1).map((it, i) => ({ key: pairKey("t0", it.key), a: items[0], b: it }));
  const model = pairModel((n) => n === 1);
  const first = await judgePairs(model.complete, pairs, { max: 25 });
  assert.equal(model.calls.length, 2, "25 pairs: 20 and 5");
  assert.equal(first.asked, 25);
  assert.equal(Object.keys(first.cache).length, 25);
  const second = await judgePairs(model.complete, pairs, { cache: first.cache, max: 25 });
  assert.equal(model.calls.length, 3, "the 4 left over in one call");
  assert.equal(second.asked, 4);
  const again = await judgePairs(model.complete, pairs, { cache: second.cache, max: 25 });
  assert.equal(model.calls.length, 3, "nothing new: no call");
  assert.equal(again.asked, 0);
  const changed = pairs.map((p, i) =>
    i === 3 ? { ...p, b: listed(p.b.key, "Task 4, renamed", { title: "New" }) } : p,
  );
  const fourth = await judgePairs(model.complete, changed, { cache: again.cache, max: 25 });
  assert.equal(fourth.asked, 1, "a changed entry asks again about its pairs only");
});

test("a failed pair call groups nothing and is asked again next time", async () => {
  const pairs = [{ key: "a~b", a: listed("a", "A"), b: listed("b", "B") }];
  const r = await judgePairs(async () => {
    throw new Error("down");
  }, pairs);
  assert.deepEqual(r.cache, {});
  assert.equal(r.failed, 1);
  assert.deepEqual(r.errors, ["down"]);
});

test("refreshTasks judges candidate pairs among the tasks it kept and stores them for taskList", async () => {
  const queue = [
    entry("lyon1", { title: "Lyon trip", next: "Buy the train tickets to Lyon", date: "2026-10-28" }),
    entry("lyon2", { title: "Lyon", next: "Book the train tickets to Lyon", date: "2026-10-21" }),
    entry("watch", { title: "Lyon weather", next: "Keep an eye on the train strike" }),
  ];
  const memory = {
    taskQueue: async () => queue,
    profileSample: async () => queue.map(({ topic, title }) => ({ topic, title })),
  };
  const stored = {};
  const storage = { get: async () => ({ ...stored }), set: async (o) => Object.assign(stored, o) };
  const calls = [];
  const complete = async (messages) => {
    calls.push(messages);
    if (/same commitment/.test(messages[0].content)) return '{"pairs":[{"n":1,"same":true}]}';
    return JSON.stringify({
      items: [
        { n: 1, is_task: true, still_open: true, task: "Buy the Lyon train tickets", who: null, personal: false },
        { n: 2, is_task: true, still_open: true, task: "Book the Lyon train tickets", who: null, personal: false },
        { n: 3, is_task: false, still_open: true, task: "", who: null, personal: false },
      ],
    });
  };
  const r = await refreshTasks(complete, { memory, storage, today: "2026-11-02" });
  assert.equal(calls.length, 2, "one task call, one pair call");
  assert.doesNotMatch(calls[1].at(-1).content, /weather/, "a note the node found no task is not paired");
  assert.deepEqual(Object.keys(stored.taskPairs), [pairKey("lyon1", "lyon2")]);
  assert.equal(r.pairCalls, 1);
  const list = taskList(queue, { verdicts: stored.taskVerdicts, pairs: stored.taskPairs });
  assert.deepEqual(
    list.map((e) => e.title),
    ["Buy the Lyon train tickets"],
  );
  await refreshTasks(complete, { memory, storage, today: "2026-11-02" });
  assert.equal(calls.length, 2, "a re-import with nothing new asks nothing");
});

// ---- The same commitment in two languages -------------------------------------------

test("the node is asked for an English match key, and a reply keeps it short and lowercase", () => {
  const [system] = taskMessages([{ entry: entry("a"), later: [] }]);
  assert.match(system.content, /match: .*English/);
  assert.match(system.content, /never shown/);
  const items = parseTasks(
    JSON.stringify({
      items: [
        {
          n: 1,
          is_task: true,
          still_open: true,
          task: "Kira sözleşmesini imzala",
          match: "Sign the Lease Renewal, now!",
        },
        { n: 2, is_task: true, still_open: true, task: "Do it", match: "one two three four five six seven eight" },
        { n: 3, is_task: true, still_open: true, task: "Do it" },
      ],
    }),
    3,
  );
  assert.equal(items.get(1).match, "sign the lease renewal now");
  assert.equal(items.get(1).task, "Kira sözleşmesini imzala", "the shown title stays in the note's language");
  assert.equal(items.get(2).match, "one two three four five six", "at most 6 words");
  assert.equal("match" in items.get(3), false, "no key in the reply: none stored");
});

test("candidate pairs: a Turkish and an English note for one task are found by their match keys", () => {
  const visaTr = {
    ...listed("visaTr", "Almanya vize randevusu al", { title: "Vize", topic: "seyahat" }),
    match: "book german visa appointment",
  };
  const visaEn = {
    ...listed("visaEn", "Book the German visa appointment", { title: "Visa for the Berlin trip", topic: "travel" }),
    match: "book german visa appointment",
  };
  const hotel = {
    ...listed("hotel", "Book the hotel in Berlin", { title: "Berlin hotel", topic: "travel" }),
    match: "book berlin hotel",
  };
  const keys = candidatePairs([visaTr, visaEn, hotel]).map((p) => p.key);
  assert.ok(keys.includes(pairKey("visaEn", "visaTr")), "no shared word, the same key");
  assert.ok(!keys.includes(pairKey("hotel", "visaTr")), "another task of the same trip: keys differ");
  const plain = ({ match, ...item }) => item;
  assert.ok(
    !candidatePairs([plain(visaTr), plain(visaEn)]).length,
    "without keys (a verdict from before, or a Markdown checkbox) the words decide, as before",
  );
});

test("refreshTasks pairs by the node's match keys, and a verdict from before keys is kept, not asked again", async () => {
  const queue = [
    entry("tr", { topic: "ev", title: "Kira sözleşmesi", next: "Kira sözleşmesi yenilemesini imzala" }),
    entry("en", { topic: "home", title: "Lease renewal", next: "Sign the lease renewal", date: "2026-10-22" }),
  ];
  const memory = {
    taskQueue: async () => queue,
    profileSample: async () => queue.map(({ topic, title }) => ({ topic, title })),
  };
  const stored = {};
  const storage = { get: async () => ({ ...stored }), set: async (o) => Object.assign(stored, o) };
  const calls = [];
  const complete = async (messages) => {
    calls.push(messages);
    if (/same commitment/.test(messages[0].content)) return '{"pairs":[{"n":1,"same":true}]}';
    return JSON.stringify({
      items: [
        { n: 1, is_task: true, still_open: true, task: "Kira yenilemesini imzala", match: "sign lease renewal" },
        { n: 2, is_task: true, still_open: true, task: "Sign the lease renewal", match: "sign lease renewal" },
      ],
    });
  };
  await refreshTasks(complete, { memory, storage, today: "2026-11-02" });
  assert.equal(calls.length, 2, "one task call, one pair call: the key costs no call of its own");
  assert.deepEqual(Object.keys(stored.taskPairs), [pairKey("en", "tr")]);
  // A verdict stored before keys existed still holds: no call to fill the key in.
  for (const v of Object.values(stored.taskVerdicts)) delete v.match;
  stored.taskPairs = {};
  await refreshTasks(complete, { memory, storage, today: "2026-11-02" });
  assert.equal(calls.length, 2, "nothing changed: no task call, and without keys no pair either");
});

// #76, comment of 2026-11-04: the node sees the whole day's notes with their results, and
// one summary of the day's browsing.
test("every note from the entry's day goes as possibly later, with its result; caps hold", () => {
  const sample = [
    { topic: "app", title: "Next week's note", date: "2026-11-05", result: "Shipped it." },
    { topic: "app", title: "Alpha same day", date: "2026-11-04", result: "Merged the task-node fix." },
    { topic: "app", title: "Plan the backend", date: "2026-11-04", result: "Split agreed." },
    { topic: "app", title: "Zulu same day", date: "2026-11-04", result: "none" },
    { topic: "app", title: "Yesterday", date: "2026-11-03", result: "Older." },
    { topic: "other", title: "Elsewhere", date: "2026-11-04", result: "x" },
  ];
  const entry = { topic: "app", title: "Plan the backend", date: "2026-11-04" };
  const got = laterOnTopic(entry, sample);
  assert.deepEqual(
    titles(got),
    ["Zulu same day", "Alpha same day", "Next week's note"],
    "the day's notes on both sides",
  );
  assert.deepEqual(got[1], { title: "Alpha same day", date: "2026-11-04", result: "Merged the task-node fix." });
  assert.equal(got[0].result, undefined, "a result of none is left out");
  assert.equal(laterOnTopic(entry, sample, { later: 2 }).length, 2, "LATER stays the cap across days");
  assert.ok(!titles(got).includes("Yesterday"), "an older note is not a later one");
});

test("a later note goes with its date and result, cut and cleaned", () => {
  const long = `Submitted the form; key sk-abc ${"x".repeat(300)}`;
  const [, user] = taskMessages(
    [{ entry: entry("a"), later: [{ title: "Form", date: "2026-11-04", result: long }, "Just a title"] }],
    { clean: (s) => s.replace(/sk-\w+/, "[REDACTED]"), today: "2026-11-04" },
  );
  const line = user.content.split("\n").find((l) => l.includes('"Form"'));
  assert.match(line, /^ {3}- 2026-11-04 "Form": Submitted the form; key \[REDACTED\] x+$/);
  assert.ok(line.length < 200, "the result is cut to about 150 characters");
  assert.match(user.content, /^ {3}- "Just a title"$/m);
});

test("the day's browsing goes once, cleaned, ahead of the entries; none, no block", () => {
  const activity = 'Last 1440 min (90 min active):\n- github.com: 80 min ("acme/app", "token sk-abc")';
  const [system, user] = taskMessages(
    [
      { entry: entry("a"), later: [] },
      { entry: entry("b"), later: [] },
    ],
    { activity, clean: (s) => s.replace(/sk-\w+/, "[REDACTED]") },
  );
  assert.equal(user.content.match(/Their browsing over the last day/g).length, 1);
  assert.ok(user.content.indexOf("github.com") < user.content.indexOf("Their entries:"));
  assert.doesNotMatch(user.content, /sk-abc/);
  assert.match(system.content, /evidence for still_open only:\s+never make a task from it/);
  assert.match(system.content, /planning, coordination or "decide how to" step is closed/);
  const [, plain] = taskMessages([{ entry: entry("a"), later: [] }]);
  assert.doesNotMatch(plain.content, /browsing/);
});

test("a title names what the action is for", () => {
  const [system] = taskMessages([{ entry: entry("a"), later: [] }]);
  assert.match(system.content, /Name what the action is for \(the\s+programme, person, project or document\)/);
  assert.match(
    system.content,
    /"Decide whether to submit the grant application\s+late", not "Decide whether to upload video and submit late"/,
  );
});

test("refreshTasks sends one summary of the last 24 hours to every batch; a new day asks nothing again", async () => {
  const queue = Array.from({ length: 16 }, (_, i) => entry(`e${i}`));
  const asked = [];
  const memoryWith = (text, sites) => ({
    taskQueue: async () => queue,
    profileSample: async () => [],
    activity: async ({ minutes }) => (asked.push(minutes), { summary: { sites }, text }),
  });
  const stored = {};
  const storage = {
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
    set: async (o) => Object.assign(stored, o),
  };
  const model = fakeModel();
  await refreshTasks(model.complete, {
    memory: memoryWith("- github.com: 80 min", [{ host: "github.com" }]),
    storage,
    today: "2026-11-04",
  });
  assert.deepEqual(asked, [1440], "asked once per run, for 24 hours");
  assert.equal(model.calls.length, 2);
  assert.ok(model.calls.every((m) => m.at(-1).content.includes("- github.com: 80 min")));
  const again = fakeModel();
  await refreshTasks(again.complete, {
    memory: memoryWith("- youtube.com: 3 h", [{ host: "youtube.com" }]),
    storage,
    today: "2026-11-04",
  });
  assert.equal(
    again.calls.filter((m) => /short to-do list/.test(m[0].content)).length,
    0,
    "browsing is not in the hash",
  );
  const none = fakeModel();
  await refreshTasks(none.complete, {
    memory: memoryWith("Last 1440 min: no browser activity.", []),
    storage: { get: async () => ({}), set: async () => {} },
    today: "2026-11-04",
  });
  assert.doesNotMatch(none.calls[0].at(-1).content, /browsing/, "no sites, no block");
  const old = fakeModel();
  await refreshTasks(old.complete, {
    memory: { taskQueue: async () => queue, profileSample: async () => [] },
    storage: { get: async () => ({}), set: async () => {} },
    today: "2026-11-04",
  });
  assert.equal(old.calls.length, 2, "a memory without activity still works");
});

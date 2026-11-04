import test from "node:test";
import assert from "node:assert/strict";
import { taskQueue, contextPack, renderPack, writtenBy } from "../../../src/memory/context.js";
import { buildIndex, entryDoc } from "../../../src/memory/recall.js";

const TODAY = "2026-11-01";

const entry = (over) => ({
  kind: "todo",
  topic: "bilun",
  date: "2026-10-30",
  source: "brain",
  context: "c",
  result: "r",
  evidence: "none",
  next: "do the thing",
  ...over,
});

const entries = [
  entry({ id: "a", title: "Bootcamp application", result: "deadline is 2026-11-09", next: "Fill in the form" }),
  entry({ id: "b", title: "Hackathon submission", result: "due 2026-11-04", next: "Record the demo" }),
  entry({ id: "c", title: "Read the SUT catalogue", next: "Skim chapter 2" }),
  entry({ id: "d", title: "Already filed", next: "none" }),
];

test("the queue puts the nearest deadline first and the undated loops last", () => {
  const q = taskQueue(entries, { today: TODAY });
  assert.deepEqual(
    q.map((e) => e.id),
    ["b", "a", "c"],
  );
  assert.equal(q[0].due, "2026-11-04");
  assert.equal(q[0].daysLeft, 3);
  assert.equal(q[2].due, null);
});

test("an entry with no next action is not a task", () => {
  assert.equal(
    taskQueue(entries, { today: TODAY }).some((e) => e.id === "d"),
    false,
  );
});

test("the queue respects its limit", () => {
  assert.equal(taskQueue(entries, { today: TODAY, limit: 2 }).length, 2);
});

test("the rendered pack states the days left and does not repeat a task", () => {
  const index = buildIndex(entries.map(entryDoc));
  const pack = contextPack(
    index,
    entries,
    { title: "Bootcamp", url: "https://teknoparkizmir.com.tr" },
    { today: TODAY },
  );
  const text = renderPack(pack);

  assert.match(text, /Deadlines:/);
  assert.match(text, /Hackathon submission → due 2026-11-04 \(in 3 days\)/);
  assert.equal(text.match(/Hackathon submission/g).length, 1, "a dated task is listed once, not in both sections");
});

test("no deadlines anywhere means no Deadlines section", () => {
  const plain = [entry({ id: "c", title: "Read the SUT catalogue", next: "Skim chapter 2" })];
  const index = buildIndex(plain.map(entryDoc));
  const pack = contextPack(index, plain, { title: "x", url: "https://example.com" }, { today: TODAY });
  assert.doesNotMatch(renderPack(pack), /Deadlines:/);
});

test("a deadline long past sinks below the live tasks instead of holding the top", () => {
  const old = entry({ id: "old", title: "Hasat 2026 application", result: "deadline 2025-06-01", date: "2025-05-01" });
  const q = taskQueue([old, ...entries], { today: TODAY });
  assert.equal(q[0].id, "b", "the nearest live deadline still leads");
  assert.equal(q.at(-1).id, "old", "a year-old deadline comes last, and is not dropped");
});

// #76: who wrote a next action, and how long a distilled one stays on offer.
const brainEntry = (over) => entry({ path: `notes/log/2026/${over.id}.md`, ...over });

test("who wrote a next action: the person, a coding agent, or a distill job", () => {
  assert.equal(writtenBy(brainEntry({ id: "m", source: "manual" })), "own", "brain add run by hand");
  assert.equal(writtenBy(brainEntry({ id: "c", source: "claude-code" })), "agent");
  assert.equal(writtenBy(brainEntry({ id: "d", source: "brain-distill" })), "distilled");
  assert.equal(writtenBy(entry({ id: "x", source: "distill" })), "distilled", "the extension's own distill");
  assert.equal(writtenBy(entry({ id: "g", source: "extension" })), "own", "a goal set in the extension");
  for (const [origin, source] of [
    ["md:Notes", "markdown"],
    ["paste:abc", "paste"],
    ["export:claude:conversations.json", "export"],
  ])
    assert.equal(writtenBy(entry({ id: "o", origin, source })), "own", origin);
  assert.equal(writtenBy(brainEntry({ id: "n", source: undefined })), "own", "no source is taken as the person's own");
});

test("a distilled loop older than 14 days is not offered; the person's own of the same age is", () => {
  const old = "2026-10-15"; // 17 days before TODAY
  const q = taskQueue(
    [
      brainEntry({ id: "distilled-old", date: old, source: "brain-distill", title: "Rebase the branch" }),
      brainEntry({ id: "own-old", date: old, source: "manual", title: "Renew the passport" }),
      brainEntry({ id: "agent-old", date: old, source: "claude-code", title: "Run the eval" }),
      brainEntry({ id: "distilled-new", date: "2026-10-25", source: "brain-distill", title: "Open the PR" }),
      brainEntry({
        id: "distilled-dated",
        date: old,
        source: "brain-distill",
        title: "Thesis proposal",
        result: "due 2026-11-15",
      }),
    ],
    { today: TODAY, limit: Infinity },
  );
  const ids = q.map((e) => e.id);
  assert.ok(!ids.includes("distilled-old"), "a distilled step not restated in 14 days is gone");
  assert.ok(ids.includes("own-old"), "the person's own loop of the same age stays");
  assert.ok(ids.includes("agent-old"), "an agent's session note is left to the task node, not cut by age");
  assert.ok(ids.includes("distilled-new"), "a distilled loop within 14 days stays");
  assert.ok(ids.includes("distilled-dated"), "an old distilled loop with a live deadline stays");
  assert.deepEqual(
    taskQueue([brainEntry({ id: "d", date: old, source: "brain-distill" })], { today: TODAY, distilledFor: 30 }).map(
      (e) => e.id,
    ),
    ["d"],
    "the age is a parameter",
  );
});

// #82: a notes folder's checkbox is dated by its file, so among the undated it sank below
// every newer note with a next action, out of sight behind Show all.
test("among the person's own undated loops, a notes-folder checkbox comes first", () => {
  const notes = Array.from({ length: 12 }, (_, i) =>
    brainEntry({ id: `n${i}`, date: "2026-10-31", source: "manual", title: `Note ${i}`, kind: "decision" }),
  );
  const box = entry({
    id: "box",
    kind: "todo",
    source: "markdown",
    path: "garden.md",
    origin: "md:Garden",
    title: "Order a new queen",
    date: "2026-09-12",
  });
  const agent = brainEntry({ id: "ag", date: "2026-10-31", source: "claude-code", title: "Run npm test" });
  const q = taskQueue([...notes, agent, box], { today: TODAY, limit: Infinity });
  assert.equal(q[0].id, "box");
  assert.equal(q.at(-1).id, "ag", "an agent's step still comes after the person's own");
});

test("the person's own loops come before an agent's and distilled ones, deadline by deadline", () => {
  const q = taskQueue(
    [
      brainEntry({ id: "u-distilled", date: "2026-10-31", source: "brain-distill", title: "Merge PR #9" }),
      brainEntry({ id: "u-agent", date: "2026-10-31", source: "claude-code", title: "Run npm test" }),
      brainEntry({ id: "u-own", date: "2026-10-20", source: "manual", title: "Call the bank" }),
      brainEntry({ id: "d-agent", source: "claude-code", title: "Ship it", result: "due 2026-11-04" }),
      brainEntry({ id: "d-own", source: "manual", title: "Hand it in", result: "due 2026-11-04" }),
      brainEntry({ id: "d-sooner", source: "brain-distill", title: "Earlier", result: "due 2026-11-02" }),
    ],
    { today: TODAY, limit: Infinity },
  );
  assert.deepEqual(
    q.map((e) => e.id),
    ["d-sooner", "d-own", "d-agent", "u-own", "u-agent", "u-distilled"],
    "a sooner deadline still leads; who wrote it decides within a deadline and among the undated",
  );
  assert.equal(q[0].writer, "distilled");
});

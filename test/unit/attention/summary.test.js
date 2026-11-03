import test from "node:test";
import assert from "node:assert/strict";
import { daySummary, summaryEntry } from "../../../src/attention/summary.js";
import { DEFAULTS } from "../../../src/attention/config.js";
import { relevanceKey, hostOf } from "../../../src/attention/relevance.js";
import { validate } from "../../../src/memory/entry.js";

// Hand-written logs, as the live worker records them: inputs and heartbeat ticks.
const S = 1000;
const MIN = 60 * S;
const cfg = { ...DEFAULTS, tzOffsetMin: 0 };
const t0 = Date.UTC(2026, 9, 31, 10, 0);
const goal = (over = {}) => ({
  id: "i1",
  title: "Fix the checkout bug",
  topic: "fix-the-checkout-bug",
  createdAt: t0,
  doneAt: null,
  expiredAt: t0 + 90 * MIN,
  fromLoopId: null,
  ...over,
});
const set = (ts, id = "i1", extra = {}) => ({
  type: "session",
  ts,
  kind: "intent_set",
  payload: { id, title: "Fix the checkout bug", topic: "fix-the-checkout-bug", ...extra },
});
const page = (ts, url, title, label, flags = {}) => ({
  type: "context",
  ts,
  tabId: 1,
  url,
  host: hostOf(url),
  title,
  key: relevanceKey("i1", url, title),
  label,
  confidence: 0.9,
  source: "llm",
  audible: false,
  browserFocused: true,
  idleState: "active",
  ...flags,
});
const repo = (ts, flags) => page(ts, "https://github.com/acme/shop", "cart.js · acme/shop", "related", flags);
const video = (ts) => page(ts, "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes", "unrelated");
// The heartbeat: a tick every 30 s after `from`, up to `to`.
const ticks = (from, to, every = 30 * S) =>
  Array.from({ length: Math.floor((to - from) / every) }, (_, i) => ({ type: "tick", ts: from + (i + 1) * every }));

// An hour on the repo, a drift to a video with two words, back after 160 s, then work
// until the goal runs out at 90 minutes.
const day = [
  set(t0),
  repo(t0),
  ...ticks(t0, t0 + 60 * MIN),
  video(t0 + 60 * MIN),
  ...ticks(t0 + 60 * MIN, t0 + 60 * MIN + 150 * S),
  repo(t0 + 60 * MIN + 160 * S),
  ...ticks(t0 + 60 * MIN + 160 * S, t0 + 90 * MIN),
  // Outputs and side records are not inputs: they change nothing.
  { type: "trigger", ts: t0 + 5 * MIN, id: "drift-old", kind: "drift", level: 3 },
  { type: "llm", ts: t0 + 5 * MIN, node: "classifyRelevance", ok: true },
];

test("a day with a goal: time on work, one drift, the words said and the returns", () => {
  assert.deepEqual(daySummary(day, goal(), cfg), {
    intentId: "i1",
    date: "2026-10-31",
    goal: "Fix the checkout bug",
    picked: false,
    onGoalMin: 87,
    drifts: 1,
    nudges: 2,
    returned: 2,
    site: "github.com",
    lastWork: "cart.js · acme/shop",
    finished: false,
    replaced: false,
  });
});

test("staying away after the words is no return", () => {
  const away = [
    set(t0),
    repo(t0),
    ...ticks(t0, t0 + 5 * MIN),
    video(t0 + 5 * MIN),
    ...ticks(t0 + 5 * MIN, t0 + 15 * MIN),
  ];
  const sum = daySummary(away, goal({ expiredAt: t0 + 15 * MIN }), cfg);
  assert.equal(sum.drifts, 1);
  assert.equal(sum.nudges, 3, "L1, L2, L3, then quiet");
  assert.equal(sum.returned, 0);
  assert.equal(sum.onGoalMin, 5);
});

test("sleep and an unfocused browser are not time on the goal", () => {
  const slept = [set(t0), repo(t0), ...ticks(t0, t0 + 10 * MIN), { type: "tick", ts: t0 + 190 * MIN }];
  assert.equal(daySummary(slept, goal({ expiredAt: t0 + 191 * MIN }), cfg).onGoalMin, 10);
  const blurred = [
    set(t0),
    repo(t0),
    ...ticks(t0, t0 + 10 * MIN),
    repo(t0 + 10 * MIN, { browserFocused: false }),
    ...ticks(t0 + 10 * MIN, t0 + 40 * MIN),
  ];
  assert.equal(daySummary(blurred, goal({ expiredAt: t0 + 40 * MIN }), cfg).onGoalMin, 10);
});

test("the goal's own time only: it stops at its end and at the next goal", () => {
  const later = [...day, set(t0 + 91 * MIN, "i2"), repo(t0 + 91 * MIN), ...ticks(t0 + 91 * MIN, t0 + 200 * MIN)];
  assert.equal(daySummary(later, goal(), cfg).onGoalMin, 87);
  const done = goal({ expiredAt: null, doneAt: t0 + 30 * MIN });
  const sum = daySummary(day, done, cfg);
  assert.equal(sum.onGoalMin, 30);
  assert.equal(sum.drifts, 0);
  assert.equal(sum.finished, true);
  const replaced = daySummary(later, goal({ expiredAt: null, doneAt: t0 + 91 * MIN, replaced: true }), cfg);
  assert.equal(replaced.finished, false);
  assert.equal(replaced.replaced, true);
});

test("a restart sets the same goal again: its day goes on", () => {
  const restarted = [
    set(t0),
    repo(t0),
    ...ticks(t0, t0 + 10 * MIN),
    set(t0 + 10 * MIN + S, "i1", { restored: true }),
    repo(t0 + 10 * MIN + 2 * S),
    ...ticks(t0 + 10 * MIN + 2 * S, t0 + 20 * MIN),
  ];
  assert.equal(daySummary(restarted, goal({ expiredAt: t0 + 20 * MIN }), cfg).onGoalMin, 20);
});

test("nothing to say: a goal not in the log, or barely in front of the person", () => {
  assert.equal(daySummary(day, goal({ id: "gone" }), cfg), null);
  const brief = [set(t0), repo(t0), { type: "tick", ts: t0 + 30 * S }];
  assert.equal(daySummary(brief, goal({ expiredAt: null, doneAt: t0 + 40 * S, replaced: true }), cfg), null);
});

test("the entry: the record format, the facts, and no page title", () => {
  const sum = daySummary(day, goal(), cfg);
  const e = summaryEntry(sum);
  assert.deepEqual(validate(e), []);
  assert.equal(e.kind, "event");
  assert.equal(e.topic, "focus");
  assert.equal(e.date, "2026-10-31");
  assert.equal(e.title, "Day 2026-10-31: Fix the checkout bug: 1h27 on goal, 1 drift");
  assert.equal(e.next, "none");
  assert.match(e.context, /Fix the checkout bug/);
  assert.match(e.context, /typed/);
  assert.equal(
    e.result,
    "Not finished. 1h27 on pages that served the goal; 1 drift; 2 nudges, 2 followed by a return to work within 2 minutes. Last work on github.com.",
  );
  assert.doesNotMatch(JSON.stringify(e), /cart\.js|F1 crashes|acme/);
  const picked = summaryEntry({ ...sum, picked: true, finished: true, drifts: 0, nudges: 0, returned: 0, site: null });
  assert.match(picked.context, /to-do list/);
  assert.equal(picked.title, "Day 2026-10-31: Fix the checkout bug: 1h27 on goal, 0 drifts");
  assert.equal(picked.result, "Finished. 1h27 on pages that served the goal; 0 drifts; no nudges.");
  assert.match(summaryEntry({ ...sum, replaced: true }).result, /^Not finished; another goal replaced it\./);
});

test("a long goal is cut in the title, the numbers are not", () => {
  const sum = daySummary(day, goal(), cfg);
  const e = summaryEntry({ ...sum, goal: "Write ".repeat(30).trim(), onGoalMin: 45 });
  assert.equal(e.title.length, 120);
  assert.match(e.title, /…: 0h45 on goal, 1 drift$/);
  assert.deepEqual(validate(e), []);
});

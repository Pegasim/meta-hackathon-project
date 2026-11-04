import test from "node:test";
import assert from "node:assert/strict";
import { initialState, step, nextWakeAt } from "../../../src/attention/engine.js";
import { withOverrides } from "../../../src/attention/config.js";
import { relevanceKey, hostOf } from "../../../src/attention/relevance.js";
import { present } from "../../../src/tuck/present.js";

const S = 1000;
const t0 = Date.UTC(2026, 9, 31, 10, 0); // 13:00 in Istanbul
const intent = { id: "i1", title: "Fix the checkout bug", topic: "shop" };
const REPO = ["https://github.com/acme/shop", "cart.js · acme/shop"];
const VIDEO = ["https://www.youtube.com/watch?v=a", "Top 10 F1 crashes"];
const SEARCH = ["https://www.google.com/search?q=x", "x - Google Search"];

// Task 3 tests the engine alone: every candidate passes at level 1. The second look
// is off here and tested on its own below.
const stubDecide = (policy, cand) => ({ policy, trigger: { ...cand, level: 1 } });
const CFG = withOverrides({ secondLook: false });
CFG.decide = stubDecide;

const ctx = (ts, [url, title], label, extra = {}) => ({
  type: "context",
  ts,
  tabId: 1,
  url,
  host: hostOf(url),
  title,
  key: relevanceKey(intent.id, url, title),
  ...(label && { label, confidence: 0.9, source: "llm" }),
  audible: false,
  browserFocused: true,
  idleState: "active",
  ...extra,
});
const setIntent = (ts) => ({ type: "session", ts, kind: "intent_set", payload: intent });
const tick = (ts) => ({ type: "tick", ts });

// Run inputs in order, inserting 1 s ticks between them up to `until`.
function run(inputs, { until, cfg = CFG, state = initialState() } = {}) {
  const out = [];
  const sorted = [...inputs].sort((a, b) => a.ts - b.ts);
  const end = until ?? sorted.at(-1).ts;
  let i = 0;
  for (let ts = sorted[0].ts; ts <= end; ts += S) {
    while (i < sorted.length && sorted[i].ts <= ts) {
      const r = step(state, sorted[i++], cfg);
      state = r.state;
      out.push(...r.out);
    }
    const r = step(state, tick(ts), cfg);
    state = r.state;
    out.push(...r.out);
  }
  return { state, out, triggers: out.filter((o) => o.type === "trigger") };
}

test("unrelated past tolerance → drift", () => {
  const { state, triggers } = run([setIntent(t0), ctx(t0, REPO, "related"), ctx(t0 + 10 * S, VIDEO, "unrelated")], {
    until: t0 + 60 * S,
  });
  const drift = triggers.find((t) => t.kind === "drift");
  assert.ok(drift, "a drift trigger");
  assert.ok(Math.abs(drift.ts - (t0 + 55 * S)) <= S, `drift at ${(drift.ts - t0) / S}s`);
  assert.equal(drift.evidence.host, "youtube.com");
  assert.equal(drift.evidence.lastRelevant.url, REPO[0]);
  assert.equal(state.state, "drifting");
});

test("related never warns", () => {
  const { state, triggers } = run([setIntent(t0), ctx(t0, REPO, "related")], { until: t0 + 600 * S });
  assert.equal(triggers.length, 0);
  assert.equal(state.budgetSec, 0);
  assert.equal(state.state, "focused");
});

test("neutral leaves the budget unchanged", () => {
  const { state } = run([setIntent(t0), ctx(t0, VIDEO, "unrelated"), ctx(t0 + 20 * S, SEARCH, "neutral")], {
    until: t0 + 320 * S,
  });
  assert.equal(state.budgetSec, 20);
});

test("unsure pages accumulate budget", () => {
  const unsure = ctx(t0, VIDEO, "unrelated", { confidence: 0.4 });
  const { state, triggers } = run([setIntent(t0), unsure], { until: t0 + 50 * S });
  assert.equal(state.budgetSec, 50);
  assert.ok(triggers.some((t) => t.kind === "drift"));
});

test("related time drains the budget at the decay rate", () => {
  const { state } = run([setIntent(t0), ctx(t0, VIDEO, "unrelated"), ctx(t0 + 30 * S, REPO, "related")], {
    until: t0 + 40 * S,
  });
  assert.equal(state.budgetSec, 10);
});

// Hopping: 7 switches in 90 s, 72 s of it on pages labelled unrelated at `confidence`.
function hop(cfg, { confidence = 0.9, labels } = {}) {
  const pages = [
    VIDEO,
    REPO,
    ["https://x.com/home", "Home / X"],
    REPO,
    ["https://reddit.com/r/f1", "r/f1"],
    REPO,
    VIDEO,
  ];
  labels ??= ["unrelated", "related", "unrelated", "related", "unrelated", "related", "unrelated"];
  const durations = [16, 6, 16, 6, 16, 6, 24];
  let ts = t0;
  const inputs = [setIntent(t0)];
  pages.forEach((p, i) => {
    inputs.push(ctx(ts, p, labels[i], labels[i] === "unrelated" ? { confidence } : {}));
    ts += durations[i] * S;
  });
  const { triggers } = run(inputs, { until: ts, cfg: { ...cfg, toleranceSec: 1000 } });
  return triggers.filter((t) => t.kind === "fragmentation").length;
}

test("hopping between tabs is fragmentation, when it is on", () => {
  assert.equal(hop({ ...CFG, fragmentation: true }), 1);
});

test("issue #30: the fragmentation nudge is off by default", () => {
  assert.equal(hop(CFG), 0);
});

test("issue #30: fast switching between work tabs is never fragmentation", () => {
  const work = Array(7).fill("related");
  assert.equal(hop({ ...CFG, fragmentation: true }, { labels: work }), 0);
});

test("issue #30: an unsure unrelated verdict is not off-task time", () => {
  // The same hopping, but each unrelated verdict is below unsureConfidence.
  assert.equal(hop({ ...CFG, fragmentation: true }, { confidence: 0.4 }), 0);
});

test("a relevance answer for a page the user left does not relabel the page in front", () => {
  let { state, out } = step(initialState(), setIntent(t0), CFG);
  ({ state, out } = step(state, ctx(t0, VIDEO), CFG));
  assert.deepEqual(
    out.filter((o) => o.type === "need_relevance").map((o) => o.key),
    [relevanceKey(intent.id, ...VIDEO)],
  );
  ({ state } = step(state, ctx(t0 + S, REPO, "related"), CFG));
  const before = structuredClone(state);
  ({ state, out } = step(
    state,
    {
      type: "relevance",
      ts: t0 + 2 * S,
      key: relevanceKey(intent.id, ...VIDEO),
      label: "unrelated",
      confidence: 0.9,
      source: "llm",
    },
    CFG,
  ));
  assert.equal(state.current.key, before.current.key);
  assert.equal(state.current.label, "related");
  assert.equal(out.filter((o) => o.type === "state").length, 0);
});

test("a page waiting for its label counts as neutral and asks once", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, ctx(t0, VIDEO), CFG);
  r = step(r.state, ctx(t0 + S, VIDEO), CFG); // a title update on the same page
  assert.equal(r.out.filter((o) => o.type === "need_relevance").length, 0);
  const { state } = run([tick(t0 + 2 * S)], { state: r.state, until: t0 + 60 * S });
  assert.equal(state.budgetSec, 0);
});

test("a long silence is time away, not drift", () => {
  let { state } = step(initialState(), setIntent(t0), CFG);
  ({ state } = step(state, ctx(t0, VIDEO, "unrelated"), CFG));
  const r = step(state, tick(t0 + 30 * 60 * S), CFG);
  assert.equal(r.out.filter((o) => o.type === "trigger").length, 0);
  assert.equal(r.state.budgetSec, 0);
  assert.equal(r.state.state, "away");
});

test("coming back after a long time away is a return", () => {
  const away = ctx(t0 + 10 * S, REPO, "related", { idleState: "idle" });
  const back = ctx(t0 + 400 * S, REPO, "related");
  const { triggers } = run([setIntent(t0), ctx(t0, REPO, "related"), away, back], { until: t0 + 401 * S });
  assert.deepEqual(
    triggers.map((t) => t.kind),
    ["return"],
  );
});

test("a JSON round trip mid-drift changes nothing", () => {
  const inputs = [setIntent(t0), ctx(t0, VIDEO, "unrelated")];
  const straight = run(inputs, { until: t0 + 50 * S });
  const half = run(inputs, { until: t0 + 40 * S });
  const resumed = run([tick(t0 + 41 * S)], { state: JSON.parse(JSON.stringify(half.state)), until: t0 + 50 * S });
  const drifts = (ts) => ts.filter((t) => t.kind === "drift").map((t) => t.ts);
  assert.deepEqual([...drifts(half.triggers), ...drifts(resumed.triggers)], drifts(straight.triggers));
  assert.equal(drifts(straight.triggers).length, 1);
});

test("an audible tab while idle is not away; an unfocused browser is", () => {
  let { state } = step(initialState(), setIntent(t0), CFG);
  ({ state } = step(state, ctx(t0, REPO, "related", { idleState: "idle", audible: true }), CFG));
  assert.equal(state.state, "focused");
  ({ state } = step(state, ctx(t0 + S, REPO, "related", { browserFocused: false }), CFG));
  assert.equal(state.state, "away");
});

test("a break holds off drift, then ends with break_over", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    { type: "response", ts: t0 + 10 * S, triggerId: "x", choice: "break" },
  ];
  const { triggers, state } = run(inputs, { until: t0 + 10 * S + 5 * 60 * S });
  assert.deepEqual(
    triggers.map((t) => t.kind),
    ["break_over"],
  );
  assert.equal(triggers[0].ts, t0 + 10 * S + 5 * 60 * S);
  assert.notEqual(state.state, "break");
});

test("no intent, no drift", () => {
  const { triggers, state } = run([ctx(t0, VIDEO, "unrelated")], { until: t0 + 120 * S });
  assert.deepEqual(
    triggers.filter((t) => t.kind !== "session_start"),
    [],
  );
  assert.equal(state.state, "no_intent");
});

test("step never mutates its input", () => {
  let { state } = step(initialState(), setIntent(t0), CFG);
  const frozen = structuredClone(state);
  step(state, ctx(t0, VIDEO, "unrelated"), CFG);
  assert.deepEqual(state, frozen);
});

test("nextWakeAt is when the budget will cross tolerance", () => {
  const { state } = run([setIntent(t0), ctx(t0, VIDEO, "unrelated")], { until: t0 + 10 * S });
  assert.equal(state.budgetSec, 10);
  assert.equal(nextWakeAt(state, CFG), state.lastTs + 35 * S);
});

test("Take me back ends the episode and empties the budget", () => {
  const { state } = run(
    [setIntent(t0), ctx(t0, VIDEO, "unrelated"), { type: "response", ts: t0 + 50 * S, triggerId: "d", choice: "back" }],
    { until: t0 + 50 * S },
  );
  assert.equal(state.budgetSec, 0);
});

test("session_start greets the first active page of a day once, only without a goal", () => {
  const cfg = { ...CFG, tzOffsetMin: -180 };
  const morning = Date.UTC(2026, 10, 1, 6, 0); // 09:00 in Istanbul
  const kinds = (inputs, until) =>
    run(inputs, { until, cfg })
      .triggers.filter((t) => t.kind === "session_start")
      .map((t) => t.ts);
  assert.deepEqual(kinds([ctx(morning, REPO), ctx(morning + 60 * S, VIDEO)], morning + 70 * S), [morning]);
  assert.deepEqual(kinds([setIntent(morning), ctx(morning, REPO, "related")], morning + 10 * S), []);
});

// #73: after a restart sessionDay is unset while the goal is restored. Ending the goal
// is the day already started: its word asks what's next, and a greeting would replace it.
test("session_start does not follow a finished goal, even after a restart", () => {
  const cfg = { ...CFG, tzOffsetMin: -180 };
  const morning = Date.UTC(2026, 10, 1, 6, 0);
  const restored = { type: "session", ts: morning, kind: "intent_set", payload: { ...intent, restored: true } };
  const done = { type: "session", ts: morning + 60 * S, kind: "intent_done", payload: { id: intent.id } };
  const { triggers } = run([restored, ctx(morning, REPO, "related"), done, ctx(morning + 61 * S, REPO)], {
    until: morning + 70 * S,
    cfg,
  });
  assert.deepEqual(
    triggers.filter((t) => t.kind === "session_start"),
    [],
  );
});

test("one nudge at a time: no fragmentation while a drift is running", () => {
  const cfg = { ...CFG, fragmentation: true };
  const X = ["https://x.com/home", "Home / X"];
  const inputs = [setIntent(t0), ctx(t0, VIDEO, "unrelated")];
  // Drift starts at 45 s; then hop between unrelated pages while drifting.
  [X, VIDEO, X, VIDEO, X, VIDEO, X].forEach((p, i) => inputs.push(ctx(t0 + (50 + i * 5) * S, p, "unrelated")));
  const { triggers } = run(inputs, { until: t0 + 90 * S });
  assert.ok(triggers.some((t) => t.kind === "drift"));
  assert.equal(triggers.filter((t) => t.kind === "fragmentation").length, 0);
});

test("review I4: one navigation (url, then title, then load) is one page switch", () => {
  const url = "https://www.youtube.com/watch?v=a";
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, ctx(t0, REPO, "related"), CFG);
  r = step(r.state, ctx(t0 + 100, [url, REPO[1]]), CFG); // new URL, old title
  r = step(r.state, ctx(t0 + 300, [url, "Top 10 F1 crashes"]), CFG); // the real title
  r = step(r.state, ctx(t0 + 400, [url, "Top 10 F1 crashes"]), CFG); // load complete
  assert.equal(r.state.timeline.length, 2);
  assert.equal(r.state.current.key, relevanceKey(intent.id, url, "Top 10 F1 crashes"));
});

test("review I5: no goal, no relevance requests", () => {
  const r = step(initialState(), ctx(t0, VIDEO), CFG);
  assert.equal(r.out.filter((o) => o.type === "need_relevance").length, 0);
  assert.deepEqual(r.state.asked, {});
});

test("review I5: an unanswered relevance request is asked again after 30 s", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, ctx(t0, VIDEO), CFG);
  r = step(r.state, ctx(t0 + 10 * S, REPO, "related"), CFG);
  r = step(r.state, ctx(t0 + 40 * S, VIDEO), CFG);
  assert.equal(r.out.filter((o) => o.type === "need_relevance").length, 1);
});

test("review I6: turning Off back on is not a return from away", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, ctx(t0, REPO, "related"), CFG);
  r = step(r.state, { type: "session", ts: t0 + S, kind: "mode", payload: { mode: "off" } }, CFG);
  r = step(r.state, { type: "session", ts: t0 + 600 * S, kind: "mode", payload: { mode: "focus" } }, CFG);
  assert.equal(r.state.away, false);
  r = step(r.state, ctx(t0 + 601 * S, REPO, "related"), CFG);
  assert.equal(r.out.filter((o) => o.type === "trigger").length, 0);
});

test("minor 1: This is for my task relabels the nudged page, not the page in front", () => {
  const X = ["https://x.com/home", "Home / X"];
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, ctx(t0, REPO, "related"), CFG);
  r = step(r.state, ctx(t0 + 10 * S, X, "unrelated"), CFG); // the user moved on
  r = step(r.state, { type: "response", ts: t0 + 11 * S, choice: "related", pageUrl: VIDEO[0] }, CFG);
  assert.equal(r.state.current.label, "unrelated");
  assert.equal(r.state.lastRelevant.url, REPO[0]);
});

test("minor 2: heartbeat ticks while away do not count as activity", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, ctx(t0, REPO, "related"), CFG);
  r = step(r.state, ctx(t0 + S, REPO, "related", { idleState: "locked" }), CFG);
  for (let ts = t0 + 31 * S; ts < t0 + 3600 * S; ts += 30 * S) r = step(r.state, tick(ts), CFG);
  assert.equal(r.state.lastActiveTs, t0);
});

test("minor 7: break_over stays quiet when the user is already back at work", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    { type: "response", ts: t0 + 10 * S, triggerId: "x", choice: "break" },
    ctx(t0 + 200 * S, REPO, "related"),
  ];
  const { triggers } = run(inputs, { until: t0 + 10 * S + 5 * 60 * S });
  assert.deepEqual(triggers, []);
});

test("the trigger says whether the page is unsure", () => {
  const unsure = ctx(t0, VIDEO, "unrelated", { confidence: 0.4 });
  const { triggers } = run([setIntent(t0), unsure], { until: t0 + 50 * S });
  assert.equal(triggers.find((t) => t.kind === "drift").evidence.unsure, true);
  const sure = run([setIntent(t0), ctx(t0, VIDEO, "unrelated")], { until: t0 + 50 * S });
  assert.equal(sure.triggers.find((t) => t.kind === "drift").evidence.unsure, false);
});

test("evidence counts time away from work, not time on this page", () => {
  const X = ["https://x.com/home", "Home / X"];
  const { triggers } = run(
    [setIntent(t0), ctx(t0, REPO, "related"), ctx(t0 + 10 * S, VIDEO, "unrelated"), ctx(t0 + 40 * S, X, "unrelated")],
    { until: t0 + 60 * S },
  );
  const drift = triggers.find((t) => t.kind === "drift");
  assert.equal(drift.ts, t0 + 55 * S);
  assert.equal(drift.evidence.awaySec, 45);
  assert.equal(drift.evidence.host, "x.com");
});

test("time outside the browser is not time away from work (İrem's log, 2026-11-04)", () => {
  // Off to a video, then three minutes in the terminal answering the coding agent, then
  // back on another unrelated page: only the browser time counts.
  const X = ["https://x.com/home", "Home / X"];
  const { triggers } = run(
    [
      setIntent(t0),
      ctx(t0, REPO, "related"),
      ctx(t0 + 10 * S, VIDEO, "unrelated"),
      ctx(t0 + 20 * S, VIDEO, "unrelated", { browserFocused: false }),
      ctx(t0 + 200 * S, X, "unrelated"),
    ],
    { until: t0 + 240 * S },
  );
  const drift = triggers.find((t) => t.kind === "drift" && t.ts > t0 + 200 * S);
  assert.ok(drift, "a drift word on the page after coming back");
  assert.equal(drift.evidence.awaySec, Math.round((drift.ts - t0 - 190 * S) / S));
});

// ---- The second look (issue #5) ----------------------------------------------
// With the real policy and the second look on. The video becomes unrelated at +10 s,
// so the budget reaches 30 s (tolerance 45 − lead 15) at +40 s: the excerpt is read
// ahead. It reaches 45 s at +55 s: typing is checked, and the answer at +56 s decides.

const LOOK = withOverrides();
const videoKey = relevanceKey(intent.id, ...VIDEO);
const answer = (ts, fields, key = videoKey) => ({ type: "second_look", ts, key, composing: false, ...fields });
const typing = (ts) => answer(ts, { composing: true });
const toVideo = [setIntent(t0), ctx(t0, REPO, "related"), ctx(t0 + 10 * S, VIDEO, "unrelated")];
const drifts = (triggers) => triggers.filter((t) => t.kind === "drift");
const asked = (out, type) => out.filter((o) => o.type === type).map((o) => [(o.ts - t0) / S, o.url]);

test("second look: the excerpt is read ahead; typing is checked when the word is due", () => {
  const { out } = run(toVideo, { until: t0 + 60 * S, cfg: LOOK });
  assert.deepEqual(asked(out, "read_ahead"), [[40, VIDEO[0]]]);
  assert.deepEqual(asked(out, "need_second_look"), [[55, VIDEO[0]]]);
  assert.equal(out.find((o) => o.type === "read_ahead").key, videoKey);
});

test("second look: 'nothing seen' lets the drift come, at L1", () => {
  const { triggers } = run([...toVideo, answer(t0 + 56 * S)], { until: t0 + 60 * S, cfg: LOOK });
  assert.equal(drifts(triggers)[0].ts, t0 + 56 * S);
  assert.equal(drifts(triggers)[0].level, 1);
});

test("second look: with no answer the drift waits, then goes ahead at the timeout", () => {
  const { triggers } = run(toVideo, { until: t0 + 80 * S, cfg: LOOK });
  assert.equal(drifts(triggers)[0].ts, t0 + 75 * S); // asked at +55, timeout 20 s
});

test("second look: an excerpt read ahead that shows work ends the detour before any word", () => {
  const { out, state, triggers } = run([...toVideo, answer(t0 + 42 * S, { label: "related", confidence: 0.9 })], {
    until: t0 + 120 * S,
    cfg: LOOK,
  });
  assert.deepEqual(drifts(triggers), []);
  assert.deepEqual(asked(out, "need_second_look"), []);
  assert.equal(state.state, "focused");
  assert.equal(state.current.source, "look");
  assert.equal(state.lastRelevant.url, REPO[0], "Take me back still goes to the repo");
});

test("second look: a 'related' the model is unsure of does not stop the drift", () => {
  const unsure = { label: "related", confidence: 0.4 };
  const { triggers } = run([...toVideo, answer(t0 + 42 * S, unsure), answer(t0 + 56 * S, unsure)], {
    until: t0 + 60 * S,
    cfg: LOOK,
  });
  assert.equal(drifts(triggers)[0].ts, t0 + 56 * S);
});

test("second look: typing holds the first word twice, then it comes at L1", () => {
  // Typing at +56 → hold (until +176); look again, typing at +177 → hold (until +297);
  // look again, typing at +298 → no holds left: the drift.
  const { out, triggers } = run([...toVideo, typing(t0 + 56 * S), typing(t0 + 177 * S), typing(t0 + 298 * S)], {
    until: t0 + 310 * S,
    cfg: LOOK,
  });
  assert.equal(drifts(triggers)[0].ts, t0 + 298 * S);
  assert.equal(drifts(triggers)[0].level, 1);
  assert.deepEqual(
    asked(out, "need_second_look").map(([ts]) => ts),
    [55, 176, 297],
  );
  assert.equal(asked(out, "read_ahead").length, 1, "the excerpt is read once");
});

test("second look: an answer for a page already left is ignored", () => {
  const REDDIT = ["https://www.reddit.com/r/formula1", "r/formula1"];
  const inputs = [
    ...toVideo,
    ctx(t0 + 56 * S, REDDIT, "unrelated"),
    answer(t0 + 57 * S, { label: "related", confidence: 0.9 }), // about the video
  ];
  const { out, state, triggers } = run(inputs, { until: t0 + 80 * S, cfg: LOOK });
  assert.equal(state.current.label, "unrelated");
  assert.deepEqual(asked(out, "need_second_look").at(-1), [56, REDDIT[0]], "Reddit is looked at in turn");
  assert.equal(drifts(triggers)[0].ts, t0 + 75 * S); // the word waits from +55, one timeout
});

test("second look: none in do-not-disturb", () => {
  const dnd = { type: "session", ts: t0, kind: "mode", payload: { mode: "dnd" } };
  const { out, triggers } = run([...toVideo, dnd], { until: t0 + 60 * S, cfg: LOOK });
  assert.deepEqual([...asked(out, "read_ahead"), ...asked(out, "need_second_look")], []);
  assert.equal(drifts(triggers)[0].ts, t0 + 55 * S);
  assert.equal(drifts(triggers)[0].level, 0);
});

test("second look: going back to work ends a hold", () => {
  const { state } = run([...toVideo, typing(t0 + 56 * S), ctx(t0 + 60 * S, REPO, "related")], {
    until: t0 + 61 * S,
    cfg: LOOK,
  });
  assert.deepEqual([state.holds, state.holdUntil, state.look, state.readAheadKey], [0, null, null, null]);
});

test("second look: nextWakeAt wakes for the read-ahead, the timeout and the hold, never for a past time", () => {
  const at = (until, extra = []) => nextWakeAt(run([...toVideo, ...extra], { until, cfg: LOOK }).state, LOOK);
  assert.equal(at(t0 + 20 * S), t0 + 40 * S, "the read-ahead, before the tolerance");
  assert.equal(at(t0 + 56 * S), t0 + 75 * S, "the look's timeout");
  assert.equal(at(t0 + 57 * S, [typing(t0 + 56 * S)]), t0 + 176 * S, "the hold's end");
  assert.ok(at(t0 + 76 * S) > t0 + 76 * S, "after the timeout: the next escalation, not the past timeout");
});

test("second look: a new page during a drift is read ahead; work there ends the drift", () => {
  // L1 about the video at +56; at +70 a chat on another site, whose excerpt (read ahead
  // at once) shows work: no L2 (it was due at +86), and no look was needed for it.
  const CHAT = ["https://www.linkedin.com/feed/", "Feed | LinkedIn"];
  const chatKey = relevanceKey(intent.id, ...CHAT);
  const { out, triggers } = run(
    [
      ...toVideo,
      answer(t0 + 56 * S),
      ctx(t0 + 70 * S, CHAT, "unrelated"),
      answer(t0 + 72 * S, { label: "related", confidence: 0.9 }, chatKey),
    ],
    { until: t0 + 120 * S, cfg: LOOK },
  );
  assert.deepEqual(
    drifts(triggers).map((t) => (t.ts - t0) / S),
    [56],
  );
  assert.deepEqual(asked(out, "need_second_look"), [[55, VIDEO[0]]]);
  assert.deepEqual(asked(out, "read_ahead").at(-1), [70, CHAT[0]]);
});

test("second look: a hold ends when the person moves to another page", () => {
  // Typing on the video holds at +56 (until +176); at +60 another unrelated page, where
  // nobody types: it is looked at, and the drift word comes for it.
  const REDDIT = ["https://www.reddit.com/r/formula1", "r/formula1"];
  const redditKey = relevanceKey(intent.id, ...REDDIT);
  const { triggers } = run(
    [...toVideo, typing(t0 + 56 * S), ctx(t0 + 60 * S, REDDIT, "unrelated"), answer(t0 + 61 * S, {}, redditKey)],
    { until: t0 + 70 * S, cfg: LOOK },
  );
  assert.equal(drifts(triggers)[0].ts, t0 + 61 * S);
  assert.equal(drifts(triggers)[0].evidence.url, REDDIT[0]);
});

// Review findings on the first version of the second look.

test("second look: every drift word checks typing again (L2 holds while the person types)", () => {
  const { out, triggers } = run([...toVideo, answer(t0 + 56 * S), typing(t0 + 87 * S)], {
    until: t0 + 120 * S,
    cfg: LOOK,
  });
  assert.deepEqual(
    asked(out, "need_second_look").map(([ts]) => ts),
    [55, 86],
  );
  assert.deepEqual(
    drifts(triggers).map((t) => [(t.ts - t0) / S, t.level]),
    [[56, 1]],
    "L2 waits: the person is typing",
  );
});

test("second look: a blocked escalation never leaves a past wake time (no tick loop)", () => {
  // L1 at +56; the L2 look at +86 finds typing → hold until +207. Every step in between
  // must wake in the future.
  let state = initialState();
  const inputs = [...toVideo, answer(t0 + 56 * S), typing(t0 + 87 * S)].sort((a, b) => a.ts - b.ts);
  for (let ts = t0, i = 0; ts <= t0 + 200 * S; ts += S) {
    while (i < inputs.length && inputs[i].ts <= ts) state = step(state, inputs[i++], LOOK).state;
    state = step(state, tick(ts), LOOK).state;
    const at = nextWakeAt(state, LOOK);
    assert.ok(at == null || at > ts, `wake at ${(at - t0) / S} s when it is ${(ts - t0) / S} s`);
  }
});

test("second look: hopping between pages faster than the model answers still gets a word", () => {
  // A new unrelated page every 12 s from +60 and no answer ever: the word waits once
  // (from +55), not again for every page.
  const pages = [];
  for (let i = 0; i < 10; i++)
    pages.push(ctx(t0 + (60 + 12 * i) * S, [`https://site${i}.example/`, `Page ${i}`], "unrelated"));
  const { triggers } = run([...toVideo, ...pages], { until: t0 + 180 * S, cfg: LOOK });
  assert.equal(drifts(triggers)[0]?.ts, t0 + 75 * S);
});

// One URL and title, two surfaces (issue #9).
const FEED = ["https://www.linkedin.com/feed/", "Feed | LinkedIn"];
const CONVO = { kind: "conversation", labels: ["Ali"] };
const PLAIN = { kind: "page", labels: [] };
const onSurface = (ts, surface, label, source = "llm") =>
  ctx(ts, FEED, label, {
    surface,
    source,
    key: relevanceKey(intent.id, ...FEED, surface),
  });

test("moving between a chat and the feed on one URL is not a tab switch", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, onSurface(t0, PLAIN, "unrelated"), CFG);
  const before = r.state.timeline.length;
  for (let i = 1; i <= 8; i++) r = step(r.state, onSurface(t0 + i * S, i % 2 ? CONVO : PLAIN, "unrelated"), CFG);
  assert.equal(r.state.timeline.length, before);
});

test("a chat that is work does not excuse the feed: drift counts again on the feed", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, onSurface(t0, CONVO, "related", "label"), CFG);
  r = step(r.state, tick(t0 + 60 * S), CFG);
  assert.equal(r.state.budgetSec, 0);
  r = step(r.state, onSurface(t0 + 61 * S, PLAIN, "unrelated"), CFG);
  assert.equal(r.state.current.label, "unrelated");
  const { state } = run([tick(t0 + 62 * S)], { state: r.state, until: t0 + 100 * S });
  assert.ok(state.budgetSec > 30);
});

test("the surface a nudge was about travels in its evidence", () => {
  const { out } = run([setIntent(t0), onSurface(t0, CONVO, "unrelated")], { until: t0 + 60 * S });
  const trigger = out.find((o) => o.type === "trigger" && o.kind === "drift");
  assert.deepEqual(trigger.evidence.surface, CONVO);
});

test("an answer about the chat does not mark the feed the person has moved to", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, onSurface(t0, PLAIN, "unrelated"), CFG);
  const chatKey = relevanceKey(intent.id, ...FEED, CONVO);
  r = step(r.state, { type: "response", ts: t0 + S, choice: "related", pageUrl: FEED[0], pageKey: chatKey }, CFG);
  assert.equal(r.state.current.label, "unrelated");
});

test("an answer about the surface in front marks it, also from a log with no surface", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, onSurface(t0, CONVO, "unrelated"), CFG);
  const chatKey = relevanceKey(intent.id, ...FEED, CONVO);
  const a = step(r.state, { type: "response", ts: t0 + S, choice: "related", pageUrl: FEED[0], pageKey: chatKey }, CFG);
  assert.equal(a.state.current.label, "related");
  let old = step(initialState(), setIntent(t0), CFG);
  old = step(old.state, ctx(t0, FEED, "unrelated"), CFG);
  old = step(old.state, { type: "response", ts: t0 + S, choice: "related", pageUrl: FEED[0] }, CFG);
  assert.equal(old.state.current.label, "related");
});

test("a conversation is no place to go back to: the URL opens the feed, not the chat", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, ctx(t0, REPO, "related"), CFG);
  r = step(r.state, onSurface(t0 + S, CONVO, "related", "label"), CFG);
  assert.equal(r.state.lastRelevant.url, REPO[0]);
});

test("the request to judge a page says who the conversation is with", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, onSurface(t0, CONVO), CFG);
  assert.deepEqual(r.out.find((o) => o.type === "need_relevance").surface, CONVO);
});

test("when the notes change, the page in front is judged again and holds the budget meanwhile", () => {
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, onSurface(t0, CONVO, "unrelated"), CFG);
  r = step(r.state, onSurface(t0 + S, CONVO), CFG);
  assert.equal(r.out.filter((o) => o.type === "need_relevance").length, 0, "the same page keeps its verdict");
  r = step(r.state, { type: "session", ts: t0 + 2 * S, kind: "memory" }, CFG);
  assert.equal(r.state.state, "focused", "no verdict yet: not drifting");
  r = step(r.state, onSurface(t0 + 3 * S, CONVO), CFG);
  assert.equal(r.out.filter((o) => o.type === "need_relevance").length, 1, "asked again");
  const budget = r.state.budgetSec;
  r = step(r.state, tick(t0 + 30 * S), CFG);
  assert.equal(r.state.budgetSec, budget);
});

test("an answer about one person's chat does not mark another person's", () => {
  const other = { kind: "conversation", labels: ["Deniz"] };
  let r = step(initialState(), setIntent(t0), CFG);
  r = step(r.state, onSurface(t0, other, "unrelated"), CFG);
  const aliKey = relevanceKey(intent.id, ...FEED, CONVO);
  r = step(r.state, { type: "response", ts: t0 + S, choice: "related", pageUrl: FEED[0], pageKey: aliKey }, CFG);
  assert.equal(r.state.current.label, "unrelated");
});

// Whose turn it is in a coding agent (issue #11).
const agent = (ts, status) => ({ type: "agent", ts, status, session: "s1" });
const words = (out) => out.filter((o) => o.type === "trigger" && o.kind === "agent");

test("the bridge's facts reach the agent word's evidence (#67)", () => {
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600, decide: stubDecide });
  const done = { ...agent(t0 + S, "completed"), folder: "bilun", minutes: 4 };
  const { out, state } = run([setIntent(t0), agent(t0, "working"), ctx(t0, REPO, "related"), done], {
    until: t0 + 2 * S,
    cfg,
  });
  const [word] = words(out);
  assert.equal(word.evidence.agentFolder, "bilun");
  assert.equal(word.evidence.agentMin, 4);
  assert.equal(word.evidence.agentTool, null);
  assert.deepEqual(state.agent, {
    status: "completed",
    ts: t0 + S,
    session: "s1",
    done: false,
    folder: "bilun",
    minutes: 4,
  });
});

test("while the agent works, an unrelated page is a wait, not a drift", () => {
  const { state, out } = run([setIntent(t0), agent(t0, "working"), ctx(t0, VIDEO, "unrelated")], {
    until: t0 + 300 * S,
    cfg: withOverrides({ secondLook: false, agentQuietSec: 600, decide: stubDecide }),
  });
  assert.equal(state.budgetSec, 0);
  assert.equal(state.state, "agent_working");
  assert.equal(out.filter((o) => o.type === "trigger").length, 0);
});

test("when it stops, Tuck says so once, and drift counts again", () => {
  // Asking again while it waits has its own tests below.
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600, agentAskAgainSec: 600, decide: stubDecide });
  const { state, out } = run(
    [
      setIntent(t0),
      agent(t0, "working"),
      ctx(t0, VIDEO, "unrelated"),
      agent(t0 + 10 * S, "waiting_for_user"),
      agent(t0 + 16 * S, "waiting_for_user"), // the Notification after a PermissionRequest
    ],
    { until: t0 + 40 * S, cfg },
  );
  assert.equal(words(out).length, 1);
  assert.equal(words(out)[0].evidence.agent, "waiting_for_user");
  assert.ok(state.budgetSec > 20);
});

test("the turn's end is news even after an approval with the same status (Muse 2026-11-04)", () => {
  // Recorded: Muse asked for approval, ran the command under another session id (so the
  // person's session never said working again), then ended the turn with a question.
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600, agentAskAgainSec: 600, decide: stubDecide });
  const { out } = run(
    [
      setIntent(t0),
      agent(t0, "working"),
      agent(t0 + 4 * S, "waiting_for_user"), // PermissionRequest
      agent(t0 + 24 * S, "waiting_for_user"), // the second command's approval
      { ...agent(t0 + 66 * S, "waiting_for_user"), turnEnd: true }, // Stop: "Want me to fix cart.js?"
    ],
    { until: t0 + 70 * S, cfg },
  );
  assert.deepEqual(
    words(out).map((t) => [t.evidence.agent, t.ts - t0, t.evidence.agentDone]),
    [
      ["waiting_for_user", 4 * S, false],
      ["waiting_for_user", 66 * S, true],
    ],
  );
});

test("idle in front of an unrelated page still counts as time away from work", () => {
  // Reading a feed or a muted video without touching anything is still the detour.
  const X = ["https://x.com/home", "Home / X"];
  const { triggers } = run(
    [
      setIntent(t0),
      ctx(t0, REPO, "related"),
      ctx(t0 + 10 * S, VIDEO, "unrelated"),
      ctx(t0 + 20 * S, VIDEO, "unrelated", { idleState: "idle" }),
      ctx(t0 + 200 * S, X, "unrelated"),
    ],
    { until: t0 + 240 * S },
  );
  const drift = triggers.filter((t) => t.kind === "drift").at(-1);
  assert.equal(drift.evidence.awaySec, Math.round((drift.ts - t0 - 10 * S) / S));
});

test("after Muse's turn ends, drift on a page counts again (İrem, 2026-11-04)", () => {
  // Her second recorded turn: an approval, another, then the turn ends on a question.
  // Then she browses an unrelated page: Tuck must notice, as with no agent at all.
  const cfg = withOverrides({ secondLook: false, decide: stubDecide });
  const { out } = run(
    [
      setIntent(t0),
      ctx(t0, REPO, "related"),
      agent(t0, "working"),
      agent(t0 + 4 * S, "waiting_for_user"),
      agent(t0 + 18 * S, "waiting_for_user"),
      { ...agent(t0 + 51 * S, "waiting_for_user"), turnEnd: true },
      ctx(t0 + 60 * S, VIDEO, "unrelated"),
    ],
    { until: t0 + 200 * S, cfg },
  );
  const drift = out.find((o) => o.type === "trigger" && o.kind === "drift");
  assert.ok(drift, "a drift word after the turn ended");
  assert.ok(drift.ts - t0 <= 60 * S + cfg.toleranceSec * S + 2 * S, `drift at ${(drift.ts - t0) / S}s`);
});

test("a finished turn is never followed by 'still waiting' (İrem, 2026-11-04)", () => {
  // The turn ended with a question; the person reads it in the terminal. Asking again
  // whether Muse still waits is for an approval in the middle of a turn, not for this.
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600, agentAskAgainSec: 10, decide: stubDecide });
  const { out } = run(
    [setIntent(t0), agent(t0, "working"), { ...agent(t0 + 5 * S, "waiting_for_user"), turnEnd: true }],
    { until: t0 + 120 * S, cfg },
  );
  assert.deepEqual(
    words(out).map((t) => [t.ts - t0, t.evidence.agentDone, t.evidence.agentAgain]),
    [[5 * S, true, false]],
  );
});

test("a word comes for each stop, once work has started again", () => {
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600, decide: stubDecide });
  const { out } = run(
    [
      setIntent(t0),
      agent(t0, "working"),
      agent(t0 + S, "waiting_for_user"),
      agent(t0 + 2 * S, "working"),
      agent(t0 + 3 * S, "completed"),
    ],
    { until: t0 + 5 * S, cfg },
  );
  assert.deepEqual(
    words(out).map((t) => t.evidence.agent),
    ["waiting_for_user", "completed"],
  );
});

test("a stop while the browser is away is said when the person comes back", () => {
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600, decide: stubDecide });
  let r = step(initialState(), setIntent(t0), cfg);
  r = step(r.state, agent(t0, "working"), cfg);
  r = step(r.state, ctx(t0, REPO, "related", { browserFocused: false }), cfg);
  r = step(r.state, agent(t0 + S, "completed"), cfg);
  assert.equal(words(r.out).length, 0);
  r = step(r.state, ctx(t0 + 2 * S, REPO, "related"), cfg);
  assert.equal(words(r.out).length, 1);
});

test("an agent that goes quiet stops excusing the wait, and nothing is said", () => {
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 60, decide: stubDecide });
  const { state, out } = run([setIntent(t0), agent(t0, "working"), ctx(t0, VIDEO, "unrelated")], {
    until: t0 + 100 * S,
    cfg,
  });
  assert.equal(state.agent.status, "unknown");
  assert.equal(words(out).length, 0);
  assert.ok(state.budgetSec > 30);
});

test("the wake time is never in the past while the agent works", () => {
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600, decide: stubDecide });
  const { state } = run([setIntent(t0), ctx(t0, VIDEO, "unrelated"), agent(t0 + 100 * S, "working")], {
    until: t0 + 110 * S,
    cfg,
  });
  assert.equal(state.state, "agent_working");
  assert.ok(nextWakeAt(state, cfg) > state.lastTs);
});

test("do not disturb logs the word and shows nothing", () => {
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600 });
  let r = step(initialState(), setIntent(t0), cfg);
  r = step(r.state, { type: "session", ts: t0, kind: "mode", payload: { mode: "dnd" } }, cfg);
  r = step(r.state, agent(t0 + S, "working"), cfg);
  r = step(r.state, agent(t0 + 2 * S, "completed"), cfg);
  assert.deepEqual(
    words(r.out).map((t) => [t.level, t.suppressedBy]),
    [[0, "dnd"]],
  );
});

test("the agent's word is not drowned by a drift word: the person gets the tolerance again", () => {
  const cfg = withOverrides({ secondLook: false, agentQuietSec: 600, decide: stubDecide });
  const { state, out } = run(
    [
      setIntent(t0),
      ctx(t0, VIDEO, "unrelated"),
      agent(t0 + 100 * S, "working"), // already well past the tolerance
      agent(t0 + 110 * S, "completed"),
    ],
    { until: t0 + 112 * S, cfg },
  );
  const after = out.filter((o) => o.type === "trigger" && o.ts >= t0 + 110 * S);
  assert.deepEqual(
    after.map((t) => t.kind),
    ["agent"],
  );
  assert.ok(state.budgetSec < 5);
});

// Issue #37. The real policy, so the levels are what a person would get.
const WORDS = withOverrides({ secondLook: false });
const X = ["https://x.com/home", "Home / X"];
const answer37 = (ts, page, label = "unrelated") => ({
  type: "relevance",
  ts,
  key: relevanceKey(intent.id, ...page),
  label,
  confidence: 0.9,
  source: "llm",
});
const away37 = (ts, page) => ctx(ts, page, "unrelated", { browserFocused: false });
const driftWords = (triggers) =>
  triggers.filter((t) => t.kind === "drift").map((t) => [Math.round((t.ts - t0) / S), t.level]);

test("hopping: the wait on a page the person has left counts once the model says unrelated", () => {
  const inputs = [setIntent(t0), ctx(t0, VIDEO), ctx(t0 + 10 * S, X), ctx(t0 + 20 * S, REPO, "related")];
  let { state } = run(inputs, { until: t0 + 20 * S });
  assert.equal(state.budgetSec, 0, "neutral while it waits");
  ({ state } = step(state, answer37(t0 + 20 * S, VIDEO), CFG));
  ({ state } = step(state, answer37(t0 + 20 * S, X), CFG));
  assert.equal(state.budgetSec, 20);
  assert.equal(state.state, "focused", "the page in front is still work");
});

test("hopping: the word comes on the first page the model has judged off task", () => {
  const inputs = [setIntent(t0)];
  for (let i = 0; i < 6; i++) {
    const page = [`https://site${i}.example/`, `Page ${i}`];
    inputs.push(ctx(t0 + i * 10 * S, page));
    inputs.push(answer37(t0 + (i * 10 + 12) * S, page));
  }
  // Page 5 opens at +50 and stays: its answer at +62 is the first verdict on a page in front.
  const { triggers } = run(inputs, { until: t0 + 70 * S, cfg: WORDS });
  assert.deepEqual(driftWords(triggers), [[62, 1]]);
});

test("the wait counts for the page still in front, once", () => {
  const inputs = [setIntent(t0), ctx(t0, VIDEO), answer37(t0 + 5 * S, VIDEO)];
  const { state } = run(inputs, { until: t0 + 10 * S });
  assert.equal(state.budgetSec, 10);
  const again = step(state, answer37(t0 + 10 * S, VIDEO), CFG);
  assert.equal(again.state.budgetSec, 10, "a second answer adds nothing");
});

test("a wait on a page that turns out related or neutral adds nothing", () => {
  for (const label of ["related", "neutral"]) {
    const inputs = [
      setIntent(t0),
      ctx(t0, VIDEO),
      ctx(t0 + 10 * S, X, "unrelated"),
      answer37(t0 + 10 * S, VIDEO, label),
    ];
    const { state } = run(inputs, { until: t0 + 10 * S });
    assert.equal(state.budgetSec, 0, label);
  }
});

test("time away while a page waits for its answer does not count", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO),
    ctx(t0 + 5 * S, VIDEO, undefined, { browserFocused: false }),
    answer37(t0 + 60 * S, VIDEO),
  ];
  const { state } = run(inputs, { until: t0 + 60 * S });
  assert.equal(state.budgetSec, 5);
});

test("time a page waits for its answer while the agent works does not count", () => {
  const inputs = [
    setIntent(t0),
    { type: "agent", ts: t0, status: "working", session: "a" },
    ctx(t0, VIDEO),
    answer37(t0 + 10 * S, VIDEO),
  ];
  const { state } = run(inputs, { until: t0 + 10 * S });
  assert.equal(state.budgetSec, 0);
});

test("one drift: a glance at another window does not start it over", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    away37(t0 + 50 * S, VIDEO),
    ctx(t0 + 53 * S, VIDEO, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 90 * S, cfg: WORDS });
  // L1 at 45 s off task; L2 after 30 s more off task: 3 s away are not among them.
  assert.deepEqual(driftWords(triggers), [
    [45, 1],
    [78, 2],
  ]);
});

test("one drift: a new tab or other neutral page does not start it over", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    ctx(t0 + 50 * S, SEARCH, "neutral"),
    ctx(t0 + 60 * S, VIDEO, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 90 * S, cfg: WORDS });
  assert.deepEqual(driftWords(triggers), [
    [45, 1],
    [85, 2],
  ]);
});

test("one drift: coming back after a few minutes is not a word by itself", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    away37(t0 + 50 * S, VIDEO),
    ctx(t0 + 200 * S, VIDEO, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 210 * S, cfg: WORDS });
  assert.deepEqual(driftWords(triggers), [[45, 1]]);
});

test("one drift: a moment on work does not start it over", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    ctx(t0 + 50 * S, REPO, "related"),
    ctx(t0 + 52 * S, VIDEO, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 70 * S, cfg: WORDS });
  assert.deepEqual(driftWords(triggers), [[45, 1]]);
});

test("back on work long enough, the next drift is a new one and starts at L1", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    ctx(t0 + 50 * S, REPO, "related"),
    ctx(t0 + 120 * S, VIDEO, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 170 * S, cfg: WORDS });
  assert.deepEqual(driftWords(triggers), [
    [45, 1],
    [165, 1],
  ]);
});

test("a real absence ends the drift: the person is greeted, and it starts at L1", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    away37(t0 + 80 * S, VIDEO),
    ctx(t0 + 400 * S, VIDEO, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 405 * S, cfg: WORDS });
  assert.ok(triggers.some((t) => t.kind === "return"));
  assert.deepEqual(driftWords(triggers).at(-1), [400, 1]);
});

test("switching mode back and forth during a drift is no new word", () => {
  const mode = (ts, m) => ({ type: "session", ts, kind: "mode", payload: { mode: m } });
  const inputs = [setIntent(t0), ctx(t0, VIDEO, "unrelated"), mode(t0 + 50 * S, "gentle"), mode(t0 + 51 * S, "focus")];
  const { triggers } = run(inputs, { until: t0 + 60 * S, cfg: WORDS });
  assert.deepEqual(driftWords(triggers), [[45, 1]]);
});

test("the next word's wake time comes from the time still to spend off task", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    away37(t0 + 50 * S, VIDEO),
    ctx(t0 + 53 * S, VIDEO, "unrelated"),
  ];
  const { state } = run(inputs, { until: t0 + 54 * S, cfg: WORDS });
  assert.equal(nextWakeAt(state, WORDS), t0 + 78 * S);
});

test("with a short tolerance, an empty budget still ends the drift", () => {
  const short = withOverrides({ secondLook: false, toleranceSec: 3, escalateAfterSec: 5 });
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    ctx(t0 + 4 * S, REPO, "related"),
    ctx(t0 + 10 * S, VIDEO, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 14 * S, cfg: short });
  assert.deepEqual(driftWords(triggers), [
    [3, 1],
    [13, 1],
  ]);
});

test("after the last word Tuck stays quiet on that page; a new page starts over, spaced", () => {
  const onVideo = [setIntent(t0), ctx(t0, VIDEO, "unrelated")];
  const quiet = run(onVideo, { until: t0 + 300 * S, cfg: WORDS });
  assert.deepEqual(driftWords(quiet.triggers), [
    [45, 1],
    [75, 2],
    [105, 3],
  ]);
  const { triggers } = run([...onVideo, ctx(t0 + 140 * S, X, "unrelated")], { until: t0 + 230 * S, cfg: WORDS });
  // Out of words at +135 on the video. The new page starts them over, 30 s off task later,
  // and its L2 waits out the last loud word (L3 at +105).
  assert.deepEqual(driftWords(triggers).slice(3), [
    [165, 1],
    [195, 1],
    [225, 2],
  ]);
});

// From the review of #37.
test("one drift: words keep coming when off-task time is mixed with work", () => {
  // 20 s off task, 10 s on work, over and over: the budget hovers, the time off task does not.
  const inputs = [setIntent(t0), ctx(t0, VIDEO, "unrelated")];
  for (let c = 0; c < 6; c++) {
    inputs.push(ctx(t0 + (50 + c * 30) * S, REPO, "related"));
    inputs.push(ctx(t0 + (60 + c * 30) * S, VIDEO, "unrelated"));
  }
  const { triggers } = run(inputs, { until: t0 + 180 * S, cfg: WORDS });
  assert.deepEqual(
    driftWords(triggers).map(([, level]) => level),
    [1, 2, 3],
  );
});

test("one drift: work that does not end it does not push the next word further away", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    ctx(t0 + 106 * S, REPO, "related"),
    ctx(t0 + 150 * S, X, "unrelated"),
  ];
  // Words at +45, +75, +105. 44 s of work leaves the budget above the floor: the same
  // drift, so the next word needs 30 s off task, not the whole way back to the old budget.
  const { triggers } = run(inputs, { until: t0 + 185 * S, cfg: WORDS });
  assert.deepEqual(driftWords(triggers).at(-1)?.[0], 179);
});

test("coming back to a finished agent is one word: the agent's", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, REPO, "related"),
    { type: "agent", ts: t0 + S, status: "working", session: "a" },
    ctx(t0 + 2 * S, REPO, "related", { browserFocused: false }),
    { type: "agent", ts: t0 + 400 * S, status: "completed", session: "a" },
    ctx(t0 + 500 * S, REPO, "related"),
  ];
  const { triggers } = run(inputs, { until: t0 + 501 * S, cfg: WORDS });
  assert.deepEqual(
    triggers.map((t) => t.kind),
    ["agent"],
  );
});

test("a stop during a break waits for its end, and is said then", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    { type: "agent", ts: t0 + S, status: "working", session: "a" },
    { type: "response", ts: t0 + 2 * S, choice: "break" },
    { type: "agent", ts: t0 + 10 * S, status: "completed", session: "a" },
    ctx(t0 + 20 * S, VIDEO, "unrelated"),
  ];
  const during = run(inputs, { until: t0 + 60 * S, cfg: WORDS });
  assert.deepEqual(
    during.triggers.map((t) => t.kind),
    [],
    "the break is left alone",
  );
  const after = run(inputs, { until: t0 + 303 * S, cfg: WORDS });
  assert.deepEqual(
    after.triggers.map((t) => t.kind),
    ["agent"],
    "the agent's word, not a second one about the break",
  );
});

test("the same stop heard twice while away does not lose the word", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, VIDEO, "unrelated"),
    { type: "agent", ts: t0 + S, status: "working", session: "a" },
    ctx(t0 + 2 * S, VIDEO, "unrelated", { browserFocused: false }),
    { type: "agent", ts: t0 + 10 * S, status: "waiting_for_user", session: "a" },
    { type: "agent", ts: t0 + 16 * S, status: "waiting_for_user", session: "a" },
    ctx(t0 + 60 * S, VIDEO, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 61 * S, cfg: WORDS });
  assert.deepEqual(
    triggers.map((t) => t.kind),
    ["agent"],
  );
});

// Muse can ask many times on one hook (a command's stages), and no hook marks an answer,
// so while it waits Tuck asks again, by time the person spends in the browser.
const waiting = (ts) => agent(ts, "waiting_for_user");
const askedAt = (triggers) =>
  triggers.filter((t) => t.kind === "agent").map((t) => [Math.round((t.ts - t0) / S), !!t.evidence.agentAgain]);

test("while the agent waits, Tuck asks again, further and further apart", () => {
  const inputs = [setIntent(t0), ctx(t0, REPO, "related"), agent(t0, "working"), waiting(t0 + S)];
  const { triggers } = run(inputs, { until: t0 + 240 * S, cfg: WORDS });
  assert.deepEqual(askedAt(triggers), [
    [1, false],
    [31, true],
    [91, true],
    [211, true],
  ]);
});

test("Got it does not end the wait: Muse is what ends it", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, REPO, "related"),
    agent(t0, "working"),
    waiting(t0 + S),
    { type: "response", ts: t0 + 2 * S, choice: "dismiss" },
  ];
  const { triggers } = run(inputs, { until: t0 + 32 * S, cfg: WORDS });
  assert.deepEqual(askedAt(triggers).at(-1), [31, true]);
});

test("time in the terminal does not count towards asking again", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, REPO, "related"),
    agent(t0, "working"),
    waiting(t0 + S),
    ctx(t0 + 10 * S, REPO, "related", { browserFocused: false }),
    ctx(t0 + 100 * S, X, "unrelated"),
  ];
  const { triggers } = run(inputs, { until: t0 + 121 * S, cfg: WORDS });
  // 9 s before the terminal, 21 s after it.
  assert.deepEqual(askedAt(triggers).at(-1), [121, true]);
  assert.equal(askedAt(run(inputs, { until: t0 + 120 * S, cfg: WORDS }).triggers).length, 1);
});

test("the agent moving on ends the asking", () => {
  for (const status of ["working", "completed", "unknown"]) {
    const inputs = [
      setIntent(t0),
      ctx(t0, REPO, "related"),
      agent(t0, "working"),
      waiting(t0 + S),
      agent(t0 + 10 * S, status),
    ];
    const { triggers } = run(inputs, {
      until: t0 + 200 * S,
      cfg: withOverrides({ secondLook: false, agentQuietSec: 900 }),
    });
    assert.equal(askedAt(triggers).filter(([, again]) => again).length, 0, status);
  }
});

test("a finished agent is said once, with no asking again", () => {
  const inputs = [setIntent(t0), ctx(t0, REPO, "related"), agent(t0, "working"), agent(t0 + S, "completed")];
  const { triggers } = run(inputs, { until: t0 + 200 * S, cfg: WORDS });
  assert.equal(askedAt(triggers).length, 1);
});

test("no asking again on a break", () => {
  const inputs = [
    setIntent(t0),
    ctx(t0, REPO, "related"),
    agent(t0, "working"),
    waiting(t0 + S),
    { type: "response", ts: t0 + 2 * S, choice: "break" },
  ];
  const { triggers } = run(inputs, { until: t0 + 200 * S, cfg: WORDS });
  assert.equal(askedAt(triggers).filter(([, again]) => again).length, 0);
});

test("asking again leaves room: no drift word right behind it", () => {
  const inputs = [setIntent(t0), ctx(t0, VIDEO, "unrelated"), agent(t0, "working"), waiting(t0 + S)];
  const { triggers } = run(inputs, { until: t0 + 40 * S, cfg: WORDS });
  assert.deepEqual(askedAt(triggers).at(-1), [31, true]);
  assert.equal(triggers.filter((t) => t.kind === "drift").length, 0);
});

test("the wake time includes the next asking", () => {
  const inputs = [setIntent(t0), ctx(t0, REPO, "related"), agent(t0, "working"), waiting(t0 + S)];
  const { state } = run(inputs, { until: t0 + 11 * S, cfg: WORDS });
  assert.equal(nextWakeAt(state, WORDS), t0 + 31 * S);
});

// Issue #66: Muse working again means the person answered it in the terminal. The
// worker takes the waiting word down on `agent_resumed` and logs it.
const resumed = (out) => out.filter((o) => o.type === "agent_resumed");

test("Muse back at work after a wait takes the waiting word back", () => {
  const inputs = [setIntent(t0), ctx(t0, REPO, "related"), agent(t0, "working"), waiting(t0 + S)];
  const { out } = run([...inputs, agent(t0 + 5 * S, "working")], { until: t0 + 10 * S, cfg: WORDS });
  assert.deepEqual(askedAt(out.filter((o) => o.type === "trigger")), [[1, false]]);
  assert.deepEqual(resumed(out), [{ type: "agent_resumed", ts: t0 + 5 * S }]);
  // Only after a wait: starting again after a stop of another kind takes nothing back.
  for (const status of ["completed", "failed", "unknown"]) {
    const after = run([setIntent(t0), agent(t0, "working"), agent(t0 + S, status), agent(t0 + 5 * S, "working")], {
      cfg: WORDS,
    });
    assert.deepEqual(resumed(after.out), [], status);
  }
});

test("Muse finishing after a wait says it is done, in the wait's place", () => {
  const inputs = [setIntent(t0), ctx(t0, REPO, "related"), agent(t0, "working"), waiting(t0 + S)];
  const { out, triggers } = run([...inputs, agent(t0 + 5 * S, "completed")], { until: t0 + 10 * S, cfg: WORDS });
  const said = triggers.filter((t) => t.kind === "agent").map((t) => present({ trigger: t })?.bubble?.text);
  assert.deepEqual(said, ["Muse is waiting on you.", "Muse is done."]);
  assert.deepEqual(resumed(out), [], "the done word replaces it, nothing is taken back first");
});

// A page for something else the person has to do is not drift (#8).
const TAX = ["https://tax.example/form", "Tax form"];

test("a page for another commitment adds nothing to the budget and gets no word", () => {
  const inputs = [setIntent(t0), ctx(t0, VIDEO, "unrelated"), ctx(t0 + 20 * S, TAX, "other_commitment")];
  const { state, triggers } = run(inputs, { until: t0 + 200 * S, cfg: WORDS });
  assert.equal(state.budgetSec, 20, "held, as on a neutral page");
  assert.equal(state.state, "focused");
  assert.equal(triggers.length, 0);
});

test("the wait on such a page adds nothing either", () => {
  const inputs = [setIntent(t0), ctx(t0, TAX), answer37(t0 + 10 * S, TAX, "other_commitment")];
  assert.equal(run(inputs, { until: t0 + 30 * S }).state.budgetSec, 0);
});

test("another commitment is no place to go back to", () => {
  const inputs = [setIntent(t0), ctx(t0, REPO, "related"), ctx(t0 + S, TAX, "other_commitment")];
  assert.equal(run(inputs, { until: t0 + 2 * S }).state.lastRelevant.url, REPO[0]);
});

test("a second look that finds another commitment ends the detour", () => {
  const cfg = withOverrides({ decide: stubDecide });
  let r = step(initialState(), setIntent(t0), cfg);
  r = step(r.state, ctx(t0, TAX, "unrelated"), cfg);
  r = step(
    r.state,
    {
      type: "second_look",
      ts: t0 + 5 * S,
      key: relevanceKey(intent.id, ...TAX),
      label: "other_commitment",
      confidence: 0.9,
    },
    cfg,
  );
  assert.equal(r.state.state, "focused");
  assert.equal(r.state.current.label, "other_commitment");
  assert.equal(r.state.lastRelevant, null);
});

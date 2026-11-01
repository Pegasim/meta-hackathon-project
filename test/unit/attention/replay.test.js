import test from "node:test";
import assert from "node:assert/strict";
import { replay } from "../../../src/attention/replay.js";
import { DEFAULTS } from "../../../src/attention/config.js";
import { relevanceKey, hostOf } from "../../../src/attention/relevance.js";

// A hand-written log, not a recording: it pins replay's mechanics (which records
// are inputs, ticks between them). The criteria run on recorded logs in test/fixtures/.
const S = 1000;
const t0 = Date.UTC(2026, 9, 31, 10, 0);
const page = (ts, url, title, label) => ({
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
});
const log = {
  version: 1,
  events: [
    { type: "session", ts: t0, kind: "intent_set", payload: { id: "i1", title: "Fix the bug", topic: "shop" } },
    page(t0, "https://github.com/acme/shop", "cart.js", "related"),
    page(t0 + 60 * S, "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes", "unrelated"),
    // Outputs recorded by an older engine: replay recomputes them and ignores these.
    { type: "trigger", ts: t0 + 61 * S, id: "drift-old", kind: "drift", level: 3 },
    { type: "llm", ts: t0 + 61 * S, node: "classifyRelevance", ok: true },
    { type: "tick", ts: t0 + 130 * S }, // the live heartbeat, logged
    page(t0 + 200 * S, "https://github.com/acme/shop", "cart.js", "related"),
  ],
};

test("replay recomputes triggers from the logged inputs, with ticks between them", () => {
  const { triggers } = replay(log);
  assert.deepEqual(
    triggers.map((t) => [t.kind, (t.ts - t0) / S, t.level]),
    [
      ["drift", 105, 1],
      ["drift", 135, 2],
      ["drift", 165, 3],
    ],
  );
  assert.ok(!triggers.some((t) => t.id === "drift-old"));
});

test("replay takes engine settings", () => {
  const { triggers } = replay(log, { cfg: { ...DEFAULTS, toleranceSec: 100 } });
  assert.equal(triggers[0].ts, t0 + 160 * S);
});

test("replay is deterministic", () => {
  assert.deepEqual(replay(log), replay(log));
});

test("replay reports state changes too", () => {
  const { states } = replay(log);
  assert.deepEqual(
    states.map((s) => s.to),
    ["focused", "detour", "drifting", "focused"],
  );
});

test("review I3: replay does not tick through a sleep", () => {
  // 10 s on the video, then the laptop sleeps for 20 minutes.
  const sleepLog = {
    events: [
      log.events[0],
      page(t0, "https://github.com/acme/shop", "cart.js", "related"),
      page(t0 + 50 * S, "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes", "unrelated"),
      page(t0 + 20 * 60 * S, "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes", "unrelated"),
    ],
  };
  const { triggers } = replay(sleepLog);
  // The engine sees the silence as time away: coming back is a return, not a drift.
  assert.ok(
    triggers.some((t) => t.kind === "return"),
    triggers.map((t) => t.kind).join(" "),
  );
  assert.ok(
    !triggers.some((t) => t.kind === "drift" && t.ts < t0 + 20 * 60 * S),
    triggers.map((t) => `${t.kind}@${(t.ts - t0) / S}`).join(" "),
  );
});

test("issue #5: a log with second-look answers replays them", () => {
  // The same visit (the video from +60 s, so its excerpt is read ahead at +90 s), but
  // the live worker found a work chat on the page.
  const videoKey = relevanceKey("i1", "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes");
  const withLook = {
    events: [...log.events, { type: "second_look", ts: t0 + 92 * S, key: videoKey, label: "related", confidence: 0.9 }],
  };
  assert.deepEqual(replay(withLook).triggers, []);
});

test("review: a log with second-look answers still finds them when replayed with other settings", () => {
  // Live, the excerpt read ahead at +90 s showed work. Replayed with tolerance 60 s the
  // read-ahead comes at +105 s; the recorded verdict (15 s earlier) still applies.
  const videoKey = relevanceKey("i1", "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes");
  const withLook = {
    events: [...log.events, { type: "second_look", ts: t0 + 92 * S, key: videoKey, label: "related", confidence: 0.9 }],
  };
  assert.deepEqual(replay(withLook, { cfg: { ...DEFAULTS, toleranceSec: 60 } }).triggers, []);
});

test("review: recorded typing holds the word in replay, as it did live", () => {
  const videoKey = relevanceKey("i1", "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes");
  const typed = (ts) => ({ type: "second_look", ts, key: videoKey, composing: true });
  // Live: typing at the word (+106 s), and again when the hold ended (+227 s).
  const withTyping = { events: [...log.events, typed(t0 + 106 * S), typed(t0 + 227 * S)] };
  const { triggers } = replay(withTyping);
  assert.ok(!triggers.some((t) => t.kind === "drift" && t.ts < t0 + 200 * S), "held while typing");
});

test("a replay sees the surface logged on the context input", () => {
  const surface = { kind: "conversation", labels: ["Ali Demir"] };
  const chat = page(t0 + 60 * S, "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes", "unrelated");
  const tick = { type: "tick", ts: t0 + 130 * S }; // replay fills in ticks only up to the last input
  const { triggers } = replay({ version: 1, events: [log.events[0], log.events[1], { ...chat, surface }, tick] });
  assert.deepEqual(triggers[0].evidence.surface, surface);
});

test("a replay sees the agent's status", () => {
  const events = [
    log.events[0],
    { type: "agent", ts: t0, status: "working", session: "s" },
    page(t0, "https://www.youtube.com/watch?v=a", "Top 10 F1 crashes", "unrelated"),
    { type: "tick", ts: t0 + 130 * S },
  ];
  assert.equal(replay({ version: 1, events }).triggers.length, 0);
});

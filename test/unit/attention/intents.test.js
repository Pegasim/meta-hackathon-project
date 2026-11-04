import test from "node:test";
import assert from "node:assert/strict";
import { dayKey, makeIntent, isExpired, syncFocus, focusMinutes, stepDone } from "../../../src/attention/intents.js";
import { DEFAULTS } from "../../../src/attention/config.js";

const IST = -180; // Istanbul, UTC+3, as getTimezoneOffset() reports it
const H = 3600 * 1000;
const at = (iso) => Date.parse(iso); // UTC instants
const created = at("2026-10-31T20:00:00Z"); // 23:00 in Istanbul

test("the day turns at 04:00 local time", () => {
  assert.equal(dayKey(at("2026-11-01T00:30:00Z"), DEFAULTS, IST), "2026-10-31"); // 03:30 local
  assert.equal(dayKey(at("2026-11-01T01:01:00Z"), DEFAULTS, IST), "2026-11-01"); // 04:01 local
});

test("a goal from late last night is still active before 04:00", () => {
  const intent = makeIntent({ title: "Edit the demo video" }, created);
  const now = at("2026-11-01T00:30:00Z");
  assert.equal(isExpired(intent, now, now, DEFAULTS, IST), false);
});

test("a goal expires on the first focus of a new day", () => {
  const intent = makeIntent({ title: "Edit the demo video" }, created);
  const now = at("2026-11-01T01:01:00Z");
  assert.equal(isExpired(intent, now, now, DEFAULTS, IST), true);
});

test("a goal expires after six hours away", () => {
  const intent = makeIntent({ title: "Edit the demo video" }, at("2026-11-01T06:00:00Z"));
  const now = at("2026-11-01T13:00:00Z");
  assert.equal(isExpired(intent, now, now - 7 * H, DEFAULTS, IST), true);
  assert.equal(isExpired(intent, now, now - 5 * H, DEFAULTS, IST), false);
});

test("makeIntent fills the shadow record", () => {
  const intent = makeIntent({ title: "Edit the demo video", steps: ["Cut the intro"] }, created, "id-1");
  assert.deepEqual(intent, {
    id: "id-1",
    title: "Edit the demo video",
    steps: ["Cut the intro"],
    estMin: null,
    topic: "edit-the-demo-video",
    createdAt: created,
    doneAt: null,
    expiredAt: null,
    memoryEntryId: null,
    fromLoopId: null,
    focusMs: 0,
    focusSince: null,
    stepIndex: 0,
  });
  assert.equal(
    makeIntent({ title: "SUT kural motorundaki kırık testleri düzelt" }, created).topic,
    "sut-kural-motorundaki-kirik-testleri-duz",
  );
  assert.equal(typeof makeIntent({ title: "x y z" }, created).id, "string");
});

test("focus time counts only while active", () => {
  let i = makeIntent({ title: "Fix the cart" }, 0);
  i = syncFocus(i, true, 1000);
  i = syncFocus(i, false, 1000 + 10 * 60e3);
  i = syncFocus(i, false, 1000 + 15 * 60e3);
  i = syncFocus(i, true, 1000 + 20 * 60e3);
  assert.equal(focusMinutes(i, 1000 + 28 * 60e3), 18);
});

test("syncFocus returns the same intent when nothing flips; an old intent reads as 0", () => {
  const i = syncFocus(makeIntent({ title: "Fix the cart" }, 0), true, 5);
  assert.equal(syncFocus(i, true, 99), i);
  assert.equal(focusMinutes({ title: "old" }, 1e9), 0);
});

test("stepDone moves to the next plan step; the last step and no plan stay", () => {
  const i = {
    ...makeIntent({ title: "Deck", steps: ["A"] }, 0),
    plan: { steps: [{ step: "A" }, { step: "B" }, { step: "C" }] },
  };
  const n = stepDone(i);
  assert.equal(n.stepIndex, 1);
  assert.deepEqual(n.steps, ["B"]);
  assert.equal(stepDone({ ...n, stepIndex: 2 }).stepIndex, 2);
  const none = makeIntent({ title: "No plan" }, 0);
  assert.equal(stepDone(none), none);
});

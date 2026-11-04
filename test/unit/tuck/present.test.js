import test from "node:test";
import assert from "node:assert/strict";
import { present, nudgeText, comesWhileAway } from "../../../src/tuck/present.js";

const evidence = {
  url: "https://www.youtube.com/watch?v=a",
  host: "youtube.com",
  title: "Top 10 F1 crashes",
  dwellSec: 0,
  awaySec: 52,
  lastRelevant: { url: "https://github.com/acme/shop", title: "cart.js · acme/shop" },
};
const trigger = (kind, level) => ({
  type: "trigger",
  id: `${kind}-1`,
  kind,
  level,
  evidence,
  intentTitle: "Fix the bug",
  intentStep: "Write the failing test",
});

test("L1 drift speaks right away: the drift pose with the message and the answers", () => {
  const v = present({ trigger: trigger("drift", 1) });
  assert.equal(v.pose, "drift");
  assert.equal(v.bubble.kind, "nudge");
  assert.equal(v.bubble.text, "Still on YouTube? Next up: write the failing test.");
  assert.deepEqual(
    v.bubble.buttons.map((b) => b.choice),
    ["back", "related", "break"],
  );
  assert.equal(v.triggerId, "drift-1");
});

test("on a page the model is unsure about, L1 asks instead", () => {
  const unsure = { ...trigger("drift", 1), evidence: { ...evidence, unsure: true } };
  const v = present({ trigger: unsure });
  assert.equal(v.pose, "drift");
  assert.equal(v.bubble.text, "Is this page part of your task?");
  assert.deepEqual(
    v.bubble.buttons.map((b) => [b.choice, b.label]),
    [
      ["related", "Yes, it's for my task"],
      ["back", "No, take me back"],
    ],
  );
});

test("L2 and L3 drift: the drift pose, with the message and the three answers", () => {
  for (const level of [2, 3]) {
    const v = present({ trigger: trigger("drift", level) });
    assert.equal(v.pose, "drift");
    assert.equal(v.bubble.kind, "nudge");
    assert.equal(v.bubble.text, "Still on YouTube. Want to get back to it?");
    assert.deepEqual(
      v.bubble.buttons.map((b) => b.choice),
      ["back", "related", "break"],
    );
    assert.equal(v.bubble.dismissable, true);
  }
});

test("fragmentation at L2 is a nudge too", () => {
  const v = present({ trigger: trigger("fragmentation", 2) });
  assert.equal(v.pose, "drift");
  assert.equal(v.bubble.text, "These tabs don't look like your task. Want to pick one thing?");
});

test("return and break_over: hello, with a nudge", () => {
  const r = present({ trigger: trigger("return", 2) });
  assert.equal(r.pose, "hello");
  assert.equal(r.bubble.text, "Welcome back. Next up: write the failing test.");
  assert.deepEqual(
    r.bubble.buttons.map((b) => b.choice),
    ["back"],
  );
  const b = present({ trigger: trigger("break_over", 2) });
  assert.equal(b.pose, "hello");
  assert.equal(b.bubble.text, "Break's over. Ready to get back to it?");
});

test("session_start: hello with the goal form and up to two things to pick up", () => {
  const v = present({
    trigger: trigger("session_start", 2),
    loops: [{ title: "Edit the demo video" }, { title: "Write the README" }, { title: "Third" }],
  });
  assert.equal(v.pose, "hello");
  assert.equal(v.bubble.kind, "goal");
  assert.equal(v.bubble.text, "Hi. What are we working on today?");
  assert.deepEqual(v.bubble.pickUp, ["Edit the demo video", "Write the README"]);
});

test("after Done: what's next, with the goal form", () => {
  const v = present({ event: "goal_done" });
  assert.equal(v.pose, "hello");
  assert.equal(v.bubble.kind, "goal");
  assert.equal(v.bubble.text, "Nice work. What's next?");
});

test("goal set, nudge resolved and Take me back: happy, then Tuck rests on the page", () => {
  assert.deepEqual(present({ event: "goal_set" }), {
    pose: "happy",
    settle: "rest",
    bubble: { kind: "note", text: "Got it. Let's go." },
    closeBubbleAfterMs: 2000,
  });
  assert.deepEqual(present({ event: "resolved" }), { pose: "happy", settle: "rest", bubble: null });
  assert.deepEqual(present({ event: "back" }), { pose: "happy", settle: "rest", bubble: null });
});

test("tucked away from the card, Tuck says how to bring it back, then leaves", () => {
  const v = present({ event: "away" });
  assert.deepEqual(v, {
    pose: "hello",
    bubble: { kind: "note", text: "Okay. Click the toolbar icon to bring me back." },
    leaveAfterMs: 2500,
  });
  // Tuck's voice: at most 12 words, no exclamation marks, no buttons.
  assert.ok(v.bubble.text.split(/\s+/).length <= 12);
  assert.doesNotMatch(v.bubble.text, /!/);
  assert.equal(v.bubble.buttons, undefined);
});

test("while the coding agent works, a happy hop settles to work, not rest", () => {
  for (const event of ["goal_set", "resolved", "back"])
    assert.equal(present({ event, agent: "working" }).settle, "work", event);
  assert.equal(present({ event: "resolved", agent: "waiting_for_user" }).settle, "rest");
});

test("on any page with a goal, Tuck rests quietly, or works while the agent does", () => {
  assert.deepEqual(present({ event: "presence", agent: "working" }), { pose: "work", bubble: null, quiet: true });
  for (const agent of [null, undefined, "unknown", "waiting_for_user"])
    assert.deepEqual(present({ event: "presence", agent }), { pose: "rest", bubble: null, quiet: true });
});

test("on a break, Tuck sleeps on the page quietly", () => {
  assert.deepEqual(present({ event: "break" }), { pose: "sleep", bubble: null, quiet: true });
});

test("clicking Tuck with no nudge: hello and the goal card", () => {
  const v = present({ event: "card", intent: { title: "Fix the bug", steps: ["Write the failing test"] } });
  assert.equal(v.pose, "hello");
  assert.deepEqual(v.bubble, { kind: "card", text: "Fix the bug", next: "Write the failing test" });
});

test("clicking Tuck with no goal opens the goal form", () => {
  const v = present({ event: "card", intent: null });
  assert.equal(v.pose, "hello");
  assert.equal(v.bubble.kind, "goal");
});

test("level 0 (do not disturb) and session_start without loops", () => {
  assert.equal(present({ trigger: trigger("drift", 0) }), null);
  assert.deepEqual(present({ trigger: trigger("session_start", 2) }).bubble.pickUp, []);
});

test("the model's line is used when it is ready", () => {
  const v = present({ trigger: { ...trigger("drift", 2), message: "That's 5 minutes on YouTube. Back to the test?" } });
  assert.equal(v.bubble.text, "That's 5 minutes on YouTube. Back to the test?");
  assert.equal(nudgeText({ ...trigger("drift", 1), message: "Back to the test?" }), "Back to the test?");
});

test("minutes away come from awaySec, never seconds", () => {
  const long = { ...trigger("drift", 2), evidence: { ...evidence, awaySec: 330 } };
  assert.equal(nudgeText(long), "That's 6 minutes away from work. Next up: write the failing test.");
});

test("the agent stopping is one short line, with answers that fit it", () => {
  for (const [status, line] of [
    ["waiting_for_user", "Muse is waiting on you."],
    ["completed", "Muse is done."],
    ["failed", "Muse stopped on an error."],
  ]) {
    const v = present({ trigger: { id: "a", kind: "agent", level: 2, evidence: { agent: status } } });
    assert.equal(v.pose, "wait");
    assert.equal(v.bubble.text, line);
    assert.deepEqual(
      v.bubble.buttons.map((b) => b.choice),
      ["dismiss", "break"],
    );
  }
});

test("asking again about the agent is a question: it may be running what was approved", () => {
  const trigger = { id: "a", kind: "agent", level: 2, evidence: { agent: "waiting_for_user", agentAgain: true } };
  assert.equal(present({ trigger }).bubble.text, "Is Muse still waiting on you?");
  assert.deepEqual(
    present({ trigger }).bubble.buttons.map((b) => b.label),
    ["Got it", "5-min break"],
  );
});

test("while Tuck is away only a drift, fragmentation, agent word or the session start comes", () => {
  for (const kind of ["drift", "fragmentation", "agent", "session_start"])
    assert.equal(comesWhileAway(kind), true, kind);
  for (const kind of ["return", "break_over", "checkin"]) assert.equal(comesWhileAway(kind), false, kind);
});

test("a turn that ended on a question says Muse is done, not that it is still waiting", () => {
  const trigger = { id: "a", kind: "agent", level: 1, evidence: { agent: "waiting_for_user", agentDone: true } };
  assert.equal(present({ trigger }).bubble.text, "Muse is done and asked you something.");
});

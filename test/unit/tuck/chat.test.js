import test from "node:test";
import assert from "node:assert/strict";
import {
  menuView,
  trailLine,
  newThread,
  say,
  tuckSays,
  pending,
  addTrail,
  resolve,
  toStep,
  dropPending,
  setupView,
  needsKey,
  SETUP_ASK,
  SETUP_BAD,
  SETUP_THANKS,
  notesThread,
  NOTES_ASK,
  NOTES_SKIPPED,
  THINKING,
  chatView,
  OPENER,
  LOOKING,
  PLANNING,
  STEP_OPENER,
} from "../../../src/tuck/chat.js";
import { followsVoice } from "../../../src/tuck/voice.js";

test("the row with a goal: one step, dots, focus minutes", () => {
  const intent = {
    title: "Fix the checkout bug",
    steps: ["Write the failing test"],
    stepIndex: 1,
    focusMs: 18 * 60e3,
    focusSince: null,
    plan: { steps: [{ step: "Repro" }, { step: "Write the failing test" }, { step: "Guard" }, { step: "Review" }] },
  };
  const v = menuView({ intent, now: 0 });
  assert.equal(v.pose, "hello");
  assert.deepEqual(v.bubble.goal, {
    title: "Fix the checkout bug",
    now: "Write the failing test",
    dots: { done: 1, total: 4 },
    focusMin: 18,
    canStep: true,
  });
  assert.deepEqual(v.bubble.actions, ["chat", "stuck", "break", "done", "away"]);
});

test("on the plan's last step there is no Step done", () => {
  const intent = { title: "Deck", steps: ["B"], stepIndex: 1, plan: { steps: [{ step: "A" }, { step: "B" }] } };
  assert.equal(menuView({ intent, now: 0 }).bubble.goal.canStep, false);
});

test("no plan: no dots and no Step done; no goal: chat and away only", () => {
  const g = menuView({ intent: { title: "Fix the cart", steps: [] }, now: 0 }).bubble.goal;
  assert.equal(g.dots, null);
  assert.equal(g.canStep, false);
  assert.equal(g.now, null);
  assert.deepEqual(menuView({ intent: null, now: 0 }).bubble, { kind: "menu", goal: null, actions: ["chat", "away"] });
});

test("trail lines say what Tuck looked at, never note text", () => {
  assert.equal(
    trailLine({ tool: "recall_notes", args: { query: "checkout" }, result: "3 notes" }),
    "Searched your notes: checkout · 3 notes",
  );
  assert.equal(trailLine({ tool: "list_tasks", args: {}, result: "4 tasks" }), "Checked your tasks · 4 tasks");
  assert.equal(
    trailLine({ tool: "recent_activity", args: {}, result: "5 pages" }),
    "Looked at your recent pages · 5 pages",
  );
  assert.equal(
    trailLine({ tool: "look_at_page", args: {}, result: "read 900 characters" }),
    "Read your last work page",
  );
  assert.equal(trailLine({ tool: "goal", args: {}, result: "the goal" }), null);
  assert.equal(
    trailLine({ tool: "github_status", args: { repo: "acme/shop" }, result: "2 items" }),
    "Checked GitHub: acme/shop",
  );
  assert.equal(trailLine({ tool: "propose_goal", args: {} }), null, "finishing tools add no line");
  assert.equal(
    trailLine({ tool: "recall_notes", args: { query: "x" }, result: "error: offline" }),
    null,
    "failed lookups add no line",
  );
});

test("a pending reply collects trail lines and resolves in place", () => {
  let t = newThread({ intent: null, opener: OPENER, chips: ["Send the grant form"] });
  assert.equal(t.mode, "goal");
  assert.equal(t.messages[0].chips[0], "Send the grant form");
  t = pending(say(t, "the investor deck"), LOOKING);
  t = addTrail(t, "Searched your notes: investor deck · 2 notes");
  t = resolve(t, { from: "tuck", text: "Finish slides 6 to 9 of the investor deck?" });
  assert.deepEqual(
    t.messages.map((m) => m.from),
    ["tuck", "me", "tuck"],
  );
  assert.deepEqual(t.messages[2].trail, ["Searched your notes: investor deck · 2 notes"]);
  assert.equal(t.messages[2].pending, undefined);
  const v = chatView(t);
  assert.equal(v.bubble.kind, "chat");
  assert.equal(v.bubble.field.name, "goal");
  assert.equal(v.update, true);
});

test("with a goal, the thread is a step thread titled by the goal", () => {
  const t = tuckSays(newThread({ intent: { title: "Fix the cart" }, opener: STEP_OPENER }), {
    from: "tuck",
    text: "Got it.",
  });
  assert.equal(t.mode, "step");
  assert.equal(chatView(t).bubble.title, "Fix the cart");
  assert.equal(chatView(t).bubble.field.name, "say");
});

test("the thread keeps the last 12 messages", () => {
  let t = newThread({ intent: null, opener: OPENER });
  for (let i = 0; i < 20; i++) t = say(t, `line ${i}`);
  assert.equal(t.messages.length, 12);
  assert.equal(t.messages.at(-1).text, "line 19");
});

test("every fixed line in the chat follows Tuck's voice", () => {
  for (const line of [OPENER, LOOKING, PLANNING, STEP_OPENER]) assert.ok(followsVoice(line), line);
});

test("only the newest message offers buttons and chips: an answered one is just words", () => {
  let t = newThread({ intent: null, opener: OPENER, chips: ["Send the grant form"] });
  t = say(t, "the investor deck");
  assert.equal(t.messages[0].chips, undefined, "the chips go once the person answers");
  t = resolve(pending(t, LOOKING), { text: "Finish slides 6 to 9?", buttons: [{ label: "Set as goal" }] });
  t = tuckSays(toStep(t, { title: "Finish slides 6 to 9" }), { text: "Got it." });
  assert.equal(t.messages.at(-2).buttons, undefined, "the proposal's buttons go once the goal is set");
  assert.equal(t.messages.at(-2).text, "Finish slides 6 to 9?");
});

test("a pending line with nothing to say goes away, its lookups with it", () => {
  let t = pending(say(newThread({ intent: null, opener: OPENER }), "the deck"), PLANNING);
  t = dropPending(addTrail(t, "Searched your notes: deck · 0 notes"));
  assert.deepEqual(
    t.messages.map((m) => m.from),
    ["tuck", "me"],
  );
  assert.equal(dropPending(t), t, "nothing pending: unchanged");
});

test("Tuck's first question is a small bubble; the chat opens once there is more than the question", () => {
  const t = newThread({ intent: null, opener: OPENER, chips: ["Send the grant form"] });
  assert.equal(chatView(t).bubble.compact, true, "only Tuck's question: a small bubble");
  assert.equal(chatView({ ...t, expanded: true }).bubble.compact, false, "opened from the row: the chat");
  assert.equal(chatView(say(t, "the deck")).bubble.compact, false, "the person answered: the chat");
});

test("with no API key, Tuck asks for one first, in a small bubble; a bad key says so", () => {
  const v = setupView();
  assert.equal(v.bubble.kind, "setup");
  assert.equal(v.bubble.text, SETUP_ASK);
  assert.equal(v.bubble.error, null);
  assert.equal(setupView({ error: true }).bubble.error, SETUP_BAD);
  for (const line of [SETUP_ASK, SETUP_BAD, SETUP_THANKS]) assert.ok(followsVoice(line), line);
});

test("needsKey: no key needs one, except Ollama", () => {
  assert.equal(needsKey(undefined), true);
  assert.equal(needsKey({ provider: "meta", apiKey: "" }), true);
  assert.equal(needsKey({ provider: "meta", apiKey: "k" }), false);
  assert.equal(needsKey({ provider: "ollama" }), false);
});

test("after the key, Tuck asks about notes once: a folder, a chat history, or skip", () => {
  const t = notesThread();
  assert.equal(t.messages[0].text, NOTES_ASK);
  assert.deepEqual(
    t.messages[0].chips.map((c) => c.msg),
    [
      { type: "notes-choice", choice: "brain" },
      { type: "notes-choice", choice: "export" },
      { type: "notes-choice", choice: "skip" },
    ],
  );
  assert.equal(chatView(t).bubble.compact, true);
  for (const line of [NOTES_ASK, NOTES_SKIPPED, THINKING]) assert.ok(followsVoice(line), line);
});


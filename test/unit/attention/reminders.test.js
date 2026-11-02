import test from "node:test";
import assert from "node:assert/strict";
import {
  pickReminder,
  sayable,
  stillOpen,
  markSaid,
  markDone,
  markNotTask,
  taskList,
} from "../../../src/attention/reminders.js";

const today = "2026-11-02";
const task = (id, daysLeft, title = id) => ({ id, title, daysLeft, due: daysLeft == null ? null : "x" });
const queue = [task("exam", 0), task("visa", 1), task("old", -30), task("undated", null), task("far", 9)];

test("the most urgent close task, not the goal the person is on", () => {
  assert.equal(pickReminder(queue, { today }).id, "exam");
  assert.equal(pickReminder(queue, { today, goalTitle: "exam" }).id, "visa");
});

test("only what is close: not far off, undated or long missed", () => {
  const rest = [task("old", -30), task("undated", null), task("far", 9)];
  assert.equal(pickReminder(rest, { today }), null);
  assert.equal(pickReminder([task("missed", -7)], { today }).id, "missed");
});

test("once a day: said today waits until tomorrow, for reminders and drift lines alike", () => {
  const loops = markSaid({}, "exam", today);
  assert.equal(pickReminder(queue, { today, loops }).id, "visa");
  assert.ok(!sayable(queue, loops, today).some((e) => e.id === "exam"));
  assert.equal(pickReminder(queue, { today: "2026-11-03", loops }).id, "exam");
});

test("done stays done, also in the Pick up list, and keeps what was said", () => {
  const loops = markDone(markSaid({}, "exam", today), "exam", 1);
  assert.deepEqual(loops.exam, { saidOn: today, doneAt: 1 });
  assert.equal(pickReminder(queue, { today: "2026-11-09", loops }).id, "visa");
  assert.ok(!stillOpen(queue, loops).some((e) => e.id === "exam"));
});

test("an entry with no id cannot be remembered, so it is not raised", () => {
  assert.equal(pickReminder([{ title: "x", daysLeft: 0 }], { today }), null);
});

test("Not a task leaves the list and the reminders, like Done", () => {
  const loops = markNotTask({}, "exam", 1);
  assert.ok(!stillOpen(queue, loops).some((e) => e.id === "exam"));
  assert.equal(pickReminder(queue, { today, loops }).id, "visa");
});

test("the to-do list keeps memory's order and the node's titles, and leaves out the rest", () => {
  const verdicts = {
    exam: { isTask: true, open: true, task: "Revise chapter 3", who: null, personal: false },
    visa: { isTask: true, open: false, task: "Post the papers", personal: false },
    old: { isTask: false, open: true, task: "", personal: false },
  };
  const list = taskList(queue, { verdicts });
  assert.deepEqual(
    list.map((e) => e.id),
    ["exam", "undated", "far"],
    "closed and no-task entries out; unread ones in, in place",
  );
  assert.equal(list[0].title, "Revise chapter 3");
  assert.equal(list[1].title, "undated", "not read yet: its own title");
  assert.equal(list[0].daysLeft, 0, "the deadline stays memory's");
});

test("personal topics can be hidden, by the node's word or, unread, by the topic", () => {
  const q = [
    { id: "a", title: "a", topic: "shop" },
    { id: "b", title: "b", topic: "work" },
    { id: "c", title: "c", topic: "health" },
    { id: "d", title: "d", topic: "health-checks" },
    { id: "e", title: "e", topic: "healthcare-app" },
  ];
  const verdicts = { b: { isTask: true, open: true, task: "b", personal: true } };
  assert.equal(taskList(q, { verdicts }).length, 5, "off by default");
  assert.deepEqual(
    taskList(q, { verdicts, hidePersonal: true }).map((e) => e.id),
    ["a", "e"],
  );
});

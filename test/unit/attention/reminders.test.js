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
  pairKey,
  markAll,
  splitRow,
  splitTasks,
  park,
  nextParked,
  unpark,
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

// ---- One commitment, one row (#47) -------------------------------------------------

const loop = (id, fields = {}) => ({
  id,
  title: id,
  topic: "trip",
  date: "2026-10-20",
  due: null,
  daysLeft: null,
  ...fields,
});
const yes = (task) => ({ isTask: true, open: true, task, who: null, personal: false });

test("entries the node found to be one commitment are one row: newest title, earliest deadline, sources", () => {
  const q = [
    loop("ticket-md", { origin: "md:Vault", due: "2026-11-10", daysLeft: 7, date: "2026-10-18" }),
    loop("other", { due: "2026-11-12", daysLeft: 9 }),
    loop("ticket-new", { origin: "brain", path: "notes/log/a.md", date: "2026-10-28" }),
    loop("ticket-old", { path: "notes/log/b.md", date: "2026-10-21" }),
  ];
  const verdicts = {
    "ticket-new": yes("Buy the train tickets to Lyon"),
    "ticket-old": yes("Book the Lyon train"),
    other: yes("Pack"),
  };
  const pairs = {
    [pairKey("ticket-md", "ticket-new")]: { same: true },
    [pairKey("ticket-new", "ticket-old")]: { same: true },
  };
  const list = taskList(q, { verdicts, pairs });
  assert.deepEqual(
    list.map((e) => e.id),
    ["ticket-new", "other"],
    "one row, where its first member stood in memory's order",
  );
  const row = list[0];
  assert.equal(row.title, "Buy the train tickets to Lyon", "the newest member's words");
  assert.equal(row.due, "2026-11-10", "the earliest deadline");
  assert.equal(row.daysLeft, 7);
  assert.deepEqual(row.members.sort(), ["ticket-md", "ticket-new", "ticket-old"]);
  assert.equal(row.sources, "brain ×2, Vault");
  assert.equal(list[1].members, undefined, "a single entry is left as it was");
});

test("a pair the node called different, or the person split, is never merged, even through a third", () => {
  const q = [loop("a"), loop("b"), loop("c")];
  const verdicts = { a: yes("A"), b: yes("B"), c: yes("C") };
  const chain = { [pairKey("a", "b")]: { same: true }, [pairKey("b", "c")]: { same: true } };
  assert.equal(taskList(q, { verdicts, pairs: chain }).length, 1, "a chain of same pairs is one row");
  const conflict = { ...chain, [pairKey("a", "c")]: { same: false } };
  assert.equal(taskList(q, { verdicts, pairs: conflict }).length, 2, "a and c are not one task");
  const splits = { [pairKey("a", "b")]: 1 };
  assert.deepEqual(
    taskList(q, { verdicts, pairs: chain, splits }).map((e) => e.members ?? [e.id]),
    [["a"], ["b", "c"]],
    "Not the same is kept per pair",
  );
});

test("a member already marked Done or Not a task stays out of the row, and the rest still show", () => {
  const q = [loop("a", { date: "2026-10-28" }), loop("b")];
  const verdicts = { a: yes("A"), b: yes("B") };
  const pairs = { [pairKey("a", "b")]: { same: true } };
  const list = taskList(q, { verdicts, pairs, loops: markDone({}, "a", 1) });
  assert.deepEqual(
    list.map((e) => e.id),
    ["b"],
  );
  assert.equal(list[0].members, undefined);
});

test("Done and Not a task on a row mark every member", () => {
  const row = { id: "a", members: ["a", "b"] };
  const done = markAll(markDone, {}, row, 5);
  assert.deepEqual(Object.keys(done).sort(), ["a", "b"]);
  assert.equal(done.b.doneAt, 5);
  assert.ok(stillOpen([loop("a"), loop("b")], markAll(markNotTask, {}, row, 6)).length === 0);
  assert.deepEqual(Object.keys(markAll(markDone, {}, { id: "c" }, 1)), ["c"], "a single row marks itself");
});

test("Not the same splits every pair in the row", () => {
  const splits = splitRow({}, { id: "a", members: ["a", "b", "c"] }, 9);
  assert.deepEqual(Object.keys(splits).sort(), [pairKey("a", "b"), pairKey("a", "c"), pairKey("b", "c")].sort());
  assert.equal(pairKey("b", "a"), pairKey("a", "b"), "a pair is the same both ways");
});

test("Settings splits the list into Today, Coming up and the rest (#77)", () => {
  const list = [
    task("missed", -3),
    task("long-missed", -9),
    task("today", 0),
    task("tomorrow", 1),
    task("later", 20),
    task("soon", 3),
    task("far", 61),
    task("undated", null),
    { ...task("goal", 30), members: ["goal", "goal-note"] },
  ];
  const ids = (rows) => rows.map((e) => e.id);
  const { today, comingUp, rest } = splitTasks(list, { goalFrom: "goal-note" });
  assert.deepEqual(ids(today), ["goal", "missed", "today", "tomorrow"], "the goal's row first, then what is close");
  assert.deepEqual(ids(comingUp), ["soon", "later"], "dated after tomorrow, within 60 days, soonest first");
  assert.deepEqual(ids(rest), ["long-missed", "far", "undated"], "the rest keeps the list's order");
  assert.deepEqual(ids(splitTasks(list).today), ["missed", "today", "tomorrow"], "no goal, no goal row");
  assert.deepEqual(ids(splitTasks(list).comingUp), ["soon", "later", "goal"]);
});

test("Today holds at most 5 rows; what does not fit stays in the list, not lost", () => {
  const close = ["a", "b", "c", "d", "e", "f"].map((id, i) => task(id, i % 2));
  const { today, comingUp, rest } = splitTasks([...close, task("goal", null)], { goalFrom: "goal" });
  assert.deepEqual(
    today.map((e) => e.id),
    ["goal", "a", "b", "c", "d"],
  );
  assert.deepEqual(comingUp, []);
  assert.deepEqual(
    rest.map((e) => e.id),
    ["e", "f"],
  );
});

test("a parked thought is named oldest first, once: named, it leaves the list (#59)", () => {
  const parked = park(park([], { id: "a", text: "Check the bank app" }, 1), { id: "b", text: "Reply to Ali" }, 2);
  assert.deepEqual(nextParked(parked), { id: "a", text: "Check the bank app", at: 1 });
  const after = unpark(parked, "a");
  assert.equal(nextParked(after).id, "b");
  assert.equal(nextParked(unpark(after, "b")), null);
  assert.equal(nextParked(), null);
});

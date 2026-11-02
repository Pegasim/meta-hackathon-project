import test from "node:test";
import assert from "node:assert/strict";
import { deadlinesIn, dueOf, daysLeft, dueLabel, localDate } from "../../../src/memory/due.js";

// Wording taken from real entries in the brain this reads.
const bootcamp = {
  kind: "todo",
  topic: "bilun",
  title: "Fikir Doğrulama Odaklı Bootcamp (Teknopark İzmir) application due 2026-11-09",
  date: "2026-10-30",
  context: "Safa pasted the bootcamp announcement and application form on 2026-10-26.",
  result: "Bootcamp application deadline is 2026-11-09. The program runs 2026-11-13 to 2027-01-05.",
  next: "Fill in the form after the Meta hackathon submission.",
};

test("finds a deadline when a cue sits beside the date", () => {
  assert.deepEqual(deadlinesIn("application due 2026-11-09"), ["2026-11-09"]);
  assert.deepEqual(deadlinesIn("Son başvuru tarihi 2026-11-01"), ["2026-11-01"]);
});

test("a bare date is not a deadline", () => {
  assert.deepEqual(deadlinesIn("On 2026-10-26 Safa and İrem discussed the companion."), []);
  assert.equal(dueOf({ date: "2026-10-26", context: "Discussed on 2026-10-28 and again on 2026-10-29." }), null);
});

test("reads the deadline out of a real entry, not the dates around it", () => {
  assert.equal(dueOf(bootcamp), "2026-11-09");
});

test("a date the entry mentions as already past is not a deadline", () => {
  assert.equal(dueOf({ date: "2026-11-01", result: "The deadline was 2026-10-15 and we missed it." }), null);
});

test("the earliest cued deadline wins", () => {
  const e = { date: "2026-11-01", result: "deadline 2026-12-01", next: "deadline 2026-11-05" };
  assert.equal(dueOf(e), "2026-11-05");
});

test("counts whole days, and names them the way Tuck would say it", () => {
  assert.equal(daysLeft("2026-11-09", "2026-11-01"), 8);
  assert.equal(daysLeft("2026-11-01", "2026-11-01"), 0);
  assert.equal(daysLeft("2026-10-30", "2026-11-01"), -2);
  assert.equal(daysLeft(null, "2026-11-01"), null);

  assert.equal(dueLabel(0), "today");
  assert.equal(dueLabel(1), "tomorrow");
  assert.equal(dueLabel(8), "in 8 days");
  assert.equal(dueLabel(-2), "2 days ago");
  assert.equal(dueLabel(null), null);
});

test("a cue does not reach across another date", () => {
  // The programme's own start and end dates sit next to the word "deadline"; only
  // the date the word actually introduces is the deadline.
  const text = "Program runs 2026-11-13 to 2027-01-05; application deadline is 2026-12-01.";
  assert.deepEqual(deadlinesIn(text), ["2026-12-01"]);
  assert.equal(dueOf({ date: "2026-10-30", result: text }), "2026-12-01");
});

test("the local day is used, not UTC", () => {
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test("reads Obsidian's due date and Dataview due fields", () => {
  assert.deepEqual(deadlinesIn("Pay the invoice 📅 2026-11-10 ⏫"), ["2026-11-10"]);
  assert.deepEqual(deadlinesIn("Send the budget due:: 2026-11-20"), ["2026-11-20"]);
  assert.deepEqual(deadlinesIn("Review the PR [due:: 2026-11-12]"), ["2026-11-12"]);
});

test("📅 counts only right before its date: scheduled and done dates are not deadlines", () => {
  assert.deepEqual(deadlinesIn("⏳ 2026-11-05 📅 2026-11-15"), ["2026-11-15"]);
  assert.deepEqual(deadlinesIn("📅 2026-11-15 ✅ 2026-11-01"), ["2026-11-15"]);
  assert.deepEqual(deadlinesIn("🛫 2026-11-03"), []);
});

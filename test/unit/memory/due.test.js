import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadBrain } from "../../../src/memory/brain.js";
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

// #96: dates as people write them. The note's own day is 2026-10-30 unless a test says so.
const FROM = "2026-10-30";

test("reads day and month in English and Turkish, with and without a year", () => {
  assert.deepEqual(deadlinesIn("applications close 8 Nov", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("due Nov 8", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("due November 8th, 2026", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("son başvuru 8 Kasım", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("son başvuru 11 Aralık 2026", FROM), ["2026-12-11"]);
  assert.deepEqual(deadlinesIn("son tarih 11 ARALIK", FROM), ["2026-12-11"]);
  assert.deepEqual(deadlinesIn("son başvuru 8 Kasim", FROM), ["2026-11-08"], "typed without Turkish letters");
});

test("a month name inside a word, or a day that does not exist, is not a date", () => {
  assert.deepEqual(deadlinesIn("due 8 Decisions later", FROM), []);
  assert.deepEqual(deadlinesIn("due 31 Nov", FROM), []);
  assert.deepEqual(deadlinesIn("due Nov 2026", FROM), [], "a month and a year name no day");
});

test("a date with no year is the occurrence nearest the note's own day", () => {
  assert.deepEqual(deadlinesIn("due Jan 5", "2026-12-20"), ["2027-01-05"], "next year when that is nearer");
  assert.deepEqual(deadlinesIn("due 8 Nov", "2026-11-10"), ["2026-11-08"], "two days ago, not next year");
  assert.equal(dueOf({ date: "2026-11-10", result: "The deadline was 8 Nov." }), null, "so already past");
});

test("in a range the last day counts", () => {
  assert.deepEqual(deadlinesIn("due Dec 8-11", FROM), ["2026-12-11"]);
  assert.deepEqual(deadlinesIn("son başvuru 8-11 Aralık", FROM), ["2026-12-11"]);
});

test("reads the cues by, before, until, closes, ending and -e kadar", () => {
  assert.deepEqual(deadlinesIn("Send it by 8 Nov", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("send it by 2026-11-08", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("submit before the Nov 5 05:00 call", FROM), ["2026-11-05"]);
  assert.deepEqual(deadlinesIn("open until Dec 8", FROM), ["2026-12-08"]);
  assert.deepEqual(deadlinesIn("the form closes on 8 Nov", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("the offer ending 2026-11-20", FROM), ["2026-11-20"]);
  assert.deepEqual(deadlinesIn("the lease ends 2027-01-15", FROM), ["2027-01-15"]);
  assert.deepEqual(deadlinesIn("8 Kasım'a kadar gönder", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("2026-11-08'e kadar gönder", FROM), ["2026-11-08"]);
  assert.deepEqual(deadlinesIn("11 Aralık 2026'ya kadar", FROM), ["2026-12-11"]);
  assert.deepEqual(deadlinesIn("5 Kasım 05:00'e kadar", FROM), ["2026-11-05"]);
  assert.deepEqual(deadlinesIn("11 Aralık tarihine kadar", FROM), ["2026-12-11"]);
});

test("a cue after a date that belongs to the next date is not the first one's", () => {
  assert.deepEqual(deadlinesIn("The workshop runs 8-11 Dec, due 2026-12-20", FROM), ["2026-12-20"]);
});

test("a short cue counts only right before its date", () => {
  assert.deepEqual(deadlinesIn("Approved by Mira on 2026-11-06.", FROM), []);
  assert.deepEqual(deadlinesIn("Written by hand before lunch on 8 Nov", FROM), []);
  assert.deepEqual(deadlinesIn("The applications closed 8 Nov", FROM), []);
  assert.deepEqual(deadlinesIn("Stayed there until the end, 8 Nov", FROM), []);
});

test("a cue followed by passed, missed, geçti or kaçırıldı is not a deadline", () => {
  const passed = "The deadline passed 2026-11-03 without a submission.";
  assert.deepEqual(deadlinesIn(passed, "2026-11-01"), []);
  assert.equal(dueOf({ date: "2026-11-01", result: passed, next: "Ask about the next round" }), null);
  assert.deepEqual(deadlinesIn("deadline 2026-11-03 missed", "2026-11-01"), []);
  assert.deepEqual(deadlinesIn("son başvuru 8 Kasım geçti", FROM), []);
  assert.deepEqual(deadlinesIn("son başvuru 8 Kasım'dı, kaçırıldı", FROM), []);
  assert.deepEqual(deadlinesIn("Send it by 8 Nov (missed)", FROM), []);
  assert.deepEqual(deadlinesIn("SON BAŞVURU 8 KASIM KAÇIRILDI", FROM), [], "in capitals too");
  assert.deepEqual(deadlinesIn("We passed the review; deadline 8 Nov", FROM), ["2026-11-08"], "only after the cue");
});

test("a time with a zone is read on the person's own day", () => {
  // 20:00 in Los Angeles on 2 November (standard time, UTC-8) is 04:00 UTC on 3 November.
  assert.deepEqual(deadlinesIn("deadline 2026-11-02 20:00 PT", FROM), [localDate(new Date("2026-11-03T04:00:00Z"))]);
  // In summer the same zone is UTC-7.
  assert.deepEqual(deadlinesIn("deadline 2026-07-02 20:00 PT", "2026-07-01"), [
    localDate(new Date("2026-07-03T03:00:00Z")),
  ]);
  assert.deepEqual(deadlinesIn("due 4 Nov 21:00 ET", FROM), [localDate(new Date("2026-11-05T02:00:00Z"))]);
  assert.deepEqual(deadlinesIn("due 2026-11-08 23:30 UTC+3", FROM), [localDate(new Date("2026-11-08T20:30:00Z"))]);
  assert.deepEqual(deadlinesIn("due 2026-11-08 23:30 TRT", FROM), [localDate(new Date("2026-11-08T20:30:00Z"))]);
  assert.deepEqual(deadlinesIn("due 2026-11-08 23:30", FROM), ["2026-11-08"], "without a zone the day stands");
});

test("the next action's deadline comes before the rest of the note's", () => {
  const e = { date: "2026-10-25", context: "deadline was moved from 2026-11-10", next: "Send it before Nov 22" };
  assert.equal(dueOf(e), "2026-11-22");
  assert.equal(dueOf({ ...e, next: "Send it" }), "2026-11-10", "with none there, the rest of the note");
});

// Invented notes (test/fixtures/invented-dates): one per form, and traps that read like a
// deadline but are not one. The real brain cannot be copied into a public repo.
test("an invented memory shows the expected deadlines and no wrong one", () => {
  const dir = new URL("../../fixtures/invented-dates/notes/log/2026/", import.meta.url);
  const files = fs
    .readdirSync(dir)
    .map((f) => ({ path: `notes/log/2026/${f}`, text: fs.readFileSync(new URL(f, dir), "utf8") }));
  const { entries, skipped } = loadBrain(files);
  assert.deepEqual(skipped, []);
  assert.deepEqual(Object.fromEntries(entries.map((e) => [e.id, dueOf(e)]).sort()), {
    bakesale: null,
    choir: "2026-11-20",
    concert: "2026-10-20",
    contest: "2026-11-22",
    festival: "2026-12-03",
    garden: "2026-11-15",
    landlord: null,
    lease: "2027-02-28",
    minutes: null,
    pottery: "2026-11-08",
    results: "2026-11-18",
    scholarship: null,
    sergi: "2026-11-30",
    trip: null,
    visa: "2026-12-11",
  });
});

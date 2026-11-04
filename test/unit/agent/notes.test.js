import test from "node:test";
import assert from "node:assert/strict";
import { noteOf, ageOf, NOTE_CHARS } from "../../../src/agent/notes.js";

// Invented entries, in the brain's record shape.
const old = {
  title: "Checkout fix review",
  item: {
    topic: "shop",
    date: "2026-11-02",
    context: "Fixed removeItem in cart.js.",
    result: "PR #12 is open.",
    next: "Review PR #12 and decide merge.",
  },
};

test("#90: an entry carries its date and its age by the person's day", () => {
  assert.deepEqual(noteOf(old, "2026-11-04"), {
    title: "Checkout fix review",
    topic: "shop",
    date: "2026-11-02",
    age: "2 days ago",
    text: "Fixed removeItem in cart.js. PR #12 is open. Review PR #12 and decide merge.",
  });
  assert.equal(noteOf(old, "2026-11-02").age, "today");
  assert.equal(noteOf(old, "2026-11-03").age, "1 day ago");
});

test("#90: a document gets no date, and neither does an entry without a valid one", () => {
  const doc = noteOf({ title: "Shop notes", item: { path: "notes/shop.md", text: "Cart rules", date: "2026-11-01" } });
  assert.equal("date" in doc, false);
  assert.equal("age" in doc, false);
  assert.equal(doc.text, "Cart rules");
  const undated = noteOf({ title: "x", item: { ...old.item, date: "last week" } }, "2026-11-04");
  assert.equal("date" in undated, false);
});

test("ageOf: a date ahead of today reads as today", () => {
  assert.equal(ageOf("2026-11-05", "2026-11-04"), "today");
  assert.equal(ageOf("2026-10-25", "2026-11-04"), "10 days ago");
});

test("a note is still redacted and cut, and 'none' is no next action", () => {
  const long = noteOf(
    {
      title: "k",
      item: {
        date: "2026-11-04",
        context: "token sk-abcdefghijklmnopqrstuvwxyz123456 " + "a".repeat(900),
        next: "none",
      },
    },
    "2026-11-04",
  );
  assert.doesNotMatch(long.text, /sk-abcdef/);
  assert.equal(long.text.length, NOTE_CHARS);
  assert.doesNotMatch(noteOf({ title: "k", item: { date: "2026-11-04", context: "c", next: "none" } }).text, /none/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { siteName, taskPhrase, templateNudge, followsVoice, reminderLine } from "../../../src/tuck/voice.js";

test("sites go by their everyday names", () => {
  assert.equal(siteName("youtube.com"), "YouTube");
  assert.equal(siteName("m.youtube.com"), "YouTube");
  assert.equal(siteName("linkedin.com"), "LinkedIn");
  assert.equal(siteName("x.com"), "X");
  assert.equal(siteName("mail.google.com"), "Gmail");
  assert.equal(siteName("news.ycombinator.com"), "Hacker News");
  assert.equal(siteName("ioztimur.com"), "ioztimur.com");
});

test("the task is the next step when there is one, said as a phrase", () => {
  assert.equal(
    taskPhrase({ title: "Working on meta hackathon project", step: "Testing the extension" }),
    "testing the extension",
  );
  assert.equal(taskPhrase({ title: "Fix the checkout bug" }), "fix the checkout bug");
  assert.equal(taskPhrase({ title: "SUT rules engine" }), "SUT rules engine");
  assert.equal(taskPhrase({}), "your goal");
});

const task = { title: "Working on meta hackathon project", step: "Testing the extension" };

test("template lines in Tuck's voice", () => {
  const cases = [
    [{ kind: "drift", level: 1, site: "YouTube", awayMin: 0 }, "Still on YouTube? Next up: testing the extension."],
    [
      { kind: "drift", level: 2, site: "LinkedIn", awayMin: 5 },
      "That's 5 minutes away from work. Next up: testing the extension.",
    ],
    [{ kind: "drift", level: 2, site: "LinkedIn", awayMin: 1 }, "Still on LinkedIn. Want to get back to it?"],
    [{ kind: "drift", level: 1, site: "YouTube", unsure: true }, "Is this page part of your task?"],
    [{ kind: "fragmentation", level: 2 }, "These tabs don't look like your task. Want to pick one thing?"],
    [{ kind: "return", level: 2 }, "Welcome back. Next up: testing the extension."],
    [{ kind: "break_over", level: 2 }, "Break's over. Ready to get back to it?"],
    [{ kind: "session_start", level: 2 }, "Hi. What are we working on today?"],
  ];
  for (const [input, expected] of cases) assert.equal(templateNudge({ ...input, task }), expected, input.kind);
});

test("every template follows the voice rules", () => {
  for (const kind of ["drift", "fragmentation", "return", "break_over", "session_start"])
    for (const level of [1, 2, 3])
      for (const unsure of [false, true]) {
        const line = templateNudge({ kind, level, unsure, site: "YouTube", awayMin: 7, task });
        assert.ok(followsVoice(line), `${kind} L${level}: ${line}`);
      }
});

test("the voice rules: short, no emoji, no exclamation, no seconds", () => {
  assert.equal(followsVoice("Still on YouTube? Let's get back to testing the extension."), true);
  assert.equal(followsVoice("Back to it! 🙂"), false);
  assert.equal(followsVoice("You've been on youtube.com for 0 s — back to it?"), false);
  assert.equal(
    followsVoice("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen"),
    false,
  );
});

test("a reminder's line follows the voice", () => {
  for (const when of ["today", "tomorrow", "yesterday", "3 days ago"])
    assert.ok(followsVoice(reminderLine(when)), when);
  assert.equal(reminderLine("tomorrow"), "Due tomorrow. Still on your list?");
  assert.equal(reminderLine("yesterday"), "That was due yesterday. Still on your list?");
});

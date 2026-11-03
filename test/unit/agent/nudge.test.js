import test from "node:test";
import assert from "node:assert/strict";
import { nudgeMessages, parseNudge, composeNudge } from "../../../src/agent/nudge.js";

const input = {
  kind: "drift",
  level: 2,
  site: "LinkedIn",
  awayMin: 5,
  unsure: false,
  task: { title: "Working on meta hackathon project", step: "Testing the extension" },
  lastWork: "Model API · Meta",
  hour: 15,
};
const reply = (message) => JSON.stringify({ message });

function fakeModel(...replies) {
  const calls = [];
  const complete = async (messages, opts) => {
    calls.push({ messages, opts });
    const r = replies[calls.length - 1];
    if (r instanceof Error) throw r;
    return r;
  };
  return { complete, calls };
}

test("a line in Tuck's voice is used as is", async () => {
  const { complete } = fakeModel(reply("That's 5 minutes on LinkedIn. Back to the hackathon project?"));
  const r = await composeNudge(complete, input);
  assert.equal(r.message, "That's 5 minutes on LinkedIn. Back to the hackathon project?");
  assert.equal(r.source, "llm");
});

test("a line that breaks the voice rules is asked again, then dropped", async () => {
  const bad = reply("You have been on LinkedIn for 300 seconds! Please go back to work now 🙂");
  const { complete, calls } = fakeModel(bad, reply("Still on LinkedIn? Back to testing the extension?"));
  const r = await composeNudge(complete, input);
  assert.equal(r.message, "Still on LinkedIn? Back to testing the extension?");
  assert.match(calls[1].messages.at(-1).content, /rules/i);
  const twice = await composeNudge(fakeModel(bad, bad).complete, input);
  assert.equal(twice.message, null);
  assert.equal(twice.source, "fallback");
});

test("a failing model gives no line, so the template is used", async () => {
  const r = await composeNudge(fakeModel(new Error("HTTP 429")).complete, input);
  assert.equal(r.message, null);
  assert.match(r.error, /429/);
});

test("parseNudge trims quotes and rejects a missing message", () => {
  assert.equal(parseNudge('{"message":" \\"Back to it?\\" "}'), "Back to it?");
  assert.throws(() => parseNudge('{"text":"x"}'), /message/);
});

test("the prompt gives the facts and the voice rules, not the raw URL", () => {
  const [system, user] = nudgeMessages(input);
  assert.match(system.content, /12 words/);
  assert.match(system.content, /no emoji/i);
  assert.match(user.content, /LinkedIn/);
  assert.match(user.content, /5 minutes/);
  assert.match(user.content, /Testing the extension/);
  assert.match(user.content, /second nudge/i);
});

test("today's date and a close deadline reach the prompt", () => {
  const [system, user] = nudgeMessages({
    ...input,
    today: "Sunday 2026-11-01",
    due: [{ title: "Hackathon submission", when: "tomorrow" }],
  });
  assert.match(user.content, /Today: Sunday 2026-11-01/);
  assert.match(user.content, /Due soon:\n- Hackathon submission \(tomorrow\)/);
  assert.match(system.content, /as a reminder: never as a/);
});

test("no deadline means no Due soon block at all", () => {
  const [, user] = nudgeMessages({ ...input, today: "Sunday 2026-11-01", due: [] });
  assert.doesNotMatch(user.content, /Due soon/);
});

test("the greeting after a goal: how it went, and no away time (#46)", () => {
  const [system, user] = nudgeMessages({
    kind: "session_start",
    task: { title: "Plan the launch" },
    last: { onGoalMin: 130, finished: false, site: "GitHub" },
    lastWork: "launch-plan.md · acme/launch",
  });
  assert.match(system.content, /12 words/);
  assert.match(user.content, /^Situation: .*new session/m);
  assert.match(user.content, /Their task: Plan the launch/);
  assert.match(user.content, /Last time: 130 minutes on it, not finished, last on GitHub/);
  assert.match(user.content, /Last work page: launch-plan\.md · acme\/launch/);
  assert.doesNotMatch(user.content, /Away from work/);
  // A drift's prompt still says how long they have been away.
  assert.match(nudgeMessages(input)[1].content, /Away from work: 5 minutes/);
});

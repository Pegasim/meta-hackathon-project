import test from "node:test";
import assert from "node:assert/strict";
import { lineFor, follow, settle, settled, SETTLE } from "../../../bridge/status.mjs";
import { extensionId, withTuckHooks } from "../../../bridge/install.mjs";

const event = (hook_event_name, extra = {}) => ({ hook_event_name, session_id: "s1", ...extra });
const status = (e) => lineFor(e, 1)?.status;

test("each hook maps to whose turn it is", () => {
  assert.equal(status(event("UserPromptSubmit", { prompt: "secret" })), "working");
  assert.equal(status(event("PostToolUse")), "working");
  assert.equal(status(event("PermissionRequest")), "waiting_for_user");
  assert.equal(status(event("Notification", { notification_type: "permission_prompt" })), "waiting_for_user");
  assert.equal(status(event("Stop", { last_assistant_message: "All done." })), "completed");
  assert.equal(status(event("StopFailure")), "failed");
  assert.equal(status(event("SessionEnd")), "unknown");
});

test("a question in plain text is the person's turn, not a finished job", () => {
  assert.equal(status(event("Stop", { last_assistant_message: "What should I name it?\n" })), "waiting_for_user");
});

test("events that say nothing about whose turn it is pass silently", () => {
  assert.equal(lineFor(event("PreLLMCall"), 1), null);
  assert.equal(lineFor(event("Notification", { notification_type: "other" }), 1), null);
  assert.equal(lineFor({ hook_event_name: "Stop" }, 1), null, "no session");
  assert.equal(lineFor(null, 1), null);
});

test("no prompt, tool input or message text ever leaves", () => {
  const secret = "hunter2";
  const lines = [
    event("UserPromptSubmit", { prompt: secret }),
    event("PostToolUse", { tool_input: secret, tool_response: secret }),
    event("PermissionRequest", { tool_input: secret }),
    event("Stop", { last_assistant_message: `${secret}?` }),
  ].map((e) => JSON.stringify(lineFor(e, 1)));
  for (const l of lines) assert.doesNotMatch(l, /hunter2/);
});

test("only the session of the latest prompt counts: subagents are ignored", () => {
  let r = follow(null, { session: "main", status: "working", prompt: true });
  assert.equal(r.session, "main");
  r = follow(r.session, { session: "reminder-subagent", status: "working" });
  assert.equal(r.pass, null);
  r = follow(r.session, { session: "main", status: "completed" });
  assert.equal(r.pass.status, "completed");
  r = follow(r.session, { session: "other", status: "working", prompt: true });
  assert.equal(r.session, "other", "the latest prompt wins");
});

test("the extension id is the form Chrome uses, and comes from the manifest's key", () => {
  assert.match(extensionId("AAAA"), /^[a-p]{32}$/);
  assert.notEqual(extensionId("AAAA"), extensionId("BBBB"));
});

test("installing keeps the project's hooks and adds Tuck's only once", () => {
  const theirs = { schema: 1, hooks: { Stop: [{ hooks: [{ type: "command", command: "theirs" }] }] } };
  const once = withTuckHooks(theirs, "tuck");
  const twice = withTuckHooks(once, "tuck");
  assert.deepEqual(twice, once);
  assert.equal(once.schema, 1);
  assert.deepEqual(
    once.hooks.Stop.map((g) => g.hooks[0].command),
    ["theirs", "tuck"],
  );
  assert.ok(once.hooks.UserPromptSubmit);
  assert.equal(once.hooks.PreLLMCall, undefined, "large payloads are not subscribed to");
});

// Muse fires Stop, runs its helpers, and only then shows the answer (measured: 3.2 s).
const stop = lineFor(event("Stop", { last_assistant_message: "All done." }), 1);
const asks = lineFor(event("Stop", { last_assistant_message: "Which one?" }), 1);
const line = (status) => ({ ts: 1, session: "s1", status });

test("the end of a turn waits; anything else goes straight on", () => {
  assert.deepEqual(settle(null, stop, 0).send, []);
  assert.deepEqual(settle(null, asks, 0).send, []);
  const approval = lineFor(event("PermissionRequest"), 1);
  assert.deepEqual(settle(null, approval, 0), { held: null, send: [approval] });
});

test("a held turn end goes once the hooks have been quiet", () => {
  const { held } = settle(null, stop, 0);
  assert.equal(settled(held, SETTLE.quietMs - 1), false);
  assert.equal(settled(held, SETTLE.quietMs), true);
  assert.equal(settled(null, SETTLE.quietMs), false);
});

test("a helper still at work keeps it waiting, but only so long", () => {
  let { held } = settle(null, stop, 0);
  ({ held } = settle(held, null, SETTLE.quietMs - 1)); // a line from another session
  assert.equal(settled(held, SETTLE.quietMs), false);
  assert.equal(settled(held, 2 * SETTLE.quietMs - 1), true);
  for (let at = 1000; at < SETTLE.mostMs; at += 1000) ({ held } = settle(held, null, at));
  assert.equal(settled(held, SETTLE.mostMs), true, "helpers that never stop cannot hold it forever");
});

test("the agent working again drops the held word", () => {
  const { held } = settle(null, stop, 0);
  const working = line("working");
  assert.deepEqual(settle(held, working, 100), { held: null, send: [working] });
});

test("the session ending does not lose the held word", () => {
  const { held } = settle(null, stop, 0);
  const gone = line("unknown");
  assert.deepEqual(settle(held, gone, 100), { held: null, send: [stop, gone] });
});

test("a newer turn end replaces the held one", () => {
  const first = settle(null, stop, 0);
  const second = settle(first.held, asks, 100);
  assert.deepEqual(second.send, []);
  assert.equal(second.held.line, asks);
});

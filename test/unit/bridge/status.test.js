import test from "node:test";
import assert from "node:assert/strict";
import {
  lineFor,
  follow,
  settle,
  settled,
  SETTLE,
  folderName,
  toolName,
  track,
  outgoing,
} from "../../../bridge/status.mjs";
import { extensionId, withTuckHooks } from "../../../bridge/install.mjs";

const event = (hook_event_name, extra = {}) => ({ hook_event_name, session_id: "s1", ...extra });
const status = (e) => lineFor(e, 1)?.status;

test("each hook maps to whose turn it is", () => {
  assert.equal(status(event("UserPromptSubmit", { prompt: "secret" })), "working");
  assert.equal(status(event("PostToolUse")), "working");
  assert.equal(status(event("Notification", { notification_type: "permission_prompt" })), "waiting_for_user");
  assert.equal(status(event("Notification", { notification_type: "question_prompt" })), "waiting_for_user");
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
  assert.equal(lineFor(event("PermissionRequest"), 1), null, "Muse's judge may answer it");
  assert.equal(lineFor({ hook_event_name: "Stop" }, 1), null, "no session");
  assert.equal(lineFor(null, 1), null);
});

test("no prompt, tool input or message text ever leaves", () => {
  const secret = "hunter2";
  const lines = [
    event("UserPromptSubmit", { prompt: secret }),
    event("PostToolUse", { tool_input: secret, tool_response: secret }),
    event("PermissionRequest", { tool_input: secret }),
    event("Notification", { notification_type: "permission_prompt", title: secret, message: secret }),
    event("Stop", { last_assistant_message: `${secret}?` }),
  ].map((e) => JSON.stringify(lineFor(e, 1)));
  for (const l of lines) assert.doesNotMatch(l, /hunter2/);
});

// #67: the words may say where and how long, never what.
test("of the folder only its name leaves, of a tool only its name", () => {
  assert.equal(folderName("/home/hunter2/code/bilun"), "bilun");
  assert.equal(folderName("/home/a/bilun/"), "bilun");
  assert.equal(folderName("C:\\Users\\a\\shop"), "shop");
  assert.equal(folderName("/"), null);
  assert.equal(folderName(42), null);
  assert.equal(folderName(`/a/${"x".repeat(65)}`), null, "a name that long is not a folder's name");
  assert.equal(toolName("Bash"), "Bash");
  assert.equal(toolName("mcp__github__create_issue"), "mcp__github__create_issue");
  assert.equal(toolName("rm -rf hunter2"), null, "a command is not a tool's name");
  assert.equal(toolName({ command: "x" }), null);

  const secret = "hunter2";
  const cwd = `/home/${secret}/code/bilun`;
  const lines = [
    event("UserPromptSubmit", { cwd, prompt: secret }),
    event("PreToolUse", { cwd, tool_name: "Bash", tool_input: { command: secret } }),
    event("PostToolUse", { cwd, tool_name: "Bash", tool_input: secret, tool_response: secret }),
    event("Notification", { cwd, notification_type: "permission_prompt", message: secret }),
    event("Stop", { cwd, last_assistant_message: secret }),
  ].map((e) => lineFor(e, 1));
  for (const l of lines) assert.doesNotMatch(JSON.stringify(l), /hunter2|code\//);
  assert.deepEqual(lines[1], { ts: 1, session: "s1", tool: "Bash" }, "a tool's name, and no status");
  assert.equal(lines[3].folder, "bilun");
  assert.equal(lines[3].permission, true);
  assert.equal(lineFor(event("Notification", { notification_type: "question_prompt" }), 1).permission, undefined);
});

test("the host sends the turn's start, and the tool only with an approval", () => {
  const prompt = { ts: 100, session: "s1", status: "working", folder: "bilun", prompt: true };
  let turn = track(null, prompt, null);
  assert.deepEqual(turn, { session: "s1", startedAt: 100, tool: null });
  turn = track(turn, { ts: 200, session: "helper", tool: "Edit" }, "s1");
  assert.equal(turn.tool, null, "a subagent's tool is not the turn's");
  turn = track(turn, { ts: 300, session: "s1", tool: "Bash" }, "s1");
  const wait = { ts: 400, session: "s1", status: "waiting_for_user", folder: "bilun", permission: true };
  assert.deepEqual(outgoing(wait, turn), {
    status: "waiting_for_user",
    session: "s1",
    ts: 400,
    folder: "bilun",
    startedAt: 100,
    tool: "Bash",
  });
  const done = { ts: 500, session: "s1", status: "completed", turnEnd: true };
  // The turn's end is marked, so a repeated status is still news to Tuck.
  assert.deepEqual(outgoing(done, turn), {
    status: "completed",
    session: "s1",
    ts: 500,
    turnEnd: true,
    startedAt: 100,
  });
  assert.deepEqual(outgoing({ ...done, session: "s2" }, turn), {
    status: "completed",
    session: "s2",
    ts: 500,
    turnEnd: true,
  });
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
  assert.ok(once.hooks.Notification);
  assert.ok(once.hooks.PreToolUse, "for the name of the tool an approval is for (#67)");
  assert.equal(once.hooks.PermissionRequest, undefined, "its tool input is not needed");
  assert.equal(once.hooks.PreLLMCall, undefined, "large payloads are not subscribed to");
});

// Muse fires Stop, runs its helpers, and only then shows the answer (measured: 3.2 s).
const stop = lineFor(event("Stop", { last_assistant_message: "All done." }), 1);
const asks = lineFor(event("Stop", { last_assistant_message: "Which one?" }), 1);
const line = (status) => ({ ts: 1, session: "s1", status });

test("the end of a turn waits; anything else goes straight on", () => {
  assert.deepEqual(settle(null, stop, 0).send, []);
  assert.deepEqual(settle(null, asks, 0).send, []);
  const approval = lineFor(event("Notification", { notification_type: "permission_prompt" }), 1);
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

// The host's loop over a timed run of hook events, polled every 500 ms: what reaches Tuck.
function relay(run, until) {
  let session = null;
  let held = null;
  const sent = [];
  for (let now = 0, i = 0; now <= until; now += 500) {
    for (; i < run.length && run[i][0] <= now; i++) {
      const line = lineFor(run[i][1], run[i][0]);
      if (!line) continue; // the hook wrote nothing
      const next = follow(session, line);
      session = next.session;
      const settling = settle(held, next.pass, now);
      held = settling.held;
      sent.push(...settling.send);
    }
    if (settled(held, now)) {
      sent.push(held.line);
      held = null;
    }
  }
  return sent.map((l) => l.status);
}

// Measured on Muse Code 1.4.14 (#65): the judge approved in 2.0 to 9.6 s and no Notification
// came; with the judge off, Notification came 6.0 to 6.1 s after PermissionRequest.
test("approvals Muse's judge decides send no waiting_for_user", () => {
  const run = [
    [0, event("UserPromptSubmit")],
    [1000, event("PermissionRequest")],
    [4400, event("PostToolUse")],
    [5000, event("PermissionRequest")],
    [14600, event("PostToolUse")],
    [16000, event("Stop", { last_assistant_message: "Done." })],
  ];
  assert.deepEqual(relay(run, 30000), ["working", "working", "working", "completed"]);
});

test("an approval left to the person sends waiting_for_user once", () => {
  const run = [
    [0, event("UserPromptSubmit")],
    [1000, event("PermissionRequest")],
    [7100, event("Notification", { notification_type: "permission_prompt" })],
  ];
  assert.deepEqual(relay(run, 60000), ["working", "waiting_for_user"]);
});

// The real hook script and host, as separate processes, with a throwaway home folder.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bridge = path.resolve(import.meta.dirname, "../../../bridge");

const hook = (home, input) =>
  spawnSync(process.execPath, [path.join(bridge, "tuck-hook.mjs")], {
    input,
    env: { HOME: home },
    encoding: "utf8",
  });

test("a hook's status reaches the host's output, framed for Chrome, with no text", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tuck-"));
  hook(home, JSON.stringify({ hook_event_name: "Stop", session_id: "old", last_assistant_message: "x" }));
  const host = spawn(process.execPath, [path.join(bridge, "host.mjs")], { env: { HOME: home } });
  let out = Buffer.alloc(0);
  host.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
  await new Promise((r) => setTimeout(r, 300));

  const send = (e) => hook(home, JSON.stringify({ session_id: "s1", ...e }));
  send({ hook_event_name: "UserPromptSubmit", prompt: "hunter2" });
  hook(home, JSON.stringify({ hook_event_name: "PostToolUse", session_id: "subagent" }));
  send({ hook_event_name: "Stop", last_assistant_message: "hunter2?" });
  await new Promise((r) => setTimeout(r, 4400)); // a turn's end waits for the hooks to go quiet
  host.stdin.end();
  await new Promise((r) => host.on("exit", r));

  const messages = [];
  for (let at = 0; at < out.length;) {
    const size = out.readUInt32LE(at);
    messages.push(JSON.parse(out.subarray(at + 4, at + 4 + size).toString()));
    at += 4 + size;
  }
  assert.deepEqual(
    messages.filter((m) => !m.preview).map((m) => m.status),
    ["working", "waiting_for_user"],
    "what came before the host started and the subagent are left out",
  );
  assert.deepEqual(
    messages.filter((m) => m.preview).map((m) => m.status),
    ["waiting_for_user"],
    "the held turn end is announced at once, for Tuck to write its word (#67)",
  );
  assert.doesNotMatch(out.toString(), /hunter2/);
  assert.doesNotMatch(fs.readFileSync(path.join(home, ".tuck/agent.jsonl"), "utf8"), /hunter2/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("Muse's answer on screen comes first: a turn's end waits, an approval does not", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tuck-"));
  const host = spawn(process.execPath, [path.join(bridge, "host.mjs")], { env: { HOME: home } });
  let out = Buffer.alloc(0);
  host.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
  const framed = () => {
    const seen = [];
    for (let at = 0; at < out.length;) {
      const size = out.readUInt32LE(at);
      seen.push(JSON.parse(out.subarray(at + 4, at + 4 + size).toString()));
      at += 4 + size;
    }
    return seen;
  };
  const statuses = () =>
    framed()
      .filter((m) => !m.preview)
      .map((m) => m.status);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(300);
  const send = (e) => hook(home, JSON.stringify({ session_id: "s1", ...e }));
  send({ hook_event_name: "UserPromptSubmit" });
  send({ hook_event_name: "PermissionRequest" });
  await wait(900);
  assert.deepEqual(statuses(), ["working"], "Muse's judge may answer it");
  send({ hook_event_name: "Notification", notification_type: "permission_prompt" });
  await wait(900);
  assert.deepEqual(statuses(), ["working", "waiting_for_user"], "the approval is on screen already");
  send({ hook_event_name: "Stop", last_assistant_message: "Done." });
  await wait(900);
  assert.deepEqual(statuses(), ["working", "waiting_for_user"], "the end of the turn waits");
  assert.deepEqual(
    framed()
      .filter((m) => m.preview)
      .map((m) => m.status),
    ["completed"],
    "but its word can be written meanwhile",
  );
  await wait(3500);
  assert.deepEqual(statuses(), ["working", "waiting_for_user", "completed"]);
  host.stdin.end();
  await new Promise((r) => host.on("exit", r));
  fs.rmSync(home, { recursive: true, force: true });
});

test("only the folder's name, the turn's start and an approval's tool leave (#67)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tuck-"));
  const host = spawn(process.execPath, [path.join(bridge, "host.mjs")], { env: { HOME: home } });
  let out = Buffer.alloc(0);
  host.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
  await new Promise((r) => setTimeout(r, 300));
  const cwd = "/home/hunter2/code/bilun";
  const send = (e) => hook(home, JSON.stringify({ session_id: "s1", cwd, ...e }));
  send({ hook_event_name: "UserPromptSubmit", prompt: "hunter2" });
  send({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm hunter2" } });
  send({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "hunter2" });
  send({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: "hunter2" });
  await new Promise((r) => setTimeout(r, 900));
  host.stdin.end();
  await new Promise((r) => host.on("exit", r));

  const messages = [];
  for (let at = 0; at < out.length;) {
    const size = out.readUInt32LE(at);
    messages.push(JSON.parse(out.subarray(at + 4, at + 4 + size).toString()));
    at += 4 + size;
  }
  const [start, wait, after] = messages;
  assert.equal(messages.length, 3, "the tool's name alone sends nothing");
  assert.deepEqual(Object.keys(wait).sort(), ["folder", "session", "startedAt", "status", "tool", "ts"]);
  assert.equal(wait.folder, "bilun");
  assert.equal(wait.tool, "Bash");
  assert.equal(wait.startedAt, start.ts);
  assert.equal(after.tool, undefined, "the tool's name goes with an approval only");
  assert.doesNotMatch(out.toString(), /hunter2|code\//);
  assert.doesNotMatch(fs.readFileSync(path.join(home, ".tuck/agent.jsonl"), "utf8"), /hunter2|code\//);
  fs.rmSync(home, { recursive: true, force: true });
});

test("a host restarted during a turn still follows that turn", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tuck-"));
  const send = (e) => hook(home, JSON.stringify({ session_id: "s1", ...e }));
  send({ hook_event_name: "UserPromptSubmit" });
  hook(home, JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s2" }));
  send({ hook_event_name: "UserPromptSubmit" });
  const host = spawn(process.execPath, [path.join(bridge, "host.mjs")], { env: { HOME: home } });
  let out = Buffer.alloc(0);
  host.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
  await new Promise((r) => setTimeout(r, 300));
  send({ hook_event_name: "Notification", notification_type: "permission_prompt" });
  await new Promise((r) => setTimeout(r, 900));
  host.stdin.end();
  await new Promise((r) => host.on("exit", r));
  assert.match(out.toString(), /waiting_for_user/);
  assert.doesNotMatch(out.toString(), /working/, "what came before it started is still left out");
  fs.rmSync(home, { recursive: true, force: true });
});

test("the hook never gets in the agent's way: bad input exits 0 and prints nothing", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tuck-"));
  const r = hook(home, "not json");
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
  fs.rmSync(home, { recursive: true, force: true });
});

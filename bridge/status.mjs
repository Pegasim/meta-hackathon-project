// What a Muse Code hook event means for Tuck. Pure. Only status leaves here, with the
// project folder's name and, for an approval, the tool's name (#67): never a prompt, a
// tool's input or a message. Events and fields were checked on Muse Code 1.4.14; see
// docs/plans/2026-11-01-muse-bridge.md. `cwd` and `tool_name` were not: without them
// the words just say less.

// Notification types that wait on the person: an approval, and a question (named in Muse's
// binary, not yet seen in a run).
const WAITS = ["permission_prompt", "question_prompt"];

// The last part of the working folder: "/home/a/code/bilun" → "bilun". Never the path.
export function folderName(cwd) {
  if (typeof cwd !== "string") return null;
  const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return /^[^\p{C}]{1,64}$/u.test(name) ? name : null;
}

// A tool's name ("Bash", "Edit", "mcp__github__create_issue"), never its input.
export const toolName = (name) => (typeof name === "string" && /^[A-Za-z][\w.:-]{0,63}$/.test(name) ? name : null);

// One line for ~/.tuck/agent.jsonl, or null when the event says nothing about whose turn it is.
export function lineFor(event, ts) {
  const session = event?.session_id;
  if (!session) return null;
  const folder = folderName(event.cwd);
  const line = (status, extra = {}) => ({ ts, session, status, ...(folder && { folder }), ...extra });
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return line("working", { prompt: true });
    case "PreToolUse": {
      // No status: which tool an approval that may follow is for. The host keeps it.
      const tool = toolName(event.tool_name);
      return tool ? { ts, session, tool } : null;
    }
    case "PostToolUse":
      return line("working");
    case "Notification":
      // Muse's approval judge decides most approvals itself, in 2 to 10 s, and
      // PermissionRequest fires for those too. This comes about 6 s on, and only while the
      // person still has to answer.
      if (!WAITS.includes(event.notification_type)) return null;
      return line("waiting_for_user", event.notification_type === "permission_prompt" ? { permission: true } : {});
    case "Stop":
      // A question in plain text also ends a turn. Only this yes or no leaves the script.
      return line(/\?\s*$/.test(event.last_assistant_message ?? "") ? "waiting_for_user" : "completed", {
        turnEnd: true,
      });
    case "StopFailure":
      return line("failed");
    case "SessionEnd":
      return line("unknown");
    default:
      return null;
  }
}

// Muse's internal subagents fire hooks too, with their own session, some after Stop. The
// session of the latest prompt is the one the person is waiting on. Returns the line to
// pass on, or null, and the session to remember.
export function follow(session, line) {
  if (line.prompt) return { session: line.session, pass: line };
  return { session, pass: line.session === session ? line : null };
}

// Muse fires Stop, runs its helpers, and only then shows the answer: saying "done" at Stop
// beats the screen by seconds. So a turn's end waits until the hooks of every session have
// been quiet, for so long at most. held: { line, since, lastSeen } or null.
export const SETTLE = { quietMs: 3500, mostMs: 15000 }; // helpers were up to 2.7 s apart

// For every line read. pass: what follow() passed on, or null for another session's line.
export function settle(held, pass, now) {
  const kept = held && { ...held, lastSeen: now };
  if (!pass) return { held: kept, send: [] };
  if (pass.turnEnd) return { held: { line: pass, since: now, lastSeen: now }, send: [] };
  // The session ending says nothing against the word; anything else means it went on.
  return { held: null, send: pass.status === "unknown" && held ? [held.line, pass] : [pass] };
}

export function settled(held, now) {
  return !!held && (now - held.lastSeen >= SETTLE.quietMs || now - held.since >= SETTLE.mostMs);
}

// The session of the latest prompt in the file: a host started during a turn follows it.
export function latestPromptSession(text) {
  for (const raw of text.split("\n").reverse()) {
    try {
      const line = JSON.parse(raw);
      if (line?.prompt) return line.session;
    } catch {}
  }
  return null;
}

// The turn the host follows: when its prompt came, and the tool last about to run in it.
// turn: { session, startedAt, tool } or null. Lines with no status only name a tool.
export function track(turn, line, session) {
  if (line.prompt) return { session: line.session, startedAt: line.ts, tool: null };
  if (line.tool && turn && line.session === session) return { ...turn, tool: line.tool };
  return turn;
}

// What the host sends Chrome for a line. Nothing else in a line leaves.
export function outgoing(line, turn) {
  const same = turn?.session === line.session;
  return {
    status: line.status,
    session: line.session,
    ts: line.ts,
    ...(line.folder && { folder: line.folder }),
    // A turn's end is news to Tuck even when the status repeats (an approval before it).
    ...(line.turnEnd && { turnEnd: true }),
    ...(same && turn.startedAt != null && { startedAt: turn.startedAt }),
    ...(same && line.permission && turn.tool && { tool: turn.tool }),
  };
}

export const HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

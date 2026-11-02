// What a Muse Code hook event means for Tuck. Pure. Only status leaves here: never a
// prompt, a tool's input or a message. Events and fields were checked on Muse Code
// 1.4.14; see docs/plans/2026-11-01-muse-bridge.md.

// One line for ~/.tuck/agent.jsonl, or null when the event says nothing about whose turn it is.
export function lineFor(event, ts) {
  const session = event?.session_id;
  if (!session) return null;
  const line = (status, extra = {}) => ({ ts, session, status, ...extra });
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
      return line("working", { prompt: true });
    case "PostToolUse":
      return line("working");
    case "PermissionRequest":
      return line("waiting_for_user");
    case "Notification":
      return event.notification_type === "permission_prompt" ? line("waiting_for_user") : null;
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

export const HOOK_EVENTS = [
  "UserPromptSubmit",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

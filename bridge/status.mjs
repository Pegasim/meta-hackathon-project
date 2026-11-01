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
      return line(/\?\s*$/.test(event.last_assistant_message ?? "") ? "waiting_for_user" : "completed");
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

export const HOOK_EVENTS = [
  "UserPromptSubmit",
  "PostToolUse",
  "PermissionRequest",
  "Notification",
  "Stop",
  "StopFailure",
  "SessionEnd",
];

// Tuck's icon row and its chat (design: docs/superpowers/specs/2026-11-04-tuck-dock-chat-design.md).
// Pure, like present.js: background.js builds these views and overlay.js draws them.
// A thread lives in the background per tab while its chat is open; every change is a new
// thread object and a redraw.
import { focusMinutes } from "../attention/intents.js";

export const OPENER = "What are we working on?";
export const LOOKING = "Looking at your notes…";
export const PLANNING = "Making a plan from your notes…";
export const STEP_OPENER = "What's in the way?";
const MAX_MESSAGES = 12;

// Clicking Tuck: the goal as one step (NOW), its plan as dots, its focus minutes, and the
// row of actions. With no goal, only the chat and Tuck away make sense.
export function menuView({ intent, now }) {
  if (!intent) return { pose: "hello", bubble: { kind: "menu", goal: null, actions: ["chat", "away"] } };
  const total = intent.plan?.steps?.length ?? 0;
  const done = Math.min(intent.stepIndex ?? 0, Math.max(total - 1, 0));
  return {
    pose: "hello",
    bubble: {
      kind: "menu",
      goal: {
        title: intent.title,
        now: intent.steps?.[0] ?? null,
        dots: total ? { done, total } : null,
        focusMin: focusMinutes(intent, now),
        canStep: total > 0 && done < total - 1,
      },
      actions: ["chat", "stuck", "break", "done", "away"],
    },
  };
}

// One line of what Tuck looked at, from a loop trail entry (agent/loop.js): the search
// words and counts it already keeps, never a note's text. Finishing tools, the goal
// lookup and failed lookups add nothing.
export function trailLine({ tool, args = {}, result } = {}) {
  if (!result || /^(error|rejected)/.test(result)) return null;
  switch (tool) {
    case "recall_notes":
      return `Searched your notes: ${args.query ?? ""} · ${result}`;
    case "list_tasks":
      return `Checked your tasks · ${result}`;
    case "recent_activity":
      return `Looked at your recent pages · ${result}`;
    case "look_at_page":
      return "Read your last work page";
    case "github_status":
      return `Checked GitHub: ${args.repo ?? "your repository"}`;
    default:
      return null;
  }
}

const keep = (messages) => messages.slice(-MAX_MESSAGES);
// Only the newest message can be answered: what came before keeps its words, not its buttons.
const answered = ({ buttons, chips, ...m }) => m;
const withMessages = (thread, messages) => ({
  ...thread,
  messages: keep(messages.map((m, i) => (i < messages.length - 1 ? answered(m) : m))),
});

// mode "goal": no goal yet, the person says what today is about. "step": a goal runs.
export function newThread({ intent, opener, chips = [] }) {
  return {
    mode: intent ? "step" : "goal",
    title: intent?.title ?? "Today",
    messages: [{ from: "tuck", text: opener, ...(chips.length && { chips }) }],
  };
}

export const say = (thread, text) => withMessages(thread, [...thread.messages, { from: "me", text }]);
export const tuckSays = (thread, msg) => withMessages(thread, [...thread.messages, { from: "tuck", ...msg }]);
export const pending = (thread, text) =>
  withMessages(thread, [...thread.messages, { from: "tuck", text, pending: true, trail: [] }]);

export function addTrail(thread, line) {
  const i = thread.messages.findLastIndex((m) => m.pending);
  if (i < 0 || !line) return thread;
  const messages = thread.messages.slice();
  messages[i] = { ...messages[i], trail: [...messages[i].trail, line] };
  return { ...thread, messages };
}

// The answer takes the pending message's place, keeping what Tuck looked at above it.
export function resolve(thread, msg) {
  const i = thread.messages.findLastIndex((m) => m.pending);
  if (i < 0) return tuckSays(thread, msg);
  const messages = thread.messages.slice();
  const trail = messages[i].trail;
  messages[i] = { from: "tuck", ...msg, ...(trail.length && { trail }) };
  return { ...thread, messages };
}

// A pending line that came to nothing (no plan): it goes, with what was looked up for it.
export function dropPending(thread) {
  const i = thread.messages.findLastIndex((m) => m.pending);
  if (i < 0) return thread;
  return { ...thread, messages: thread.messages.filter((_, j) => j !== i) };
}

export const toStep = (thread, intent) => ({
  ...thread,
  mode: "step",
  title: intent.title,
  messages: thread.messages.map(answered),
});

export function chatView(thread) {
  const goal = thread.mode === "goal";
  return {
    pose: thread.messages.some((m) => m.pending) ? "wait" : "hello",
    bubble: {
      kind: "chat",
      title: thread.title,
      messages: thread.messages,
      field: { name: goal ? "goal" : "say", placeholder: goal ? "Today I want to…" : "Talk to Tuck" },
      change: !goal,
      // Only Tuck's question so far, and not opened from the row: a small speech bubble
      // that grows into the chat when the person clicks or types.
      compact:
        !thread.expanded &&
        thread.messages.every((m) => m.from === "tuck" && !m.pending) &&
        thread.messages.length === 1,
    },
    update: true,
  };
}

// First run: with no API key the chat cannot think, so Tuck asks for the key first.
export const SETUP_ASK = "Hi, I'm Tuck. I need a Meta API key to think.";
export const SETUP_BAD = "That key didn't work. Check it and try again.";
export const SETUP_THANKS = "Thanks. What are we working on?";
export const needsKey = (settings) => !settings?.apiKey && settings?.provider !== "ollama";
export const setupView = ({ error = false } = {}) => ({
  pose: "hello",
  bubble: { kind: "setup", text: SETUP_ASK, error: error ? SETUP_BAD : null },
});

// Then, once: does the person have notes? Without them Tuck reads nothing and says so.
export const NOTES_ASK = "Got it. Do you have notes I can read?";
export const NOTES_SKIPPED = "Okay, no notes. What are we working on?";
export const THINKING = "Thinking…"; // the wait when there is nothing to look up
export const notesThread = () =>
  newThread({
    intent: null,
    opener: NOTES_ASK,
    chips: [
      { label: "Connect a notes folder", msg: { type: "notes-choice", choice: "brain" } },
      { label: "Import a chat history", msg: { type: "notes-choice", choice: "export" } },
      { label: "Skip", msg: { type: "notes-choice", choice: "skip" } },
    ],
  });

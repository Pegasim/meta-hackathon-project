// What Tuck shows for an engine trigger or a goal event: its state and its bubble.
// Pure; background.js sends the result to the page (overlay.js draws it) and the
// popup shares the same words. Design §12.
import { siteName, templateNudge } from "./voice.js";

const ANSWERS = {
  back: { choice: "back", label: "Take me back", primary: true },
  related: { choice: "related", label: "This is for my task" },
  break: { choice: "break", label: "5-min break" },
};

// The model's line when it is ready (agent/nudge.js), else the template in Tuck's voice.
export function nudgeText(t) {
  if (t.message) return t.message;
  const e = t.evidence ?? {};
  return templateNudge({
    kind: t.kind,
    level: t.level,
    site: siteName(e.host),
    awayMin: Math.round((e.awaySec ?? 0) / 60),
    unsure: !!e.unsure,
    agent: e.agent,
    again: !!e.agentAgain,
    agentFacts: { folder: e.agentFolder, minutes: e.agentMin, tool: e.agentTool },
    task: { title: t.intentTitle, step: t.intentStep },
  });
}

const goalForm = (text, pickUp = []) => ({ kind: "goal", text, pickUp });

// input: {trigger, loops} for an engine trigger, or {event, intent} for
// "goal_set" | "goal_done" | "resolved" | "presence" | "card". Returns null when Tuck stays away.
export function present({ trigger, loops = [], event, intent }) {
  if (trigger) {
    if (trigger.level < 1) return null;
    const { kind, level, id } = trigger;
    if (kind === "session_start")
      return {
        tuck: "checkin",
        bubble: goalForm(
          nudgeText(trigger),
          loops.slice(0, 2).map((l) => l.title),
        ),
      };
    if (kind === "return" || kind === "break_over") {
      const buttons = kind === "return" ? [ANSWERS.back] : [ANSWERS.back, ANSWERS.break];
      return {
        tuck: "checkin",
        bubble: { kind: "nudge", text: nudgeText(trigger), buttons, dismissable: true },
        triggerId: id,
      };
    }
    // Tuck cannot bring a terminal to the front, so there is nothing to take the person back to.
    if (kind === "agent")
      return {
        tuck: "checkin",
        bubble: {
          kind: "nudge",
          text: nudgeText(trigger),
          buttons: [{ choice: "dismiss", label: "Got it", primary: true }, ANSWERS.break],
          dismissable: true,
        },
        triggerId: id,
      };
    // The first word: a visible wave and the message at once. On a page the model is
    // unsure about, Tuck asks instead, and the answer becomes a label.
    if (level === 1) {
      const e = trigger.evidence ?? {};
      const bubble = e.unsure
        ? {
            kind: "nudge",
            text: nudgeText(trigger),
            buttons: [
              { choice: "related", label: "Yes, it's for my task", primary: true },
              { choice: "back", label: "No, take me back" },
            ],
            dismissable: true,
          }
        : {
            kind: "nudge",
            text: nudgeText(trigger),
            buttons: [ANSWERS.back, ANSWERS.related, ANSWERS.break],
            dismissable: true,
          };
      return { tuck: "checkin", bubble, triggerId: id };
    }
    return {
      tuck: "thinking",
      bubble: {
        kind: "nudge",
        text: nudgeText(trigger),
        buttons: [ANSWERS.back, ANSWERS.related, ANSWERS.break],
        dismissable: true,
      },
      triggerId: id,
    };
  }
  switch (event) {
    case "goal_set":
      return {
        tuck: "welcome",
        settle: "resting",
        bubble: { kind: "note", text: "Got it. Let's go." },
        closeBubbleAfterMs: 2000,
      };
    case "goal_done":
      return { tuck: "checkin", bubble: goalForm("Nice work. What's next?") };
    case "resolved":
      return { tuck: "welcome", settle: "resting", bubble: null };
    case "presence":
      // Tuck rests on every page while there is a goal; quiet: no entrance if already there.
      return { tuck: "resting", bubble: null, quiet: true };
    case "card":
      return intent
        ? { tuck: "checkin", bubble: { kind: "card", text: intent.title, next: intent.steps?.[0] ?? "" } }
        : { tuck: "checkin", bubble: goalForm("What are we working on?") };
    default:
      return null;
  }
}

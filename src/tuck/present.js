// What Tuck shows for an engine trigger or a goal event: its pose (skins.js POSES) and its bubble.
// Pure; background.js sends the result to the page (overlay.js draws it) and the
// popup shares the same words. Design §12.
import { siteName, templateNudge } from "./voice.js";

const ANSWERS = {
  back: { choice: "back", label: "Take me back", primary: true },
  related: { choice: "related", label: "This is for my task" },
  break: { choice: "break", label: "5-min break" },
  // #61: asks the agent for one small step instead of answering the word (stuckView).
  stuck: { choice: "stuck", label: "I'm stuck", msg: { type: "stuck-tuck" } },
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
    done: !!e.agentDone,
    agentFacts: { folder: e.agentFolder, minutes: e.agentMin, tool: e.agentTool },
    task: { title: t.intentTitle, step: t.intentStep },
  });
}

// While Tuck is hidden ("Tuck away"), these are the only words that still come:
// a drift (fragmentation counts as one), the coding agent's word, and the day's goal form.
const WHILE_AWAY = new Set(["drift", "fragmentation", "agent", "session_start"]);
export const comesWhileAway = (kind) => WHILE_AWAY.has(kind);

const goalForm = (text, pickUp = []) => ({ kind: "goal", text, pickUp });

// "I'm stuck" (#61): Tuck waits while the agent looks (up to 20 s), then shows the one step
// with its minutes. "Another one" asks once more at most: the second step has no such button.
// Each view names its ask (`stuck`), so closing it cancels the ask; while Tuck is tucked
// away, Tuck leaves with it. Start this carries the goal id: a step for a goal that has
// ended does nothing. The popup shows the same words.
export const STUCK_WAIT = "Let me find one small step…";
export const minutesLine = (minutes) => (minutes ? `About ${minutes} min` : "");
export function stuckView({ step, minutes, intentId, again = false, away = false, ask }) {
  const marks = { ...(ask && { stuck: ask }), ...(away && { away }) };
  if (!step) return { pose: "wait", bubble: { kind: "note", text: STUCK_WAIT }, ...marks };
  const buttons = [
    { choice: "start", label: "Start this", primary: true, msg: { type: "start-step", step, intentId } },
  ];
  if (!again) buttons.push({ choice: "another", label: "Another one", msg: { type: "stuck-tuck", again: true } });
  return {
    pose: "hello",
    bubble: { kind: "step", text: step, next: minutesLine(minutes), buttons, dismissable: true },
    ...marks,
  };
}

// The one check that a stuck ask is still wanted (#61), before its late step is drawn and
// while a drift word waits behind it: it is still the live ask (the person did not close
// it, no newer one replaced it), its goal is still the active one, and an ask from a page
// still has that tab in front. Nothing late is redrawn (DECISIONS, #81).
export function stuckWanted(ask, { live, intentId, tabId }) {
  return !!ask && ask.id === live?.id && ask.intentId === intentId && (ask.tabId == null || ask.tabId === tabId);
}

// input: {trigger, loops} for an engine trigger, or {event, intent, agent} for
// "goal_set" | "goal_done" | "resolved" | "back" | "presence" | "break" | "card" | "away". Returns null when
// Tuck stays away. Poses follow the spec's pose table (2026-11-04-tuck-v1-skins-design.md).
export function present({ trigger, loops = [], event, intent, agent }) {
  if (trigger) {
    if (trigger.level < 1) return null;
    const { kind, level, id } = trigger;
    if (kind === "session_start")
      return {
        pose: "hello",
        bubble: goalForm(
          nudgeText(trigger),
          loops.slice(0, 2).map((l) => l.title),
        ),
      };
    if (kind === "return" || kind === "break_over") {
      const buttons = kind === "return" ? [ANSWERS.back] : [ANSWERS.back, ANSWERS.break];
      return {
        pose: "hello",
        bubble: { kind: "nudge", text: nudgeText(trigger), buttons, dismissable: true },
        triggerId: id,
      };
    }
    // Tuck cannot bring a terminal to the front, so there is nothing to take the person back to.
    if (kind === "agent")
      return {
        pose: "wait",
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
            buttons: [ANSWERS.back, ANSWERS.stuck, ANSWERS.related, ANSWERS.break],
            dismissable: true,
          };
      return { pose: "drift", bubble, triggerId: id };
    }
    return {
      pose: "drift",
      bubble: {
        kind: "nudge",
        text: nudgeText(trigger),
        buttons: [ANSWERS.back, ANSWERS.stuck, ANSWERS.related, ANSWERS.break],
        dismissable: true,
      },
      triggerId: id,
    };
  }
  // Tuck's pose with nothing to say: resting, or working while the coding agent does.
  const resting = agent === "working" ? "work" : "rest";
  switch (event) {
    case "goal_set":
      return {
        pose: "happy",
        settle: resting,
        bubble: { kind: "note", text: "Got it. Let's go." },
        closeBubbleAfterMs: 2000,
      };
    case "away":
      // Tucked away from the card: one line on the way out, so the way back is known.
      return {
        pose: "hello",
        bubble: { kind: "note", text: "Okay. Click the toolbar icon to bring me back." },
        leaveAfterMs: 2500,
      };
    case "goal_done":
      return { pose: "hello", bubble: goalForm("Nice work. What's next?") };
    case "resolved":
    case "back":
      return { pose: "happy", settle: resting, bubble: null };
    case "presence":
      // Tuck rests on every page while there is a goal, and works while the coding agent
      // does; quiet: no entrance if already there.
      return { pose: resting, bubble: null, quiet: true };
    case "break":
      // Asleep on the page for the whole break.
      return { pose: "sleep", bubble: null, quiet: true };
    case "card":
      // The plan the agent made from the person's notes (#78), when it made one.
      return intent
        ? {
            pose: "hello",
            bubble: {
              kind: "card",
              text: intent.title,
              next: intent.steps?.[0] ?? "",
              ...(intent.plan && { plan: intent.plan.steps.map((s) => s.step), watchOut: intent.plan.watchOut }),
            },
          }
        : { pose: "hello", bubble: goalForm("What are we working on?") };
    default:
      return null;
  }
}

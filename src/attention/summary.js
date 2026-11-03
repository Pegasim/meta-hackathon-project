// How a goal went, from the event log: the facts behind the day's entry in memory and
// the next greeting (issue #46). Pure. The logged inputs run through the engine again,
// as in replay.js, so time on work, a drift and a return mean what they meant live.
import { DEFAULTS } from "./config.js";
import { initialState, step } from "./engine.js";
import { dayKey } from "./intents.js";
import { hostOf } from "./relevance.js";

const S = 1000;
// As logged live: second looks are the answers the worker got, so they are fed as they came.
const INPUTS = new Set(["context", "relevance", "session", "response", "tick", "agent", "second_look"]);
const NUDGES = ["drift", "fragmentation"];
const RETURN_MS = 2 * 60 * S; // INTENT.md: back to related work within 2 minutes

const setsGoal = (e, id) => e.type === "session" && e.kind === "intent_set" && (id == null || e.payload?.id === id);
const atWork = (s) => !s.away && s.current?.label === "related" && !s.current.pending;

// events: the log since the goal was set; intent: the goal, ended (doneAt or expiredAt).
// Null when there is nothing to say: the goal is not in the log (pruned, or set before
// the log), or it was in front of the person for less than cfg.summaryMinSec.
// lastWork is the last work page's title, for the greeting's line on this device only.
export function daySummary(events, intent, cfg = DEFAULTS) {
  const inputs = events.filter((e) => INPUTS.has(e.type)).sort((a, b) => a.ts - b.ts);
  const first = inputs.findIndex((e) => setsGoal(e, intent.id));
  if (first < 0) return null;
  const end = intent.doneAt ?? intent.expiredAt ?? Infinity;
  let s = initialState();
  let onGoalMs = 0;
  let activeMs = 0;
  let drifts = 0;
  const nudges = []; // {ts, key, returned}
  for (let i = first; i < inputs.length && inputs[i].ts <= end; i++) {
    const input = inputs[i];
    if (i > first && setsGoal(input) && input.payload?.id !== intent.id) break;
    // A restart starts the engine over with the same goal, keeping the mode and the way
    // back (background engineState).
    if (i > first && input.payload?.restored) s = { ...initialState(), mode: s.mode, lastRelevant: s.lastRelevant };
    const wasDrifting = s.lastDriftBudget != null;
    const r = step(s, input, cfg);
    s = r.state;
    if (!wasDrifting && s.lastDriftBudget != null) drifts += 1;
    for (const o of r.out)
      if (o.type === "trigger" && NUDGES.includes(o.kind) && o.level >= 1)
        nudges.push({ ts: o.ts, key: o.evidence?.key ?? null, returned: false });
    // Back means on a work page other than the one the word was about.
    if (atWork(s))
      for (const n of nudges)
        if (!n.returned && input.ts - n.ts <= RETURN_MS && s.current.key !== n.key) n.returned = true;
    // Until the next input. A longer silence is sleep, as the engine reads it: no time at all.
    const dt = Math.min(inputs[i + 1]?.ts ?? end, end) - input.ts;
    if (!Number.isFinite(dt) || dt > cfg.maxGapSec * S || !s.intent || s.away) continue;
    activeMs += dt;
    if (atWork(s)) onGoalMs += dt;
  }
  if (activeMs < cfg.summaryMinSec * S) return null;
  const last = s.lastRelevant;
  return {
    intentId: intent.id,
    date: dayKey(intent.createdAt, cfg),
    goal: intent.title,
    picked: !!intent.fromLoopId,
    onGoalMin: Math.round(onGoalMs / (60 * S)),
    drifts,
    nudges: nudges.length,
    returned: nudges.filter((n) => n.returned).length,
    site: last?.url ? hostOf(last.url) : null,
    lastWork: last?.title || null,
    finished: !!intent.doneAt && !intent.replaced,
    replaced: !!intent.replaced,
  };
}

const clock = (min) => `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The entry memory keeps (src/memory/README.md, Entry format): the goal, the numbers and
// the site, never a page title. `next` is none: the greeting already offers an unfinished
// goal, so an open loop here would list it twice.
export function summaryEntry(sum) {
  const head = `Day ${sum.date}: `;
  const stats = `: ${clock(sum.onGoalMin)} on goal, ${count(sum.drifts, "drift")}`;
  const room = 120 - head.length - stats.length;
  const goal = sum.goal.length > room ? `${sum.goal.slice(0, room - 1)}…` : sum.goal;
  const ending = sum.finished
    ? "Finished."
    : sum.replaced
      ? "Not finished; another goal replaced it."
      : "Not finished.";
  const words = sum.nudges
    ? `${count(sum.nudges, "nudge")}, ${sum.returned} followed by a return to work within 2 minutes`
    : "no nudges";
  return {
    kind: "event",
    topic: "focus",
    date: sum.date,
    title: `${head}${goal}${stats}`,
    context: `Goal "${sum.goal}", ${sum.picked ? "picked from the to-do list" : "typed"} in Tuck.`,
    result: [
      ending,
      `${clock(sum.onGoalMin)} on pages that served the goal; ${count(sum.drifts, "drift")}; ${words}.`,
      sum.site ? `Last work on ${sum.site}.` : null,
    ]
      .filter(Boolean)
      .join(" "),
    evidence: "Counted from Tuck's event log on this device.",
    next: "none",
  };
}

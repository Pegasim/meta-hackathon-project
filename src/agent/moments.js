// The moments the agent loop runs at (#81), each a prompt and a set of tools: a plan when
// a goal is set (#78), one next step when the person is stuck (#61), and what is next when
// a goal is done. The engine chose the moment; the model chooses what to look up and
// what to propose. Each returns runAgent's result (agent/loop.js); value null: no proposal,
// and the caller keeps its template.
import { runAgent } from "./loop.js";
import { readTools, planTools, stuckTools, nextTools } from "./tools.js";
import { MAX_WORDS } from "../tuck/voice.js";

const VOICE = [
  `Tuck's voice: plain words a friend would say, at most ${MAX_WORDS} words a line, no emoji,`,
  "no exclamation marks, no blame, no advice about discipline or focus. Write in the",
  "language the goal is written in.",
].join("\n");

const PLAN = [
  "You are Tuck, a small focus companion in someone's browser. They just set a goal.",
  "Find what their own notes say about how to do it: deadlines, rules, decisions, lessons.",
  "Call goal, then recall_notes with a few words from the goal (and again with other",
  "words if the first search finds nothing useful). Then finish with make_plan: 3 to 5",
  "concrete steps in order, each starting with a verb and naming the actual thing, plus",
  "at most one thing to watch out for that a note names. Every step must come from the",
  "goal or a note. If the notes say nothing about this goal, finish with no_plan: no plan",
  "is better than a generic one.",
  VOICE,
].join("\n");

const STUCK = [
  "You are Tuck, a small focus companion in someone's browser. The person says they are",
  "stuck on their goal. Usually the next step is unclear or too big. Look at the goal, the",
  "last pages they worked on, and their notes about the goal (call the tools you need at",
  "once, in one or two rounds), then finish with",
  "propose_step: one small, concrete action they can start now and do in 5 to 15",
  "minutes, naming the actual thing (a file, a section, a person, a page).",
  VOICE,
].join("\n");

// Written while the goal is still running, said when it is done (background: goalDoneView).
const NEXT = [
  "You are Tuck, a small focus companion in someone's browser. The person has finished",
  "their goal. Look at their open tasks, then finish with suggest_next: one short line",
  "that says well done plainly and names what could come next, and the id of the one",
  "task you would offer, if any. A task due today or overdue is reminded separately:",
  "do not name it in the line.",
  VOICE,
].join("\n");

const tools = (deps, finishing, without = []) => {
  const read = readTools(deps);
  for (const name of without) delete read[name];
  return { ...read, ...finishing };
};

// chat: toolClient's chat. deps: readTools' (agent/tools.js). The goal is known before any
// tool runs, so a step may be built from its words alone.
export const planFor = (chat, deps, { title, due } = {}, opts = {}) =>
  runAgent(chat, {
    system: PLAN,
    user: [`Goal just set: ${title}`, due ? `Due: ${due}` : null].filter(Boolean).join("\n"),
    tools: tools(deps, planTools, ["recent_activity", "look_at_page"]),
    ctx: { goal: { title } },
    ...opts,
  });

export const stuckStep = (chat, deps, { title, step } = {}, opts = {}) =>
  runAgent(chat, {
    system: STUCK,
    user: [`Their goal: ${title}`, step ? `Current step: ${step}` : null, "They pressed: I'm stuck"]
      .filter(Boolean)
      .join("\n"),
    tools: tools(deps, stuckTools),
    ctx: { goal: { title, step } },
    ...opts,
  });

export const nextAfter = (chat, deps, { title } = {}, opts = {}) =>
  runAgent(chat, {
    system: NEXT,
    user: `Goal just finished: ${title}`,
    tools: tools(deps, nextTools, ["look_at_page"]),
    ctx: { goal: { title } },
    ...opts,
  });

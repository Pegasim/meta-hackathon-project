// The moments the agent loop runs at (#81), each a prompt and a set of tools: a plan when
// a goal is set (#78), one next step when the person is stuck (#61), and what is next when
// a goal is done. The engine chose the moment; the model chooses what to look up and
// what to propose. Each returns runAgent's result (agent/loop.js); value null: no proposal,
// and the caller keeps its template.
import { runAgent } from "./loop.js";
import { readTools, planTools, stuckTools, nextTools, goalTools } from "./tools.js";
import { closedRefs } from "./github.js";
import { MAX_WORDS } from "../tuck/voice.js";

const VOICE = [
  `Tuck's voice: plain words a friend would say, at most ${MAX_WORDS} words a line, no emoji,`,
  "no exclamation marks, no blame, no advice about discipline or focus. Write in the",
  "language the goal is written in.",
].join("\n");

// #90: a note's next action was the next step on the day it was written, not today.
const HISTORY = [
  "A note's date and age say when it was written. A next action in a note from before",
  "today is history: use it as a step only if nothing later (a newer note, list_tasks,",
  "today's pages) says it is done; otherwise leave it out.",
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
  HISTORY,
  VOICE,
].join("\n");

const STUCK = [
  "You are Tuck, a small focus companion in someone's browser. The person says they are",
  "stuck on their goal. Usually the next step is unclear or too big. Look at the goal, the",
  "last pages they worked on, and their notes about the goal (call the tools you need at",
  "once, in one or two rounds), then finish with",
  "propose_step: one small, concrete action they can start now and do in 5 to 15",
  "minutes, naming the actual thing (a file, a section, a person, a page).",
  HISTORY,
  VOICE,
].join("\n");

// The goal chat: what the person typed is the goal; the notes only make it concrete.
const GOAL = [
  "You are Tuck, a small focus companion. The person just told you what they want to do",
  "today, in their own words. Their words come first. Look up their notes once about the",
  "same thing. If a note is about the same thing, finish with propose_goal: their goal made",
  "concrete with that note (keep their subject), and one first step. If no note is about",
  "the same thing, or there are no notes, finish with keep_goal. Never swap their goal for",
  "another task, however urgent it looks.",
  HISTORY,
  VOICE,
].join("\n");

// Written while the goal is still running, said when it is done (background: goalDoneView).
const NEXT = [
  "You are Tuck, a small focus companion in someone's browser. The person has finished",
  "their goal. Look at their open tasks, then finish with suggest_next: one short line",
  "that says well done plainly and names what could come next, and the id of the one",
  "task you would offer, if any. A task due today or overdue is reminded separately:",
  "do not name it in the line.",
  HISTORY,
  VOICE,
].join("\n");

const tools = (deps, finishing, without = []) => {
  const read = readTools(deps);
  for (const name of without) delete read[name];
  return { ...read, ...finishing };
};

// #91: a step or line naming a PR or issue that is merged or closed is left out before it
// is shown, in code: whether a PR is merged is a fact to look up, not a judgement. The
// trail says what was left out. texts(value): the texts to check; keep(value, closed): the
// value without them, or null.
async function withoutClosed(r, github, texts, keep) {
  if (!r.value) return r;
  const closed = await closedRefs(github, texts(r.value)).catch(() => new Map());
  if (!closed.size) return r;
  const left = [...closed.values()].map(({ ref, state }) => ({
    tool: "github_check",
    args: { ref },
    result: `${state}, left out`,
  }));
  return { ...r, value: keep(r.value, closed), trail: [...r.trail, ...left] };
}

// chat: toolClient's chat. deps: readTools' (agent/tools.js). The goal is known before any
// tool runs, so a step may be built from its words alone.
export const planFor = (chat, deps, { title, due } = {}, opts = {}) =>
  runAgent(chat, {
    system: PLAN,
    user: [`Goal just set: ${title}`, due ? `Due: ${due}` : null].filter(Boolean).join("\n"),
    tools: tools(deps, planTools, ["look_at_page"]),
    ctx: { goal: { title } },
    ...opts,
  }).then((r) =>
    withoutClosed(
      r,
      deps.github,
      (v) => [...v.steps.map((s) => s.step), v.watchOut ?? ""],
      // Every step left out: no plan, as if the model had said no_plan.
      (v, closed) => {
        const steps = v.steps.filter((_, i) => !closed.has(i));
        return steps.length ? { steps, watchOut: closed.has(v.steps.length) ? null : v.watchOut } : null;
      },
    ),
  );

export const stuckStep = (chat, deps, { title, step, said } = {}, opts = {}) =>
  runAgent(chat, {
    system: STUCK,
    user: [
      `Their goal: ${title}`,
      step ? `Current step: ${step}` : null,
      said ? `They said: ${said}` : "They pressed: I'm stuck",
    ]
      .filter(Boolean)
      .join("\n"),
    tools: tools(deps, stuckTools),
    ctx: { goal: { title, step } },
    ...opts,
  }).then((r) =>
    withoutClosed(
      r,
      deps.github,
      (v) => [v.step],
      () => null,
    ),
  );

export const nextAfter = (chat, deps, { title } = {}, opts = {}) =>
  runAgent(chat, {
    system: NEXT,
    user: `Goal just finished: ${title}`,
    tools: tools(deps, nextTools, ["look_at_page"]),
    ctx: { goal: { title } },
    ...opts,
  }).then((r) =>
    withoutClosed(
      r,
      deps.github,
      (v) => [v.message, v.task?.title ?? ""],
      // A closed one in the line: the template says it. In the task offered: no task.
      (v, closed) => (closed.has(0) ? null : { ...v, task: null }),
    ),
  );

export const goalFrom = (chat, deps, { said } = {}, opts = {}) =>
  runAgent(chat, {
    system: GOAL,
    user: `They said: ${said}`,
    tools: tools(deps, goalTools, ["look_at_page", "recent_activity"]),
    ctx: { said, goal: { title: said } },
    readRounds: 1,
    ...opts,
  });

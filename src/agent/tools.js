// The agent's tools (#81), for agent/loop.js. Read tools look things up through the
// background's own code (memory's search, the to-do list, the event log, the second look's
// excerpt) and return data; a finishing tool ends the loop with what Tuck proposes, checked
// here. None acts by itself: a proposal reaches the page as words and buttons.
import { followsVoice, MAX_WORDS } from "../tuck/voice.js";

const noArgs = { type: "object", properties: {} };

// deps: {recall(query) -> [{title, topic, text}], tasks() -> [{id, title, when}],
// activity() -> [{title, host, label, minutesAgo}], page() -> {title, excerpt} | {skipped},
// goal() -> {title, step, minutesOn}}. Each is wired in the background and already redacted.
// Whatever a tool returns is also kept in ctx, so a finishing tool can check its words
// against what was read.
export function readTools(deps) {
  return {
    recall_notes: {
      description: "Search the person's own notes. Returns up to 5 notes with their title, topic and text.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A few words: the goal, a project, a person" } },
        required: ["query"],
      },
      run: async ({ query } = {}, ctx) => {
        const notes = (await deps.recall(String(query ?? "").slice(0, 120))).slice(0, 5);
        (ctx.notes ??= []).push(...notes);
        return { notes };
      },
      summary: ({ notes }) => `${notes.length} note${notes.length === 1 ? "" : "s"}`,
    },
    list_tasks: {
      description: "The person's open tasks, most urgent first, with when each is due.",
      parameters: noArgs,
      run: async (_args, ctx) => {
        const tasks = (await deps.tasks()).slice(0, 8);
        ctx.tasks = tasks;
        return { tasks };
      },
      summary: ({ tasks }) => `${tasks.length} task${tasks.length === 1 ? "" : "s"}`,
    },
    recent_activity: {
      description: "The pages the person was on in the last 30 minutes: title, site, and whether each served the goal.",
      parameters: noArgs,
      run: async (_args, ctx) => {
        const pages = (await deps.activity()).slice(0, 8);
        ctx.pages = pages;
        return { pages };
      },
      summary: ({ pages }) => `${pages.length} page${pages.length === 1 ? "" : "s"}`,
    },
    look_at_page: {
      description: "A short excerpt of the last work page, where the person was working. Some pages are never read.",
      parameters: noArgs,
      run: async (_args, ctx) => {
        const page = await deps.page();
        ctx.page = page;
        return page;
      },
      summary: (p) => (p.skipped ? `skipped (${p.skipped})` : `read ${p.excerpt.length} characters`),
    },
    goal: {
      description: "The person's current goal, its next step if one is set, and minutes spent on it.",
      parameters: noArgs,
      run: async (_args, ctx) => {
        const goal = await deps.goal();
        ctx.goal = goal;
        return { goal };
      },
      summary: ({ goal }) => (goal ? "the goal" : "no goal"),
    },
  };
}

// ---- What a proposal must be ----------------------------------------------

const STOP = new Set(
  "about after again also back before being both does done each from have here into just like make more most much need next only other over same some such take than that their them then there these they this those very want were what when where which while will with work would your yours step steps task tasks goal plan".split(
    " ",
  ),
);

// Content words, lowercased, Turkish İ/ı folded: "Write the failing tests" → write, failing, tests.
function words(text = "") {
  return (
    String(text)
      .replace(/[İI]/g, "i")
      .replace(/ı/g, "i")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .match(/[\p{L}\p{N}]{4,}/gu)
      ?.filter((w) => !STOP.has(w)) ?? []
  );
}

// Everything the agent read, plus the goal: what a step may be built from.
function grounds(ctx, extra = []) {
  const texts = [
    ctx.goal?.title,
    ctx.goal?.step,
    ...extra,
    ...(ctx.notes ?? []).flatMap((n) => [n.title, n.text]),
    ...(ctx.tasks ?? []).map((t) => t.title),
    ...(ctx.pages ?? []).map((p) => p.title),
    ctx.page?.title,
    ctx.page?.excerpt,
  ];
  return new Set(texts.flatMap((t) => words(t)).map((w) => w.slice(0, 5)));
}

// A step that names something real: a word of it (by its first 5 letters, so "tests" meets
// "testing") is in the goal or in what was read.
const grounded = (text, ground) => words(text).some((w) => ground.has(w.slice(0, 5)));

// Advice that fits any goal, so it says nothing about this one: a stock phrase, or a
// vague verb with at most one word after it ("Review notes", but not "Review the cart diff").
const GENERIC_PHRASE =
  /\b(your (work|day|tasks?|goals?|time|priorities)|stay focused|take a break|get started|break (it|the task) down|make a (list|plan)|set (a )?goals?)\b/i;
const VAGUE_VERB = /^(plan|organi[sz]e|prioriti[sz]e|focus|review|reflect|brainstorm|relax|breathe|think)\b/i;
export const generic = (text) => GENERIC_PHRASE.test(text) || (VAGUE_VERB.test(text) && words(text).length <= 2);

// One step: in Tuck's voice, at most MAX_WORDS words, not generic, and built from the
// goal or what was read. Throws with the reason, which the model is told.
function checkStep(step, ground) {
  const text = String(step ?? "").trim();
  if (!text) throw new Error("a step is empty");
  if (!followsVoice(text)) throw new Error(`"${text}" breaks the rules: at most ${MAX_WORDS} words, no "!", no emoji`);
  if (generic(text)) throw new Error(`"${text}" is generic: name the actual thing from the goal or the notes`);
  if (!grounded(text, ground)) throw new Error(`"${text}" names nothing from the goal or what you read`);
  return text;
}

const clamp = (n, lo, hi, dflt) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt);

// #78: a short plan for the goal just set, from the person's notes or not at all.
export const planTools = {
  make_plan: {
    description:
      "Finish with a plan of 3 to 5 steps for the goal, each built from the goal or the notes you read, and at most one thing to watch out for that a note names.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              step: { type: "string", description: `At most ${MAX_WORDS} words, starting with a verb` },
              minutes: { type: "integer", description: "5 to 60" },
            },
            required: ["step", "minutes"],
          },
        },
        watch_out: { type: "string", description: "Optional: a deadline, rule or lesson from a note" },
      },
      required: ["steps"],
    },
    finish: (args, ctx) => {
      if (!ctx.notes?.length) throw new Error("no notes were read: call recall_notes, or no_plan if nothing fits");
      const ground = grounds(ctx);
      const raw = Array.isArray(args?.steps) ? args.steps : [];
      if (raw.length < 3 || raw.length > 5) throw new Error(`a plan has 3 to 5 steps, not ${raw.length}`);
      const steps = raw.map((s) => ({ step: checkStep(s?.step, ground), minutes: clamp(s?.minutes, 5, 60, 15) }));
      // The watch-out is kept only when a note backs it; a weak one is dropped, not argued over.
      const w = String(args?.watch_out ?? "").trim();
      const watchOut = w && w.split(/\s+/).length <= 20 && !w.includes("!") && grounded(w, ground) ? w : null;
      return { steps, watchOut };
    },
  },
  no_plan: {
    description: "Finish with no plan: the notes say nothing about how to do this goal.",
    parameters: { type: "object", properties: { reason: { type: "string" } } },
    finish: () => null,
  },
};

// #61: one small next step for someone stuck on their goal.
export const stuckTools = {
  propose_step: {
    description: `Finish with one small, concrete next step for the goal, at most ${MAX_WORDS} words, starting with a verb, doable in 5 to 15 minutes.`,
    parameters: {
      type: "object",
      properties: { step: { type: "string" }, minutes: { type: "integer", description: "5 to 15" } },
      required: ["step"],
    },
    finish: (args, ctx) => ({
      step: checkStep(args?.step, grounds(ctx)),
      minutes: clamp(args?.minutes, 5, 15, 10),
    }),
  },
};

// A goal was just finished: one line about what is next, and at most one task to offer.
export const nextTools = {
  suggest_next: {
    description: `Finish with one line for the person (at most ${MAX_WORDS} words), and optionally the id of one task from list_tasks to offer next.`,
    parameters: {
      type: "object",
      properties: { message: { type: "string" }, task_id: { type: "string" } },
      required: ["message"],
    },
    finish: (args, ctx) => {
      const message = String(args?.message ?? "").trim();
      if (!followsVoice(message))
        throw new Error(`"${message}" breaks the rules: at most ${MAX_WORDS} words, no "!", no emoji`);
      const id = args?.task_id;
      const task = id ? (ctx.tasks ?? []).find((t) => t.id === id) : null;
      if (id && !task) throw new Error(`no task "${id}" came from list_tasks`);
      return { message, task: task ? { id: task.id, title: task.title } : null };
    },
  },
};

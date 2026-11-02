// LLM#6: which of the person's open loops are real tasks, still open. Structured output,
// no tools. Runs at import and re-sync, never on the nudge path.
//
// Memory counts every entry that names a next action as an open loop (memory/brain.js),
// so a fact note that says "check X" is one, and nothing marks a loop done. This node
// keeps the ones the person still has to do, with a short title. It never decides what
// is urgent: the deadline is read from the text in code and the order stays memory's
// (docs/INTENT.md, "Facts and timing are deterministic").
import { extractJsonObject } from "./json.js";
import { taskKey } from "../attention/reminders.js";

const BATCH = 15;
const CONCURRENCY = 3;
const LATER = 6; // later notes on the same topic shown with each entry
const KIN = 4; // and notes on the topic whose titles share its words
const TASK_WORDS = 10;
const FIELD_CHARS = 300;

const SYSTEM = [
  "You read entries from someone's own notes. Each one names a next action. Say for each",
  "whether it is a task this person still has to do, so a focus companion can keep a",
  "short to-do list for them.",
  "- is_task: true only when the next action is something they (or their team) have to",
  "  do: send, write, build, fix, book, ask, decide, buy, apply. False for a reminder to",
  "  keep watching something, a rule or fact to remember, or a note with no action.",
  "- still_open: false when the entry or another note on the same topic shows it was",
  "  done, submitted, merged, sent, cancelled or replaced. True when nothing shows that.",
  "- task: the action in at most 10 words, as an instruction, in the note's language. No",
  "  dates: the deadline is read separately.",
  "- who: the person it is with or for, when the note names one; else null.",
  "- personal: true for health, body, dating, family, money or home; false for work,",
  "  study and projects.",
  "Write nothing you cannot point to in the notes.",
  'Reply with one JSON object only: {"items": [{"n": 1, "is_task": true,',
  '"still_open": true, "task": "...", "who": null, "personal": false}]}, one item per',
  "entry, in order.",
].join("\n");

const fold = (s) => s.replace(/[İIı]/g, "i").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const COMMON = new Set("the and for with from that this into after before when what then than".split(" "));
const wordsOf = (s = "") =>
  new Set(
    fold(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3 && !COMMON.has(w)),
  );

// sample: memory.profileSample({ limit: Infinity }), newest first. The other notes on the
// same topic that can say whether this entry closed: the ones written after it, oldest
// first, and the ones whose titles share two of its words. The sample has no dates and
// keeps no order within a day, so a note from the same day ("application submitted") is
// found by its words. Titles only.
export function laterOnTopic(entry, sample, { later = LATER, kin = KIN } = {}) {
  const at = sample.findIndex((s) => s.topic === entry.topic && s.title === entry.title);
  const same = (s, i) => i !== at && s.topic === entry.topic;
  const after =
    at > 0
      ? sample
          .slice(0, at)
          .filter((s) => s.topic === entry.topic)
          .reverse()
          .slice(0, later)
      : [];
  const own = wordsOf(entry.title);
  const shared = (s) => [...wordsOf(s.title)].filter((w) => own.has(w)).length >= 2;
  const near = sample.filter((s, i) => same(s, i) && !after.includes(s) && shared(s)).slice(0, kin);
  return [...after, ...near].map((s) => s.title);
}

// FNV-1a: a verdict holds while the entry and its later notes are unchanged.
export function taskHash(entry, later) {
  const text = JSON.stringify([
    entry.kind,
    entry.topic,
    entry.date,
    entry.title,
    entry.context,
    entry.result,
    entry.next,
    later,
  ]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const cut = (s, n = FIELD_CHARS) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

// items: [{ entry, later }]. clean: what each text goes through first (redact).
export function taskMessages(items, { clean = (s) => s } = {}) {
  const blocks = items.map(({ entry: e, later }, i) =>
    [
      `${i + 1}. [${e.topic}] ${e.kind}, ${e.date}: ${clean(cut(e.title, 120))}`,
      `   Context: ${clean(cut(e.context))}`,
      `   Result: ${clean(cut(e.result))}`,
      `   Next action: ${clean(cut(e.next))}`,
      later.length ? `   Other notes on this topic: ${later.map((t) => `"${clean(cut(t, 120))}"`).join("; ")}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: ["Their entries:", ...blocks].join("\n\n") },
  ];
}

const words = (s) => s.trim().split(/\s+/).slice(0, TASK_WORDS).join(" ");

// Returns the valid items by entry number; an item that does not parse is left out, and
// that entry is asked again at the next import.
export function parseTasks(text, count) {
  const raw = extractJsonObject(text);
  if (!Array.isArray(raw.items)) throw new Error("items must be an array");
  const out = new Map();
  for (const it of raw.items) {
    const n = Number(it?.n);
    if (!Number.isInteger(n) || n < 1 || n > count || out.has(n)) continue;
    if (typeof it.is_task !== "boolean" || typeof it.still_open !== "boolean") continue;
    const task = typeof it.task === "string" ? words(it.task).slice(0, 100) : "";
    if (it.is_task && it.still_open && !task) continue;
    out.set(n, {
      isTask: it.is_task,
      open: it.still_open,
      task,
      who: typeof it.who === "string" && it.who.trim() ? it.who.trim().slice(0, 60) : null,
      personal: it.personal === true,
    });
  }
  if (!out.size) throw new Error("no valid item in the reply");
  return out;
}

// One call for one batch. Returns {verdicts: Map | null, source, latencyMs, error?}.
export async function judgeBatch(complete, items, { clean, now = Date.now } = {}) {
  const started = now();
  const messages = taskMessages(items, { clean });
  const opts = { maxTokens: 4000, temperature: 0 };
  try {
    const first = await complete(messages, opts);
    try {
      return { verdicts: parseTasks(first, items.length), source: "llm", latencyMs: now() - started };
    } catch (err) {
      const retry = [
        ...messages,
        { role: "assistant", content: first },
        { role: "user", content: `Your last reply was invalid: ${err.message}. Reply with the JSON object only.` },
      ];
      const second = await complete(retry, opts);
      return { verdicts: parseTasks(second, items.length), source: "llm", latencyMs: now() - started };
    }
  } catch (err) {
    return { verdicts: null, source: "fallback", latencyMs: now() - started, error: err.message ?? String(err) };
  }
}

// An unchecked "- [ ]" in a Markdown folder is a task by construction, still open until it
// is checked or marked Done: listed under its own title with no call (taskList keeps an
// entry with no verdict as it is).
export const taskByConstruction = (e) => e.source === "markdown" && e.kind === "todo";

// candidates: open loops (memory.taskQueue). sample: memory.profileSample, newest first.
// cache: { [taskKey]: verdict } from the last run. Only entries that are new, or whose
// text or later notes changed, are sent; a batch that fails leaves its entries out of the
// cache, so they are asked again next time. Returns { cache, judged, failed, calls, errors }.
export async function extractTasks(
  complete,
  { candidates, sample, cache = {}, clean, now = Date.now, batch = BATCH, concurrency = CONCURRENCY, onProgress },
) {
  const next = {};
  const todo = [];
  for (const entry of candidates) {
    if (taskByConstruction(entry)) continue;
    const later = laterOnTopic(entry, sample);
    const hash = taskHash(entry, later);
    const key = taskKey(entry);
    if (cache[key]?.hash === hash) next[key] = cache[key];
    else todo.push({ entry, later, hash, key });
  }
  const batches = [];
  for (let i = 0; i < todo.length; i += batch) batches.push(todo.slice(i, i + batch));
  let calls = 0;
  let failed = 0;
  let done = 0;
  const errors = new Set();
  const run = async () => {
    while (batches.length) {
      const items = batches.shift();
      const r = await judgeBatch(complete, items, { clean, now });
      calls += 1;
      if (!r.verdicts) {
        failed += items.length;
        errors.add(r.error);
      } else
        items.forEach((it, i) => {
          const v = r.verdicts.get(i + 1);
          if (v) next[it.key] = { ...v, hash: it.hash, at: now() };
          else failed += 1;
        });
      done += items.length;
      onProgress?.({ done, total: todo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, run));
  return { cache: next, judged: todo.length - failed, failed, calls, errors: [...errors] };
}

// The whole step, for the settings page and the worker alike. storage: chrome.storage.local
// (or a fake), where the verdicts live under "taskVerdicts", next to "loops"
// (attention/reminders.js). Goals set in the extension and loops already answered are not
// asked about.
export async function refreshTasks(complete, { memory, storage, today, clean, onProgress }) {
  const { taskVerdicts = {}, loops = {} } = await storage.get(["taskVerdicts", "loops"]);
  const candidates = (await memory.taskQueue({ today, limit: Infinity })).filter(
    (e) => e.source !== "extension" && !loops[e.id]?.doneAt && !loops[e.id]?.notTaskAt,
  );
  const sample = await memory.profileSample({ limit: Infinity });
  const r = await extractTasks(complete, { candidates, sample, cache: taskVerdicts, clean, onProgress });
  await storage.set({ taskVerdicts: r.cache });
  return { ...r, candidates: candidates.length };
}

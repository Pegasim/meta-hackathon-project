// LLM#6: which of the person's open loops are real tasks, still open. Structured output,
// no tools. Runs at import and re-sync, never on the nudge path.
//
// Memory counts every entry that names a next action as an open loop (memory/brain.js),
// so a fact note that says "check X" is one, and nothing marks a loop done. This node
// keeps the ones the person still has to do, with a short title. It never decides what
// is urgent: the deadline is read from the text in code and the order stays memory's
// (docs/INTENT.md, "Facts and timing are deterministic").
import { extractJsonObject } from "./json.js";
import { taskKey, pairKey } from "../attention/reminders.js";
import { writtenBy, ageOf } from "../memory/context.js";
import { localDate } from "../memory/due.js";

const BATCH = 15;
const CONCURRENCY = 3;
const LATER = 6; // later notes on the same topic shown with each entry
const KIN = 4; // and notes on the topic whose titles share its words
const TASK_WORDS = 10;
const MATCH_WORDS = 6;
const FIELD_CHARS = 300;
const RESULT_CHARS = 150; // a later note's result line (#76)
// Hidden reasoning counts against max_tokens: 15 invented entries took 6,700 to 10,629
// reasoning tokens at the default effort (#43). A cap, not a target. Low effort: on the
// task eval it got the same answers as the default (21 of 22) in a third of the time,
// 14-20 s per batch of 15 against 50-58 s, under the worker's 30-second fetch limit.
const MAX_TOKENS = 32000;
const EFFORT = "low";
// One commitment, one row (#47): candidate pairs per call, and at most this many asked in
// one run; the rest are asked at the next import.
const PAIRS_PER_CALL = 20;
const PAIRS_MAX = 60;
// In every verdict's hash: a change to the rules below asks about every entry again.
const RULES = 3; // 2: commitments, not a coding agent's steps (#75); 3: later notes' results, steps under way (#76)

const SYSTEM = [
  "You read entries from someone's own notes. Each one names a next action. Say for each",
  "whether it is a task this person still has to do, so a focus companion can keep a",
  "short to-do list for them.",
  "- is_task: true only when it is a commitment they would write on their own to-do",
  "  list: an outcome with something to deliver, a person or a date (send the report,",
  "  book the dentist, pay the bill, fix the bug users reported, review a colleague's",
  "  doc). An action on a set date is one too, even a check (look up the results when",
  "  they are announced). False for a reminder to keep watching something with no date,",
  "  a rule or fact to remember, or a note with no action.",
  "- Many entries are notes a coding agent wrote at the end of a session, and their next",
  "  action is the agent's next step inside the work: merge or review a pull request, run",
  "  tests or evals, rebase, commit or push, delete a branch, change a setting in the",
  "  code, open or close an issue. Such a step is not a task (is_task false), unless it is",
  "  the only trace of a larger commitment still open (a release, a feature someone was",
  "  promised, a submission, a deliverable for a person). Then is_task is true and task",
  '  names that larger thing: "Ship the Linux bridge", not "Merge PR #45".',
  "- Each entry says how long ago it was written and by whom. A coding agent's step from",
  "  weeks ago that no later note mentions is most likely done: still_open false.",
  "- still_open: false when the entry or another note on the same topic shows it was",
  "  done, submitted, merged, sent, cancelled or replaced. True when nothing shows that.",
  "  The other notes come with their date and result. Notes from the same day carry no",
  "  time, so one may have been written before or after the entry.",
  '- A planning, coordination or "decide how to" step is closed (still_open false) when',
  "  later notes or their browsing show the work being carried out or finished.",
  "- Their browsing over the last day, when given, is evidence for still_open only:",
  "  never make a task from it, and never keep a task open because of it.",
  "- task: the action in at most 10 words, as an instruction, in the note's language. No",
  "  dates: the deadline is read separately. Name what the action is for (the",
  "  programme, person, project or document), from the entry's title or context when",
  '  the next action leaves it out: "Decide whether to submit the grant application',
  '  late", not "Decide whether to upload video and submit late".',
  "- match: the same action in 2 to 6 plain English words, lowercase, whatever language",
  "  the note is in. It is never shown: it only finds the same task written in another",
  "  language. Steps of the same larger thing get the same match.",
  "- who: the person it is with or for, when the note names one; else null.",
  "- personal: true for health, body, dating, family, money or home; false for work,",
  "  study and projects.",
  "Write nothing you cannot point to in the notes.",
  'Reply with one JSON object only: {"items": [{"n": 1, "is_task": true,',
  '"still_open": true, "task": "...", "match": "...", "who": null, "personal": false}]},',
  "one item per entry, in order.",
].join("\n");

const fold = (s) => s.replace(/[İIı]/g, "i").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const COMMON = new Set("the and for with from that this into after before when what then than".split(" "));
const wordsOf = (s = "", min = 4) =>
  new Set(
    fold(s)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= min && !COMMON.has(w)),
  );

// sample: memory.profileSample({ limit: Infinity }), newest first. The other notes on the
// same topic that can say whether this entry closed: the ones written after it, oldest
// first, and the ones whose titles share two of its words. Entries carry a date and no
// time, and a day's notes sort by title, so every note from the entry's own day may be a
// later one, and all of them go (#76); `later` and `kin` stay the caps. A sample with no
// dates falls back to its own order. Returns [{ title, date?, result? }].
export function laterOnTopic(entry, sample, { later = LATER, kin = KIN } = {}) {
  const at = sample.findIndex((s) => s.topic === entry.topic && s.title === entry.title);
  const same = (s, i) => i !== at && s.topic === entry.topic;
  const day = entry.date?.slice(0, 10);
  const isLater = (s, i) => same(s, i) && (day && s.date ? s.date.slice(0, 10) >= day : i < at);
  const after = sample.filter(isLater).reverse().slice(0, later);
  const own = wordsOf(entry.title);
  const shared = (s) => [...wordsOf(s.title)].filter((w) => own.has(w)).length >= 2;
  const near = sample.filter((s, i) => same(s, i) && !after.includes(s) && shared(s)).slice(0, kin);
  return [...after, ...near].map(({ title, date, result }) => ({
    title,
    ...(date && { date: date.slice(0, 10) }),
    ...(result && result !== "none" && { result }),
  }));
}

// FNV-1a: a verdict holds while the entry and its later notes are unchanged, the rules are
// the same, and the entry's age is in the same band (a week, a month, older), since the
// node reads an old agent step as likely done.
export function taskHash(entry, later, today) {
  const text = JSON.stringify([
    RULES,
    today ? ageBand(ageOf(entry, today)) : null,
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

const ageBand = (days) => (days == null ? null : days <= 7 ? 0 : days <= 30 ? 1 : 2);

const WRITERS = {
  own: "by them",
  agent: "by a coding agent, at the end of a session",
  distilled: "by a summary job, from a conversation",
};
// "Written 17 days ago, by a coding agent, at the end of a session" (#76).
function written(e, today) {
  const age = ageOf(e, today);
  const when =
    age == null ? "Written" : age <= 0 ? "Written today" : age === 1 ? "Written yesterday" : `Written ${age} days ago`;
  return `${when}, ${WRITERS[e.writer ?? writtenBy(e)]}`;
}

const cut = (s, n = FIELD_CHARS) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);

// One later note: `- 2026-11-04 "Title": result`. A plain string is a title alone.
function laterLine(note, clean) {
  const { title, date, result } = typeof note === "string" ? { title: note } : note;
  const said = result ? `: ${clean(cut(result, RESULT_CHARS))}` : "";
  return `   - ${date ? `${date} ` : ""}"${clean(cut(title, 120))}"${said}`;
}

// items: [{ entry, later }]. clean: what each text goes through first (redact). today: the
// date each entry's age is counted from. activity: the last day's browsing as
// renderSummary writes it (sites, minutes, top titles), once for the whole batch, or null.
export function taskMessages(items, { clean = (s) => s, today = localDate(), activity = null } = {}) {
  const blocks = items.map(({ entry: e, later }, i) =>
    [
      `${i + 1}. [${e.topic}] ${e.kind}, ${e.date}: ${clean(cut(e.title, 120))}`,
      `   ${written(e, today)}`,
      `   Context: ${clean(cut(e.context))}`,
      `   Result: ${clean(cut(e.result))}`,
      `   Next action: ${clean(cut(e.next))}`,
      ...(later.length ? ["   Other notes on this topic:", ...later.map((n) => laterLine(n, clean))] : []),
    ].join("\n"),
  );
  const browsing = activity ? [`Their browsing over the last day, for still_open only:\n${clean(activity)}`] : [];
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: [...browsing, "Their entries:", ...blocks].join("\n\n") },
  ];
}

const words = (s, n = TASK_WORDS) => s.trim().split(/\s+/).slice(0, n).join(" ");
// The English key, as plain lowercase words: only ever compared, never shown.
const matchKey = (s) =>
  typeof s === "string" ? words(s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " "), MATCH_WORDS).slice(0, 60) : "";

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
    const match = matchKey(it.match);
    out.set(n, {
      isTask: it.is_task,
      open: it.still_open,
      task,
      who: typeof it.who === "string" && it.who.trim() ? it.who.trim().slice(0, 60) : null,
      personal: it.personal === true,
      ...(match && { match }),
    });
  }
  if (!out.size) throw new Error("no valid item in the reply");
  return out;
}

// One call for one batch. Returns {verdicts: Map | null, source, latencyMs, error?, cut?}.
// cut: the reply hit the token limit, so a smaller batch may fit.
export async function judgeBatch(complete, items, { clean, today, activity, now = Date.now, effort = EFFORT } = {}) {
  const started = now();
  const messages = taskMessages(items, { clean, today, activity });
  const opts = { maxTokens: MAX_TOKENS, temperature: 0, reasoningEffort: effort, whole: true };
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
    return {
      verdicts: null,
      source: "fallback",
      latencyMs: now() - started,
      error: err.message ?? String(err),
      cut: err.cut === true,
    };
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
  {
    candidates,
    sample,
    cache = {},
    clean,
    today = localDate(),
    activity = null,
    now = Date.now,
    batch = BATCH,
    concurrency = CONCURRENCY,
    onProgress,
  },
) {
  const next = {};
  const todo = [];
  for (const entry of candidates) {
    if (taskByConstruction(entry)) continue;
    const later = laterOnTopic(entry, sample);
    const hash = taskHash(entry, later, today);
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
      const r = await judgeBatch(complete, items, { clean, today, activity, now });
      calls += 1;
      // Cut at the limit: ask again in two halves, down to one entry, so that one long
      // batch does not leave all of its entries unread.
      if (r.cut && items.length > 1) {
        const half = Math.ceil(items.length / 2);
        batches.unshift(items.slice(0, half), items.slice(half));
        continue;
      }
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

// ---- One commitment, one row (#47) ------------------------------------------

// A word on many of the tasks (a project's name) says nothing about which task it is.
const COMMON_SHARE = 0.2;
// Nor does the verb: "book the dentist" and "book a haircut" share only how it is done.
const ACTIONS = new Set(
  "book call send write make finish check prepare review update decide pick start draft order file plan read submit reply email meet apply renew".split(
    " ",
  ),
);
// Six letters: "application" and "applications", "submit" and "submitted" are one word.
const stems = (s, min) => new Set([...wordsOf(s, min)].filter((w) => !ACTIONS.has(w)).map((w) => w.slice(0, 6)));

// items: [{ key, entry, task, match? }], the tasks the list keeps (task: the node's title,
// match: its English key). The pairs worth asking the model about, most shared words first.
// Words are the node's title and the entry's; a long note shares words with many others, so
// what counts is the share of the shorter one's words: all of them, or half (two at least),
// or a quarter with the same deadline, or half on the same topic within three days (a
// third, with two words). The same rules run once more on the English keys, so a Turkish
// note and an English one for the same task are found; an item without a key (a verdict
// from before keys, a Markdown checkbox) is found by its words only. On one real brain's
// 229 open loops the word rules gave about 100 pairs, against 26,000 for every two. Code
// only, so the model never sees every two tasks.
export function candidatePairs(items) {
  const words = usefulWords(
    items.map(({ entry, task }) => stems(`${task} ${entry.title}`)),
    items.length,
  );
  // Three letters in a key: "car", "tax" and "vet" are the whole task.
  const keyed = items.filter(({ match }) => match).length;
  const keys = usefulWords(
    items.map(({ match }) => (match ? stems(match, 3) : new Set())),
    keyed,
  );
  const days = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) / 864e5;
  const out = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const [a, b] = [items[i].entry, items[j].entry];
      const sameDue = !!a.due && a.due === b.due;
      const near = a.topic === b.topic && days(a.date, b.date) <= 3;
      const by = [words, keys].map((bags) => overlap(bags[i], bags[j], { sameDue, near }));
      const shared = Math.max(...by.map((o) => o.shared));
      if (by.some((o) => o.pair))
        out.push({ key: pairKey(items[i].key, items[j].key), a: items[i], b: items[j], shared });
    }
  return out.sort((x, y) => y.shared - x.shared);
}

// Each bag without the words on many of the n tasks.
function usefulWords(bags, n) {
  const df = new Map();
  for (const bag of bags) for (const w of bag) df.set(w, (df.get(w) ?? 0) + 1);
  const limit = Math.max(3, Math.ceil(n * COMMON_SHARE));
  return bags.map((bag) => [...bag].filter((w) => df.get(w) <= limit));
}

function overlap(x, y, { sameDue, near }) {
  const shared = x.filter((w) => y.includes(w)).length;
  if (!shared) return { shared, pair: false };
  const share = shared / Math.min(x.length, y.length);
  const close = near && (share >= 0.5 || (shared >= 2 && share >= 0.33));
  return { shared, pair: share === 1 || (shared >= 2 && share >= 0.5) || (sameDue && share >= 0.25) || close };
}

const PAIR_SYSTEM = [
  "You compare pairs of tasks from someone's own notes, so their to-do list can show each",
  "commitment once. For each pair, say whether A and B are the same commitment: one piece",
  "of work, where doing it once finishes both. A later note that restates, narrows or",
  "updates the same task is the same, also when it comes from another notebook or app.",
  "Two tasks are different when they are separate pieces of work, even on the same",
  "project, with the same person or by the same deadline (writing a talk's abstract and",
  "booking its venue; the October and the November newsletter). When unsure, say false:",
  "a task listed twice is better than a task hidden.",
  'Reply with one JSON object only: {"pairs": [{"n": 1, "same": false}]}, one item per',
  "pair, in order.",
].join("\n");

const side = (label, { entry: e, task }, clean) =>
  [
    `   ${label}: [${e.topic}] ${e.kind}, ${e.date}: ${clean(cut(e.title, 120))}`,
    `      Task: ${clean(cut(task, 120))}`,
    `      Next action: ${clean(cut(e.next))}`,
    `      Context: ${clean(cut(e.context, 200))}`,
    e.due ? `      Due: ${e.due}` : null,
  ]
    .filter(Boolean)
    .join("\n");

// pairs: candidatePairs' output. clean: what each text goes through first (redact).
export function pairMessages(pairs, { clean = (s) => s } = {}) {
  const blocks = pairs.map((p, i) => [`${i + 1}.`, side("A", p.a, clean), side("B", p.b, clean)].join("\n"));
  return [
    { role: "system", content: PAIR_SYSTEM },
    { role: "user", content: ["The pairs:", ...blocks].join("\n\n") },
  ];
}

// Returns same-or-not by pair number; an item that does not parse is left out, and that
// pair is asked again at the next import.
export function parsePairs(text, count) {
  const raw = extractJsonObject(text);
  if (!Array.isArray(raw.pairs)) throw new Error("pairs must be an array");
  const out = new Map();
  for (const it of raw.pairs) {
    const n = Number(it?.n);
    if (!Number.isInteger(n) || n < 1 || n > count || out.has(n) || typeof it.same !== "boolean") continue;
    out.set(n, it.same);
  }
  if (!out.size) throw new Error("no valid item in the reply");
  return out;
}

// A verdict on a pair holds while both entries and the node's titles are unchanged.
const pairHash = ({ a, b }) => taskHash({ ...a.entry, title: `${a.entry.title}|${a.task}` }, [b.entry, b.task]);

// cache: { [pairKey]: { same, hash, at } } from the last run. Only new or changed pairs
// are asked, at most `max` of them; a call that fails leaves its pairs unasked, and so
// ungrouped. Returns { cache, asked, failed, calls, errors }.
export async function judgePairs(
  complete,
  pairs,
  { cache = {}, clean, now = Date.now, max = PAIRS_MAX, perCall = PAIRS_PER_CALL, effort = EFFORT } = {},
) {
  const next = {};
  const todo = [];
  for (const p of pairs) {
    const hash = pairHash(p);
    if (cache[p.key]?.hash === hash) next[p.key] = cache[p.key];
    else if (todo.length < max) todo.push({ ...p, hash });
  }
  const opts = { maxTokens: MAX_TOKENS, temperature: 0, reasoningEffort: effort, whole: true };
  let calls = 0;
  let failed = 0;
  const errors = new Set();
  for (let i = 0; i < todo.length; i += perCall) {
    const chunk = todo.slice(i, i + perCall);
    calls += 1;
    try {
      const got = parsePairs(await complete(pairMessages(chunk, { clean }), opts), chunk.length);
      chunk.forEach((p, j) => {
        if (got.has(j + 1)) next[p.key] = { same: got.get(j + 1), hash: p.hash, at: now() };
        else failed += 1;
      });
    } catch (err) {
      failed += chunk.length;
      errors.add(err.message ?? String(err));
    }
  }
  return { cache: next, asked: todo.length, failed, calls, errors: [...errors] };
}

// The last 24 hours of browsing, as memory summarises it (at most 6 sites, 2 titles each),
// or null when there is none. One block per run, never per entry, and not in a verdict's
// hash: a verdict is not asked again because the day went on, only when its notes change.
async function dayOfBrowsing(memory) {
  const act = await memory.activity?.({ minutes: 24 * 60 }).catch(() => null);
  return act?.summary?.sites?.length ? act.text : null;
}

// The whole step, for the settings page and the worker alike. storage: chrome.storage.local
// (or a fake), where the verdicts live under "taskVerdicts", next to "loops"
// (attention/reminders.js). Goals set in the extension and loops already answered are not
// asked about.
export async function refreshTasks(complete, { memory, storage, today, clean, onProgress }) {
  const { taskVerdicts = {}, taskPairs = {}, loops = {} } = await storage.get(["taskVerdicts", "taskPairs", "loops"]);
  const candidates = (await memory.taskQueue({ today, limit: Infinity })).filter(
    (e) => e.source !== "extension" && !loops[e.id]?.doneAt && !loops[e.id]?.notTaskAt,
  );
  const sample = await memory.profileSample({ limit: Infinity });
  const activity = await dayOfBrowsing(memory);
  const r = await extractTasks(complete, {
    candidates,
    sample,
    cache: taskVerdicts,
    clean,
    today,
    activity,
    onProgress,
  });
  // Then which of the tasks it kept are one commitment (#47). A pair that fails is not
  // grouped, and the list still works, so it is not a problem to report.
  const kept = candidates.flatMap((entry) => {
    const v = r.cache[taskKey(entry)];
    if (taskByConstruction(entry)) return [{ key: taskKey(entry), entry, task: entry.title }];
    return v?.isTask && v.open ? [{ key: taskKey(entry), entry, task: v.task, match: v.match }] : [];
  });
  const p = await judgePairs(complete, candidatePairs(kept), { cache: taskPairs, clean });
  // Why this run left entries unread, for a settings page opened later.
  await storage.set({ taskVerdicts: r.cache, taskPairs: p.cache, taskProblem: r.errors.join(" | ") || null });
  return { ...r, candidates: candidates.length, pairCalls: p.calls, pairsAsked: p.asked, pairErrors: p.errors };
}

// Context pack: what the agent needs to judge the current activity.
// The latest stated intent, the open loops related to what is on screen, and
// related notes, rendered as one bounded text block for a model prompt.
import { topicSearch, hostWords } from "./recall.js";
import { openLoops } from "./brain.js";
import { dueOf, daysLeft, dueLabel, localDate } from "./due.js";
import { BRAIN, originOf } from "./sources.js";

const isOpenLoop = (doc) => doc.ref.type === "entry" && doc.item.next && doc.item.next !== "none";

const keyOf = (e) => e.id ?? `${e.date}|${e.title}`;

// Who wrote an entry's next action (#76): "own" (the person: a notes folder, a goal set in
// the extension, pasted memory, an export, `brain add` run by hand), "agent" (a coding
// agent's session note in a second brain) or "distilled" (written by a distill job from
// conversations or activity). A second brain's `brain add` writes "manual" when the person
// runs it and the harness's name otherwise (claude-code, codex, opencode); its nightly
// run writes "brain-distill". An entry with no source is taken as the person's own.
const OWN_SOURCES = new Set(["manual", "meta-hackathon-project"]);
export function writtenBy(e) {
  if (/distill/.test(e.source ?? "")) return "distilled";
  if (originOf(e) === BRAIN && e.source && !OWN_SOURCES.has(e.source)) return "agent";
  return "own";
}
const RANK = { own: 0, agent: 1, distilled: 2 };

// Whole days since an entry was written, or null without a date.
export const ageOf = (e, today) => (e.date ? -daysLeft(e.date.slice(0, 10), today) : null);

// Open loops ordered by how little time is left, soonest first, then the undated ones
// newest first. Plain arithmetic on purpose: what is urgent is never a model
// judgement (docs/INTENT.md, "Facts and timing are deterministic"). Within a deadline,
// and among the undated, the person's own come first, then an agent's, then distilled.
//
// A deadline long past is not a live task: nothing in the brain marks a loop done,
// so without `staleAfter` a note from last year would hold the top of the queue
// forever. Those sink below the undated ones instead of being dropped, because a
// missed deadline is still worth seeing.
//
// A distilled next action is the state of one session, and the distill job writes a new
// one whenever the work comes up again, so one not restated within `distilledFor` days is
// not offered at all (#76), unless it names a deadline still live.
export function taskQueue(entries, { today = localDate(), limit = 5, staleAfter = 14, distilledFor = 14 } = {}) {
  const loops = openLoops(entries).flatMap((e) => {
    const due = dueOf(e);
    const left = daysLeft(due, today);
    const writer = writtenBy(e);
    const live = due && left >= -staleAfter;
    if (writer === "distilled" && !live && ageOf(e, today) > distilledFor) return [];
    return [{ ...e, due, daysLeft: left, writer }];
  });
  const rank = (a, b) => RANK[a.writer] - RANK[b.writer];
  const live = loops
    .filter((e) => e.due && e.daysLeft >= -staleAfter)
    .sort((a, b) => a.due.localeCompare(b.due) || rank(a, b));
  // A notes folder's checkbox is a task the person wrote as one, dated only by its file:
  // among their own undated loops it comes first, not below every newer note (#82).
  const box = (e) => (e.source === "markdown" && e.kind === "todo" ? 0 : 1);
  const undated = loops
    .filter((e) => !e.due)
    .sort((a, b) => rank(a, b) || box(a) - box(b) || (b.date ?? "").localeCompare(a.date ?? ""));
  const stale = loops
    .filter((e) => e.due && e.daysLeft < -staleAfter)
    .sort((a, b) => b.due.localeCompare(a.due) || rank(a, b));
  return [...live, ...undated, ...stale].slice(0, limit);
}

// Dated plans with no next action (#96): "results on 11 Dec", "the lease ends 2027-01-15".
// openLoops leaves them out, so they are not in the queue: never a to-do, never said aloud,
// never read by the task node. Settings shows them in Coming up or Long run with their
// date. Only what is still ahead of `today`, soonest first.
export function upcoming(entries, { today = localDate() } = {}) {
  return entries
    .filter((e) => !e.next || e.next === "none")
    .flatMap((e) => {
      const due = dueOf(e);
      const left = daysLeft(due, today);
      return due && left >= 0 ? [{ ...e, due, daysLeft: left, writer: writtenBy(e), upcoming: true }] : [];
    })
    .sort((a, b) => a.due.localeCompare(b.due));
}

// The user's stated intent: the newest todo they set in the extension and have
// not marked done. Brain todos and distilled todos are open loops, not intents.
export function latestIntent(entries) {
  return entries
    .filter((e) => e.kind === "todo" && e.source === "extension" && !e.done)
    .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || b.date.localeCompare(a.date))[0];
}

// activity: { title, url } of what the user is looking at now.
export function contextPack(index, entries, activity, { loops = 5, notes = 5, today } = {}) {
  const intent = latestIntent(entries);
  const query = [activity.title, hostWords(activity.url), intent?.title].filter(Boolean).join(" ");
  // Topics named by the tab, plus the stated intent's topic, rank first.
  const topics = intent ? [intent.topic] : [];
  return {
    activity,
    intent,
    // Two orderings, and both matter: what is running out, and what resembles the
    // page in front of you.
    queue: taskQueue(entries, { today, limit: loops }),
    openLoops: topicSearch(index, query, { limit: loops, filter: isOpenLoop, topics }).map((d) => d.item),
    related: topicSearch(index, query, { limit: notes, filter: (d) => !isOpenLoop(d), topics }).map((d) => ({
      type: d.ref.type,
      title: d.title,
      text: d.text,
    })),
  };
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function renderPack(pack, { maxChars = 6000 } = {}) {
  // What has a date comes first and says how long is left; the rest keeps the
  // relevance order, minus anything already named above it. The heading says
  // "Deadlines", not "due soon": every line carries its own distance, and calling a
  // date four months out "soon" would read as urgent in the prompt.
  const due = (pack.queue ?? []).filter((e) => e.due);
  const shown = new Set(due.map(keyOf));
  const lines = [
    `Now: ${pack.activity.title} (${pack.activity.url})`,
    pack.intent
      ? `Stated intent (${pack.intent.date}): ${pack.intent.title}; next: ${pack.intent.next}`
      : "Stated intent: none",
    ...(due.length
      ? [
          "",
          "Deadlines:",
          ...due.map((e) => `- [${e.topic}] ${e.title} → due ${e.due} (${dueLabel(e.daysLeft)}); next: ${e.next}`),
        ]
      : []),
    "",
    "Open loops:",
    ...pack.openLoops
      .filter((e) => !shown.has(keyOf(e)))
      .map((e) => `- [${e.date} ${e.topic}] ${e.title} → next: ${e.next}`),
    "",
    "Related:",
    ...pack.related.map((d) => `- ${d.title}: ${clip(d.text.replace(/\s+/g, " "), 300)}`),
  ];
  return clip(lines.join("\n"), maxChars);
}

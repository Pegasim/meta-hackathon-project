// What Tuck reminds the person of, and when it has said enough. Pure: which item, never
// how often Tuck interrupts. It runs only at moments that already exist (a greeting, a
// return, a break's end, a finished goal), so it adds no trigger. Nothing in the notes
// marks a loop done, so "done" is kept here, by entry id, and survives a re-import.

// Close enough to say aloud: due today or tomorrow, or missed within the last week.
const SOONEST_MISSED = -7;
export const isClose = ({ daysLeft }) => daysLeft != null && daysLeft <= 1 && daysLeft >= SOONEST_MISSED;

// loops: { [entryId]: { saidOn, doneAt, notTaskAt } } from chrome.storage.local.
export const stillOpen = (queue, loops = {}) => queue.filter((e) => !loops[e.id]?.doneAt && !loops[e.id]?.notTaskAt);

// How an entry is known across imports: its stable id, as memory's own queue keys it.
export const taskKey = (e) => e.id ?? `${e.date}|${e.title}`;

// Topics that are the person's own life, for an entry the task node has not read yet.
const PERSONAL = /^(personal|health|fitness|body|dating|family|money|home)(-|$)/;

// The to-do list: memory's queue in its own order (deadline, then recency), with what the
// task node (agent/tasks.js) made of each entry. One it found no task, or closed, is left
// out, and a task gets the node's short title. One it has not read yet (no model, a
// failed call, a note added since) keeps its own title. verdicts: { [taskKey]: verdict }.
// With loops, what was marked Done or Not a task is left out before entries are grouped,
// so one old answer on a member does not hide the others. pairs and splits: see groupTasks.
export function taskList(queue, { verdicts = {}, hidePersonal = false, loops, pairs = {}, splits = {} } = {}) {
  const list = queue.flatMap((e) => {
    const v = verdicts[taskKey(e)];
    if (hidePersonal && (v ? v.personal : PERSONAL.test(e.topic ?? ""))) return [];
    if (!v) return [e];
    return v.isTask && v.open ? [{ ...e, title: v.task, who: v.who }] : [];
  });
  return groupTasks(loops ? stillOpen(list, loops) : list, { pairs, splits });
}

// One commitment often sits in several entries: restated on a later day, or the same task
// in the brain, a notes folder and a pasted memory (#47). A pair is known the same both ways.
export const pairKey = (a, b) => [a, b].sort().join("~");

const originName = (e) => {
  const origin = e.origin ?? (e.path ? "brain" : "extension");
  if (origin.startsWith("md:")) return origin.slice(3);
  if (origin.startsWith("paste:")) return "pasted memory";
  return origin === "extension" ? "Tuck" : origin;
};

function sourcesOf(members) {
  const counts = new Map();
  for (const e of members) counts.set(originName(e), (counts.get(originName(e)) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(", ");
}

// pairs: { [pairKey]: { same } }, what the task node said of each candidate pair.
// splits: { [pairKey]: ts }, the person's "Not the same". Entries the node called the same
// become one row, unless any two of them were called different or split: a wrong merge
// hides a task, which is worse than a row shown twice. The row stands where its first
// member stood, so the order stays memory's; it takes the newest member's words and its
// deadline, or the latest deadline among the members when that one has none (#94: not
// the newest note's words with the oldest note's date); and it names its sources. Entries
// stay as they are.
export function groupTasks(list, { pairs = {}, splits = {} } = {}) {
  const keys = list.map(taskKey);
  const at = new Map(keys.map((k, i) => [k, i]));
  const group = keys.map((_, i) => [i]);
  const differ = (i, j) => {
    const k = pairKey(keys[i], keys[j]);
    return !!splits[k] || pairs[k]?.same === false;
  };
  for (const [k, v] of Object.entries(pairs)) {
    if (!v.same || splits[k]) continue;
    const [i, j] = k.split("~").map((x) => at.get(x));
    if (i == null || j == null || group[i] === group[j]) continue;
    const [a, b] = [group[i], group[j]];
    if (a.some((x) => b.some((y) => differ(x, y)))) continue;
    a.push(...b);
    for (const y of b) group[y] = a;
  }
  const out = [];
  list.forEach((e, i) => {
    const members = group[i];
    if (members.length === 1) return out.push(e);
    if (Math.min(...members) !== i) return;
    const ordered = [...members].sort((x, y) => x - y).map((x) => list[x]);
    const newest = [...ordered].sort((x, y) => (y.date ?? "").localeCompare(x.date ?? ""))[0];
    const dated = newest.due ? newest : [...ordered].filter((m) => m.due).sort((x, y) => y.due.localeCompare(x.due))[0];
    out.push({
      ...newest,
      due: dated?.due ?? null,
      daysLeft: dated ? dated.daysLeft : null,
      members: ordered.map(taskKey),
      sources: sourcesOf(ordered),
    });
  });
  return out;
}

// The tasks a drift line may name: not one already said today.
export function sayable(queue, loops = {}, today) {
  return stillOpen(queue, loops).filter((e) => isClose(e) && loops[e.id]?.saidOn !== today);
}

// The most urgent thing worth a word now. queue is ordered by time left (memory's
// taskQueue). Not the goal the person is on, and once a day at most.
export function pickReminder(queue, { goalTitle, loops = {}, today }) {
  return sayable(queue, loops, today).find((e) => e.id && e.title !== goalTitle) ?? null;
}

// Settings' views of the one list (#77, #92). Today: the row the current goal came from,
// then what is due today or tomorrow, at most 5. Missed: a deadline that passed within the
// last week, in the list's order. Coming up: dated after tomorrow, within 60 days, soonest
// first. The rest (Long run) keeps the list's order: undated, further off, missed longer
// ago, and what did not fit in Today. Once the person has rows of their own (a notes
// folder, pasted to-dos: writer "own"), rows a coding agent or the distill wrote go to
// suggested instead, in the list's order; with none, suggested is empty. A row grouped
// from several entries is the person's if any of them is: ownKeys holds those entries'
// taskKeys. goalFrom is the goal's fromLoopId, which may name a row or one of its members.
const TODAY_MAX = 5;
const AHEAD_DAYS = 60;
export function splitTasks(list, { goalFrom = null, ownKeys = new Set() } = {}) {
  const isGoal = (e) => goalFrom != null && (e.id === goalFrom || !!e.members?.includes(goalFrom));
  const isOwn = (e) => e.writer === "own" || !!e.members?.some((k) => ownKeys.has(k));
  const suggested = list.some(isOwn) ? list.filter((e) => !isOwn(e) && !isGoal(e)) : [];
  const shown = list.filter((e) => !suggested.includes(e));
  const close = (e) => !isGoal(e) && isClose(e);
  const today = [...shown.filter(isGoal), ...shown.filter((e) => close(e) && e.daysLeft >= 0)].slice(0, TODAY_MAX);
  const missed = shown.filter((e) => close(e) && e.daysLeft < 0);
  const comingUp = shown
    .filter((e) => !today.includes(e) && e.daysLeft > 1 && e.daysLeft <= AHEAD_DAYS)
    .sort((a, b) => a.daysLeft - b.daysLeft);
  const rest = shown.filter((e) => !today.includes(e) && !missed.includes(e) && !comingUp.includes(e));
  return { today, missed, comingUp, rest, suggested };
}

export const markSaid = (loops, id, today) => ({ ...loops, [id]: { ...loops[id], saidOn: today } });
export const markDone = (loops, id, ts) => ({ ...loops, [id]: { ...loops[id], doneAt: ts } });
export const markNotTask = (loops, id, ts) => ({ ...loops, [id]: { ...loops[id], notTaskAt: ts } });
// An answer on a row is an answer on every entry in it (markDone or markNotTask).
export const markAll = (mark, loops, row, ts) => (row.members ?? [row.id]).reduce((l, id) => mark(l, id, ts), loops);
// Not the same: every pair in the row is kept apart from now on.
export function splitRow(splits, row, ts) {
  const ids = row.members ?? [row.id];
  const out = { ...splits };
  ids.forEach((a, i) => ids.slice(i + 1).forEach((b) => (out[pairKey(a, b)] = ts)));
  return out;
}

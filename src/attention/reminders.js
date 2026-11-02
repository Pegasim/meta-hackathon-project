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
export function taskList(queue, { verdicts = {}, hidePersonal = false } = {}) {
  return queue.flatMap((e) => {
    const v = verdicts[taskKey(e)];
    if (hidePersonal && (v ? v.personal : PERSONAL.test(e.topic ?? ""))) return [];
    if (!v) return [e];
    return v.isTask && v.open ? [{ ...e, title: v.task, who: v.who }] : [];
  });
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

export const markSaid = (loops, id, today) => ({ ...loops, [id]: { ...loops[id], saidOn: today } });
export const markDone = (loops, id, ts) => ({ ...loops, [id]: { ...loops[id], doneAt: ts } });
export const markNotTask = (loops, id, ts) => ({ ...loops, [id]: { ...loops[id], notTaskAt: ts } });

// Due dates for entries.
//
// The brain record format has no due field and cannot gain one: `brain consolidate`
// rewrites an entry's frontmatter with a fixed set of keys, so a `due:` written here
// would be dropped on the next nightly run. The date is derived from the text
// instead, which also means notes written before Tuck existed already carry one.
//
// Pure functions, no chrome.* APIs, so they run under node.

const ISO = /\d{4}-\d{2}-\d{2}/g;

// A date counts as a deadline only when one of these sits beside it. Without the
// cue, "On 2026-10-26 Safa said …" would read as a deadline on almost every entry.
// Kept deliberately narrow: a wrong deadline is worse than a missing one, because
// Tuck would then be confidently wrong about what is urgent.
const CUES = ["due", "deadline", "closes", "expires", "last day", "son başvuru", "son tarih", "teslim"];
// Obsidian Tasks writes "📅 2026-11-10" for a due date. It counts only right before the
// date: in "⏳ 2026-11-05 📅 2026-11-10" the scheduled date is not a deadline.
const CUES_BEFORE = ["📅"];

// How far from the date the cue may sit. Deadlines read "deadline is <date>" or
// "<date> son tarih", so the room before the date is the generous side.
const BEFORE = 32;
const AFTER = 16;

const DAY = 24 * 60 * 60 * 1000;

// The fields a deadline is looked for in, nearest-intent first.
const FIELDS = ["next", "result", "title", "context"];

// The user's own day, not UTC: a deadline belongs to the date on their wall.
export const localDate = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

// Every ISO date in `text` that a deadline cue sits next to. A cue never reaches
// across another date, so in "runs 2026-11-13 to 2027-01-05; deadline is 2026-12-01"
// only the last date is a deadline.
export function deadlinesIn(text) {
  if (!text) return [];
  const s = String(text);
  const found = [];
  let prevEnd = 0;
  for (const m of s.matchAll(ISO)) {
    const end = m.index + m[0].length;
    const before = s.slice(Math.max(prevEnd, m.index - BEFORE), m.index).toLowerCase();
    const after = s.slice(end, end + AFTER).toLowerCase();
    const cued =
      CUES.some((cue) => before.includes(cue) || after.includes(cue)) ||
      CUES_BEFORE.some((cue) => before.trimEnd().endsWith(cue));
    if (cued) found.push(m[0]);
    prevEnd = end;
  }
  return found;
}

// The entry's deadline, or null: the earliest cued date that has not already passed
// as of the day the entry was written. ISO dates compare correctly as strings.
export function dueOf(entry) {
  const dates = FIELDS.flatMap((f) => deadlinesIn(entry?.[f])).filter((d) => !entry?.date || d >= entry.date);
  return dates.length ? dates.sort()[0] : null;
}

// Whole days from `today` to `due`: 0 is today, negative is overdue.
export function daysLeft(due, today) {
  if (!due) return null;
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
}

// "today" | "tomorrow" | "in 3 days" | "3 days ago" — the phrasing Tuck can say aloud.
export function dueLabel(days) {
  if (days == null) return null;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

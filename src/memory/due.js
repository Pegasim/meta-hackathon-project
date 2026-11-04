// Due dates for entries.
//
// The brain record format has no due field and cannot gain one: `brain consolidate`
// rewrites an entry's frontmatter with a fixed set of keys, so a `due:` written here
// would be dropped on the next nightly run. The date is derived from the text
// instead, which also means notes written before Tuck existed already carry one.
//
// A wrong deadline is worse than a missing one: Tuck would be confidently wrong about
// what is urgent. So every date form below counts only beside a cue, and every new
// form or cue needs one.
//
// Pure functions, no chrome.* APIs, so they run under node.

// Dates as people write them (#96): 2026-11-08, "8 Nov", "Nov 8", "8 Kasım",
// "11 Aralık 2026", and ranges, "Dec 8-11", where the last day counts. Turkish names are
// also read without their letters ("Kasim", "Aralik") and with a suffix ("Kasım'a").
const EN =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const TR = "ocak|[şs]ubat|mart|nisan|may[ıi]s|haziran|temmuz|a[ğg]ustos|eyl[üu]l|ekim|kas[ıi]m|aral[ıi]k";
const MONTH = `(?<!\\p{L})((?:${EN})\\.?(?!\\p{L})|${TR})`;
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-–]\\s*(\\d{1,2})(?:st|nd|rd|th)?)?";
const YEAR = "(?:,?\\s+(\\d{4}))?";
const DATE = new RegExp(
  `(\\d{4})-(\\d{2})-(\\d{2})|(?<![\\d.:/-])${DAY}\\s+${MONTH}${YEAR}(?!\\d)|${MONTH}\\s+${DAY}${YEAR}(?![\\d:])`,
  "giu",
);
const MONTH_NO = Object.fromEntries(
  "jan oca|feb sub|mar|apr nis|may|jun haz|jul tem|aug agu|sep eyl|oct eki|nov kas|dec ara"
    .split("|")
    .flatMap((keys, i) => keys.split(" ").map((k) => [k, i + 1])),
);
const monthNo = (word) =>
  MONTH_NO[word.toLowerCase().replace(/ş/g, "s").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ı/g, "i").slice(0, 3)];

// A time after the date, with an optional zone: "2026-11-02 20:00 PT" is 07:00 on 3 November
// in Turkey, so the deadline is the person's local day. Without a zone the day stands.
const TIME =
  /^,?\s*(?:at\s+|saat\s+)?(\d{1,2})[:.](\d{2})(?:\s*(?:(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?|([+-])(\d{2}):?(\d{2})|(UTC|GMT|Z|TRT|CEST|CET|[ECMP][SD]?T)))?(?![\p{L}\d])/u;
// Minutes ahead of UTC.
const OFFSET = {
  ...{ UTC: 0, GMT: 0, Z: 0, TRT: 180, CET: 60, CEST: 120 },
  ...{ EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420 },
};
// The bare US names change with daylight saving, so the zone's own clock says which.
const ZONE = { ET: "America/New_York", CT: "America/Chicago", MT: "America/Denver", PT: "America/Los_Angeles" };

// A date counts as a deadline only when one of these sits beside it. Without the
// cue, "On 2026-10-26 Safa said …" would read as a deadline on almost every entry.
// Kept deliberately narrow.
const CUES = ["due", "deadline", "closes", "expires", "last day", "son başvuru", "son tarih", "teslim"];
// Obsidian Tasks writes "📅 2026-11-10" for a due date. It counts only right before the
// date: in "⏳ 2026-11-05 📅 2026-11-10" the scheduled date is not a deadline.
const CUES_BEFORE = ["📅"];
// Short words that are everywhere ("approved by Safa on 2026-11-01") count only as the
// word right before the date: "by 8 Nov", "until Dec 8", "close 8 Nov", "ends on 2027-01-15".
const RIGHT_BEFORE = /(?<!\p{L})(?:by|before|until|close|closing|ends|ending)(?:\s+(?:on|the))*\s*$/u;
// Turkish puts it after: "8 Kasım'a kadar", "2026-11-08'e kadar", "11 Aralık tarihine kadar".
const RIGHT_AFTER = /^['’]?(?:[yn]?[ae]|\s+tarihine)\s+kadar(?!\p{L})/u;
// "The deadline passed 2026-11-03", "son başvuru 8 Kasım'dı, kaçırıldı": a cue followed by
// one of these is not a deadline.
// The dotless ı is also read as i: "KAÇIRILDI".toLowerCase() is "kaçirildi".
const NEGATED = /(?<!\p{L})(?:passed|missed|geçt[ıi]|kaç[ıi]r[ıi]ld[ıi]|kaç[ıi]rd)/u;

// How far from the date the cue may sit. Deadlines read "deadline is <date>" or
// "<date> son tarih", so the room before the date is the generous side.
const BEFORE = 32;
const AFTER = 16;

const MS_DAY = 24 * 60 * 60 * 1000;

// The fields a deadline is looked for in: the next action first, then the rest of the
// note, nearest-intent first.
const FIELDS = ["result", "title", "context"];

// The user's own day, not UTC: a deadline belongs to the date on their wall.
export const localDate = (d = new Date()) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

const pad = (n) => String(n).padStart(2, "0");
const real = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return m >= 1 && m <= 12 && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

// A date with no year is the occurrence nearest the note's own day: "8 Nov" in a note of
// 2026-10-30 is 2026-11-08, "Jan 5" in one of 2026-12-20 is 2027-01-05, and "8 Nov" in one
// of 2026-11-10 is two days before it, so already past, not next year's.
function nearest(m, d, from) {
  const ref = Date.parse(`${from}T00:00:00Z`);
  const y0 = Number(from.slice(0, 4));
  const years = [y0 - 1, y0, y0 + 1].filter((y) => real(y, m, d));
  const dist = (y) => Math.abs(Date.UTC(y, m - 1, d) - ref);
  return years.sort((a, b) => dist(a) - dist(b) || b - a)[0];
}

// Minutes the zone's clock is ahead of UTC at `t`.
function offsetIn(zone, t) {
  const opts = { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric" };
  const parts = new Intl.DateTimeFormat("en-US", { ...opts, hour: "numeric", minute: "numeric" }).formatToParts(t);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, Number(value)]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60000) * 60000) / 60000;
}

// The local day of a time read in another zone, or the day itself without a zone.
function localDay(y, m, d, t) {
  const day = `${y}-${pad(m)}-${pad(d)}`;
  const [, hh, mm, s1, h1, m1 = 0, s2, h2, m2, name] = t ?? [];
  if (!t || Number(hh) > 23 || Number(mm) > 59) return day;
  let off;
  if (s1) off = (s1 === "-" ? -1 : 1) * (Number(h1) * 60 + Number(m1));
  else if (s2) off = (s2 === "-" ? -1 : 1) * (Number(h2) * 60 + Number(m2));
  else if (name) off = OFFSET[name] ?? ZONE[name];
  if (off == null) return day;
  const wall = Date.UTC(y, m - 1, d, Number(hh), Number(mm));
  const minutes = typeof off === "number" ? () => off : (at) => offsetIn(off, at);
  return localDate(new Date(wall - minutes(wall - minutes(wall) * 60000) * 60000));
}

// The ISO date a match stands for, or null when it is not a real day.
function dateOf(m, time, from) {
  let y, mo, d;
  if (m[1]) [y, mo, d] = [m[1], m[2], m[3]].map(Number);
  else {
    const [first, last, month, year] = m[6] ? m.slice(4, 8) : [m[9], m[10], m[8], m[11]];
    if (last && Number(last) <= Number(first)) return null;
    [mo, d] = [monthNo(month), Number(last ?? first)];
    y = year ? Number(year) : nearest(mo, d, from);
  }
  return y && real(y, mo, d) ? localDay(y, mo, d, time) : null;
}

// A cue in the room before or after the date that no "passed" follows. When another date
// ends the room after (`shared`), a cue there counts only if it is nearer this date.
function cued(before, after, shared) {
  const live = (cue) => {
    const i = before.lastIndexOf(cue);
    const j = after.indexOf(cue);
    const mine = j >= 0 && (!shared || j < after.length - j - cue.length);
    return (i >= 0 && !NEGATED.test(before.slice(i) + " " + after)) || (mine && !NEGATED.test(after.slice(j)));
  };
  return (
    CUES.some(live) ||
    CUES_BEFORE.some((cue) => before.trimEnd().endsWith(cue)) ||
    ((RIGHT_BEFORE.test(before) || RIGHT_AFTER.test(after)) && !NEGATED.test(after))
  );
}

// Every date in `text` that a deadline cue sits next to, as ISO dates. A cue never reaches
// across another date, either way, so in "runs 2026-11-13 to 2027-01-05; deadline is 2026-12-01" only
// the last date is a deadline. `from` is the day the text was written: it gives a date
// with no year its year.
export function deadlinesIn(text, from = localDate()) {
  if (!text) return [];
  const s = String(text);
  const found = [];
  let prevEnd = 0;
  const matches = [...s.matchAll(DATE)];
  matches.forEach((m, k) => {
    let end = m.index + m[0].length;
    const time = s.slice(end).match(TIME);
    if (time) end += time[0].length;
    const before = s.slice(Math.max(prevEnd, m.index - BEFORE), m.index).toLowerCase();
    const stop = matches[k + 1]?.index ?? Infinity;
    const after = s.slice(end, Math.min(end + AFTER, stop)).toLowerCase();
    const date = dateOf(m, time, from);
    if (date && cued(before, after, stop < end + AFTER)) found.push(date);
    prevEnd = end;
  });
  return found;
}

// The entry's deadline, or null: the earliest cued date in its next action that has not
// already passed as of the day the entry was written, else the earliest in the rest of
// the note. ISO dates compare correctly as strings.
export function dueOf(entry) {
  const from = entry?.date?.slice(0, 10);
  const live = (f) => deadlinesIn(entry?.[f], from).filter((d) => !from || d >= from);
  const next = entry?.next === "none" ? [] : live("next");
  const dates = next.length ? next : FIELDS.flatMap(live);
  return dates.length ? dates.sort()[0] : null;
}

// Whole days from `today` to `due`: 0 is today, negative is overdue.
export function daysLeft(due, today) {
  if (!due) return null;
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_DAY);
}

// "today" | "tomorrow" | "in 3 days" | "3 days ago" — the phrasing Tuck can say aloud.
export function dueLabel(days) {
  if (days == null) return null;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

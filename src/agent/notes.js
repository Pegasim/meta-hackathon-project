// A note as the agent loop reads it (#81), redacted and cut. An entry carries its date and
// its age by the person's own day (#90), so a next action from days ago does not read as
// today's. A document (an item with `text`) has no date of its own and gets none.
import { redact } from "../memory/index.js";
import { localDate, daysLeft } from "../memory/due.js";

export const NOTE_CHARS = 600;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// "today" | "1 day ago" | "3 days ago". A date ahead of today (another clock) is today.
export function ageOf(date, today = localDate()) {
  const days = -daysLeft(date, today);
  if (!(days > 0)) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function noteOf({ title, item }, today = localDate()) {
  const doc = typeof item.text === "string";
  const body = doc
    ? item.text
    : [item.context, item.result, item.next !== "none" && item.next].filter(Boolean).join(" ");
  return {
    title: redact(title ?? "").text,
    topic: item.topic ?? "notes",
    ...(!doc && ISO_DATE.test(item.date ?? "") && { date: item.date, age: ageOf(item.date, today) }),
    text: redact(body.replace(/\s+/g, " ")).text.slice(0, NOTE_CHARS),
  };
}

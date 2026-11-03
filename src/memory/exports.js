// Exports: an assistant's account export (Claude's conversations.json, Gemini's
// MyActivity.json from Google Takeout) becomes memory entries, one conversation at a time
// through the paste node (paste.js), so there is no second prompt. An export holds the
// whole history, and only a little of it is sent: conversations from the last 30 days in
// which the person's own words name a date, a deadline or a to-do, newest first, at most
// 50. The model call and the cache are passed in; everything else here is pure.
import { redact } from "./consolidate.js";
import { pasteMessages, parsePasted, MAX_PASTE_CHARS } from "./paste.js";

export const EXPORT_DAYS = 30;
export const MAX_EXPORT_CONVERSATIONS = 50;
const ENTRIES_PER_CONVERSATION = 6;
const CONCURRENCY = 3;
const TITLE_CHARS = 90;
const NAMES = { claude: "Claude", gemini: "Gemini" };

// A conversation: { id, title, updated (ISO time of its last message), turns: [{ role, text }] },
// role "user" (the person) or "assistant". Attachments, tool calls and thinking stay out.

// Claude's conversations.json: [{ uuid, name, updated_at, chat_messages: [{ sender, created_at,
// text, content: [{ type, text }] }] }]. Same fields as the brain's extractor reads.
export function fromClaudeExport(list) {
  return list.map((c) => {
    const turns = [];
    let last = c.updated_at ?? null;
    for (const m of c.chat_messages ?? []) {
      const parts = (m.content ?? []).filter((i) => i?.type === "text" && i.text?.trim()).map((i) => i.text.trim());
      const text = parts.length ? parts.join("\n\n") : (m.text ?? "").trim();
      if (!text) continue;
      turns.push({ role: m.sender === "human" ? "user" : "assistant", text });
      if (!last || (m.created_at && m.created_at > last)) last = m.created_at;
    }
    return {
      id: String(c.uuid),
      title: oneLine(c.name || turns.find((t) => t.role === "user")?.text || ""),
      updated: last,
      turns,
    };
  });
}

// Gemini's MyActivity.json: one record per prompt, "Prompted <text>", its reply as HTML,
// and the chat it belongs to in a details link ".../app/<id>". Feedback and other events
// have no such link and are skipped, as are Canvas documents.
export function fromGeminiTakeout(records) {
  const chats = new Map();
  for (const r of [...records].sort((a, b) => String(a.time ?? "").localeCompare(String(b.time ?? "")))) {
    const title = r.title ?? "";
    const link = (r.details ?? []).find((d) => String(d?.name ?? "").includes("/app/"));
    if (!link || !title.startsWith("Prompted")) continue;
    const id = link.name.split("/").pop();
    if (!chats.has(id)) chats.set(id, { id, title: "", updated: null, turns: [] });
    const chat = chats.get(id);
    const prompt = decode(title.slice("Prompted".length)).trim();
    const replyText = (r.safeHtmlItem ?? [])
      .map((i) => htmlToText(i?.html))
      .filter(Boolean)
      .join("\n\n");
    if (prompt) chat.turns.push({ role: "user", text: prompt });
    if (replyText) chat.turns.push({ role: "assistant", text: replyText });
    chat.title ||= oneLine(prompt);
    chat.updated = r.time ?? chat.updated;
  }
  return [...chats.values()].filter((c) => c.turns.length);
}

// { kind: "claude" | "gemini", conversations }, from a parsed export file.
export function readExport(json) {
  if (Array.isArray(json) && json.some((c) => Array.isArray(c?.chat_messages)))
    return { kind: "claude", conversations: fromClaudeExport(json) };
  if (Array.isArray(json) && json.some((r) => typeof r?.title === "string" && r.title.startsWith("Prompted")))
    return { kind: "gemini", conversations: fromGeminiTakeout(json) };
  throw new Error(
    "This is not a Claude or Gemini export: choose Claude's conversations.json, or Gemini's MyActivity.json from Google Takeout.",
  );
}

// Words that say something is owed. A cue counts only in the person's own words: an
// assistant's "you need to" in an explanation says nothing about them.
const word = (s) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${s})(?![\\p{L}])`, "iu");
const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık";
const DAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tonight|next week|the end of|end of";
const CUES = [
  /\d{4}-\d{2}-\d{2}/,
  word(`\\d{1,2}(?:st|nd|rd|th|')?\\s+(?:${MONTHS})|(?:${MONTHS})\\s+\\d{1,2}`),
  word("due|deadline|remind(?: me)?|to-?do|need to|have to|must|promised|until"),
  word(`by\\s+(?:${DAYS}|\\d)|before\\s+(?:${DAYS}|\\d)`),
  word("teslim|son tarih|lazım|gerekiyor|hatırlat|unutma|yapmalıyım|bitirmeliyim|kadar bitir"),
];
export const hasCommitmentCue = (text) => CUES.some((re) => re.test(text ?? ""));

// The conversations that will be sent, and how many were left out and why.
// { chosen, tooOld, noCue, overCap }
export function selectConversations(conversations, { today, days = EXPORT_DAYS, max = MAX_EXPORT_CONVERSATIONS }) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const recent = conversations.filter((c) => c.updated && c.updated.slice(0, 10) >= from);
  const cued = recent
    .filter((c) => c.turns.some((t) => t.role === "user" && hasCommitmentCue(t.text)))
    .sort((a, b) => b.updated.localeCompare(a.updated));
  return {
    chosen: cued.slice(0, max),
    tooOld: conversations.length - recent.length,
    noCue: recent.length - cued.length,
    overCap: Math.max(0, cued.length - max),
  };
}

// What is sent for one conversation: a header, then its turns, redacted, cut from the start
// when it runs over the paste cap, since the newest part is what is still open.
// { text, redactions, cut }
export function conversationText(c, { maxChars = MAX_PASTE_CHARS } = {}) {
  const header = redact(
    `One conversation with their assistant, "${c.title}", last on ${c.updated.slice(0, 10)}. "User" is the person; only what they say about themselves or agree to counts.`,
  );
  const body = redact(c.turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`).join("\n"));
  const room = maxChars - header.text.length - 1;
  const cut = body.text.length > room;
  return {
    text: `${header.text}\n${cut ? body.text.slice(-room) : body.text}`,
    redactions: header.count + body.count,
    cut,
  };
}

// The chosen conversations through the model, three at a time. cache: { [id]: { stamp,
// entries, dropped } } from earlier runs; a conversation whose stamp (its last message) is
// unchanged is not sent again, and onSaved(cache) runs after each one, so a run that stops
// halfway resumes. A failed conversation stays out of the cache and is asked next time.
// Returns { cache, sent, failed, errors, dropped, redactions }.
export async function importExport(
  complete,
  chosen,
  { kind, cache = {}, topics = [], concurrency = CONCURRENCY, onProgress, onSaved } = {},
) {
  const next = { ...cache };
  const todo = chosen.filter((c) => next[c.id]?.stamp !== c.updated);
  const errors = new Set();
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  let redactions = 0;
  let done = 0;
  const run = async () => {
    while (todo.length) {
      const c = todo.shift();
      const date = c.updated.slice(0, 10);
      const t = conversationText(c);
      redactions += t.redactions;
      try {
        const reply = await complete(
          pasteMessages({ text: t.text, today: date, topics, maxEntries: ENTRIES_PER_CONVERSATION }),
          { maxTokens: 16000, temperature: 0, reasoningEffort: "low" },
        );
        const r = parsePasted(reply, { today: date, maxEntries: ENTRIES_PER_CONVERSATION });
        const evidence = `${NAMES[kind] ?? kind} conversation "${redact(c.title).text}", ${date}`;
        next[c.id] = {
          stamp: c.updated,
          entries: r.entries.map((e) => ({ ...e, source: "export", evidence })),
          dropped: r.dropped,
        };
        dropped += r.dropped;
        sent += 1;
        await onSaved?.(next);
      } catch (err) {
        failed += 1;
        errors.add(err.message ?? String(err));
      }
      done += 1;
      onProgress?.({ done, total: done + todo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, run));
  return { cache: next, sent, failed, errors: [...errors], dropped, redactions };
}

// Everything read so far from the conversations still in the file: what importEntries
// stores for the export's origin, which replaces that origin's earlier import.
export const exportEntries = (cache, conversations) => conversations.flatMap((c) => cache[c.id]?.entries ?? []);

function oneLine(s) {
  const line = String(s).replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#")
      return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Gemini's replies are HTML: block ends become line breaks, tags go, entities are decoded.
function htmlToText(html) {
  const text = decode(
    String(html ?? "")
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|li|div|h[1-6]|tr|pre|blockquote)>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  );
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

// Inbox → log. Validates each pending entry, redacts secret-shaped strings,
// drops unchanged restatements of entries already in the log, and gives each
// accepted entry a stable id. Pure: the caller does the storage.
import { validate } from "./entry.js";

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(api[_-]?key|token|secret|password)(\s*[:=]\s*)\S{8,}/gi,
];
const TEXT_FIELDS = ["title", "context", "result", "evidence", "next"];

export function redact(text) {
  let count = 0;
  let out = text;
  for (const re of SECRETS) {
    out = out.replace(re, (_m, label, sep) => {
      count++;
      return typeof label === "string" ? `${label}${sep}[REDACTED]` : "[REDACTED]";
    });
  }
  return { text: out, count };
}

export const entryKey = (e) => `${e.date}|${e.topic}|${e.title}`;

// removed: { ids, keys } of entries the person took back (Memory.remove). A copy read back
// from the brain matches by key, since the brain may file it under an id of its own.
export const isRemoved = (e, removed) => removed.ids.includes(e.id) || removed.keys.includes(entryKey(e));

// FNV-1a 64-bit over key and content, first 10 hex chars.
export function entryId(e) {
  let h = 0xcbf29ce484222325n;
  for (const ch of [entryKey(e), ...TEXT_FIELDS.map((f) => e[f] ?? "")].join("\n")) {
    h ^= BigInt(ch.codePointAt(0));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0").slice(0, 10);
}

const sameContent = (a, b) => TEXT_FIELDS.every((f) => (a[f] ?? "") === (b[f] ?? ""));

// pending: inbox entries; existing: log entries. Returns what to file and why the rest was not.
export function consolidate(pending, existing) {
  const known = new Map(existing.map((e) => [entryKey(e), e]));
  const accepted = [];
  const rejected = [];
  const duplicates = [];
  let redactions = 0;

  for (const raw of pending) {
    const e = { ...raw };
    for (const f of TEXT_FIELDS) {
      if (typeof e[f] !== "string") continue;
      const r = redact(e[f]);
      e[f] = r.text;
      redactions += r.count;
    }
    const errors = validate(e);
    if (errors.length) {
      rejected.push({ entry: raw, errors });
      continue;
    }
    const prior = known.get(entryKey(e));
    if (prior && sameContent(prior, e)) {
      duplicates.push(raw);
      continue;
    }
    const filed = { ...e, id: entryId(e), status: "log" };
    // Redaction changed the id: keep the one add() returned, so a caller can still remove it.
    if (raw.id && raw.id !== filed.id) filed.addedAs = raw.id;
    known.set(entryKey(filed), filed);
    accepted.push(filed);
  }
  return { accepted, rejected, duplicates, redactions };
}

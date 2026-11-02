// Reads any Markdown folder (an Obsidian vault, plain notes) into entries and documents,
// the same shapes a second-brain checkout gives (brain.js). Open checkbox tasks become
// `todo` entries, so Tuck knows what the person owes; every file becomes a document for
// recall. Pure over [{ path, text, lastModified }], so it runs under node; the folder is
// read in the browser by readMarkdownFolder. Nothing is written back to the folder.
import { makeEntry } from "./entry.js";
import { entryId, entryKey } from "./consolidate.js";
import { localDate } from "./due.js";

const norm = (p) => p.replace(/\\/g, "/");

// .obsidian/, .trash/, .git/ and any other dot-folder hold settings and history, not notes.
const hidden = (path) => path.split("/").some((part) => part.startsWith("."));

// "- [ ] text", "* [ ] text", "+ [ ] text" or "1. [ ] text", at any indent. "[/]" is
// Obsidian's in progress, still open; "[x]" is done and "[-]" cancelled.
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ /xX-])\]\s+(.+)$/;
const OPEN = [" ", "/"];
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const ISO = /\d{4}-\d{2}-\d{2}/g;

// Obsidian Tasks metadata: priority marks, and dates or a recurrence after their emoji
// (📅 due, ⏳ scheduled, 🛫 start, ➕ created, ✅ done, 🔁 every …), plus Dataview fields
// such as [due:: 2026-11-10] or due:: 2026-11-10. Kept in `next`, where due.js reads the
// deadline; taken out of the title.
const META = [
  /\[[a-z]+::[^\]]*\]/gi,
  /\b[a-z]+::\s*\d{4}-\d{2}-\d{2}/gi,
  /🔁[^📅⏳🛫➕✅⏫🔼🔽]*/gu,
  /[📅⏳🛫➕✅]️?\s*\d{4}-\d{2}-\d{2}/gu,
  /[⏫🔼🔽🔺⏬]️?/gu,
];

const MAX_TITLE = 120;

function titleOf(text) {
  let t = text;
  for (const re of META) t = t.replace(re, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length <= MAX_TITLE) return t;
  const cut = t.slice(0, MAX_TITLE + 1);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_TITLE / 2 ? cut.slice(0, space) : t.slice(0, MAX_TITLE)).trim();
}

// A topic slug (entry.js): Turkish letters folded, anything else becomes a dash.
export function slug(s = "") {
  return s
    .replace(/[İIı]/g, "i")
    .toLowerCase()
    .replace(/ş/g, "s")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// The folder a file sits in at the top of the vault, or the file's own name at the root.
const topicOf = (path, fallback) =>
  slug(path.includes("/") ? path.split("/")[0] : path.replace(/\.md$/i, "")) || slug(fallback) || "notes";

const dayOf = (ms) => (Number.isFinite(ms) ? localDate(new Date(ms)) : null);

// The YAML block at the top of a note is metadata, not text with tasks in it.
function body(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? text.slice(m[0].length) : text).split(/\r?\n/);
}

// files: [{ path, text, lastModified }] with paths relative to the folder; lastModified in
// ms. Returns { entries, documents, skipped }: one todo entry per open task, one document
// per file. An entry's date is the earliest date written in its task line, else the
// file's date, so a deadline is never read as already past (due.js dueOf).
export function fromMarkdownFolder(files, { today = localDate(), folderName = "" } = {}) {
  const entries = [];
  const documents = [];
  const skipped = [];
  const seen = new Set();
  for (const { path: raw, text = "", lastModified } of files) {
    const path = norm(raw);
    if (!/\.md$/i.test(path) || hidden(path)) continue;
    const fileDay = dayOf(lastModified) ?? today;
    const topic = topicOf(path, folderName);
    let heading = null;
    let fenced = false;
    let docTitle = null;
    for (const line of body(text)) {
      if (FENCE.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      const h = line.match(HEADING);
      if (h) {
        heading = h[1];
        if (!docTitle && /^#\s/.test(line)) docTitle = h[1];
        continue;
      }
      const t = line.match(TASK);
      if (!t || !OPEN.includes(t[1])) continue;
      const task = t[2].trim();
      const title = titleOf(task);
      if (title.length < 3) continue;
      const dates = (task.match(ISO) ?? []).sort();
      const date = dates.length && dates[0] < fileDay ? dates[0] : fileDay;
      try {
        const entry = makeEntry({
          kind: "todo",
          topic,
          title,
          date,
          source: "markdown",
          context: heading ? `${path} › ${heading}` : path,
          result: "open",
          next: task,
        });
        if (seen.has(entryKey(entry))) continue; // the same task twice in one file or topic
        seen.add(entryKey(entry));
        entries.push({ ...entry, id: entryId(entry), path });
      } catch (err) {
        skipped.push({ path, reason: err.message });
      }
    }
    documents.push({ path, title: docTitle ?? path.split("/").pop().replace(/\.md$/i, ""), text });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  return { entries, documents, skipped };
}

// Reads a folder the person picked (File System Access API): every .md file under it with
// its text and lastModified, skipping dot-folders. The browser side of fromMarkdownFolder.
export async function readMarkdownFolder(dir, prefix = "") {
  const files = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith(".")) continue;
    const path = prefix + name;
    if (handle.kind === "directory") files.push(...(await readMarkdownFolder(handle, path + "/")));
    else if (/\.md$/i.test(name)) {
      const file = await handle.getFile();
      files.push({ path, text: await file.text(), lastModified: file.lastModified });
    }
  }
  return files;
}

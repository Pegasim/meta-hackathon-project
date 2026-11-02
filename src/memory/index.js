// Public memory API. The extension talks to memory only through this class.
import { makeEntry } from "./entry.js";
import { loadBrain, openLoops } from "./brain.js";
import { consolidate, entryId, entryKey, isRemoved } from "./consolidate.js";
import { buildIndex, search, entryDoc, noteDoc } from "./recall.js";
import { contextPack, renderPack, latestIntent, taskQueue } from "./context.js";
import { IDLE_GAP, toSpans, clipSpans, summarize, renderSummary } from "./activity.js";
import { distillMessages, parseEntries } from "./distill.js";
import * as db from "./db.js";
import { readBrainFolder, writeInboxEntry, removeInboxEntry, permission } from "./connector.js";

// Secret-shaped strings (keys, tokens, "password: …") replaced by [REDACTED]: for any
// text that leaves the device, such as a page excerpt. Returns { text, count }. entryKey:
// an entry's date, topic and title, which remove() also takes.
export { redact, entryKey } from "./consolidate.js";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const today = () => new Date().toISOString().slice(0, 10);

export class Memory {
  #db;
  #index = null;
  #entries = [];
  #stamp;

  static async open(name) {
    const m = new Memory();
    m.#db = await db.openDb(name);
    return m;
  }

  // The entries and the search index are cached, and the options page and the
  // background worker each hold their own Memory over one database. Every write stores
  // a fresh stamp in `meta`; a read reloads when the stored stamp is not the one its
  // copy was loaded under, so a write made by the other instance is seen on the next
  // read, with no message between them. The stamp is random rather than a counter:
  // two writers that read the same counter would store the same next value, and a
  // reader that loaded between their writes would never see the second.
  async #load() {
    const stamp = await db.getMeta(this.#db, "version");
    if (this.#index && stamp === this.#stamp) return;
    this.#stamp = stamp;
    this.#entries = await db.getAll(this.#db, "entries");
    const notes = await db.getAll(this.#db, "notes");
    this.#index = buildIndex([...this.#entries.map(entryDoc), ...notes.map(noteDoc)]);
  }

  async #dirty() {
    this.#index = null;
    await db.setMeta(this.#db, "version", crypto.randomUUID());
  }

  // Drop the local copy so the next read reloads it. Reads already notice a write made
  // by another instance; this is for a caller that wants to say so explicitly.
  refresh() {
    this.#index = null;
  }

  // The stamp of the last write by any instance. A caller that caches something
  // derived from memory (a model's decisions about pages) can compare it to know when
  // to clear that cache.
  async version() {
    return db.getMeta(this.#db, "version");
  }

  // What the person took back with remove(): { ids, keys }.
  async #removed() {
    return (await db.getMeta(this.#db, "removed")) ?? { ids: [], keys: [] };
  }

  // ---- Brain -------------------------------------------------------------

  // Import a brain snapshot: [{ path, text }]. Replaces the previous import and keeps
  // the extension's own entries, except those the brain now holds (exported earlier).
  // An entry removed here stays out, though the brain still holds it.
  async importFiles(files) {
    const removed = await this.#removed();
    const read = loadBrain(files);
    const { documents, skipped } = read;
    const entries = read.entries.filter((e) => !isRemoved(e, removed));
    const brainKeys = new Set(entries.map(entryKey));
    const own = (await db.getAll(this.#db, "entries")).filter((e) => !e.path && !brainKeys.has(entryKey(e)));
    await db.clear(this.#db, "entries");
    await db.clear(this.#db, "notes");
    await db.putAll(this.#db, "entries", [
      ...own,
      ...entries.map((e) => ({ ...e, id: e.id ?? entryId(e), status: e.path.startsWith("inbox/") ? "inbox" : "log" })),
    ]);
    await db.putAll(this.#db, "notes", documents);
    await this.#dirty();
    return { entries: entries.length, notes: documents.length, skipped };
  }

  async importBrain(dirHandle) {
    return this.importFiles(await readBrainFolder(dirHandle));
  }

  // Remember the folder (handles survive in IndexedDB) and import it.
  async connectBrain(dirHandle) {
    await db.setMeta(this.#db, "brain", dirHandle);
    return this.importBrain(dirHandle);
  }

  // Cheap status check, no file reads: { connected, permission }.
  async brainState() {
    const dir = await db.getMeta(this.#db, "brain");
    if (!dir) return { connected: false };
    return { connected: true, name: dir.name, permission: await permission(dir, "read") };
  }

  async stats() {
    await this.#load();
    const notes = await db.getAll(this.#db, "notes");
    return { entries: this.#entries.length, notes: notes.length, openLoops: openLoops(this.#entries).length };
  }

  // Re-import the remembered folder. prompt: true only from a user click.
  async syncBrain({ prompt = false } = {}) {
    const dir = await db.getMeta(this.#db, "brain");
    if (!dir) return { connected: false };
    if ((await permission(dir, "read", { prompt })) !== "granted") return { connected: true, needsPermission: true };
    return { connected: true, ...(await this.importBrain(dir)) };
  }

  // Write consolidated entries made here into the brain's inbox/, once each.
  async exportPending({ prompt = false, host = "browser" } = {}) {
    const dir = await db.getMeta(this.#db, "brain");
    if (!dir) return { exported: 0, connected: false };
    if ((await permission(dir, "readwrite", { prompt })) !== "granted") return { exported: 0, needsPermission: true };
    const pending = (await db.byStatus(this.#db, "log")).filter((e) => !e.path && !e.exported);
    const written = [];
    for (const e of pending) written.push({ ...e, exported: true, exportedAs: await writeInboxEntry(dir, e, host) });
    await db.putAll(this.#db, "entries", written);
    return { exported: pending.length };
  }

  // ---- Entries -----------------------------------------------------------

  // New entry from the extension. Lands in the inbox until consolidate(). Returns the
  // stored entry; its id is what remove() takes.
  async add(fields) {
    const entry = makeEntry({ source: "extension", ...fields });
    const stored = { ...entry, id: entryId(entry), status: "inbox", ts: Date.now() };
    await db.putAll(this.#db, "entries", [stored]);
    await this.#dirty();
    return stored;
  }

  async consolidate() {
    const pending = await db.byStatus(this.#db, "inbox");
    const existing = await db.byStatus(this.#db, "log");
    const result = consolidate(pending, existing);
    // Rejected entries stay in the inbox with their errors attached; the rest leave it.
    // Redaction can change an accepted entry's id, so remove by the pending ids.
    const flagged = result.rejected.map(({ entry, errors }) => ({ ...entry, errors }));
    await db.removeAll(
      this.#db,
      "entries",
      pending.map((e) => e.id),
    );
    await db.putAll(this.#db, "entries", [
      ...result.accepted.map((e) => ({ ...e, ts: e.ts ?? Date.now() })),
      ...flagged,
    ]);
    await this.#dirty();
    return {
      accepted: result.accepted.length,
      duplicates: result.duplicates.length,
      rejected: result.rejected.length,
      redactions: result.redactions,
    };
  }

  // Take an entry back, such as a preference written for a label the person then forgot.
  // id: what add() returned; key: entryKey(), for a copy the brain filed under another id.
  // It leaves this memory and every later import, and if it was not exported yet it never
  // will be. A copy already written to the brain's inbox/ is deleted only when write access
  // is already granted, with no prompt; whatever the brain has filed is left alone.
  // Returns { removed, file: "deleted" | "kept" | "not in inbox" | null }.
  async remove(id, { key } = {}) {
    const all = await db.getAll(this.#db, "entries");
    const target = all.find((e) => e.id === id || e.addedAs === id);
    const keys = [...new Set([key, target && entryKey(target)].filter(Boolean))];
    const copies = all.filter((e) => e === target || keys.includes(entryKey(e)));
    const removed = await this.#removed();
    await db.setMeta(this.#db, "removed", {
      ids: [...new Set([...removed.ids, id, ...copies.map((e) => e.id)])],
      keys: [...new Set([...removed.keys, ...keys])],
    });
    await db.removeAll(
      this.#db,
      "entries",
      copies.map((e) => e.id),
    );
    await this.#dirty();
    // Written out by this extension: the exported entry, or its copy read back from inbox/.
    const written = copies.find((e) => e.exported || (e.source === "extension" && e.path?.startsWith("inbox/")));
    return { removed: copies.length, file: written ? await this.#unexport(written) : null };
  }

  async #unexport(entry) {
    const dir = await db.getMeta(this.#db, "brain");
    if (!dir || (await permission(dir, "readwrite")) !== "granted") return "kept";
    return (await removeInboxEntry(dir, entry)) ? "deleted" : "not in inbox";
  }

  async recall(query, opts) {
    await this.#load();
    return search(this.#index, query, opts).map(({ ref, title, score, item }) => ({ ref, title, score, item }));
  }

  async openLoops() {
    await this.#load();
    return openLoops(this.#entries);
  }

  async latestIntent() {
    await this.#load();
    return latestIntent(this.#entries);
  }

  // Open loops ordered by how little time is left; each carries `due` and `daysLeft`.
  async taskQueue(opts) {
    await this.#load();
    return taskQueue(this.#entries, opts);
  }

  // ---- Profile -----------------------------------------------------------

  // What an agent node reads to work out who this person is: the newest entries,
  // trimmed to the three fields that say what they work on.
  async profileSample({ limit = 60 } = {}) {
    await this.#load();
    return [...this.#entries]
      .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
      .slice(0, limit)
      .map(({ topic, title, next }) => ({ topic, title, next }));
  }

  // { summary, topics, workHosts } as the node returned it, or null before an import.
  async profile() {
    return (await db.getMeta(this.#db, "profile")) ?? null;
  }

  async setProfile(profile) {
    await db.setMeta(this.#db, "profile", profile);
    return profile;
  }

  // Set what the user is about to do. It becomes the stated intent the audit checks.
  async setIntent({ title, next }) {
    return this.add({ kind: "todo", topic: "focus", title, context: "Stated by the user.", result: title, next });
  }

  // Mark an intent done: it stops being the stated intent, and an event records it.
  async completeIntent(id) {
    await this.#load();
    const todo = this.#entries.find((e) => e.id === id);
    if (!todo) throw new Error(`no entry ${id}`);
    await db.putAll(this.#db, "entries", [{ ...todo, done: true }]);
    await this.#dirty();
    return this.add({
      kind: "event",
      topic: todo.topic,
      title: `Done: ${todo.title}`.slice(0, 120),
      context: `Intent stated on ${todo.date}.`,
      result: "Marked done by the user.",
    });
  }

  async topics() {
    await this.#load();
    return [...new Set(this.#entries.map((e) => e.topic))].sort();
  }

  // activity: { title, url }. Returns { pack, prompt }.
  async contextPack(activity, opts) {
    await this.#load();
    const pack = contextPack(this.#index, this.#entries, activity, opts);
    return { pack, prompt: renderPack(pack, opts) };
  }

  // ---- Activity ----------------------------------------------------------

  // event: { url, title, kind: "focus" | "idle", ts }. The extension calls this when
  // the active page changes and when the user goes idle or leaves the browser.
  async recordActivity({ url = "", title = "", kind = "focus", ts = Date.now() }) {
    await db.append(this.#db, "activity", { url, title, kind, ts });
  }

  // The last `minutes` of activity: { spans, summary, text }.
  async activity({ minutes = 60, now = Date.now() } = {}) {
    const from = now - minutes * MINUTE;
    // An event from just before the window can still be running inside it.
    const events = await db.since(this.#db, "activity", from - IDLE_GAP);
    const spans = clipSpans(toSpans(events, now), from);
    const summary = summarize(spans);
    return { spans, summary, text: renderSummary(summary, now - from) };
  }

  // ---- Distill -----------------------------------------------------------

  // complete(messages) -> reply text (see model.js). Turns recent activity into
  // inbox entries; consolidate() files them.
  async distill(complete, { minutes = 60, now = Date.now() } = {}) {
    const act = await this.activity({ minutes, now });
    const last = act.spans.at(-1);
    if (!last) return { added: 0, rejected: [], reason: "no activity" };
    const { prompt } = await this.contextPack({ title: last.title, url: last.url });
    const messages = distillMessages({
      activityText: act.text,
      contextPrompt: prompt,
      topics: await this.topics(),
      date: today(),
    });
    const { entries, rejected } = parseEntries(await complete(messages), { date: today() });
    const added = [];
    for (const e of entries) added.push(await this.add(e));
    return { added: added.length, entries: added, rejected };
  }

  // ---- Maintenance -------------------------------------------------------

  // Run on a schedule (chrome.alarms): consolidate, drop old raw activity, and
  // export to the brain if write access is already granted (never prompts).
  async maintain({ keepDays = 7, now = Date.now() } = {}) {
    const consolidated = await this.consolidate();
    await db.deleteBefore(this.#db, "activity", now - keepDays * DAY);
    let exported;
    try {
      exported = await this.exportPending();
    } catch (err) {
      exported = { exported: 0, error: String(err) };
    }
    return { consolidated, exported };
  }

  // Live connection, single entry, from a user click.
  async writeToBrain(dirHandle, entry, host) {
    await writeInboxEntry(dirHandle, entry, host);
  }
}

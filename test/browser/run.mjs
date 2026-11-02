// Loads the unpacked extension in Chromium and drives the Memory API from an
// extension page: IndexedDB, import, add, consolidate, recall, context pack,
// activity, distill (fake model), and the brain connector. The brain folder is
// an origin-private file system directory, because a test cannot click the
// folder picker; the background worker then re-syncs it from the stored handle.
// Needs Playwright with a Chromium build: `npm run test:browser`.
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import assert from "node:assert/strict";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "../../src"); // the extension
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ext-profile-"));

// Extensions need Chromium's new headless mode, passed as a flag.
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--headless=new", `--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
let [worker] = ctx.serviceWorkers();
worker ??= await ctx.waitForEvent("serviceworker");
const id = new URL(worker.url()).host;

const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`chrome-extension://${id}/popup/popup.html`);

const result = await page.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const m = await Memory.open("browser-test");
  const log = `---\ntype: note\ntitle: "Ship the pricing page"\nkind: decision\ntopic: shop\ndate: 2026-10-10\nsource: claude-code\nhost: laptop\nid: aaaaaaaaaa\n---\n\n# Ship the pricing page\n\n- **Context:** Old page converts badly.\n- **Decision/Result:** New layout.\n- **Evidence:** none\n- **Next action:** Ship it by Friday.\n`;
  const imported = await m.importFiles([
    { path: "notes/log/2026/a.md", text: log },
    { path: "notes/topics/shop.md", text: "# Shop\nCheckout lives in the shop repo." },
  ]);
  const added = await m.add({
    kind: "todo",
    topic: "shop",
    title: "Fix checkout bug",
    context: "Cart drops items.",
    result: "Fix checkout bug",
    next: "Write the failing test",
    evidence: "api_key=supersecretvalue1",
  });
  const cons = await m.consolidate();
  const again = await m.consolidate();
  const hits = (await m.recall("checkout")).map((h) => h.title);
  const loops = (await m.openLoops()).map((e) => e.title);
  const { prompt } = await m.contextPack({ title: "Checkout - Shop admin", url: "https://shop.example/checkout" });
  const filed = (await m.recall("checkout bug"))[0].item;
  return {
    imported,
    added: added.status,
    cons,
    again,
    hits,
    loops,
    prompt,
    filedEvidence: filed.evidence,
    filedStatus: filed.status,
  };
});

const memory2 = await page.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const M = 60 * 1000;
  const now = Date.now();

  // Activity: three pages over 30 minutes, then idle.
  const a = await Memory.open("browser-test-2");
  await a.recordActivity({ url: "https://github.com/x/shop", title: "Fix checkout bug", ts: now - 30 * M });
  await a.recordActivity({ url: "https://www.youtube.com/watch", title: "Lofi", ts: now - 20 * M });
  await a.recordActivity({ url: "https://github.com/x/shop", title: "Fix checkout bug", ts: now - 5 * M });
  await a.recordActivity({ kind: "idle", ts: now - 1 * M });
  const act = await a.activity({ minutes: 60, now });

  // Distill with a fake model that returns one entry wrapped in a reasoning block.
  const fake = async (messages) => {
    if (!messages[1].content.includes("youtube.com: 15 min")) throw new Error("activity not in prompt");
    return '<think>x</think>[{"kind":"todo","topic":"shop","title":"Checkout bug fix in progress","context":"25 min on the shop repo.","result":"Bug located in cart.","evidence":"github.com 19 min","next":"Write the failing test"}]';
  };
  const distilled = await a.distill(fake, { now });
  const cons = await a.consolidate();

  // Brain connector on an OPFS folder that looks like a second-brain checkout.
  const root = await navigator.storage.getDirectory();
  const brain = await root.getDirectoryHandle("brain", { create: true });
  const write = async (dir, parts, text) => {
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(text);
    await w.close();
  };
  await write(brain, ["notes", "topics", "shop.md"], "# Shop\nCheckout notes.");
  await write(brain, ["skills", "ignored.md"], "# not read");
  const m = await Memory.open(); // default DB, shared with the background worker
  const connected = await m.connectBrain(brain);
  await m.add({
    kind: "fact",
    topic: "shop",
    title: "Cart drops items on reload",
    context: "Seen in testing.",
    result: "Reproduced twice.",
  });
  const maintained = await m.maintain();
  const inbox = await brain.getDirectoryHandle("inbox");
  const exportedFiles = [];
  for await (const [name, h] of inbox.entries()) exportedFiles.push({ name, text: await (await h.getFile()).text() });
  const again = await m.exportPending();
  return {
    spans: act.spans.length,
    text: act.text,
    distilled: distilled.added,
    cons,
    connected,
    maintained,
    exportedFiles,
    again,
  };
});

// Background worker: re-import the brain from the handle stored in IndexedDB.
const synced = await page.evaluate(() => chrome.runtime.sendMessage({ type: "sync-brain" }));
const afterSync = await page.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const hits = await (await Memory.open()).recall("cart drops items reload");
  return hits.filter((h) => h.title === "Cart drops items on reload").map((h) => h.item.path ?? "own");
});

// Two Memory instances on one database, as the options page and the background worker
// are: an import made through one must show up in the other's next read, without a
// restart. Before the version stamp, the second instance kept its first read for good.
const twoInstances = await page.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const entry = (title, next) =>
    `---\nkind: todo\ntopic: demo\ntitle: "${title}"\ndate: 2026-11-01\nsource: manual\nhost: x\n---\nContext: c\nDecision/Result: r\nEvidence: none\nNext action: ${next}\n`;
  const worker = await Memory.open("browser-test-3");
  const options = await Memory.open("browser-test-3");
  const titles = async (m) => (await m.openLoops()).map((e) => e.title).sort();

  const empty = await titles(worker); // the worker loads and caches its copy here
  await options.importFiles([
    { path: "inbox/20261101T000000Z-x-y-aaaaaa.md", text: entry("First imported task", "do it") },
  ]);
  const afterImport = await titles(worker);

  // The other direction: the options page has read (so cached) its copy, then the
  // worker adds an entry of its own.
  const optionsBefore = await titles(options);
  await worker.add({
    kind: "todo",
    topic: "demo",
    title: "Added by the worker",
    context: "c",
    result: "r",
    next: "ship",
  });
  const optionsSees = await titles(options);

  // refresh() drops the local copy, so the next read reloads it.
  await options.refresh();
  const afterRefresh = await titles(options);
  return { empty, afterImport, optionsBefore, optionsSees, afterRefresh };
});

// Taking an entry back (issue #25), as Forget on a label does: the other instance's recall
// misses it at once; one not exported yet never is; one exported and still in the brain's
// inbox/ is deleted there; one whose id changed in redaction goes by the id add() returned;
// and a brain that has filed it keeps its file, but no import brings it back.
const removal = await page.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const worker = await Memory.open("browser-test-4");
  const options = await Memory.open("browser-test-4");
  const pref = (title, fields) => ({
    kind: "preference",
    topic: "shop",
    title,
    context: "Marked by the user from a nudge.",
    result: "related",
    ...fields,
  });
  const found = async (m, title) => (await m.recall(title)).some((h) => h.title === title);
  const root = await navigator.storage.getDirectory();
  const brain = await root.getDirectoryHandle("brain-4", { create: true });
  const inboxTitles = async () => {
    const titles = [];
    for await (const [, h] of (await brain.getDirectoryHandle("inbox", { create: true })).entries())
      if (h.kind === "file") titles.push((await (await h.getFile()).text()).match(/title: "(.*)"/)[1]);
    return titles.sort();
  };
  await options.connectBrain(brain);

  const kept = await worker.add(pref("example.com counts as work for shop"));
  const pending = await worker.add(pref("social.example counts as work for shop"));
  const before = await found(options, pending.title);
  const removedPending = await worker.remove(pending.id);
  const after = await found(options, pending.title);
  await worker.maintain(); // consolidate, then export what is left
  const exported = await inboxTitles();

  const removedExported = await worker.remove(kept.id);
  const inboxAfter = await inboxTitles();
  const keptFound = await found(options, kept.title);

  const secret = await worker.add(
    pref("api.example counts as work for shop", { evidence: "api_key=supersecretvalue1" }),
  );
  await worker.consolidate();
  const redactedFiled = (await worker.recall(secret.title)).find((h) => h.title === secret.title)?.item.id;
  const removedRedacted = await worker.remove(secret.id);
  const secretFound = await found(options, secret.title);

  // The brain filed the first one under notes/log with an id of its own.
  const logDir = await (
    await brain.getDirectoryHandle("notes", { create: true })
  ).getDirectoryHandle("log", {
    create: true,
  });
  const w = await (await logDir.getFileHandle("filed.md", { create: true })).createWritable();
  await w.write(
    `---\ntype: note\ntitle: "${kept.title}"\nkind: preference\ntopic: shop\ndate: ${kept.date}\nsource: extension\nhost: laptop\nid: bbbbbbbbbb\n---\n\n# ${kept.title}\n\n- **Context:** Marked by the user from a nudge.\n- **Decision/Result:** related\n- **Evidence:** none\n- **Next action:** none\n`,
  );
  await w.close();
  const synced = await options.syncBrain();
  const filedFound = await found(worker, kept.title);
  const fileStays = !!(await logDir.getFileHandle("filed.md").catch(() => null));
  return {
    before,
    after,
    removedPending,
    exported,
    removedExported,
    inboxAfter,
    keptFound,
    redactedChanged: redactedFiled !== secret.id,
    removedRedacted,
    secretFound,
    synced: synced.entries,
    filedFound,
    fileStays,
  };
});

// Memory by source (issue #6): a brain, a Markdown folder and a pasted memory side by side.
// A brain sync leaves the others as they are; removing one leaves the rest, and the other
// instance's recall misses it at once; only the extension's own entries are exported.
const sources = await page.evaluate(async () => {
  const { Memory } = await import("/memory/index.js");
  const { readTextFiles } = await import("/memory/connector.js");
  const worker = await Memory.open("browser-test-5");
  const options = await Memory.open("browser-test-5");
  const root = await navigator.storage.getDirectory();
  const write = async (dir, name, text) => {
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  };
  // Entries only: the vault's own file is found too, as a document.
  const titles = async (m, q) =>
    (await m.recall(q))
      .filter((h) => h.ref.type === "entry")
      .map((h) => h.title)
      .sort();
  const logNote = (title, next) =>
    `---\ntype: note\ntitle: "${title}"\nkind: decision\ntopic: shop\ndate: 2026-10-10\nsource: claude-code\nhost: laptop\nid: ${title.length}aaaaaaaa\n---\n\n# ${title}\n\n- **Context:** Invented.\n- **Decision/Result:** Invented.\n- **Evidence:** none\n- **Next action:** ${next}\n`;

  // A stand-in for the Markdown reader (part B): one todo per unchecked box.
  const read = async (dir) => {
    const files = await readTextFiles(dir);
    const entries = files.flatMap((f) =>
      [...f.text.matchAll(/^- \[ \] (.+)$/gm)].map((m) => ({
        kind: "todo",
        topic: "vault",
        title: m[1],
        date: "2026-10-20",
        source: "markdown",
        context: f.path,
        result: "open",
        next: m[1],
        evidence: "none",
        path: f.path,
      })),
    );
    return { entries, documents: files.map((f) => ({ path: f.path, title: f.path, text: f.text })), skipped: [] };
  };

  const brain = await root.getDirectoryHandle("brain-5", { create: true });
  const log = await (
    await brain.getDirectoryHandle("notes", { create: true })
  ).getDirectoryHandle("log", {
    create: true,
  });
  await write(log, "a.md", logNote("Ship the invoice export", "Ship it by Friday."));
  await options.connectBrain(brain);

  const vault = await root.getDirectoryHandle("Vault", { create: true });
  await write(vault, "Inbox.md", "# Inbox\n- [ ] Renew the invoice domain\n- [x] Done already\n");
  const md = await options.connectFolder(vault, { kind: "md", read });

  const paste = await options.importEntries({
    origin: "paste:t1",
    name: "Pasted from an assistant",
    entries: [
      {
        kind: "todo",
        topic: "invoices",
        title: "Send the invoice draft to the accountant",
        date: "2026-10-30",
        source: "paste",
        context: "From the assistant.",
        result: "open",
        next: "Send the invoice draft",
        evidence: "none",
      },
      { kind: "nonsense", topic: "x", title: "Bad", date: "2026-10-30", context: "c", result: "r" },
    ],
  });

  // A new brain snapshot: only the brain's part changes.
  await log.removeEntry("a.md");
  await write(log, "b.md", logNote("Close the invoice ticket", "Close it today."));
  const synced = await options.syncBrain();
  const afterSync = await titles(worker, "invoice");
  const listed = (await worker.sources()).map(({ origin, kind, name, entries, documents, openLoops, connected }) => ({
    origin,
    kind,
    name,
    entries,
    documents,
    openLoops,
    connected,
  }));

  // Only the extension's own entries go to the brain's inbox.
  const exportedNone = await worker.exportPending();
  await worker.add({
    kind: "fact",
    topic: "invoices",
    title: "Each invoice goes out monthly",
    context: "c",
    result: "r",
  });
  await worker.consolidate();
  const exportedOwn = await worker.exportPending();

  const removedPaste = await worker.removeSource("paste:t1");
  const afterPaste = await titles(options, "invoice");
  const removedMd = await options.removeSource("md:Vault");
  const syncRemoved = await options.syncSource("md:Vault", { read });
  const afterMd = await titles(worker, "invoice");
  const left = (await worker.sources()).map((x) => x.origin);
  const readded = await options.connectFolder(vault, { kind: "md", read });
  return {
    md,
    paste,
    synced: { connected: synced.connected, entries: synced.entries },
    afterSync,
    listed,
    exportedNone,
    exportedOwn,
    removedPaste,
    afterPaste,
    removedMd,
    syncRemoved,
    afterMd,
    left,
    readded: readded.entries,
  };
});

// A real Markdown folder through the real reader (issue #6, the invented vault in
// test/fixtures/vault copied into an origin-private folder), and a pasted memory through
// the paste node with a fake model: what the settings page does, without its clicks.
const vaultFiles = [];
const walkVault = (dir, rel = "") => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walkVault(full, `${rel}${name}/`);
    else vaultFiles.push({ path: `${rel}${name}`, text: fs.readFileSync(full, "utf8") });
  }
};
walkVault(path.resolve(import.meta.dirname, "../fixtures/vault"));
const { fromMarkdownFolder } = await import("../../src/memory/markdown.js");
const expectedVault = fromMarkdownFolder(
  vaultFiles.map((f) => ({ ...f, lastModified: Date.now() })),
  {
    folderName: "Vault-6",
  },
);
const own = await page.evaluate(async (files) => {
  const { Memory, importPasted } = await import("/memory/index.js");
  const memory = await Memory.open("browser-test-6");
  const root = await navigator.storage.getDirectory();
  const vault = await root.getDirectoryHandle("Vault-6", { create: true });
  for (const { path: p, text } of files) {
    const parts = p.split("/");
    let d = vault;
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
    const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }
  const folder = await memory.connectFolder(vault, { kind: "md" });
  const queue = await memory.taskQueue({ today: "2026-11-02", limit: Infinity });
  const note = (await memory.recall("cart bug")).find((h) => h.ref.type !== "entry");

  // The paste node with a fake model that answers with one task and one preference.
  const calls = [];
  const fake = async (messages) => {
    calls.push(messages);
    return JSON.stringify([
      {
        kind: "todo",
        topic: "Pantry",
        title: "Ship the Pantry beta",
        context: "Building Pantry with a friend.",
        result: "The beta has a date.",
        next: "Ship it, due 2026-11-20",
      },
      { kind: "preference", topic: "work", title: "Prefers mornings", context: "Said so.", result: "Mornings." },
    ]);
  };
  const pasted = await importPasted(fake, "- Ship the Pantry beta by 2026-11-20\n- api_key = sk-test1234567890abcdef", {
    today: "2026-11-02",
  });
  const stored = await memory.importEntries({ origin: "paste:p6", name: "Pasted 2026-11-02", entries: pasted.entries });
  const sent = calls[0].at(-1).content;
  return {
    folder,
    open: queue.filter((e) => e.origin === "md:Vault-6").map((e) => ({ title: e.title, due: e.due })),
    note: note?.title ?? null,
    pasted: { entries: stored.entries, redactions: pasted.redactions, calls: calls.length },
    secretSent: sent.includes("sk-test1234567890abcdef"),
    kinds: (await memory.sources()).map((x) => [x.origin, x.entries, x.openLoops]),
    exported: (await memory.exportPending()).exported,
  };
}, vaultFiles);

// The settings page loads with its new card, and no script error.
const settings = await ctx.newPage();
settings.on("pageerror", (e) => errors.push(String(e)));
await settings.goto(`chrome-extension://${id}/options/options.html`);
await settings.waitForSelector("#source-list p, #source-list .row");
const settingsCard = await settings.evaluate(() => ({
  ask: document.getElementById("ask-text").textContent,
  importDisabled: document.getElementById("import-paste").disabled,
}));
await settings.close();

await ctx.close();
fs.rmSync(profile, { recursive: true, force: true });

assert.deepEqual(errors, []);
assert.deepEqual(result.imported, { entries: 1, notes: 1, skipped: [] });
assert.equal(result.added, "inbox");
assert.deepEqual(result.cons, { accepted: 1, duplicates: 0, rejected: 0, redactions: 1 });
assert.equal(result.again.accepted, 0);
assert.equal(result.filedStatus, "log");
assert.equal(result.filedEvidence, "api_key=[REDACTED]");
assert.equal(result.hits[0], "Fix checkout bug");
assert.deepEqual(result.loops.sort(), ["Fix checkout bug", "Ship the pricing page"]);
assert.match(result.prompt, /Stated intent \(\d{4}-\d{2}-\d{2}\): Fix checkout bug/);
assert.equal(memory2.spans, 3);
assert.match(memory2.text, /^Last 60 min \(29 min active\):/);
assert.match(memory2.text, /github\.com: 14 min/);
assert.equal(memory2.distilled, 1);
assert.equal(memory2.cons.accepted, 1);
assert.deepEqual(memory2.connected, { entries: 0, notes: 1, skipped: [] });
assert.equal(memory2.maintained.consolidated.accepted, 1);
assert.equal(memory2.maintained.exported.exported, 1);
assert.equal(memory2.exportedFiles.length, 1);
assert.match(memory2.exportedFiles[0].name, /^\d{8}T\d{6}Z-browser-extension-[0-9a-f]{6}\.md$/);
assert.match(memory2.exportedFiles[0].text, /^---\nkind: fact\ntopic: shop\ntitle: "Cart drops items on reload"/);
assert.equal(memory2.again.exported, 0); // exported once only
assert.equal(synced.connected, true, `sync: ${JSON.stringify(synced)}`);
assert.equal(synced.entries, 1); // the exported entry came back from the brain inbox
assert.deepEqual(afterSync, [memory2.exportedFiles[0] && `inbox/${memory2.exportedFiles[0].name}`]); // once, as the brain copy

assert.deepEqual(twoInstances.empty, []);
assert.deepEqual(
  twoInstances.afterImport,
  ["First imported task"],
  "the worker's copy must pick up an import made elsewhere",
);
assert.deepEqual(twoInstances.optionsBefore, ["First imported task"]);
assert.deepEqual(
  twoInstances.optionsSees,
  ["Added by the worker", "First imported task"],
  "the other way round: an entry the worker adds must show in a page that had already read",
);
assert.deepEqual(twoInstances.afterRefresh, ["Added by the worker", "First imported task"]);
assert.equal(removal.before, true);
assert.equal(removal.after, false, "the other instance's recall misses a removed entry at once");
assert.deepEqual(removal.removedPending, { removed: 1, file: null });
assert.deepEqual(removal.exported, ["example.com counts as work for shop"], "a removed entry is never exported");
assert.deepEqual(removal.removedExported, { removed: 1, file: "deleted" });
assert.deepEqual(removal.inboxAfter, [], "the exported file left the brain's inbox");
assert.equal(removal.keptFound, false);
assert.ok(removal.redactedChanged, "redaction gave the filed entry a new id");
assert.equal(removal.removedRedacted.removed, 1, "removed by the id add() returned");
assert.equal(removal.secretFound, false);
assert.equal(removal.synced, 0, "a brain that still holds a removed entry does not bring it back");
assert.equal(removal.filedFound, false);
assert.ok(removal.fileStays, "what the brain has filed is left alone");
assert.deepEqual(sources.md, { entries: 1, notes: 1, skipped: [] }, "the checked box is not a task");
assert.equal(sources.paste.entries, 1);
assert.equal(sources.paste.skipped.length, 1, "an entry that fails validation is skipped and reported");
assert.deepEqual(sources.synced, { connected: true, entries: 1 });
assert.deepEqual(
  sources.afterSync,
  ["Close the invoice ticket", "Renew the invoice domain", "Send the invoice draft to the accountant"],
  "a brain sync replaced the brain's part and left the folder and the paste",
);
assert.deepEqual(sources.listed, [
  { origin: "brain", kind: "brain", name: "brain-5", entries: 1, documents: 0, openLoops: 1, connected: true },
  { origin: "md:Vault", kind: "md", name: "Vault", entries: 1, documents: 1, openLoops: 1, connected: true },
  {
    origin: "paste:t1",
    kind: "paste",
    name: "Pasted from an assistant",
    entries: 1,
    documents: 0,
    openLoops: 1,
    connected: undefined,
  },
]);
assert.equal(sources.exportedNone.exported, 0, "entries from other sources are never written to the brain");
assert.equal(sources.exportedOwn.exported, 1);
assert.deepEqual(sources.removedPaste, { entries: 1, notes: 0 });
assert.deepEqual(
  sources.afterPaste,
  ["Close the invoice ticket", "Each invoice goes out monthly", "Renew the invoice domain"],
  "the other instance misses the removed paste at once",
);
assert.deepEqual(sources.removedMd, { entries: 1, notes: 1 });
assert.deepEqual(sources.syncRemoved, { connected: false }, "a removed folder is not synced back");
assert.deepEqual(sources.afterMd, ["Close the invoice ticket", "Each invoice goes out monthly"]);
assert.deepEqual(sources.left, ["brain"]);
assert.equal(sources.readded, 1, "connecting the folder again brings it back");
assert.equal(own.folder.entries, expectedVault.entries.length, "every open checkbox in the vault is a task");
assert.equal(own.folder.entries, 8);
assert.equal(own.folder.notes, 4, "each .md file is a note; .obsidian/, .trash/ and .txt are not read");
assert.ok(
  own.open.some((e) => e.title === "Write the failing test for cart item removal" && e.due === "2026-11-10"),
  `a 📅 task with its deadline: ${JSON.stringify(own.open)}`,
);
assert.ok(
  !own.open.some((e) => /Set up CI|template|code fence/.test(e.title)),
  "done, hidden and fenced boxes stay out",
);
assert.equal(own.note, "Shop checkout", "recall finds a note from the folder");
assert.equal(own.pasted.entries, 2);
assert.equal(own.pasted.calls, 1, "one call for one paste");
assert.ok(own.pasted.redactions >= 1, "the secret line was redacted");
assert.equal(own.secretSent, false, "a secret in the paste is removed before it is sent");
assert.deepEqual(own.kinds, [
  ["md:Vault-6", 8, 8],
  ["paste:p6", 2, 1],
]);
assert.equal(own.exported, 0, "nothing from a folder or a paste is written anywhere");
assert.match(settingsCard.ask, /deadlines with dates/);
assert.equal(settingsCard.importDisabled, true, "nothing is sent before a preview");
console.log("browser test: ok");

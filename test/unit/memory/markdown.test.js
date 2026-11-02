import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { fromMarkdownFolder, readMarkdownFolder, slug } from "../../../src/memory/markdown.js";
import { validate } from "../../../src/memory/entry.js";
import { dueOf } from "../../../src/memory/due.js";
import { taskQueue } from "../../../src/memory/context.js";

// Invented vault only (test/fixtures/vault). No real notes in this repo.
const VAULT = fileURLToPath(new URL("../../fixtures/vault/", import.meta.url));
const MODIFIED = Date.parse("2026-11-01T10:00:00Z");

// Every file, dot-folders and .txt included: the adapter must skip them itself.
function vaultFiles(dir = VAULT) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return vaultFiles(full);
    return [{ path: relative(VAULT, full), text: readFileSync(full, "utf8"), lastModified: MODIFIED }];
  });
}

const read = (opts) => fromMarkdownFolder(vaultFiles(), { today: "2026-11-02", folderName: "My Vault", ...opts });
const byTitle = (entries, start) => entries.find((e) => e.title.startsWith(start));

test("open tasks become valid todo entries; done, cancelled and fenced ones do not", () => {
  const { entries, skipped } = read();
  assert.deepEqual(skipped, []);
  for (const e of entries) assert.deepEqual(validate(e), [], e.title);
  assert.ok(entries.every((e) => e.kind === "todo" && e.source === "markdown" && e.result === "open"));
  const titles = entries.map((e) => e.title);
  assert.ok(!titles.some((t) => /Set up CI|old programme|Çamaşır|code fence|frontmatter/.test(t)), titles.join(" | "));
  assert.ok(byTitle(entries, "Review the payment PR"), "[/] is in progress, still open");
  assert.ok(byTitle(entries, "Ask Deniz about partial refunds"), "an indented subtask counts");
  assert.ok(byTitle(entries, "Ask the accountant about VAT"), "a numbered task counts");
});

test("dot-folders and files that are not Markdown are skipped", () => {
  const { entries, documents } = read();
  const paths = [...entries, ...documents].map((x) => x.path);
  assert.ok(
    !paths.some((p) => p.startsWith(".obsidian/") || p.startsWith(".trash/") || p.endsWith(".txt")),
    paths.join(" "),
  );
});

test("the title loses Obsidian's metadata; next keeps it for the deadline", () => {
  const { entries } = read();
  const cart = byTitle(entries, "Write the failing test");
  assert.equal(cart.title, "Write the failing test for cart item removal");
  assert.match(cart.next, /📅 2026-11-10 ⏫/);
  assert.equal(byTitle(entries, "Review the payment PR").title, "Review the payment PR");
  assert.equal(byTitle(entries, "Water the office plants").title, "Water the office plants");
  assert.equal(byTitle(entries, "Send the grant budget").title, "Send the grant budget");
});

test("deadlines come from Obsidian's due date, Dataview fields and Turkish cues", () => {
  const { entries } = read();
  assert.equal(dueOf(byTitle(entries, "Write the failing test")), "2026-11-10");
  assert.equal(dueOf(byTitle(entries, "Review the payment PR")), "2026-11-12");
  assert.equal(dueOf(byTitle(entries, "Send the grant budget")), "2026-11-20");
  assert.equal(dueOf(byTitle(entries, "Ask the accountant")), "2026-11-15", "⏳ scheduled is not the deadline");
  assert.equal(dueOf(byTitle(entries, "İzmir'deki ışık faturasını öde")), "2026-11-10");
  assert.equal(dueOf(byTitle(entries, "Ask Deniz")), null);
});

test("a deadline before the file's date is still a deadline", () => {
  const late = Date.parse("2026-11-12T09:00:00Z");
  const { entries } = fromMarkdownFolder([
    { path: "todo.md", text: "- [ ] Pay the invoice 📅 2026-11-10", lastModified: late },
  ]);
  assert.equal(entries[0].date, "2026-11-10");
  assert.equal(dueOf(entries[0]), "2026-11-10");
});

test("topic is the top folder, or the file's name at the root, as a slug", () => {
  const { entries } = read();
  assert.equal(byTitle(entries, "Write the failing test").topic, "projects");
  assert.equal(byTitle(entries, "Send the grant budget").topic, "projects");
  assert.equal(byTitle(entries, "İzmir'deki").topic, "gunluk");
  assert.equal(slug("İş Planı ılık"), "is-plani-ilik");
  assert.equal(slug("!!!"), "");
});

test("context names the file and the nearest heading", () => {
  const { entries } = read();
  assert.equal(byTitle(entries, "Write the failing test").context, "Projects/shop.md › This week");
  assert.equal(byTitle(entries, "Rewrite the checkout page").context, "Projects/shop.md › Later");
});

test("a long task is cut at a word, at most 120 characters; a too short one is dropped", () => {
  const { entries } = read();
  const long = byTitle(entries, "Rewrite the checkout page");
  assert.ok(long.title.length <= 120 && !long.title.endsWith(" "), long.title);
  assert.ok(long.next.length > 120, "next keeps the whole task");
  assert.ok(!entries.some((e) => e.title === "ok"));
});

test("every Markdown file is a document, titled by its first heading", () => {
  const { documents } = read();
  const shop = documents.find((d) => d.path === "Projects/shop.md");
  assert.equal(shop.title, "Shop checkout");
  assert.equal(documents.find((d) => d.path === "Reading/ideas.md").title, "ideas");
  assert.equal(documents.length, 4);
});

test("ids are stable across reads, and one task listed twice is kept once", () => {
  assert.deepEqual(
    read().entries.map((e) => e.id),
    read().entries.map((e) => e.id),
  );
  const twice = "- [ ] Call the bank about the card\n- [ ] Call the bank about the card";
  assert.equal(fromMarkdownFolder([{ path: "a.md", text: twice, lastModified: MODIFIED }]).entries.length, 1);
});

test("the tasks join the queue in deadline order", () => {
  const queue = taskQueue(read().entries, { today: "2026-11-02", limit: Infinity });
  assert.deepEqual(
    queue.filter((e) => e.due).map((e) => e.due),
    ["2026-11-04", "2026-11-10", "2026-11-10", "2026-11-12", "2026-11-15", "2026-11-20"],
  );
});

// A stand-in for a FileSystemDirectoryHandle.
function dirHandle(tree) {
  return {
    kind: "directory",
    async *entries() {
      for (const [name, value] of Object.entries(tree)) {
        if (typeof value === "string")
          yield [name, { kind: "file", getFile: async () => ({ text: async () => value, lastModified: MODIFIED }) }];
        else yield [name, dirHandle(value)];
      }
    },
  };
}

test("readMarkdownFolder reads .md files with their dates and skips dot-folders", async () => {
  const files = await readMarkdownFolder(
    dirHandle({
      "a.md": "- [ ] one",
      ".obsidian": { "b.md": "- [ ] hidden" },
      sub: { "c.md": "- [ ] two", "d.png": "binary" },
    }),
  );
  assert.deepEqual(
    files.map((f) => [f.path, f.lastModified]),
    [
      ["a.md", MODIFIED],
      ["sub/c.md", MODIFIED],
    ],
  );
});

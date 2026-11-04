import test from "node:test";
import assert from "node:assert/strict";
import { BRAIN, OWN, READERS, originOf, kindOf, sampleAcross } from "../../../src/memory/sources.js";
import { readTextFiles } from "../../../src/memory/connector.js";

// Synthetic fixtures only. No real brain content in this repo.

// A folder in the shape of the File System Access API: { "name": "text" | { …folder } }.
function folder(tree, modified = 1700000000000) {
  return {
    async *entries() {
      for (const [name, value] of Object.entries(tree)) {
        if (typeof value === "string")
          yield [name, { kind: "file", getFile: async () => ({ text: async () => value, lastModified: modified }) }];
        else yield [name, { kind: "directory", ...folder(value, modified) }];
      }
    },
  };
}

test("an origin says where a record came from; older records have none", () => {
  assert.equal(originOf({ origin: "md:Notes", path: "a.md" }), "md:Notes");
  assert.equal(originOf({ origin: "paste:ab12" }), "paste:ab12");
  assert.equal(originOf({ path: "notes/log/2026/a.md" }), BRAIN, "a stored record with a path came from the brain");
  assert.equal(originOf({ title: "Fix the bug" }), OWN, "without a path it is the extension's own");
});

test("a source's kind is the part before the colon", () => {
  assert.equal(kindOf("md:My vault"), "md");
  assert.equal(kindOf("paste:ab12"), "paste");
  assert.equal(kindOf(BRAIN), "brain");
});

test("the brain reader reads inbox/ and notes/ only, as entries and documents", async () => {
  const log = `---\ntype: note\ntitle: "Ship the pricing page"\nkind: decision\ntopic: shop\ndate: 2026-10-10\nsource: claude-code\nhost: laptop\nid: aaaaaaaaaa\n---\n\n# Ship the pricing page\n\n- **Context:** Old page converts badly.\n- **Decision/Result:** New layout.\n- **Evidence:** none\n- **Next action:** Ship it by Friday.\n`;
  const dir = folder({
    notes: { log: { "a.md": log }, "shop.md": "# Shop\nCheckout lives in the shop repo." },
    other: { "x.md": "# Not read" },
  });
  const { entries, documents } = await READERS.brain(dir);
  assert.deepEqual(
    entries.map((e) => e.title),
    ["Ship the pricing page"],
  );
  assert.deepEqual(
    documents.map((d) => d.path),
    ["notes/shop.md"],
  );
});

test("any folder: every Markdown file with its date, hidden folders skipped", async () => {
  const dir = folder({
    "Inbox.md": "- [ ] Call the bank",
    Projects: { "Shop.md": "# Shop", "image.png": "binary" },
    ".obsidian": { "workspace.md": "app state" },
    ".trash": { "old.md": "deleted" },
  });
  const files = await readTextFiles(dir);
  assert.deepEqual(
    files.map((f) => f.path),
    ["Inbox.md", "Projects/Shop.md"],
  );
  assert.equal(files[0].text, "- [ ] Call the bank");
  assert.equal(files[0].lastModified, 1700000000000);
});

// #82: the profile reads a sample of the notes. Newest first across everything, a large
// brain filled it, and a notes folder or a paste dated a little older never made it in.
test("the profile sample gives every source a share, newest first within it", () => {
  const brain = Array.from({ length: 80 }, (_, i) => ({
    origin: BRAIN,
    topic: "work",
    title: `Brain note ${i}`,
    date: `2026-11-${String(4 - (i % 3)).padStart(2, "0")}`,
  }));
  const folderNotes = [
    { origin: "md:Garden", topic: "beekeeping", title: "Order a new queen", date: "2026-09-12" },
    { origin: "md:Garden", topic: "beekeeping", title: "Check the hive", date: "2026-09-10" },
  ];
  const pasted = [{ origin: "paste:p1", topic: "pottery", title: "Glaze class on Tuesdays", date: "2026-08-01" }];
  const sample = sampleAcross([...brain, ...folderNotes, ...pasted], 60);
  assert.equal(sample.length, 60);
  const titles = sample.map((e) => e.title);
  assert.ok(titles.includes("Order a new queen") && titles.includes("Check the hive"), "the notes folder is in");
  assert.ok(titles.includes("Glaze class on Tuesdays"), "the paste is in");
  assert.equal(sample.filter((e) => e.origin === BRAIN).length, 57, "the brain fills what the others leave");
  const dates = sample.map((e) => e.date);
  assert.deepEqual(dates, [...dates].sort().reverse(), "still newest first, as the task node expects");
  assert.equal(sampleAcross(brain, Infinity).length, 80, "no limit keeps everything");
});

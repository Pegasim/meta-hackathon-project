// Where memory comes from. Every entry and document carries an `origin`:
//   "brain"         the second-brain folder (the one exportPending writes to)
//   "md:<folder>"   a Markdown folder, read only (Obsidian, plain notes)
//   "paste:<id>"    what an assistant said it knows about the person, pasted once
//   "export:<kind>:<file>"  recent conversations from a Claude or Gemini account export
// and the extension's own entries (add(), distill) have none. `source` is something
// else: who wrote the entry (claude-code, distill, extension).
import { loadBrain } from "./brain.js";
import { readBrainFolder, readTextFiles } from "./connector.js";
import { fromMarkdownFolder } from "./markdown.js";

export const BRAIN = "brain";
export const OWN = "extension";

// Records stored before origins have none: with a path they came from the brain,
// without one they are the extension's own.
export const originOf = (item) => item.origin ?? (item.path ? BRAIN : OWN);

// A sample of the entries, newest first, in which every source gets a share (#82). Taken
// newest first across all of them, a large brain filled it, and a notes folder or a paste
// a little older never reached the profile. Sources take turns, each its newest first,
// so what one leaves unused goes to the others.
const newest = (a, b) => (b.date ?? "").localeCompare(a.date ?? "");
export function sampleAcross(entries, limit = Infinity) {
  if (entries.length <= limit) return [...entries].sort(newest);
  const bySource = new Map();
  for (const e of [...entries].sort(newest)) {
    const o = originOf(e);
    if (!bySource.has(o)) bySource.set(o, []);
    bySource.get(o).push(e);
  }
  const queues = [...bySource.values()];
  const out = [];
  for (let i = 0; out.length < limit && queues.some((q) => i < q.length); i++)
    for (const q of queues) if (i < q.length && out.length < limit) out.push(q[i]);
  return out.sort(newest);
}

// "md:Notes" -> "md"
export const kindOf = (origin) => origin.split(":")[0];

// Readers turn a connected folder into { entries, documents, skipped }, by source kind.
// A new folder kind adds one line here; Memory.connectFolder and syncSource find it by
// the origin's kind, in the options page and in the worker alike.
export const READERS = {
  brain: async (dir) => loadBrain(await readBrainFolder(dir)),
  md: async (dir) => fromMarkdownFolder(await readTextFiles(dir), { folderName: dir.name }),
};

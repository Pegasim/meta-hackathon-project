// Brain folder connector (File System Access API). Reads .md files under
// inbox/ and notes/, and writes new entries into inbox/ in the brain's format.
import { toInboxMarkdown, fromInboxMarkdown } from "./entry.js";
import { entryKey } from "./consolidate.js";

export async function readBrainFolder(dir, prefix = "") {
  const files = [];
  for await (const [name, handle] of dir.entries()) {
    const path = prefix + name;
    if (handle.kind === "directory") {
      if (prefix === "" && name !== "inbox" && name !== "notes") continue;
      files.push(...(await readBrainFolder(handle, path + "/")));
    } else if (name.endsWith(".md")) {
      files.push({ path, text: await (await handle.getFile()).text() });
    }
  }
  return files;
}

// "granted" | "prompt" | "denied". Asking (prompt: true) needs a user click,
// so background code only checks.
export async function permission(dir, mode, { prompt = false } = {}) {
  const state = await dir.queryPermission({ mode });
  if (state === "granted" || !prompt) return state;
  return dir.requestPermission({ mode });
}

// Same naming as the brain's inbox files: <UTC timestamp>-<host>-<source>-<id6>.md
export function inboxFileName(entry, host, now = new Date()) {
  const ts = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${ts}-${host}-${entry.source}-${entry.id.slice(0, 6)}.md`;
}

// Returns the file's name, so the entry can be found there again.
export async function writeInboxEntry(dir, entry, host = "browser") {
  const inbox = await dir.getDirectoryHandle("inbox", { create: true });
  const name = inboxFileName(entry, host);
  const file = await inbox.getFileHandle(name, { create: true });
  const w = await file.createWritable();
  await w.write(toInboxMarkdown(entry, host));
  await w.close();
  return name;
}

// Deletes the file this extension wrote for an entry, while it is still in inbox/: by the
// name it was written under, else by that name's ending (entries exported before the name
// was kept). Only a file that still holds that entry goes; inbox/_done/ and notes/ are
// the brain's and are never touched. Returns whether a file was deleted.
export async function removeInboxEntry(dir, entry) {
  let inbox;
  try {
    inbox = await dir.getDirectoryHandle("inbox");
  } catch {
    return false;
  }
  const named = entry.exportedAs ?? entry.path?.replace(/^inbox\//, "");
  for await (const [name, handle] of inbox.entries()) {
    if (handle.kind !== "file") continue;
    if (named ? name !== named : !name.endsWith(`-${entry.source}-${entry.id.slice(0, 6)}.md`)) continue;
    let held;
    try {
      held = fromInboxMarkdown(await (await handle.getFile()).text());
    } catch {
      continue;
    }
    if (entryKey(held) !== entryKey(entry)) continue;
    await inbox.removeEntry(name);
    return true;
  }
  return false;
}

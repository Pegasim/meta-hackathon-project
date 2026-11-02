// The brain is the folder that holds inbox/ and notes/, and only those two are read.
// Choosing inbox/ itself imports nothing, and new entries would land in inbox/inbox/.
// An empty folder is fine: it can start a new brain.
export async function wrongBrainFolder(dir) {
  let empty = true;
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === "directory" && (name === "inbox" || name === "notes")) return false;
    if (!name.startsWith(".")) empty = false;
  }
  return !empty;
}

import test from "node:test";
import assert from "node:assert/strict";
import { wrongBrainFolder } from "../../../src/options/brain-folder.js";

// The part of a directory handle the check uses.
const folder = (children) => ({
  async *entries() {
    for (const [name, kind] of Object.entries(children)) yield [name, { kind }];
  },
});

test("the brain's inbox/ itself is the wrong folder", async () => {
  assert.equal(await wrongBrainFolder(folder({ "note.md": "file", _done: "directory" })), true);
});

test("a folder holding inbox/ or notes/ is a brain", async () => {
  assert.equal(await wrongBrainFolder(folder({ inbox: "directory" })), false);
  assert.equal(await wrongBrainFolder(folder({ "README.md": "file", notes: "directory" })), false);
});

test("a file named inbox does not make a brain", async () => {
  assert.equal(await wrongBrainFolder(folder({ inbox: "file" })), true);
});

test("an empty folder can start a new brain, hidden files aside", async () => {
  assert.equal(await wrongBrainFolder(folder({})), false);
  assert.equal(await wrongBrainFolder(folder({ ".DS_Store": "file" })), false);
});

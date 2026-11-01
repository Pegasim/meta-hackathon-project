#!/usr/bin/env node
// The native messaging host. Chrome starts it and keeps it running while the extension's
// port is open. It follows ~/.tuck/agent.jsonl and passes new lines on, so the hook needs
// nothing running. Protocol: a 4-byte little-endian length, then JSON, on stdout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { follow } from "./status.mjs";

const file = path.join(os.homedir(), ".tuck", "agent.jsonl");
const POLL_MS = 500;

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([size, body]));
}

const sizeOf = () => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

// Only what happens from now on: an old status says nothing about whose turn it is.
let offset = sizeOf();
let session = null;
let partial = "";

setInterval(() => {
  const size = sizeOf();
  if (size < offset) offset = 0; // the file was replaced
  if (size === offset) return;
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.alloc(size - offset);
  fs.readSync(fd, chunk, 0, chunk.length, offset);
  fs.closeSync(fd);
  offset = size;
  const lines = (partial + chunk.toString("utf8")).split("\n");
  partial = lines.pop();
  for (const text of lines) {
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      continue;
    }
    const next = follow(session, line);
    session = next.session;
    if (next.pass) send({ status: next.pass.status, session: next.pass.session, ts: next.pass.ts });
  }
}, POLL_MS);

// Chrome closes stdin when the port closes.
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();

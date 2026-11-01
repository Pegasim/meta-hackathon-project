#!/usr/bin/env node
// Runs on each Muse Code hook. Appends one status line and gets out of the way: it never
// slows or blocks the agent, so whatever goes wrong it exits 0 and prints nothing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { lineFor } from "./status.mjs";

try {
  const line = lineFor(JSON.parse(fs.readFileSync(0, "utf8")), Date.now());
  if (line) {
    const dir = path.join(os.homedir(), ".tuck");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "agent.jsonl"), `${JSON.stringify(line)}\n`);
  }
} catch {}
process.exit(0);

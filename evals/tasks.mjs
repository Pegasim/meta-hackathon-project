// Task eval (LLM#6): runs every case in evals/tasks/cases.jsonl through the task node
// against the real model, in batches as the extension sends them. Run with
// `npm run eval:tasks` (loads MODEL_API_KEY from .env). The cases are invented: this
// repo is public, so no one's real notes go in here. Environment:
//   MODEL_API_KEY   required
//   MODEL_PROVIDER  meta (default) | ...; Contributor is never used for notes
//   MODEL_BASE_URL, MODEL_ID  optional overrides
//   REPS            runs per case, default 3 (the majority answer counts)
//
// What counts is whether an entry ends up on the list (a task, still open). Dropping a
// real open task is the worse error: the person loses it. Listing a non-task is noise
// they can take out with Not a task.
import fs from "node:fs";
import path from "node:path";
import { modelClient } from "../src/memory/model.js";
import { privateSettings } from "../src/agent/relevance.js";
import { judgeBatch } from "../src/agent/tasks.js";

const ACCURACY_MIN = 0.85;
const DROPPED_MAX = 0.1;
const BATCH = 15;
const dir = import.meta.dirname;
const reps = Number(process.env.REPS ?? 3);

const cases = fs
  .readFileSync(path.join(dir, "tasks/cases.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const settings = privateSettings({
  provider: process.env.MODEL_PROVIDER ?? "meta",
  baseUrl: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_ID,
  apiKey: process.env.MODEL_API_KEY,
});
const complete = modelClient(settings);

const listed = (v) => !!v && v.isTask && v.open;
const runs = new Map(cases.map((c) => [c.id, []]));
const errors = new Set();
for (let rep = 0; rep < reps; rep++)
  for (let i = 0; i < cases.length; i += BATCH) {
    const batch = cases.slice(i, i + BATCH);
    const r = await judgeBatch(
      complete,
      batch.map((c) => ({ entry: c.entry, later: c.later })),
    );
    if (r.error) errors.add(r.error);
    batch.forEach((c, j) => runs.get(c.id).push(r.verdicts?.get(j + 1) ?? null));
    process.stdout.write(r.verdicts ? "." : "x");
  }
console.log();

const results = cases.map((c) => {
  const got = runs.get(c.id);
  const yes = got.filter(listed).length;
  return {
    id: c.id,
    expect: c.expect.task && c.expect.open,
    got: yes * 2 > got.length,
    titles: got.filter(listed).map((v) => v.task),
    unread: got.filter((v) => !v).length,
  };
});
const open = results.filter((r) => r.expect);
const report = {
  date: new Date().toISOString(),
  provider: settings.provider,
  model: settings.model ?? null,
  reps,
  cases: results.length,
  accuracy: results.filter((r) => r.got === r.expect).length / results.length,
  dropped: open.filter((r) => !r.got).length / (open.length || 1),
  unread: results.reduce((a, r) => a + r.unread, 0),
  errors: [...errors],
  misses: results.filter((r) => r.got !== r.expect).map(({ id, expect, got, titles }) => ({ id, expect, got, titles })),
};

console.log("\nMisses:");
for (const m of report.misses) console.log(`  ${m.id}: expected ${m.expect ? "listed" : "left out"}, got the other`);
if (report.errors.length) console.log("\nErrors:", report.errors.join(" | "));
console.log(`
accuracy  ${(report.accuracy * 100).toFixed(1)}%   (min ${ACCURACY_MIN * 100}%)
dropped   ${(report.dropped * 100).toFixed(1)}%   real open tasks left out (max ${DROPPED_MAX * 100}%)
unread    ${report.unread}/${results.length * reps}`);

const out = path.join(dir, "reports", `tasks-${report.date.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`report: ${path.relative(process.cwd(), out)}`);
process.exit(report.accuracy < ACCURACY_MIN || report.dropped > DROPPED_MAX ? 1 : 0);

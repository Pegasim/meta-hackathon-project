// Relevance eval (LLM#1): runs every case in evals/relevance/cases.jsonl against the
// real model and checks the INTENT.md thresholds. Run with `npm run eval`
// (loads MODEL_API_KEY from .env). A case with an `excerpt` runs the second look's
// prompt (site, title and a page excerpt). Environment:
//   MODEL_API_KEY   required
//   MODEL_PROVIDER  meta-contributor (default) | meta | ...
//   MODEL_BASE_URL, MODEL_ID  optional overrides
//   REPS            runs per case, default 3 (the majority label counts)
//   REASONING_EFFORT  low | minimal | ...; "default": the provider's own; unset: the node's setting
import fs from "node:fs";
import path from "node:path";
import { modelClient } from "../src/memory/model.js";
import { classifyRelevance } from "../src/agent/relevance.js";

const ACCURACY_MIN = 0.85;
const FALSE_UNRELATED_MAX = 0.05;
const REGRESSION_TOLERANCE = 0.05;
const dir = import.meta.dirname;
const reps = Number(process.env.REPS ?? 3);
const provider = process.env.MODEL_PROVIDER ?? "meta-contributor";
const rawEffort = process.env.REASONING_EFFORT || undefined; // unset: the node's own setting
const effortOpt = rawEffort === undefined ? {} : { effort: rawEffort === "default" ? null : rawEffort };
// The service worker can be stopped while a fetch takes longer than this.
const WORKER_FETCH_MS = 30000;

const cases = fs
  .readFileSync(path.join(dir, "relevance/cases.jsonl"), "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const complete = modelClient({
  provider,
  baseUrl: process.env.MODEL_BASE_URL,
  model: process.env.MODEL_ID,
  apiKey: process.env.MODEL_API_KEY,
});

function majority(runs) {
  const counts = new Map();
  for (const r of runs) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  const label = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const same = runs.filter((r) => r.label === label);
  return { label, confidence: same.reduce((a, r) => a + r.confidence, 0) / same.length };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;

const results = [];
for (const c of cases) {
  const runs = [];
  for (let i = 0; i < reps; i++) runs.push(await classifyRelevance(complete, c, effortOpt));
  const m = majority(runs);
  results.push({ id: c.id, expect: c.expect, got: m.label, confidence: m.confidence, runs });
  process.stdout.write(m.label === c.expect ? "." : "x");
}
console.log();

const latencies = results.flatMap((r) => r.runs.map((x) => x.latencyMs)).sort((a, b) => a - b);
const related = results.filter((r) => r.expect === "related");
const report = {
  date: new Date().toISOString(),
  provider,
  model: process.env.MODEL_ID ?? null,
  reasoningEffort: rawEffort ?? "the node's own",
  reps,
  cases: results.length,
  related: related.length,
  accuracy: results.filter((r) => r.got === r.expect).length / results.length,
  falseUnrelated: related.filter((r) => r.got === "unrelated" && r.confidence >= 0.6).length / (related.length || 1),
  p50LatencyMs: pct(latencies, 0.5),
  p95LatencyMs: pct(latencies, 0.95),
  maxLatencyMs: latencies.at(-1) ?? 0,
  overWorkerLimit: latencies.filter((ms) => ms > WORKER_FETCH_MS).length,
  fallbacks: results.flatMap((r) => r.runs).filter((x) => x.source === "fallback").length,
  errors: [
    ...new Set(
      results
        .flatMap((r) => r.runs)
        .map((x) => x.error)
        .filter(Boolean),
    ),
  ],
  misses: results
    .filter((r) => r.got !== r.expect)
    .map((r) => ({ id: r.id, expect: r.expect, got: r.got, confidence: r.confidence, reason: r.runs[0].reason })),
};

console.log("\nMisses:");
for (const m of report.misses)
  console.log(`  ${m.id}: expected ${m.expect}, got ${m.got} (${m.confidence.toFixed(2)}) ${m.reason}`);
if (report.errors.length) console.log("\nErrors:", report.errors.join(" | "));
console.log(`
accuracy        ${(report.accuracy * 100).toFixed(1)}%   (min ${ACCURACY_MIN * 100}%)
false unrelated ${(report.falseUnrelated * 100).toFixed(1)}%   (max ${FALSE_UNRELATED_MAX * 100}%, of ${related.length} related cases)
latency         p50 ${report.p50LatencyMs} ms, p95 ${report.p95LatencyMs} ms, max ${report.maxLatencyMs} ms
over 30 s       ${report.overWorkerLimit}/${latencies.length} calls (the worker's fetch limit)
fallbacks       ${report.fallbacks}/${results.length * reps}`);

const out = path.join(dir, "reports", `${report.date.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`report: ${path.relative(process.cwd(), out)}`);

let fail = report.accuracy < ACCURACY_MIN || report.falseUnrelated > FALSE_UNRELATED_MAX;
const baselinePath = path.join(dir, "baseline.json");
if (fs.existsSync(baselinePath)) {
  const base = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  const delta = report.accuracy - base.accuracy;
  console.log(`vs baseline ${base.date}: accuracy ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts`);
  if (delta < -REGRESSION_TOLERANCE) fail = true;
}
process.exit(fail ? 1 : 0);

// Grouping eval (#47): runs every pair in evals/groups/cases.jsonl through the code that
// picks candidate pairs and through the model's same-or-not, against the real model, in
// calls as the extension sends them. Run with `npm run eval:groups` (loads MODEL_API_KEY
// from .env). The cases are invented: this repo is public. Environment:
//   MODEL_API_KEY   required
//   MODEL_PROVIDER  meta (default) | ...; Contributor is never used for notes
//   MODEL_BASE_URL, MODEL_ID  optional overrides
//   REPS            runs per case, default 3 (the majority answer counts)
//
// A wrong merge hides a task, so it is the worse error and its limit is the tighter one.
// A missed merge only shows a task twice. The code's share says how many of the pairs
// that are one commitment it would ask about at all. The English match keys the code also
// compares come from the task node, run once over every entry as at import (a Markdown
// checkbox is never sent, so it has none), and the code's share is reported with and
// without them.
import fs from "node:fs";
import path from "node:path";
import { modelClient } from "../src/memory/model.js";
import { privateSettings } from "../src/agent/relevance.js";
import { candidatePairs, judgePairs, extractTasks, taskByConstruction } from "../src/agent/tasks.js";
import { pairKey } from "../src/attention/reminders.js";

// Written before the first run (2026-11-03).
const WRONG_MAX = 0.05; // of the pairs that are separate work, called the same
const MISSED_MAX = 0.3; // of the pairs that are one commitment, called different
const FOUND_MIN = 0.7; // of the pairs that are one commitment, picked by the code
// Written before the first run with match keys (2026-11-03).
const LANGUAGE_FOUND_MIN = 0.7; // of the same pairs written in two languages, picked by the code
const PER_CALL = 20;
const dir = import.meta.dirname;
const reps = Number(process.env.REPS ?? 3);

const cases = fs
  .readFileSync(path.join(dir, "groups/cases.jsonl"), "utf8")
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

// Every entry id once: the pair verdicts are keyed by the two ids.
const ids = cases.flatMap((c) => [c.a.entry.id, c.b.entry.id]);
const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
if (twice.length) throw new Error(`entry ids used twice: ${twice.join(", ")}`);

// The node's English keys, one pass over every entry the import would send.
const entries = [...new Map(cases.flatMap((c) => [c.a.entry, c.b.entry]).map((e) => [e.id, e])).values()];
const keyRun = Date.now();
const node = await extractTasks(complete, { candidates: entries.filter((e) => !taskByConstruction(e)), sample: [] });
const keySeconds = Math.round((Date.now() - keyRun) / 100) / 10;
const matchOf = (e) => node.cache[e.id]?.match;

// Each pair on its own, as two tasks of a list: does the code ask about it?
const item = (side) => ({ key: side.entry.id, entry: side.entry, task: side.task, match: matchOf(side.entry) });
const wordsOnly = (side) => ({ ...item(side), match: undefined });
const found = new Map(cases.map((c) => [c.id, candidatePairs([item(c.a), item(c.b)]).length > 0]));
const foundByWords = new Map(cases.map((c) => [c.id, candidatePairs([wordsOnly(c.a), wordsOnly(c.b)]).length > 0]));

// The model sees every case, found or not, so its answers are measured on all of them.
const pairs = cases.map((c) => ({ key: pairKey(c.a.entry.id, c.b.entry.id), a: item(c.a), b: item(c.b) }));
const runs = new Map(cases.map((c) => [c.id, []]));
const errors = new Set();
const times = [];
for (let rep = 0; rep < reps; rep++) {
  const started = Date.now();
  const r = await judgePairs(complete, pairs, { max: Infinity, perCall: PER_CALL });
  times.push((Date.now() - started) / r.calls);
  r.errors.forEach((e) => errors.add(e));
  for (const c of cases) runs.get(c.id).push(r.cache[pairKey(c.a.entry.id, c.b.entry.id)]?.same ?? null);
  process.stdout.write(r.failed ? "x" : ".");
}
console.log();

const results = cases.map((c) => {
  const got = runs.get(c.id);
  return {
    id: c.id,
    kind: c.kind,
    expect: c.expect,
    got: got.filter((v) => v === true).length * 2 > got.length,
    unread: got.filter((v) => v == null).length,
    found: found.get(c.id),
    foundByWords: foundByWords.get(c.id),
  };
});
const same = results.filter((r) => r.expect);
const apart = results.filter((r) => !r.expect);
const sameLanguages = same.filter((r) => r.kind === "language");
const rate = (xs, f) => xs.filter(f).length / (xs.length || 1);
const report = {
  date: new Date().toISOString(),
  provider: settings.provider,
  model: settings.model ?? null,
  reps,
  cases: results.length,
  wrongMerges: rate(apart, (r) => r.got),
  missedMerges: rate(same, (r) => !r.got),
  foundByCode: rate(same, (r) => r.found),
  foundByWordsOnly: rate(same, (r) => r.foundByWords),
  languageFound: rate(sameLanguages, (r) => r.found),
  languageFoundByWordsOnly: rate(sameLanguages, (r) => r.foundByWords),
  askedApart: rate(apart, (r) => r.found),
  askedApartByWordsOnly: rate(apart, (r) => r.foundByWords),
  keyCalls: node.calls,
  keySeconds,
  keysMissing: entries.filter((e) => !matchOf(e)).map((e) => e.id),
  secondsPerCall: times.map((t) => Math.round(t / 100) / 10),
  unread: results.reduce((a, r) => a + r.unread, 0),
  errors: [...errors],
  misses: results.filter((r) => r.got !== r.expect).map(({ id, kind, expect }) => ({ id, kind, expect })),
  notFound: same.filter((r) => !r.found).map((r) => r.id),
};

console.log("\nMisses:");
for (const m of report.misses)
  console.log(`  ${m.id} (${m.kind}): expected ${m.expect ? "same" : "different"}, got the other`);
if (report.notFound.length) console.log("Not picked by the code:", report.notFound.join(", "));
if (report.errors.length) console.log("\nErrors:", report.errors.join(" | "));
const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log(`
wrong merges   ${pct(report.wrongMerges)}   of ${apart.length} separate pairs (max ${pct(WRONG_MAX)})
missed merges  ${pct(report.missedMerges)}   of ${same.length} same pairs (max ${pct(MISSED_MAX)})
found by code  ${pct(report.foundByCode)}   of the same pairs (min ${pct(FOUND_MIN)}); words only ${pct(report.foundByWordsOnly)}
two languages  ${pct(report.languageFound)}   of ${sameLanguages.length} same pairs (min ${pct(LANGUAGE_FOUND_MIN)}); words only ${pct(report.languageFoundByWordsOnly)}
separate asked ${pct(report.askedApart)}   of the separate pairs; words only ${pct(report.askedApartByWordsOnly)}
keys           ${report.keyCalls} node calls, ${report.keySeconds} s; none for ${report.keysMissing.join(", ") || "-"}
per call       ${report.secondsPerCall.join(", ")} s (${Math.ceil(cases.length / PER_CALL)} calls a run)
unread         ${report.unread}/${results.length * reps}`);

fs.mkdirSync(path.join(dir, "reports"), { recursive: true });
const out = path.join(dir, "reports", `groups-${report.date.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`report: ${path.relative(process.cwd(), out)}`);
process.exit(
  report.wrongMerges > WRONG_MAX ||
    report.missedMerges > MISSED_MAX ||
    report.foundByCode < FOUND_MIN ||
    report.languageFound < LANGUAGE_FOUND_MIN
    ? 1
    : 0,
);

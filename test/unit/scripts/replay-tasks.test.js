import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const replay = (...args) =>
  execFileSync(process.execPath, ["scripts/replay-tasks.mjs", "test/fixtures/invented-brain", ...args], {
    cwd: root,
    encoding: "utf8",
  });

// Invented notes only (test/fixtures/invented-brain), on a fixed day.
test("the replay counts each view of Settings' list, and names no task (#92)", () => {
  const out = replay("test/fixtures/invented-brain-verdicts.json", "--today", "2026-11-04");
  assert.deepEqual(JSON.parse(out).views, {
    Today: 1,
    Missed: 1,
    "Coming up": 1,
    "Long run": 2,
    "Suggested from your memory": 2,
  });
  assert.doesNotMatch(out, /grant|dentist|library|bread|fine|cart|flaky/i, "counts only");
});

test("without verdicts, every note waits for the task node", () => {
  const { listed, waiting } = JSON.parse(replay("--today", "2026-11-04"));
  assert.deepEqual({ listed, waiting }, { listed: 0, waiting: 9 });
});

// #96: the dated plans in invented notes reach Coming up and Long run without any verdict.
test("upcoming dates are counted in Coming up and Long run, and dated loops in the queue", () => {
  const out = execFileSync(
    process.execPath,
    ["scripts/replay-tasks.mjs", "test/fixtures/invented-dates", "--today", "2026-11-04"],
    { cwd: root, encoding: "utf8" },
  );
  const { dated, upcoming, listed, views } = JSON.parse(out);
  assert.deepEqual({ dated, upcoming, listed }, { dated: 6, upcoming: 3, listed: 0 });
  assert.deepEqual(views, { Today: 0, Missed: 0, "Coming up": 2, "Long run": 1, "Suggested from your memory": 0 });
});

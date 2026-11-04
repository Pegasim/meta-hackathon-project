// Settings' "Your tasks" over a brain folder, outside Chrome (#92): the steps showTasks
// takes (src/options/options.js), with the verdicts, pairs and answers as
// chrome.storage.local holds them. Prints how many rows each view holds, never a title,
// so its output can be shared. Without verdicts, every note waits for the task node, as in
// Settings before a re-read. Not replayed: entries removed in Settings, and the goal's row.
//   node scripts/replay-tasks.mjs <brain-folder> [verdicts.json] [--today YYYY-MM-DD]
// verdicts.json: { taskVerdicts, taskPairs, taskSplits, loops, taskSettings }.
import fs from "node:fs";
import path from "node:path";
import { loadBrain } from "../src/memory/brain.js";
import { entryId } from "../src/memory/consolidate.js";
import { taskQueue } from "../src/memory/context.js";
import { BRAIN } from "../src/memory/sources.js";
import { localDate } from "../src/memory/due.js";
import { stillOpen, taskList, taskKey, splitTasks } from "../src/attention/reminders.js";
import { taskByConstruction } from "../src/agent/tasks.js";

const args = process.argv.slice(2);
const at = args.indexOf("--today");
const today = at >= 0 ? args.splice(at, 2)[1] : localDate();
const [folder, verdictsFile] = args;
if (!folder || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error("usage: node scripts/replay-tasks.mjs <brain-folder> [verdicts.json] [--today YYYY-MM-DD]");
  process.exit(2);
}

const files = [];
(function walk(dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name.startsWith(".")) continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full);
    else if (d.name.endsWith(".md"))
      files.push({ path: path.relative(folder, full), text: fs.readFileSync(full, "utf8") });
  }
})(folder);

// As Memory.importEntries stores a brain import.
const entries = loadBrain(files).entries.map((e) => ({
  ...e,
  origin: BRAIN,
  id: e.id ?? entryId(e),
  status: e.path?.startsWith("inbox/") ? "inbox" : "log",
}));
const {
  taskVerdicts = {},
  taskPairs = {},
  taskSplits = {},
  loops = {},
  taskSettings = {},
} = verdictsFile ? JSON.parse(fs.readFileSync(verdictsFile, "utf8")) : {};

const queue = taskQueue(entries, { today, limit: Infinity });
const open = stillOpen(
  taskList(queue, {
    verdicts: taskVerdicts,
    hidePersonal: !!taskSettings.hidePersonal,
    loops,
    pairs: taskPairs,
    splits: taskSplits,
  }),
  loops,
).filter((e) => e.source !== "extension");
const tasks = open.filter((e) => taskVerdicts[taskKey(e)] || taskByConstruction(e));
const ownKeys = new Set(queue.filter((e) => e.writer === "own" && e.source !== "extension").map(taskKey));
const { today: due, missed, comingUp, rest, suggested } = splitTasks(tasks, { ownKeys });

console.log(
  JSON.stringify(
    {
      today,
      entries: entries.length,
      queue: queue.length,
      listed: tasks.length,
      waiting: open.length - tasks.length,
      views: {
        Today: due.length,
        Missed: missed.length,
        "Coming up": comingUp.length,
        "Long run": rest.length,
        "Suggested from your memory": suggested.length,
      },
    },
    null,
    2,
  ),
);

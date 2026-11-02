import { stillOpen, taskList, taskKey } from "../attention/reminders.js";
import { Memory, redact } from "../memory/index.js";
import { PROVIDERS, DEFAULT_PROVIDER, modelClient, loadModelSettings, saveModelSettings } from "../memory/model.js";
import { buildProfile } from "../agent/profile.js";
import { refreshTasks } from "../agent/tasks.js";
import { privateSettings } from "../agent/relevance.js";
import { dueLabel, localDate } from "../memory/due.js";
import { NEVER_READ, readingSettings } from "../attention/reading.js";

const $ = (id) => document.getElementById(id);
const memory = await Memory.open();

const NAMES = {
  meta: "Meta · Muse Spark 1.3",
  openrouter: "OpenRouter · Muse Glimmer",
  ollama: "Local Ollama · Muse Glimmer",
  together: "Together · Muse Spark Open",
  fireworks: "Fireworks · Muse Spark Open",
  baseten: "Baseten · Muse Spark Open",
  groq: "Groq · Muse Spark Open",
  nebius: "Nebius · Muse Spark Open",
};

for (const id of Object.keys(PROVIDERS))
  if (id !== "meta-contributor") $("provider").append(new Option(NAMES[id] ?? id, id));

function showProvider() {
  const p = $("provider").value;
  $("key-row").hidden = p === "ollama";
}

function current() {
  const provider = $("provider").value;
  const model = $("model").value.trim();
  return {
    provider,
    model: model && model !== PROVIDERS[provider].model ? model : undefined,
    apiKey: $("key").value.trim() || undefined,
  };
}

// Settings saved when Contributor was offered load as plain Meta; saving rewrites them.
const saved = privateSettings((await loadModelSettings()) ?? {});
$("provider").value = saved.provider ?? DEFAULT_PROVIDER;
$("model").value = saved.model ?? PROVIDERS[$("provider").value].model;
$("key").value = saved.apiKey ?? "";
$("remember").checked = !!(await chrome.storage.local.get("modelSettings")).modelSettings;
showProvider();

$("provider").onchange = () => {
  $("model").value = PROVIDERS[$("provider").value].model;
  showProvider();
};

$("save").onclick = async () => {
  await saveModelSettings(current(), { remember: $("remember").checked });
  $("model-status").textContent = $("remember").checked ? "Saved on this device." : "Saved until Chrome closes.";
};

$("test").onclick = async () => {
  $("model-status").textContent = "Testing…";
  const t = performance.now();
  try {
    const reply = await modelClient(current())([{ role: "user", content: "Reply with exactly: pong" }], {
      maxTokens: 512,
    });
    $("model-status").textContent =
      `Connected in ${((performance.now() - t) / 1000).toFixed(1)} s. Reply: ${reply.trim().slice(0, 60)}`;
  } catch (err) {
    $("model-status").textContent = `Failed: ${err.message}`;
  }
};

async function brainStatus(r = {}) {
  if (r.needsPermission || r.permission === "prompt") return "Chrome needs your permission again: press Sync now.";
  if (!r.connected) return "Not connected.";
  const s = await memory.stats();
  return (
    `${r.name ? `Folder: ${r.name}\n` : ""}${s.entries} entries, ${s.notes} notes, ${s.openLoops} open loops` +
    (r.skipped?.length ? `\n${r.skipped.length} files skipped` : "")
  );
}

$("connect").onclick = async () => {
  try {
    const dir = await showDirectoryPicker({ mode: "readwrite" });
    $("brain-status").textContent = "Reading…";
    const r = await memory.connectBrain(dir);
    await chrome.runtime.sendMessage({ type: "memory-changed" });
    $("brain-status").textContent = await brainStatus({ connected: true, name: dir.name, ...r });
    $("profile-status").textContent = "Reading…";
    const note = await readProfile();
    await showProfile(note, await readTasks());
  } catch (err) {
    if (err.name !== "AbortError") $("brain-status").textContent = `Failed: ${err.message}`;
  }
};

$("sync").onclick = async () => {
  $("brain-status").textContent = "Syncing…";
  try {
    const r = await memory.syncBrain({ prompt: true });
    if (r.connected && !r.needsPermission) await chrome.runtime.sendMessage({ type: "memory-changed" });
    const exported = r.connected && !r.needsPermission ? await memory.exportPending({ prompt: true }) : null;
    $("brain-status").textContent =
      (await brainStatus(r)) + (exported?.exported ? `\n${exported.exported} new entries written to inbox/` : "");
    if (r.connected && !r.needsPermission) {
      const note = await readProfile();
      await showProfile(note, await readTasks());
    }
  } catch (err) {
    $("brain-status").textContent = `Failed: ${err.message}`;
  }
};

$("brain-status").textContent = await brainStatus(await memory.brainState().catch(() => ({ connected: false })));

// ---- What Tuck knows -----------------------------------------------------

// The profile is read here rather than in the worker: this page holds the Memory
// instance that just imported, so its entries are the fresh ones. The worker reads
// the stored result straight from IndexedDB, so it sees this without a reload.
//
// It returns a note and never throws: an import that worked must not be reported as
// failed just because the model is not set up yet.
async function readProfile() {
  try {
    const settings = await loadModelSettings();
    if (!settings) return "Set up a model above, then press Re-read my memory.";
    const r = await buildProfile(modelClient(privateSettings(settings)), await memory.profileSample());
    if (r.source === "empty") return "No memory imported yet.";
    if (!r.profile) return `Could not read your memory: ${r.error}`;
    await memory.setProfile(r.profile);
    return null;
  } catch (err) {
    return `Could not read your memory: ${err.message}`;
  }
}

// Which open loops are real tasks (agent/tasks.js), read here for the same reason as the
// profile. Only entries that are new or changed since the last read cost a call. Returns
// a note, and never throws.
async function readTasks() {
  $("task-status").textContent = "Reading your tasks…";
  try {
    const settings = await loadModelSettings();
    if (!settings) return null;
    const r = await refreshTasks(modelClient(privateSettings(settings)), {
      memory,
      storage: chrome.storage.local,
      today: localDate(),
      clean: (text) => redact(text).text,
      onProgress: ({ done, total }) => ($("task-status").textContent = `Reading your tasks… ${done} of ${total}`),
    });
    return r.failed ? `${r.failed} entries could not be read: ${r.errors.join(" | ")}. Re-read to try again.` : null;
  } catch (err) {
    return `Could not read your tasks: ${err.message}`;
  }
}

async function showProfile(note, taskNote) {
  const profile = await memory.profile();
  const queue = await memory.taskQueue({ today: localDate(), limit: Infinity });
  const lines = [
    note,
    profile ? `Tuck knows you as: ${profile.summary}` : "Nothing read yet.",
    profile?.topics?.length ? `Your topics: ${profile.topics.join(", ")}` : null,
  ].filter(Boolean);
  $("profile-status").textContent = lines.join("\n");
  await showTasks(queue, taskNote);
  await showLabels();
}

const button = (label, onclick) => Object.assign(document.createElement("button"), { textContent: label, onclick });

// One line and one button: the tasks left, and what Tuck learned.
function listRow(text, label, onclick) {
  const row = document.createElement("div");
  row.className = "row";
  const line = document.createElement("span");
  line.className = "small";
  line.textContent = text;
  row.append(line, button(label, onclick));
  return row;
}

// The first few tasks; the rest behind Show all.
const FIRST_TASKS = 7;
let allTasks = false;

// The tasks the node kept, in memory's order (deadline, then recency). Nothing in the
// notes marks a task done, so one stays until it is marked here or answered in Tuck's
// bubble. Not a task takes out what the node got wrong; both survive a re-import.
async function showTasks(queue, note) {
  const {
    loops = {},
    taskVerdicts = {},
    taskSettings = {},
  } = await chrome.storage.local.get(["loops", "taskVerdicts", "taskSettings"]);
  $("hide-personal").checked = !!taskSettings.hidePersonal;
  // Goals set here are not tasks from the notes: they end with Done on the goal itself.
  const open = stillOpen(
    taskList(queue, { verdicts: taskVerdicts, hidePersonal: !!taskSettings.hidePersonal }),
    loops,
  ).filter((e) => e.source !== "extension");
  const unread = open.filter((e) => !taskVerdicts[taskKey(e)]).length;
  const answer = (e, choice) => async () => {
    await chrome.runtime.sendMessage({ type: "reminder-answer", id: e.id, title: e.title, choice });
    await showProfile();
  };
  $("task-list").replaceChildren(
    ...open.slice(0, allTasks ? open.length : FIRST_TASKS).map((e) => {
      const row = listRow(
        `${e.title}${e.due ? `: due ${e.due} (${dueLabel(e.daysLeft)})` : ""}`,
        "Done",
        answer(e, "done"),
      );
      row.append(button("Not a task", answer(e, "not_task")));
      return row;
    }),
  );
  $("all-tasks").hidden = open.length <= FIRST_TASKS;
  $("all-tasks").textContent = allTasks ? "Show fewer" : `Show all ${open.length}`;
  $("task-status").textContent = [
    note,
    open.length ? null : "No open tasks.",
    unread ? `${unread} not read by Tuck yet: press Re-read my memory (needs a model above).` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

$("all-tasks").onclick = async () => {
  allTasks = !allTasks;
  await showProfile();
};
$("hide-personal").onchange = async () => {
  await chrome.storage.local.set({ taskSettings: { hidePersonal: $("hide-personal").checked } });
  await showProfile();
};

function labelText({ label, host, title, surface, who }) {
  const verdict = label === "unrelated" ? "not work" : "work";
  if (surface === "conversation") return `Conversations with ${who ?? "this person"} on ${host}: ${verdict}`;
  return `${host}${title ? ` ("${title}")` : ""}: ${verdict}`;
}

async function showLabels() {
  const labels = await chrome.runtime.sendMessage({ type: "get-labels" });
  $("label-list").replaceChildren(
    ...(labels?.length
      ? labels.map((l) =>
          listRow(labelText(l), "Forget", async () => {
            await chrome.runtime.sendMessage({ type: "delete-label", key: l.key });
            await showLabels();
          }),
        )
      : [Object.assign(document.createElement("p"), { className: "small muted", textContent: "Nothing yet." })]),
  );
}

$("reread").onclick = async () => {
  $("profile-status").textContent = "Reading…";
  $("task-status").textContent = "Reading your tasks…";
  try {
    const note = await readProfile();
    await showProfile(note, await readTasks());
  } catch (err) {
    $("profile-status").textContent = `Failed: ${err.message}`;
  }
};

await showProfile();

// ---- Page reading --------------------------------------------------------

const reading = readingSettings((await chrome.storage.local.get("pageReading")).pageReading);
$("read-pages").checked = reading.enabled;
$("never-read").value = reading.neverRead.join("\n");

$("save-reading").onclick = async () => {
  const neverRead = $("never-read")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  await chrome.storage.local.set({ pageReading: { enabled: $("read-pages").checked, neverRead } });
  $("reading-status").textContent = $("read-pages").checked
    ? `Saved. ${neverRead.length} sites are never read.`
    : "Saved. Pages are not read.";
};
$("reset-reading").onclick = () => {
  $("never-read").value = NEVER_READ.join("\n");
  $("reading-status").textContent = "The default list is back. Save to keep it.";
};

// ---- Event log -----------------------------------------------------------

$("export-log").onclick = async () => {
  const log = await chrome.runtime.sendMessage({ type: "export-log" });
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `attention-log-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  $("log-status").textContent = `Exported ${log.events.length} events.`;
};

// Importing replaces the current log, so it takes a second click to confirm.
let pendingLog = null;
$("import-log").onclick = async () => {
  if (!pendingLog) return $("import-file").click();
  try {
    await chrome.runtime.sendMessage({ type: "import-log", log: pendingLog });
    $("log-status").textContent = `Imported ${pendingLog.events?.length ?? 0} events.`;
  } finally {
    pendingLog = null;
    $("import-log").textContent = "Import event log";
    $("cancel-import").hidden = true;
  }
};
$("import-file").onchange = async () => {
  const file = $("import-file").files[0];
  $("import-file").value = "";
  if (!file) return;
  try {
    pendingLog = JSON.parse(await file.text());
    const { events } = await chrome.runtime.sendMessage({ type: "export-log" });
    $("log-status").textContent =
      `This replaces your current log (${events.length} events) with ${pendingLog.events?.length ?? 0} events from ${file.name}. Export first if you want to keep it.`;
    $("import-log").textContent = "Replace my log";
    $("cancel-import").hidden = false;
  } catch (err) {
    pendingLog = null;
    $("log-status").textContent = `Import failed: ${err.message}`;
  }
};
$("cancel-import").onclick = () => {
  pendingLog = null;
  $("import-log").textContent = "Import event log";
  $("cancel-import").hidden = true;
  $("log-status").textContent = "";
};

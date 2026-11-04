import { stillOpen, taskList, taskKey, splitTasks, isClose } from "../attention/reminders.js";
import { openStore } from "../attention/store.js";
import {
  Memory,
  redact,
  previewPaste,
  importPasted,
  ASK_YOUR_ASSISTANT,
  MAX_PASTE_CHARS,
  readExport,
  selectConversations,
  conversationText,
  importExport,
  exportEntries,
} from "../memory/index.js";
import { PROVIDERS, DEFAULT_PROVIDER, modelClient, loadModelSettings, saveModelSettings } from "../memory/model.js";
import { buildProfile } from "../agent/profile.js";
import { refreshTasks, taskByConstruction } from "../agent/tasks.js";
import { privateSettings } from "../agent/relevance.js";
import { parseRepos } from "../agent/github.js";
import { dueLabel, localDate } from "../memory/due.js";
import { NEVER_READ, readingSettings } from "../attention/reading.js";
import { wrongBrainFolder } from "./brain-folder.js";
import "../tuck/skins.js";

const $ = (id) => document.getElementById(id);
const memory = await Memory.open();
const attention = openStore(); // the goal, for the row it came from (#77)

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

// Tuck's look: the skin and what it wears. The background redraws Tuck on the page and the
// toolbar icon when these change. The preview is the skin's resting pose in a shadow root,
// so its CSS stays out of this page.
const skinFile = async (id, file) => (await fetch(chrome.runtime.getURL(`tuck/skins/${id}/${file}`))).text();
const skinIds = await (await fetch(chrome.runtime.getURL("tuck/skins/index.json"))).json();
const skinNames = {};
for (const id of skinIds) {
  skinNames[id] = JSON.parse(await skinFile(id, "skin.json"));
  $("tuck-skin").append(new Option(skinNames[id].name, id));
}
async function showLook(saved) {
  const id = skinIds.includes(saved.tuckSkin) ? saved.tuckSkin : globalThis.tuckSkins.DEFAULT_SKIN;
  const manifest = skinNames[id];
  $("tuck-skin").value = id;
  $("tuck-item").replaceChildren(...manifest.items.map((i) => new Option(i, i)));
  $("tuck-item").value = manifest.items.includes(saved.tuckItem) ? saved.tuckItem : "none";
  $("tuck-item-row").hidden = manifest.items.every((i) => i === "none");
  const url = (file) => chrome.runtime.getURL(`tuck/skins/${id}/${file}`);
  const { svg, css } = await globalThis.tuckSkins.loadSkin((file) => skinFile(id, file), url);
  const shadow = $("tuck-preview").shadowRoot ?? $("tuck-preview").attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = css + globalThis.tuckSkins.themeCss(manifest.theme);
  const art = document.createElement("div");
  art.style.cssText = `width:${manifest.size.width}px;height:${manifest.size.height}px`;
  art.innerHTML = svg;
  const root = art.querySelector("svg");
  for (const [name, value] of Object.entries(globalThis.tuckSkins.poseAttrs(manifest, "rest")))
    root.setAttribute(name, value);
  root.dataset.item = $("tuck-item").value;
  shadow.replaceChildren(style, art);
}
const savedLook = () => chrome.storage.local.get({ tuckSkin: globalThis.tuckSkins.DEFAULT_SKIN, tuckItem: "bandana" });
await showLook(await savedLook());
$("tuck-skin").onchange = async () => {
  await chrome.storage.local.set({ tuckSkin: $("tuck-skin").value });
  await showLook(await savedLook());
};
$("tuck-motion").value = (await chrome.storage.local.get({ tuckMotion: "system" })).tuckMotion;
$("tuck-motion").onchange = () => chrome.storage.local.set({ tuckMotion: $("tuck-motion").value });
$("tuck-item").onchange = async () => {
  await chrome.storage.local.set({ tuckItem: $("tuck-item").value });
  await showLook(await savedLook());
};

$("save").onclick = async () => {
  await saveModelSettings(current(), { remember: $("remember").checked });
  $("model-status").textContent = $("remember").checked ? "Saved on this device." : "Saved until Chrome closes.";
  // A brain connected before the model was saved has not been read: read it now (#68).
  if (await unread()) await rereadMemory().catch((err) => ($("profile-status").textContent = `Failed: ${err.message}`));
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
  // The brain's own counts: the other sources are listed in their card.
  const b = (await memory.sources()).find((x) => x.kind === "brain") ?? {};
  return (
    `${r.name ? `Folder: ${r.name}\n` : ""}${b.entries ?? 0} entries, ${b.documents ?? 0} notes, ${b.openLoops ?? 0} open loops` +
    (r.skipped?.length ? `\n${r.skipped.length} files skipped` : "")
  );
}

$("connect").onclick = async () => {
  try {
    const dir = await showDirectoryPicker({ mode: "readwrite" });
    if (await wrongBrainFolder(dir)) {
      $("brain-status").textContent =
        `"${dir.name}" has no inbox/ or notes/ inside. Choose the folder that holds them.`;
      return;
    }
    $("brain-status").textContent = "Reading…";
    const r = await memory.connectBrain(dir);
    await chrome.runtime.sendMessage({ type: "memory-changed" });
    $("brain-status").textContent = await brainStatus({ connected: true, name: dir.name, ...r });
    await rereadMemory();
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
    if (r.connected && !r.needsPermission) await rereadMemory();
  } catch (err) {
    $("brain-status").textContent = `Failed: ${err.message}`;
  }
};

$("brain-status").textContent = await brainStatus(await memory.brainState().catch(() => ({ connected: false })));

// ---- Other memory --------------------------------------------------------

const KINDS = { md: "Notes folder", paste: "Pasted memory", export: "Assistant export" };

// After an import or a removal, as after a brain sync: the worker judges pages again, and
// the profile and the tasks are read again.
async function sourcesChanged() {
  await chrome.runtime.sendMessage({ type: "memory-changed" });
  await showSources();
  await rereadMemory();
}

function sourceText(s) {
  const read = s.lastImport ? `, read ${new Date(s.lastImport).toLocaleString()}` : "";
  return `${KINDS[s.kind] ?? s.kind} "${s.name}": ${s.entries} entries, ${s.openLoops} open, ${s.documents} notes${read}`;
}

// Every source but the brain, which has its own card.
async function showSources() {
  const list = (await memory.sources()).filter((s) => s.kind !== "brain");
  $("source-list").replaceChildren(
    ...(list.length
      ? list.map((s) => {
          const row = listRow(sourceText(s), "Remove", async () => {
            if (!confirm(`Remove "${s.name}" from Tuck's memory? Nothing in the folder or your assistant changes.`))
              return;
            await memory.removeSource(s.origin);
            if (s.kind === "export") await forgetExport(s.origin);
            $("source-status").textContent = `Removed "${s.name}".`;
            await sourcesChanged();
          });
          if (s.kind === "md")
            row.append(
              button("Sync", async () => {
                $("source-status").textContent = "Reading…";
                const r = await memory.syncSource(s.origin, { prompt: true });
                if (r.needsPermission) return ($("source-status").textContent = "Chrome needs your permission again.");
                $("source-status").textContent = folderStatus(s.name, r);
                await sourcesChanged();
              }),
            );
          return row;
        })
      : [Object.assign(document.createElement("p"), { className: "small muted", textContent: "Nothing yet." })]),
  );
}

const folderStatus = (name, r) =>
  `Read "${name}": ${r.entries} tasks and ${r.notes} notes` +
  (r.skipped?.length ? `, ${r.skipped.length} skipped` : "");

$("add-folder").onclick = async () => {
  try {
    const dir = await showDirectoryPicker({ mode: "read" });
    $("source-status").textContent = "Reading…";
    const r = await memory.connectFolder(dir, { kind: "md" });
    $("source-status").textContent = folderStatus(dir.name, r);
    await sourcesChanged();
  } catch (err) {
    if (err.name !== "AbortError") $("source-status").textContent = `Failed: ${err.message}`;
  }
};

// An assistant's export. The whole file is read here, in the page; the preview says how
// many of its conversations go to the model, and nothing is sent before Import. What each
// conversation gave is kept by origin in exportCache, so the same file again sends only
// what is new or changed, and a run that stopped halfway picks up where it was.
const EXPORT_NAMES = { claude: "Claude export", gemini: "Gemini export" };
let exportFile = null; // { kind, origin, name, conversations, chosen }

const exportCaches = async () => (await chrome.storage.local.get("exportCache")).exportCache ?? {};
async function forgetExport(origin) {
  const caches = await exportCaches();
  delete caches[origin];
  await chrome.storage.local.set({ exportCache: caches });
}

$("add-export").onclick = () => $("export-file").click();
$("export-file").onchange = async () => {
  const file = $("export-file").files[0];
  $("export-file").value = ""; // so the same file can be chosen again
  if (!file) return;
  exportFile = null;
  $("import-export").hidden = true;
  $("export-status").textContent = "Reading the file…";
  try {
    const { kind, conversations } = readExport(JSON.parse(await file.text()));
    const s = selectConversations(conversations, { today: localDate() });
    const origin = `export:${kind}:${file.name}`;
    const cache = (await exportCaches())[origin] ?? {};
    const fresh = s.chosen.filter((c) => cache[c.id]?.stamp !== c.updated);
    const chars = fresh.reduce((n, c) => n + conversationText(c).text.length, 0);
    const dates = s.chosen.map((c) => c.updated.slice(0, 10)).sort();
    exportFile = { kind, origin, name: file.name, conversations, chosen: s.chosen };
    $("export-status").textContent = [
      `${EXPORT_NAMES[kind]} "${file.name}": ${conversations.length} conversations.`,
      s.chosen.length
        ? `${s.chosen.length} are from the last 30 days and name a date or a to-do in your own words, ${dates[0]} to ${dates.at(-1)}.`
        : "None is from the last 30 days with a date or a to-do in your own words.",
      fresh.length < s.chosen.length ? `${s.chosen.length - fresh.length} were read before.` : null,
      `${fresh.length} will be sent, one at a time: ${chars.toLocaleString()} characters, secrets removed, to Muse Spark 1.3 (not Contributor).`,
      `Left out: ${s.tooOld} older, ${s.noCue} with nothing owed` +
        (s.overCap ? `, ${s.overCap} over the limit of 50` : "") +
        ".",
    ]
      .filter(Boolean)
      .join("\n");
    $("import-export").hidden = !s.chosen.length;
  } catch (err) {
    $("export-status").textContent = `Could not read it: ${err.message}`;
  }
};
$("import-export").onclick = async () => {
  const f = exportFile;
  if (!f) return;
  $("import-export").hidden = true;
  try {
    const settings = await loadModelSettings();
    if (!settings) {
      $("import-export").hidden = false;
      return ($("export-status").textContent = "Set up a model above first.");
    }
    $("export-status").textContent = "Reading…";
    const r = await importExport(modelClient(privateSettings(settings)), f.chosen, {
      kind: f.kind,
      cache: (await exportCaches())[f.origin] ?? {},
      topics: (await memory.profile().catch(() => null))?.topics ?? [],
      onSaved: async (cache) =>
        chrome.storage.local.set({ exportCache: { ...(await exportCaches()), [f.origin]: cache } }),
      onProgress: ({ done, total }) => ($("export-status").textContent = `Reading… ${done} of ${total}`),
    });
    const failed = r.failed
      ? `${r.failed} conversations could not be read (${r.errors.join(" | ")}); import the file again to retry them.`
      : null;
    const entries = exportEntries(r.cache, f.conversations);
    if (!entries.length) return ($("export-status").textContent = failed ?? "Nothing in it could be read as memory.");
    const stored = await memory.importEntries({ origin: f.origin, name: f.name, entries });
    exportFile = null;
    $("export-status").textContent = [
      `${stored.entries} entries from "${f.name}"` +
        (r.redactions ? `, ${r.redactions} secrets removed first` : "") +
        ".",
      failed,
    ]
      .filter(Boolean)
      .join("\n");
    await sourcesChanged();
  } catch (err) {
    $("export-status").textContent = `Failed: ${err.message}`;
    $("import-export").hidden = false;
  }
};

$("ask-text").textContent = ASK_YOUR_ASSISTANT;
$("copy-ask").onclick = async () => {
  await navigator.clipboard.writeText(ASK_YOUR_ASSISTANT);
  $("paste-status").textContent = "Copied.";
};

// Nothing is sent before the person has seen it: a change to the text needs a new preview.
$("paste-text").oninput = () => {
  $("import-paste").disabled = true;
  $("paste-preview").hidden = true;
};
$("preview-paste").onclick = () => {
  const p = previewPaste($("paste-text").value);
  if (!p.text) return ($("paste-status").textContent = "Paste your assistant's answer first.");
  $("paste-preview").textContent = p.text;
  $("paste-preview").hidden = false;
  $("paste-status").textContent =
    "This is what will be sent." +
    (p.redactions ? ` ${p.redactions} secrets removed.` : "") +
    (p.cut ? ` Cut to the first ${MAX_PASTE_CHARS.toLocaleString()} characters.` : "");
  $("import-paste").disabled = false;
};
$("import-paste").onclick = async () => {
  $("import-paste").disabled = true;
  try {
    const settings = await loadModelSettings();
    if (!settings) return ($("paste-status").textContent = "Set up a model above first.");
    $("paste-status").textContent = "Reading…";
    const r = await importPasted(modelClient(privateSettings(settings)), $("paste-text").value, {
      today: localDate(),
      topics: (await memory.profile().catch(() => null))?.topics ?? [],
    });
    if (!r.entries.length) return ($("paste-status").textContent = "Nothing in it could be read as memory.");
    const stored = await memory.importEntries({
      origin: `paste:${crypto.randomUUID().slice(0, 8)}`,
      name: `Pasted ${localDate()}`,
      entries: r.entries,
    });
    const dropped = r.dropped + stored.skipped.length;
    $("paste-status").textContent =
      `${stored.entries} entries imported` +
      (dropped ? `, ${dropped} left out` : "") +
      (r.redactions ? `, ${r.redactions} secrets removed first` : "") +
      ".";
    $("paste-text").value = "";
    $("paste-preview").hidden = true;
    await sourcesChanged();
  } catch (err) {
    $("paste-status").textContent = `Failed: ${err.message}`;
  }
};

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
// While it runs, taskProgress says how far it got, so a redraw in between keeps saying so.
// It is cleared by the re-read that started it, right before its last draw, so the status
// does not look settled while that draw, with the run's own note, is still to come.
// The run lives in this page and its verdicts are stored only at the end, so closing the
// page stops it and loses the batches already read (#68): the status says so.
let taskProgress = null;
async function readTasks() {
  const progress = (text) =>
    ($("task-status").textContent = taskProgress = `${text} Keep this page open until it is done.`);
  progress("Reading your tasks…");
  try {
    const settings = await loadModelSettings();
    if (!settings) return null;
    const r = await refreshTasks(modelClient(privateSettings(settings)), {
      memory,
      storage: chrome.storage.local,
      today: localDate(),
      clean: (text) => redact(text).text,
      onProgress: ({ done, total }) => progress(`Reading your tasks… ${done} of ${total}.`),
    });
    return r.failed ? `${r.failed} entries could not be read: ${r.errors.join(" | ")}. Re-read to try again.` : null;
  } catch (err) {
    return `Could not read your tasks: ${err.message}`;
  }
}

// After an import or a sync. The tasks that need no model, such as a notes folder's
// checkboxes, are listed at once; the profile and the task node are then read side by
// side, and each is drawn as soon as it is back. Drawing used to wait for both, one after
// the other, so the list sat empty for the half minute the model took (#6).
// Re-reads run one after another: a second one (a click while the first runs, or an
// import) starts when the first is done, so the node is never asked twice at once and a
// run's verdicts are never written over by one that started before it.
function rereadMemory() {
  rereadMemory.queue = (rereadMemory.queue ?? Promise.resolve()).then(rereadOnce, rereadOnce);
  return rereadMemory.queue;
}

async function rereadOnce() {
  $("profile-status").textContent = "Reading…";
  const tasks = readTasks();
  await showTasks(await queueNow());
  const profile = readProfile().then(async (note) => {
    await drawProfile(note);
    return note;
  });
  const [note, taskNote] = await Promise.all([profile, tasks]).finally(() => (taskProgress = null));
  await showProfile(note, taskNote);
}

// Memory that no run has read: no profile, or no task verdicts stored (#68).
async function unread() {
  const [sources, profile, { taskVerdicts }] = await Promise.all([
    memory.sources(),
    memory.profile().catch(() => null),
    chrome.storage.local.get("taskVerdicts"),
  ]);
  return sources.some((s) => s.entries || s.documents) && (!profile || !taskVerdicts);
}

const queueNow = () => memory.taskQueue({ today: localDate(), limit: Infinity });

async function drawProfile(note) {
  const profile = await memory.profile();
  const lines = [
    note,
    profile ? `Tuck knows you as: ${profile.summary}` : "Nothing read yet.",
    profile?.topics?.length ? `Your topics: ${profile.topics.join(", ")}` : null,
  ].filter(Boolean);
  $("profile-status").textContent = lines.join("\n");
}

async function showProfile(note, taskNote) {
  await drawProfile(note);
  await showTasks(await queueNow(), taskNote);
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

// Today, Missed and Coming up in full (#77, #92); of the rest, the first few, then Show all.
const FIRST_TASKS = 7;
let allTasks = false;
const heading = (text) => Object.assign(document.createElement("p"), { className: "small muted", textContent: text });

// The tasks the node kept, in memory's order (deadline, then recency). Nothing in the
// notes marks a task done, so one stays until it is marked here or answered in Tuck's
// bubble. Not a task takes out what the node got wrong; both survive a re-import. A note
// the node has not judged may be a fact with a next action, so it is held back and counted,
// not listed as a task (#43). A Markdown checkbox never needs judging. Entries the node
// found to be one commitment are one row, with where they came from and Not the same (#47).
let taskDraws = 0; // only the newest draw writes, so a slower, older one cannot win
async function showTasks(queue, note) {
  const draw = ++taskDraws;
  const {
    loops = {},
    taskVerdicts = {},
    taskSettings = {},
    taskPairs = {},
    taskSplits = {},
    taskProblem,
  } = await chrome.storage.local.get([
    "loops",
    "taskVerdicts",
    "taskSettings",
    "taskPairs",
    "taskSplits",
    "taskProblem",
  ]);
  const [model, goal, ahead] = await Promise.all([
    loadModelSettings(),
    attention.then((st) => st.activeIntent()).catch(() => null),
    memory.upcoming({ today: localDate() }),
  ]);
  if (draw !== taskDraws) return;
  $("hide-personal").checked = !!taskSettings.hidePersonal;
  // Goals set here are not tasks from the notes: they end with Done on the goal itself.
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
  const waiting = open.length - tasks.length;
  // Dated plans with no next action (#96): never judged, so no verdicts. Hide takes one out.
  const dates = taskList(ahead, { hidePersonal: !!taskSettings.hidePersonal, loops }).filter(
    (e) => e.source !== "extension",
  );
  const answer = (e, choice) => async () => {
    await chrome.runtime.sendMessage({ type: "reminder-answer", id: e.id, title: e.title, choice });
    await showProfile();
  };
  const taskRow = (e) => {
    if (e.upcoming) return listRow(`${e.title}: ${e.due} (${dueLabel(e.daysLeft)})`, "Hide", answer(e, "not_task"));
    const passed = isClose(e) && e.daysLeft < 0;
    const when = passed
      ? `: deadline passed ${dueLabel(e.daysLeft)}`
      : e.due
        ? `: due ${e.due} (${dueLabel(e.daysLeft)})`
        : "";
    const row = listRow(`${e.title}${when}${e.members ? ` (${e.sources})` : ""}`, "Done", answer(e, "done"));
    row.append(button("Not a task", answer(e, "not_task")));
    if (e.members) row.append(button("Not the same", answer(e, "not_same")));
    return row;
  };
  // A view with nothing in it is left out; with only undated tasks, the list reads as before.
  const view = (name, rows) => (rows.length ? [...(name ? [heading(name)] : []), ...rows.map(taskRow)] : []);
  const ownKeys = new Set(queue.filter((e) => e.writer === "own" && e.source !== "extension").map(taskKey));
  const { today, missed, comingUp, rest, suggested } = splitTasks(tasks, {
    goalFrom: goal?.fromLoopId,
    ownKeys,
    upcoming: dates,
  });
  $("task-list").replaceChildren(
    ...view("Today", today),
    ...view("Missed", missed),
    ...view("Coming up", comingUp),
    ...view(
      today.length || missed.length || comingUp.length ? "Long run" : null,
      rest.slice(0, allTasks ? rest.length : FIRST_TASKS),
    ),
  );
  $("all-tasks").hidden = rest.length <= FIRST_TASKS;
  $("all-tasks").textContent = allTasks ? "Show fewer" : `Show all ${tasks.length - suggested.length + dates.length}`;
  // Rows a coding agent or the distill wrote, once the person has their own (#92): closed,
  // and kept closed or open across redraws, as the person left it.
  const fold = $("task-suggested");
  fold.hidden = !suggested.length;
  fold.querySelector("summary").textContent = `Suggested from your memory (${suggested.length})`;
  fold.querySelector(".stack").replaceChildren(...suggested.map(taskRow));
  const notes = waiting === 1 ? "1 note" : `${waiting} notes`;
  // A run's own problem first; with none, only a missing model is a reason (#68).
  const why = note ? "" : taskProblem ? `: ${taskProblem}` : model ? null : " (needs a model above)";
  if (taskProgress) return void ($("task-status").textContent = taskProgress);
  $("task-status").textContent = [
    note,
    waiting
      ? why === null
        ? `Your notes are not read yet, so ${notes} with a next action are not listed. Press Re-read my memory to read them.`
        : `Tuck could not read your notes yet${why}, so ${notes} with a next action are not listed. Press Re-read my memory to try again.`
      : null,
    tasks.length || waiting ? null : "No open tasks.",
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
  try {
    await rereadMemory();
  } catch (err) {
    $("profile-status").textContent = `Failed: ${err.message}`;
  }
};

await showProfile();
await showSources();

// ---- What Tuck looked at (#81) --------------------------------------------

// The agent's last runs: each tool it called, with its short arguments and how much it found.
const MOMENTS = { plan: "Planned the goal", next: "Goal done: what's next", stuck: "You were stuck" };
const toolLine = ({ tool, args = {}, result }) => {
  const shown = Object.values(args).filter((v) => typeof v === "string" || typeof v === "number");
  return `${tool}${shown.length ? ` "${shown.join(", ")}"` : ""}${result ? ` → ${result}` : ""}`;
};

async function showAgentRuns() {
  const runs = await chrome.runtime.sendMessage({ type: "agent-runs" });
  const p = (text, className = "small") => Object.assign(document.createElement("p"), { className, textContent: text });
  $("agent-runs").replaceChildren(
    ...(runs?.length
      ? runs.map((r) => {
          const box = document.createElement("div");
          box.className = "stack agent-run";
          const when = new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const outcome =
            r.source === "agent"
              ? `${r.steps} step${r.steps === 1 ? "" : "s"}`
              : `fell back: ${r.error ?? "no answer"}`;
          box.append(
            p(`${when} · ${MOMENTS[r.moment] ?? r.moment ?? "Looked up"} · ${outcome}`),
            ...(r.trail ?? []).map((t) => p(toolLine(t), "small muted")),
          );
          const said = Array.isArray(r.said) ? r.said.join(" / ") : r.said;
          if (said) box.append(p(`Said: ${said}`, "small"));
          return box;
        })
      : [p("Nothing yet.", "small muted")]),
  );
}

$("refresh-runs").onclick = showAgentRuns;
await showAgentRuns();

// ---- GitHub repositories (#91) -------------------------------------------

// Read after the page has loaded: what was typed meanwhile is kept.
const savedRepos = ((await chrome.storage.local.get("githubRepos")).githubRepos ?? []).join("\n");
if (!$("github-repos").value) $("github-repos").value = savedRepos;

$("save-github").onclick = async () => {
  const { repos, bad } = parseRepos($("github-repos").value);
  if (bad.length) {
    $("github-status").textContent = `Not a repository: ${bad.join(", ")}. Write it as owner/name.`;
    return;
  }
  await chrome.storage.local.set({ githubRepos: repos });
  $("github-repos").value = repos.join("\n");
  $("github-status").textContent = repos.length
    ? `Saved. ${repos.length === 1 ? "1 repository is" : `${repos.length} repositories are`} checked.`
    : "Saved. Nothing is asked of GitHub.";
};

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

// Pause Tuck: the "off" mode, which records nothing. The popup's switch is Focus or Do not disturb.
{
  const box = $("pause-tuck");
  chrome.storage.local.get({ mode: "focus" }).then(({ mode }) => (box.checked = mode === "off"));
  box.onchange = () => chrome.runtime.sendMessage({ type: "set-mode", mode: box.checked ? "off" : "focus" });
}

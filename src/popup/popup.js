import { Memory } from "../memory/index.js";
import { loadModelSettings } from "../memory/model.js";
import { activityRows } from "./activity.js";
import { nudgeText } from "../tuck/present.js";

const $ = (id) => document.getElementById(id);
const memory = await Memory.open();
const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

const STATE = {
  no_intent: "No goal yet",
  focused: "Focused",
  detour: "Short detour",
  drifting: "Drifting",
  agent_working: "Waiting for the agent",
  away: "Away",
  break: "On a break",
  paused: "Paused",
};

async function render() {
  const { engine, lastTrigger, intent } = await send("get-status");
  $("intent-view").hidden = !intent;
  $("intent-form").hidden = !!intent;
  if (intent) {
    $("intent-title").textContent = intent.title;
    $("intent-next").textContent = intent.steps?.length ? `Next: ${intent.steps[0]}` : "";
  }
  $("mode").value = engine.mode;
  $("state-pill").textContent = STATE[engine.state] ?? engine.state;
  $("state-pill").className = `pill ${engine.state}`;
  const show =
    lastTrigger && !lastTrigger.respondedAt && !lastTrigger.resolvedAt && lastTrigger.kind !== "session_start";
  $("trigger").hidden = !show;
  if (show) $("trigger-text").textContent = nudgeText(lastTrigger);
  $("take-me-back").disabled = !engine.lastRelevant;
  $("take-me-back").title = engine.lastRelevant ? `Back to ${engine.lastRelevant.title}` : "No work page yet";
}

async function renderActivity() {
  const rows = activityRows((await memory.activity({ minutes: 30 })).spans);
  const list = $("activity");
  list.replaceChildren();
  $("activity-empty").hidden = rows.length > 0;
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "site";
    const head = document.createElement("div");
    head.className = "row between";
    const name = Object.assign(document.createElement("span"), { className: "site-name", textContent: r.site });
    const time = Object.assign(document.createElement("span"), { className: "small muted", textContent: r.time });
    head.append(name, time);
    const bar = Object.assign(document.createElement("div"), { className: "bar" });
    bar.style.setProperty("--share", r.share.toFixed(2));
    const title = Object.assign(document.createElement("div"), {
      className: "small muted site-title",
      textContent: r.title,
    });
    li.append(head, bar, title);
    list.append(li);
  }
}

async function renderSetup() {
  const settings = await loadModelSettings();
  const brain = await memory.brainState().catch(() => ({ connected: false }));
  const missing = [];
  if (!settings?.apiKey && settings?.provider !== "ollama") missing.push("add a model API key");
  if (!brain.connected) missing.push("connect your brain folder (optional)");
  $("setup").hidden = !missing.length;
  $("setup").innerHTML = missing.length
    ? `Set up: ${missing.join(", ")} in <a href="#" id="setup-link">Settings</a>.`
    : "";
  $("setup-link")?.addEventListener("click", openSettings);
}

function openSettings(e) {
  e?.preventDefault();
  chrome.runtime.openOptionsPage();
}

$("open-settings").onclick = openSettings;

$("intent-form").onsubmit = async (e) => {
  e.preventDefault();
  await send("set-intent", { title: $("title").value.trim(), next: $("next").value.trim() });
  $("title").value = "";
  $("next").value = "";
  render();
};

$("done").onclick = async () => {
  await send("complete-intent");
  render();
};

$("change").onclick = () => {
  $("intent-view").hidden = true;
  $("intent-form").hidden = false;
  $("title").focus();
};

$("mode").onchange = async () => {
  await send("set-mode", { mode: $("mode").value });
  render();
};

const respond = (choice) => async () => {
  await send("respond", { choice });
  render();
};
$("take-me-back").onclick = respond("back");
$("for-my-task").onclick = respond("related");
$("give-me-5").onclick = respond("break");

chrome.storage.onChanged.addListener((changes) => {
  if (changes.lastTrigger) render();
});
// Keep the open popup current while the person browses.
setInterval(renderActivity, 15000);

// Tuck in the header; sleeping while you are on a break or not to be disturbed.
async function renderMark() {
  const svg = await (await fetch(chrome.runtime.getURL("tuck/assets/tuck.svg"))).text();
  $("tuck-mark").innerHTML = svg;
  const { engine } = await send("get-status");
  $("tuck-mark").querySelector("svg").dataset.state = ["break", "paused"].includes(engine.state)
    ? "sleeping"
    : "resting";
}

render();
renderMark();
renderActivity();
renderSetup();

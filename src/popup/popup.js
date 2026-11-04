import { Memory } from "../memory/index.js";
import { loadModelSettings } from "../memory/model.js";
import { activityRows } from "./activity.js";
import { nudgeText } from "../tuck/present.js";
import "../tuck/skins.js";

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
  // An agent's word says nothing about the page, so it has no answer about the page.
  const agentWord = lastTrigger?.kind === "agent";
  $("take-me-back").hidden = agentWord;
  $("for-my-task").hidden = agentWord;
  $("got-it").hidden = !agentWord;
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
$("got-it").onclick = respond("dismiss");

chrome.storage.onChanged.addListener((changes) => {
  if (changes.lastTrigger) render();
});
// Keep the open popup current while the person browses.
setInterval(renderActivity, 15000);

// Tuck in the header; sleeping while you are on a break or not to be disturbed.
async function renderMark() {
  // The skin the background draws on pages (background assets()).
  const stored = await chrome.storage.local.get({ tuckSkin: "v1", tuckItem: "bandana" });
  const { tuckItem } = stored;
  // An unknown skin falls back to v1, as the background does.
  const ids = await (await fetch(chrome.runtime.getURL("tuck/skins/index.json"))).json();
  const tuckSkin = ids.includes(stored.tuckSkin) ? stored.tuckSkin : "v1";
  $("skin-css").href = `../tuck/skins/${tuckSkin}/tuck.css`;
  const read = async (file) => (await fetch(chrome.runtime.getURL(`tuck/skins/${tuckSkin}/${file}`))).text();
  const [svg, manifest] = await Promise.all([read("tuck.svg"), read("skin.json").then(JSON.parse)]);
  $("tuck-mark").innerHTML = svg;
  // The popup wears the skin's colours: its own colour variables follow the theme ones.
  $("skin-theme").textContent =
    globalThis.tuckSkins.themeCss(manifest.theme).replaceAll(":host", ":root") +
    ":root{--bg:var(--tk-surface);--surface:var(--tk-surface);--border:var(--tk-outline);--text:var(--tk-ink);" +
    "--muted:var(--tk-muted);--accent:var(--tk-accent);--accent-text:var(--tk-on-accent)}";
  const { engine } = await send("get-status");
  const pose = ["break", "paused"].includes(engine.state) ? "sleep" : "rest";
  const root = $("tuck-mark").querySelector("svg");
  for (const [name, value] of Object.entries(globalThis.tuckSkins.poseAttrs(manifest, pose))) {
    root.setAttribute(name, value);
  }
  root.dataset.item = manifest.items?.includes(tuckItem) ? tuckItem : "none";
}

// Tuck away: the card's button hides Tuck on pages; this brings it back.
async function renderShowTuck() {
  $("show-tuck").checked = !(await chrome.storage.local.get({ tuckAway: false })).tuckAway;
}
$("show-tuck").onchange = () =>
  $("show-tuck").checked ? chrome.storage.local.set({ tuckAway: false }) : send("tuck-away");
chrome.storage.onChanged.addListener((changes) => {
  if (changes.tuckAway) renderShowTuck();
});

render();
renderShowTuck();
renderMark();
renderActivity();
renderSetup();

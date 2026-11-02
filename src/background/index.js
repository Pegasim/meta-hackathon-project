// Background worker: the shell around the attention engine. Chrome events become
// engine inputs, processed one at a time; engine state lives in
// chrome.storage.session (the worker can stop at any moment); every input and
// output goes to the event log; unknown pages are judged by the model (LLM#1).
import { Memory, redact } from "../memory/index.js";
import { modelClient, loadModelSettings } from "../memory/model.js";
import { withOverrides } from "../attention/config.js";
import {
  hostOf,
  notesAbout,
  notWorkKey,
  relevanceKey,
  labelKeys,
  builtinLabel,
  cacheUsable,
  isUnsure,
  nextLabel,
  labelHolds,
} from "../attention/relevance.js";
import { readingSettings, mayRead } from "../attention/reading.js";
import { stillOpen, sayable, pickReminder, markSaid, markDone } from "../attention/reminders.js";
import { initialState, step, nextWakeAt } from "../attention/engine.js";
import { makeIntent, isExpired, dayKey } from "../attention/intents.js";
import { createSerialQueue } from "../attention/queue.js";
import { openStore } from "../attention/store.js";
import { classifyRelevance, privateSettings } from "../agent/relevance.js";
import { composeNudge } from "../agent/nudge.js";
import { buildProfile } from "../agent/profile.js";
import { dueLabel, localDate } from "../memory/due.js";
import { siteName, reminderLine } from "../tuck/voice.js";
import { contextFlags, sameDocument } from "./sensor.js";
import { watchTyping, tuckThere, watchRegion, readRegion, isComposing, readExcerpt } from "./page.js";
import { present } from "../tuck/present.js";

const memory = Memory.open();
const store = openStore();
const enqueue = createSerialQueue();
const OWN_PAGES = chrome.runtime.getURL("");
const BADGE = { loud: ["!", "#dc2626"], look: ["·", "#64748b"] };

const todayLabel = (d = new Date()) => `${d.toLocaleDateString("en-US", { weekday: "long" })} ${localDate(d)}`;

// The tasks close enough for Tuck to name out loud (attention/reminders.js). Anything else
// never reaches the prompt, so it cannot be nagged about.
async function dueSoon({ limit = 2 } = {}) {
  const queue = await (await memory).taskQueue({ today: localDate(), limit: Infinity }).catch(() => []);
  return sayable(queue, await loadLoops(), localDate())
    .slice(0, limit)
    .map((e) => ({ title: e.title, when: dueLabel(e.daysLeft) }));
}

// What has been said and finished, by entry id (attention/reminders.js).
const loadLoops = async () => (await chrome.storage.local.get("loops")).loops ?? {};
const saveLoops = (loops) => chrome.storage.local.set({ loops });

// ---- Schedules -----------------------------------------------------------

// Alarms can be lost on browser restart, so make sure they exist on every start.
const ALARMS = { distill: 60, "memory-maintain": 15, "attention-heartbeat": 0.5 };
for (const [name, periodInMinutes] of Object.entries(ALARMS)) {
  chrome.alarms.get(name).then((a) => a || chrome.alarms.create(name, { periodInMinutes }));
}
config().then((cfg) => chrome.idle.setDetectionInterval(cfg.idleAfterSec));

chrome.alarms.onAlarm.addListener(({ name }) => {
  // The heartbeat looks at the page in front: after sleep it finds the person back
  // even when no tab or idle event comes. Same page, so no switch.
  if (name === "attention-heartbeat") sense(activeTab);
  else if (name === "attention-wake") tick();
  else if (name === "distill") distill();
  else if (name === "memory-maintain") maintain();
});

async function config() {
  const { attentionConfig } = await chrome.storage.local.get("attentionConfig");
  return withOverrides(attentionConfig);
}

const loadEngine = async () => (await chrome.storage.session.get("engine")).engine ?? initialState();

// Session storage is wiped when Chrome restarts or the extension reloads, but the
// goal (IndexedDB) and the mode (local storage) survive: give them back to the engine.
// Runs inside the queue.
async function engineState(cfg, ts) {
  const { engine } = await chrome.storage.session.get("engine");
  if (engine) return engine;
  let s = initialState();
  const { mode } = await chrome.storage.local.get("mode");
  if (mode && mode !== "focus")
    s = (await apply(s, { type: "session", ts, kind: "mode", payload: { mode } }, cfg)).state;
  const st = await store;
  const intent = await st.activeIntent();
  if (intent && isExpired(intent, ts, ts, cfg)) await st.putIntent({ ...intent, expiredAt: ts });
  else if (intent) {
    const payload = { id: intent.id, title: intent.title, topic: intent.topic, restored: true };
    s = (await apply(s, { type: "session", ts, kind: "intent_set", payload }, cfg)).state;
    const { lastRelevant } = await chrome.storage.local.get("lastRelevant");
    if (lastRelevant?.intentId === intent.id) {
      const { intentId: _, ...place } = lastRelevant;
      s = { ...s, lastRelevant: place };
    }
  }
  await saveEngine(s);
  return s;
}
// The last work page also goes to local storage, so "Take me back" survives a restart.
async function saveEngine(engine) {
  await chrome.storage.session.set({ engine });
  if (engine.lastRelevant && engine.intent)
    await chrome.storage.local.set({ lastRelevant: { ...engine.lastRelevant, intentId: engine.intent.id } });
}
const log = async (record) => (await store).appendEvent(record);

// ---- The engine loop -----------------------------------------------------

// Runs inside the queue. Returns the new engine state.
async function process(input) {
  const cfg = await config();
  let s = await engineState(cfg, input.ts);
  if (s.mode === "off" && input.type !== "session" && input.type !== "response") return s;

  // A goal left over from yesterday (or hours ago) becomes an open loop.
  if (input.type === "context" && s.intent) {
    const intent = await (await store).activeIntent();
    if (intent && isExpired(intent, input.ts, s.lastActiveTs ?? input.ts, cfg)) {
      await (await store).putIntent({ ...intent, expiredAt: input.ts });
      const done = { type: "session", ts: input.ts, kind: "intent_done", payload: { id: intent.id, expired: true } };
      s = (await apply(s, done, cfg)).state;
    }
  }
  return (await apply(s, input, cfg)).state;
}

async function apply(s, input, cfg) {
  const r = step(s, input, cfg);
  await saveEngine(r.state);
  await log(input); // ticks too: replay tells sleep from a long stay by them
  for (const o of r.out) {
    if (o.type === "need_relevance") askRelevance(o);
    else if (o.type === "read_ahead") readAhead(o);
    else if (o.type === "need_second_look") secondLook(o);
    else {
      await log(o);
      if (o.type === "trigger") await showTrigger(o, r.state);
      // Tuck's words take the model a few seconds: start writing them before they are needed.
      if (o.type === "state" && o.to === "detour") draftNudge(r.state, 1, cfg);
      if (o.type === "trigger" && o.kind === "drift" && o.level >= 1 && !o.suppressedBy)
        draftNudge(r.state, o.level + 1, cfg);
      if (o.type === "state" && ["focused", "no_intent", "paused"].includes(o.to)) await setBadge(null);
      // Back on a work page before answering (a new tab or a search is not back yet).
      const backAtWork = o.type === "state" && o.to === "focused" && r.state.current?.label === "related";
      if (backAtWork && ["detour", "drifting"].includes(o.from)) await selfReturn(o.ts);
    }
  }
  if (input.type === "context") await presence(s, r.state, input);
  if (input.type === "context" && !r.state.intent && !["dnd", "off"].includes(r.state.mode)) {
    const { pendingGreeting } = await chrome.storage.session.get("pendingGreeting");
    if (pendingGreeting) await greet(input.tabId);
  }
  scheduleWake(r.state, cfg);
  return r;
}

const feed = (input) => enqueue(() => process(input));
const tick = () => feed({ type: "tick", ts: Date.now() });

let wakeTimer = null;
function scheduleWake(s, cfg) {
  const at = nextWakeAt(s, cfg);
  clearTimeout(wakeTimer);
  if (at == null) return;
  const delay = at - Date.now();
  // Alarms fire no sooner than 30 s; a timer covers the short waits while the worker is awake.
  if (delay <= 30000) wakeTimer = setTimeout(tick, Math.max(0, delay) + 50);
  else chrome.alarms.create("attention-wake", { when: at });
}

// ---- Sensor --------------------------------------------------------------

const record = (event) => memory.then((m) => m.recordActivity(event));

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

// Each Chrome event is queued the moment it arrives; the Chrome lookups happen
// inside the job, so the engine sees events in arrival order.
// getTab: () => Promise<Tab>. opts: {idleState?, forceUnfocused?}.
const sense = (getTab, opts = {}) => enqueue(() => contextJob(getTab, opts));

async function contextJob(getTab, { idleState, forceUnfocused = false } = {}) {
  const tab = await getTab().catch(() => null);
  if (!tab || tab.url === "about:blank") return; // transient, not a page the user chose
  const win = await chrome.windows.getLastFocused().catch(() => null);
  const flags = contextFlags(tab, {
    focusedWindowId: win?.focused ? win.id : -1,
    idleState: idleState ?? (await chrome.idle.queryState((await config()).idleAfterSec)),
    forceUnfocused,
  });
  if (!flags) return; // not the page in front
  let url = tab.url ?? "";
  let title = tab.title ?? "";
  // Time in this extension's own pages (settings) is neither work nor drift, and stays out of the log.
  if (url.startsWith(OWN_PAGES)) {
    url = "";
    title = "";
    record({ kind: "idle" });
  } else if (flags.browserFocused && flags.idleState === "active") {
    record({ url, title });
  } else if (!tab.audible) {
    record({ kind: "idle" });
  }
  const ts = Date.now();
  const cfg = await config();
  const s = await engineState(cfg, ts);
  const surface = await surfaceOf(tab.id, url, flags);
  return process({
    type: "context",
    ts,
    tabId: tab.id,
    url,
    host: hostOf(url),
    title,
    key: relevanceKey(s.intent?.id ?? "none", url, title, surface),
    audible: !!tab.audible,
    surface,
    ...flags,
    ...(await knownLabel(s.intent, url, title, cfg, surface)),
  });
}

// Where on the page the person is working. Logged raw on the context input, so a replay
// sees it. Runs inside the engine's queue, so a page that does not answer (loading,
// frozen) must not hold it up: it then counts as a page.
const PLAIN_PAGE = { kind: "page", labels: [] };
const REGION_WAIT_MS = 500;
async function surfaceOf(tabId, url, { browserFocused }) {
  if (!url || !browserFocused || !mayRead(url, await readingNow())) return PLAIN_PAGE;
  // Installed here, not when Tuck appears: a reload wipes it with the tab and URL unchanged.
  const look = inPage(tabId, watchRegion).then(() => inPage(tabId, readRegion));
  const region = await Promise.race([look, sleep(REGION_WAIT_MS)]);
  return region ?? PLAIN_PAGE;
}

// Built-in rules, then the user's labels, then a recent second look that found work,
// then the cache. Unknown → the engine asks.
async function knownLabel(intent, url, title, cfg, surface) {
  if (builtinLabel(url, OWN_PAGES)) return { label: "neutral", confidence: 1, source: "builtin" };
  if (!intent) return {};
  const st = await store;
  const now = Date.now();
  // The most specific answer wins: a no about this page or chat beats a yes about the site.
  const no = await st.getLabel(notWorkKey(intent.topic, url, title, surface));
  const notWork = no?.label === "unrelated" && labelHolds(no, now);
  if (!notWork)
    for (const key of labelKeys(intent.topic, url, title, surface)) {
      const l = await st.getLabel(key);
      if (l?.label === "related" && labelHolds(l, now)) return { label: l.label, confidence: 1, source: "label" };
    }
  const key = relevanceKey(intent.id, url, title, surface);
  if (mayRead(url, await readingNow()))
    for (const from of ["focus", "view"]) {
      const look = await st.getCached(`look|${from}|${key}`);
      if (
        look?.label === "related" &&
        look.confidence >= cfg.unsureConfidence &&
        now - look.ts < cfg.lookHoldMin * 60000
      )
        return { label: "related", confidence: look.confidence, source: "look" };
    }
  if (notWork) return { label: "unrelated", confidence: 1, source: "label" };
  const own = await st.getCached(key);
  const usable = ({ label, confidence }) => ({ label, confidence, source: "cache" });
  if (cacheUsable(own, now)) return usable(own);
  if (surface?.kind !== "conversation") return {};
  // A chat the notes say something about gets its own judgment. Otherwise the model
  // would see only URL and title, the same as for the page: no second call.
  if ((await notesFor(url, title, surface)).length) return {};
  const page = await st.getCached(relevanceKey(intent.id, url, title));
  return cacheUsable(page, now) ? usable(page) : {};
}

// The person's own notes about this page or this person: memory's search finds
// candidates on any shared word, notesAbout keeps those really about it. The goal stays
// out of the query: a page nothing is known about keeps the plain prompt.
const NOTES_SEARCHED = 20;
async function notesFor(url, title, surface) {
  const name = surface?.labels?.[0];
  const query = [title, hostOf(url), name].filter(Boolean).join(" ");
  const hits = await (await memory).recall(query, { limit: NOTES_SEARCHED }).catch(() => []);
  return notesAbout(hits, { title, host: hostOf(url), name }).map((note) => ({
    topic: note.topic,
    title: redact(note.title).text,
    text: redact(note.text).text,
  }));
}

// The person's notes changed. What was judged without them is judged again, and an
// answer already on its way, judged from the old notes, is not kept (memoryGeneration).
let memoryGeneration = 0;
async function memoryChanged() {
  memoryGeneration += 1;
  await (await store).clearCached();
  await feed({ type: "session", ts: Date.now(), kind: "memory" });
}

chrome.tabs.onActivated.addListener(({ tabId }) => sense(() => chrome.tabs.get(tabId)));

// A bare URL change carries the previous page's title, so wait for the new title
// or for loading to complete. Same-page repeats are one page to the engine.
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.title || change.status === "complete")) sense(async () => tab);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) sense(activeTab, { forceUnfocused: true });
  else sense(activeTab);
});

chrome.idle.onStateChanged.addListener((state) => sense(activeTab, { idleState: state }));

// ---- Relevance (LLM#1) ---------------------------------------------------

function askRelevance(need) {
  // Outside the queue; a failure leaves the page neutral and the engine asks again later.
  judge(need).catch((err) =>
    log({ type: "llm", ts: Date.now(), node: "classifyRelevance", ok: false, error: String(err) }),
  );
}

async function judge(need) {
  const s = await loadEngine();
  if (!s.intent) return;
  const generation = memoryGeneration;
  const settings = await loadModelSettings();
  // What the call really uses, so the log below names it and not the saved preset.
  const used = privateSettings(settings ?? {});
  const st = await store;
  const intent = (await st.activeIntent()) ?? s.intent;
  // Only labels that still hold: a site marked as work for one visit is no example.
  const examples = (await st.recentLabels(20))
    // Nor is a chat: the prompt sees only the page's URL and title.
    .filter((l) => l.topic === intent.topic && labelHolds(l, Date.now()) && l.surface !== "conversation")
    .slice(0, 5)
    .map(({ host, title, label }) => ({ host, title, label }));
  let r;
  try {
    r = await classifyRelevance(modelClient(used), {
      intent,
      url: need.url,
      title: need.title,
      examples,
      profile: await (await memory).profile().catch(() => null),
      notes: await notesFor(need.url, need.title, need.surface),
      conversationWith: need.surface?.labels?.[0],
    });
  } catch (err) {
    // No model set up: the page stays neutral.
    r = { label: "neutral", confidence: 0, source: "fallback", latencyMs: 0, error: err.message ?? String(err) };
  }
  await log({
    type: "llm",
    ts: Date.now(),
    node: "classifyRelevance",
    model: settings ? (used.model ?? used.provider) : null,
    latencyMs: r.latencyMs,
    ok: r.source === "llm",
    ...(r.error && { error: r.error }),
  });
  if (generation !== memoryGeneration) return; // judged from notes since replaced: asked again
  // Fallbacks too, briefly (cacheUsable), so a model that is down is not called on every visit.
  await st.putCached({ key: need.key, label: r.label, confidence: r.confidence, source: r.source, ts: Date.now() });
  await feed({
    type: "relevance",
    ts: Date.now(),
    key: need.key,
    label: r.label,
    confidence: r.confidence,
    source: r.source,
    latencyMs: r.latencyMs,
    intentId: s.intent.id,
  });
}

// ---- The second look -----------------------------------------------------

const EXCERPT_CHARS = 1000; // at most this much page text leaves the device per look
const EXCERPT_MIN_CHARS = 300; // climb from the focus until a container says this much
const LOOK_WAIT_MS = 3000; // when a word is due, wait this long at most for the excerpt's verdict

const readingNow = async () => readingSettings((await chrome.storage.local.get("pageReading")).pageReading);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In the page: run one of page.js's functions; null where Chrome does not allow it.
async function inPage(tabId, func, args = []) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return r?.result ?? null;
  } catch {
    return null;
  }
}

// Is the person typing on the page in front (a key within cfg.typingRecentSec, focus
// in a text field)? The excerpt then starts at that field; otherwise at the middle of
// the window, so a chat box left focused does not speak for a scrolled feed.
async function typingOn(tabId) {
  await inPage(tabId, watchTyping);
  return (await inPage(tabId, isComposing, [(await config()).typingRecentSec * 1000])) === true;
}

// Ahead of a drift word: read and judge the excerpt now, since that takes a model call.
// Work found tells the engine at once (the detour ends); anything else waits in the
// cache for the look. Outside the queue.
function readAhead(need) {
  typingOn(need.tabId)
    .then((typing) => excerptVerdict(need, typing ? "focus" : "view"))
    .then((v) => v.label === "related" && feed({ type: "second_look", ts: Date.now(), key: need.key, ...v }))
    .catch((err) => log({ type: "llm", ts: Date.now(), node: "secondLook", ok: false, error: String(err) }));
}

// When a drift word is due: is the person typing on the page right now, and what does
// the excerpt say (read ahead, usually)? The verdict gets LOOK_WAIT_MS at most, so a
// slow model never stalls the word; one that finds work later still ends the drift
// through the read-ahead. Outside the queue; the answer is an engine input, and only
// the verdict is kept. A failure answers "nothing seen", so the drift goes ahead.
function secondLook(need) {
  look(need).catch((err) =>
    feed({ type: "second_look", ts: Date.now(), key: need.key, composing: false, error: String(err) }),
  );
}

async function look(need) {
  const composing = await typingOn(need.tabId);
  const verdict = await Promise.race([
    excerptVerdict(need, composing ? "focus" : "view"),
    sleep(LOOK_WAIT_MS).then(() => ({ skipped: "slow" })),
  ]);
  await feed({ type: "second_look", ts: Date.now(), key: need.key, composing, ...verdict });
}

// One reading per page and starting point at a time: a look while the read-ahead still
// waits for the model shares its answer.
const inFlight = new Map();
function excerptVerdict(need, from) {
  const id = `${from}|${need.key}`;
  if (!inFlight.has(id))
    inFlight.set(
      id,
      judgeExcerpt(need, from).finally(() => inFlight.delete(id)),
    );
  return inFlight.get(id);
}

// {label, confidence, source} from the excerpt, or {skipped: why}. from: "focus" (the
// field the person types in) or "view" (the middle of the window). A verdict counts for
// cfg.lookHoldMin minutes, so a page is not read again on every drift word.
async function judgeExcerpt(need, from) {
  const generation = memoryGeneration;
  const cfg = await config();
  const st = await store;
  if (!mayRead(need.url, await readingNow())) return { skipped: "settings" };
  const cacheKey = `look|${from}|${need.key}`;
  const cached = await st.getCached(cacheKey);
  if (cached && Date.now() - cached.ts < cfg.lookHoldMin * 60000)
    return { label: cached.label, confidence: cached.confidence, source: "look-cache" };
  const page = await inPage(need.tabId, readExcerpt, [need.url, EXCERPT_CHARS, EXCERPT_MIN_CHARS, from === "focus"]);
  if (!page) return { skipped: "unreadable" };
  if (page.password) return { skipped: "password" };
  const { text, count } = redact(page.text);
  if (!text) return { skipped: "empty" };
  const intent = (await st.activeIntent()) ?? (await loadEngine()).intent;
  if (!intent) return { skipped: "no goal" };
  const settings = privateSettings((await loadModelSettings()) ?? {});
  let complete;
  try {
    complete = modelClient(settings);
  } catch {
    return { skipped: "no model" };
  }
  const profile = await (await memory).profile().catch(() => null);
  const r = await classifyRelevance(complete, {
    intent,
    url: need.url,
    title: need.title,
    profile,
    excerpt: text,
    notes: await notesFor(need.url, need.title, need.surface),
    conversationWith: need.surface?.labels?.[0],
  });
  await log({
    type: "llm",
    ts: Date.now(),
    node: "secondLook",
    model: settings.model ?? settings.provider ?? null,
    latencyMs: r.latencyMs,
    ok: r.source === "llm",
    chars: text.length, // the size only: neither the text nor the model's reason, which may retell it
    redactions: count,
    ...(r.error && { error: r.error }),
  });
  if (r.source !== "llm") return { skipped: "model failed" };
  if (generation !== memoryGeneration) return { skipped: "notes changed" };
  await st.putCached({
    key: cacheKey,
    label: r.label,
    confidence: r.confidence,
    source: "look",
    ts: Date.now(),
  });
  return { label: r.label, confidence: r.confidence, source: "look" };
}

// ---- Interventions -------------------------------------------------------

async function setBadge(kind) {
  const [text, color] = kind ? BADGE[kind] : ["", "#64748b"];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// Level 0 (do not disturb) is logged only; everything else is shown.
async function showTrigger(t, s) {
  if (t.level < 1) return;
  const intent = await (await store).activeIntent();
  const shown = {
    ...t,
    intentTitle: s.intent?.title ?? null,
    intentStep: intent?.steps?.[0] ?? null,
    message: await draftFor(t, s),
  };
  await chrome.storage.local.set({ lastTrigger: shown });
  await setBadge(t.level >= 2 ? "loud" : "look");
  if (t.kind === "session_start") return greet(s.current?.tabId);
  const view = present({ trigger: shown });
  // A return or a break's end is a natural moment; a drift is not.
  if (t.kind === "return" || t.kind === "break_over") return showWithReminder(s.current?.tabId, view, s.intent?.title);
  await showTuck(s.current?.tabId, view);
}

// Shows Tuck with the most urgent thing worth a word, if any. It counts as said only
// once it is on screen. Returns whether Tuck was shown.
async function showWithReminder(tabId, view, goalTitle) {
  const today = localDate();
  const { mode } = await loadEngine();
  const quiet = mode === "dnd" || mode === "off";
  const queue = await (await memory).taskQueue({ today, limit: Infinity }).catch(() => []);
  const item = view?.bubble && !quiet ? pickReminder(queue, { goalTitle, loops: await loadLoops(), today }) : null;
  if (!item) return showTuck(tabId, view);
  const reminder = { id: item.id, title: item.title, line: reminderLine(dueLabel(item.daysLeft)) };
  const shown = await showTuck(tabId, { ...view, bubble: { ...view.bubble, reminder } });
  if (shown) {
    // Read again: showing Tuck takes a while, and a Done may have come in meanwhile.
    await saveLoops(markSaid(await loadLoops(), item.id, today));
    await log({ type: "feedback", ts: Date.now(), kind: "reminder_said", payload: { id: item.id } });
  }
  return shown;
}

// On it: nothing more today, already noted when it was said. Done stays done. Switch:
// it becomes the goal.
async function reminderAnswer({ id, title, choice }, sender) {
  await log({ type: "feedback", ts: Date.now(), kind: "reminder", payload: { id, choice } });
  if (choice === "done") await saveLoops(markDone(await loadLoops(), id, Date.now()));
  if (choice === "switch") return setIntent({ title, from: "tuck", fromLoopId: id }, sender);
  return { ok: true };
}

// ---- Tuck's words (LLM#4) ------------------------------------------------

// Writes the line for the nudge at `level` on the page in front, ahead of time.
// Outside the queue; a failure leaves the template.
function draftNudge(s, level, cfg) {
  writeDraft(s, level, cfg).catch((err) =>
    log({ type: "llm", ts: Date.now(), node: "composeNudge", ok: false, error: String(err) }),
  );
}

async function writeDraft(s, level, cfg) {
  if (!s.intent || !s.current || level > 3) return;
  const settings = await loadModelSettings();
  if (!settings) return;
  const intent = await (await store).activeIntent();
  const unsure = isUnsure(s.current, cfg);
  // Minutes away when that nudge comes: the tolerance, plus one escalation per level after the first.
  const awayMs =
    (s.offTaskSince ? Date.now() - s.offTaskSince : 0) +
    (level === 1 ? cfg.toleranceSec * 1000 : cfg.escalateAfterSec * 1000);
  const used = privateSettings(settings);
  const r = await composeNudge(modelClient(used), {
    kind: "drift",
    level,
    site: siteName(s.current.host),
    awayMin: Math.round(awayMs / 60000),
    unsure,
    task: { title: intent?.title ?? s.intent.title, step: intent?.steps?.[0] },
    lastWork: s.lastRelevant?.title,
    hour: new Date().getHours(),
    today: todayLabel(),
    due: await dueSoon(),
  });
  await log({
    type: "llm",
    ts: Date.now(),
    node: "composeNudge",
    model: used.model ?? used.provider ?? null,
    latencyMs: r.latencyMs,
    ok: r.source === "llm",
    ...(r.error && { error: r.error }),
    ...(r.message && { message: r.message }),
  });
  if (r.message)
    await chrome.storage.session.set({ nudgeDraft: { key: s.current.key, level, unsure, message: r.message } });
}

// The drafted line, if it was written for this very nudge.
async function draftFor(t, s) {
  if (t.kind !== "drift") return null;
  const { nudgeDraft: d } = await chrome.storage.session.get("nudgeDraft");
  const unsure = !!t.evidence?.unsure;
  return d && d.key === s.current?.key && d.level === t.level && d.unsure === unsure ? d.message : null;
}

// ---- Tuck on the page ----------------------------------------------------

let tuckAssets = null;
async function assets() {
  tuckAssets ??= {
    svg: await (await fetch(chrome.runtime.getURL("tuck/assets/tuck.svg"))).text(),
    css: await (await fetch(chrome.runtime.getURL("tuck/assets/tuck.css"))).text(),
  };
  return tuckAssets;
}

// Draw a view (present.js) in a tab. False when Chrome does not allow it there
// (chrome:// pages, the Web Store, this extension's own pages).
async function showTuck(tabId, view) {
  if (tabId == null || !view) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["tuck/layout.js", "tuck/overlay.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "tuck-show", view, assets: await assets() });
    await chrome.storage.session.set({ tuckTab: tabId });
    return true;
  } catch {
    return false;
  }
}

async function hideTuck(type = "tuck-hide") {
  const { tuckTab } = await chrome.storage.session.get("tuckTab");
  if (tuckTab != null) await chrome.tabs.sendMessage(tuckTab, { type }).catch(() => {});
}
// Close the bubble and settle back to resting, staying on the page.
const restTuck = () => hideTuck("tuck-rest");

// While there is a goal, Tuck rests on every page (not on a break, paused or off).
async function presence(prev, s, input) {
  if (!s.current?.url) return;
  const changed = prev.current?.tabId !== s.current?.tabId || prev.current?.url !== s.current?.url;
  const away = ["break", "paused"].includes(s.state);
  // A reload keeps the tab and URL but wipes Tuck from the page: it comes back at once,
  // where it was. A page that cannot be scripted answers null, not false.
  const reloaded = !changed && s.intent && !away && (await inPage(input.tabId, tuckThere)) === false;
  if (!changed && !reloaded) return;
  // Typing is noted from the start of the page (its time only), for the second look.
  if (s.intent && !away) await inPage(input.tabId, watchTyping);
  if (s.intent && !away)
    await showTuck(input.tabId, { ...present({ event: "presence" }), ...(reloaded && { instant: true }) });
  else if (away) await chrome.tabs.sendMessage(input.tabId, { type: "tuck-hide" }).catch(() => {});
}

// The day's greeting with the goal form. If the first page cannot hold Tuck (a new
// tab, settings), the greeting waits for the next page that can.
async function greet(tabId) {
  const st = await store;
  const expired = await st.latestIntent();
  // The goal form offers what is running out first. The title stays exactly as it is
  // stored: tapping the chip sends it straight to set-intent, so a "(tomorrow)" glued
  // on here would become part of the goal, change its topic slug every day, and could
  // push a long title past the 120-character limit an entry validates against.
  const loops = [
    ...(expired?.expiredAt && !expired.doneAt ? [{ title: expired.title }] : []),
    ...stillOpen(await (await memory).taskQueue({ today: localDate(), limit: Infinity }), await loadLoops()).map(
      (e) => ({
        title: e.title,
      }),
    ),
  ];
  const view = present({ trigger: { kind: "session_start", level: 2, id: "greeting" }, loops });
  const shown = await showWithReminder(tabId, view, expired?.expiredAt && !expired.doneAt ? expired.title : null);
  await chrome.storage.session.set({ pendingGreeting: !shown });
}

async function respond({ choice }) {
  return enqueue(async () => {
    const { lastTrigger } = await chrome.storage.local.get("lastTrigger");
    const ts = Date.now();
    const before = await engineState(await config(), ts);
    const page = lastTrigger?.evidence; // the page the nudge was about
    // "No, take me back" answers the question Tuck asked on a page it was unsure about,
    // which only the first drift word does. Any other "back" just means going back.
    const saidNo =
      choice === "back" &&
      lastTrigger?.kind === "drift" &&
      lastTrigger.level === 1 &&
      page?.unsure &&
      page.host &&
      before.intent;
    // Nowhere to go back to yet: leave the nudge open (the popup disables the button). A no
    // is still an answer.
    if (choice === "back" && !before.lastRelevant && !saidNo) return { ok: false, reason: "no related page yet" };
    const s = await process({
      type: "response",
      ts,
      triggerId: lastTrigger?.id ?? null,
      choice,
      pageUrl: page?.url,
      pageKey: page?.key,
      latencyMs: lastTrigger ? ts - lastTrigger.ts : null,
    });
    await chrome.storage.local.set({ lastTrigger: lastTrigger ? { ...lastTrigger, respondedAt: ts, choice } : null });
    await setBadge(null);
    if (choice === "related") await showTuck(before.current?.tabId, present({ event: "resolved" }));
    else if (choice === "break") await hideTuck();
    else await restTuck();
    if (choice === "back" && s.lastRelevant) await takeMeBack(s.lastRelevant);
    if (choice === "related" && page?.host && before.intent) await markLabel(page, before.intent, ts);
    if (saidNo) await markLabel(page, before.intent, ts, "unrelated");
    return { ok: true };
  });
}

// The person went back to work before answering: the nudge is over.
async function selfReturn(ts) {
  const { lastTrigger } = await chrome.storage.local.get("lastTrigger");
  if (!lastTrigger || lastTrigger.respondedAt || lastTrigger.resolvedAt) return;
  await chrome.storage.local.set({ lastTrigger: { ...lastTrigger, resolvedAt: ts, resolvedBy: "self" } });
  await restTuck();
  await showTuck((await loadEngine()).current?.tabId, present({ event: "resolved" }));
  await log({
    type: "feedback",
    ts,
    kind: "self_return",
    payload: { triggerId: lastTrigger.id, afterMs: ts - lastTrigger.ts },
  });
}

// Focus the last related tab, or reopen its page.
async function takeMeBack(last) {
  if (!last) return;
  const tab = await chrome.tabs.get(last.tabId).catch(() => null);
  // The tab may be gone, or now showing something else: then reopen the page.
  if (tab && sameDocument(tab.url, last.url)) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: last.url, active: true });
  }
}

// page: {url, host, title, surface} from the trigger's evidence. On a whole site or in a
// conversation the label is for this visit; memory hears about it once it lasts
// (relevance.js nextLabel).
async function markLabel(page, intent, ts, verdict = "related") {
  const cfg = await config();
  const st = await store;
  const noKey = notWorkKey(intent.topic, page.url, page.title, page.surface);
  const key = verdict === "unrelated" ? noKey : labelKeys(intent.topic, page.url, page.title, page.surface)[0];
  const prev = await st.getLabel(key);
  const chat = page.surface?.kind === "conversation";
  const label = nextLabel(
    prev,
    {
      key,
      topic: intent.topic,
      host: page.host,
      title: page.title,
      ts,
      day: dayKey(ts, cfg),
      label: verdict,
      ...(chat && { surface: "conversation" }),
    },
    cfg,
  );
  // Shown in settings, where a label can be forgotten.
  await st.putLabel(chat ? { ...label, who: page.surface.labels?.[0] } : label);
  await log({ type: "feedback", ts, kind: "label", payload: label });
  if (verdict !== "related") return;
  if (key !== noKey) await st.deleteLabel(noKey); // a yes takes back an earlier no
  const lastedBefore = prev?.label === "related" && prev.days && prev.until == null;
  if (label.until != null || lastedBefore) return;
  await (
    await memory
  ).add({
    kind: "preference",
    topic: intent.topic,
    // One person's answer says nothing of the rest of the site.
    title:
      `${chat ? `Conversations with ${page.surface.labels?.[0] ?? "this person"} on ${page.host} count` : `${page.host} counts`} as work for ${intent.topic}`.slice(
        0,
        120,
      ),
    context: "Marked by the user from a nudge.",
    result: "related",
  });
}

// ---- Who this person is (LLM#5) ------------------------------------------

// One model call, at import and re-sync only, never on the nudge path. A failure
// leaves the profile that was already stored, so relevance is never made worse.
async function refreshProfile() {
  const settings = await loadModelSettings();
  if (!settings) return { profile: null, source: "no-model" };
  const m = await memory;
  const used = privateSettings(settings);
  const r = await buildProfile(modelClient(used), await m.profileSample());
  if (r.profile) await m.setProfile(r.profile);
  await log({
    type: "llm",
    ts: Date.now(),
    node: "buildProfile",
    model: used.model ?? used.provider ?? null,
    latencyMs: r.latencyMs,
    ok: !!r.profile,
    error: r.error,
  });
  return r;
}

// ---- Goals and modes -----------------------------------------------------

async function setIntent({ title, next, from, fromLoopId }, sender) {
  return enqueue(async () => {
    const st = await store;
    const previous = await st.activeIntent();
    if (previous) await st.putIntent({ ...previous, doneAt: Date.now(), replaced: true });
    const entry = await (await memory).setIntent({ title, next: next || undefined });
    const intent = {
      ...makeIntent({ title, steps: next ? [next] : [], memoryEntryId: entry.id }, Date.now()),
      ...(fromLoopId && { fromLoopId }), // finishing this goal finishes that task
    };
    await (await store).putIntent(intent);
    await process({
      type: "session",
      ts: Date.now(),
      kind: "intent_set",
      payload: { id: intent.id, title, topic: intent.topic },
    });
    await chrome.storage.session.set({ pendingGreeting: false });
    if (from === "tuck") await showTuck(sender?.tab?.id, present({ event: "goal_set" }));
    return intent;
  });
}

async function completeIntent() {
  return enqueue(async () => {
    const st = await store;
    const intent = await st.activeIntent();
    if (!intent) return null;
    if (intent.memoryEntryId) await (await memory).completeIntent(intent.memoryEntryId).catch(() => {});
    await st.putIntent({ ...intent, doneAt: Date.now() });
    if (intent.fromLoopId) await saveLoops(markDone(await loadLoops(), intent.fromLoopId, Date.now()));
    await process({ type: "session", ts: Date.now(), kind: "intent_done", payload: { id: intent.id } });
    // Tuck asks what's next, on the page in front.
    await showWithReminder((await loadEngine()).current?.tabId, present({ event: "goal_done" }), intent.title);
    return intent;
  });
}

const setMode = ({ mode }) =>
  enqueue(async () => {
    await chrome.storage.local.set({ mode });
    if (mode === "dnd" || mode === "off") await hideTuck();
    return process({ type: "session", ts: Date.now(), kind: "mode", payload: { mode } });
  });

const status = () =>
  enqueue(async () => {
    const { lastTrigger } = await chrome.storage.local.get("lastTrigger");
    const engine = await engineState(await config(), Date.now());
    return { engine, lastTrigger: lastTrigger ?? null, intent: await (await store).activeIntent() };
  });

// ---- Distill and upkeep --------------------------------------------------

async function distill() {
  const settings = await loadModelSettings();
  if (!settings) return;
  try {
    const result = await (await memory).distill(modelClient(privateSettings(settings)), { minutes: 60 });
    await chrome.storage.local.set({ lastDistill: { added: result.added, at: Date.now() } });
  } catch (err) {
    await chrome.storage.local.set({ lastDistill: { error: err.message ?? String(err), at: Date.now() } });
  }
}

async function maintain() {
  await (await memory).maintain();
  const cfg = await config();
  await (await store).pruneBefore(Date.now() - cfg.retentionDays * 24 * 3600 * 1000);
}

// ---- Messages from the popup and settings pages --------------------------

const HANDLERS = {
  "set-intent": setIntent,
  "complete-intent": completeIntent,
  "set-mode": setMode,
  respond,
  "get-status": status,
  "export-log": async () => (await store).exportLog(),
  "import-log": async ({ log }) => (await store).importLog(log),
  "record-active": () => sense(activeTab),
  // Clicking Tuck with no nudge: the goal card (or the goal form when there is none).
  "tuck-click": async (_msg, sender) =>
    showTuck(sender?.tab?.id, present({ event: "card", intent: await (await store).activeIntent() })),
  "tuck-change": async (_msg, sender) => showTuck(sender?.tab?.id, present({ event: "card", intent: null })),
  maintain,
  "sync-brain": async () => {
    const r = await (await memory).syncBrain();
    if (r.connected && !r.needsPermission) {
      await memoryChanged();
      refreshProfile().catch(() => {});
    }
    return r;
  },
  "refresh-profile": refreshProfile,
  "reminder-answer": reminderAnswer,
  // What Tuck has learned from answers, for settings. Forgetting one has the page in
  // front judged again.
  "get-labels": async () => (await (await store).recentLabels(50)).filter((l) => labelHolds(l, Date.now())),
  "delete-label": async ({ key }) => {
    await (await store).deleteLabel(key);
    await feed({ type: "session", ts: Date.now(), kind: "memory" });
    return sense(activeTab);
  },
  // An import ran in the settings page. Memory's own reads notice it; what was judged
  // without the new notes is judged again.
  "memory-changed": async () => {
    await memoryChanged();
    return sense(activeTab);
  },
  "get-profile": async () => ({
    profile: await (await memory).profile(),
    queue: await (await memory).taskQueue({ today: localDate() }),
  }),
};

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(reply, (err) => reply({ error: String(err) }));
  return true; // async reply
});

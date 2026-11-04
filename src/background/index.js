// Background worker: the shell around the attention engine. Chrome events become
// engine inputs, processed one at a time; engine state lives in
// chrome.storage.session (the worker can stop at any moment); every input and
// output goes to the event log; unknown pages are judged by the model (LLM#1).
import { Memory, redact, entryKey } from "../memory/index.js";
import { modelClient, toolClient, loadModelSettings } from "../memory/model.js";
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
import {
  stillOpen,
  sayable,
  pickReminder,
  markSaid,
  markDone,
  markNotTask,
  markAll,
  splitRow,
  taskList,
} from "../attention/reminders.js";
import { ENDS_DETOUR, initialState, step, nextWakeAt } from "../attention/engine.js";
import { makeIntent, isExpired, dayKey } from "../attention/intents.js";
import { daySummary, summaryEntry } from "../attention/summary.js";
import { createSerialQueue } from "../attention/queue.js";
import { openStore } from "../attention/store.js";
import { classifyRelevance, privateSettings } from "../agent/relevance.js";
import { composeNudge } from "../agent/nudge.js";
import { buildProfile } from "../agent/profile.js";
import { refreshTasks } from "../agent/tasks.js";
import { planFor, stuckStep, nextAfter } from "../agent/moments.js";
import { recentRuns } from "../agent/loop.js";
import { noteOf } from "../agent/notes.js";
import { dueLabel, localDate } from "../memory/due.js";
import { siteName, reminderLine, templateGreeting, toolKind, whenSaid } from "../tuck/voice.js";
import { contextFlags, sameDocument } from "./sensor.js";
import { watchTyping, tuckThere, watchRegion, readRegion, isComposing, readExcerpt } from "./page.js";
import { present, comesWhileAway } from "../tuck/present.js";
import "../tuck/skins.js";

const memory = Memory.open();
const store = openStore();
const enqueue = createSerialQueue();
const OWN_PAGES = chrome.runtime.getURL("");
const BADGE = { loud: ["!", "#dc2626"], look: ["·", "#64748b"] };

const todayLabel = (d = new Date()) => `${d.toLocaleDateString("en-US", { weekday: "long" })} ${localDate(d)}`;

// The tasks close enough for Tuck to name out loud (attention/reminders.js). Anything else
// never reaches the prompt, so it cannot be nagged about.
async function dueSoon({ limit = 2 } = {}) {
  return sayable(await toDo(), await loadLoops(), localDate())
    .slice(0, limit)
    .map((e) => ({ title: e.title, when: dueLabel(e.daysLeft) }));
}

// What has been said and finished, by entry id (attention/reminders.js).
const loadLoops = async () => (await chrome.storage.local.get("loops")).loops ?? {};
const saveLoops = (loops) => chrome.storage.local.set({ loops });

// The to-do list: memory's queue with what the task node made of it (attention/reminders.js
// taskList, agent/tasks.js), one row per commitment (#47). Before the node has run,
// memory's queue as it is.
async function toDo(today = localDate()) {
  const queue = await (await memory).taskQueue({ today, limit: Infinity }).catch(() => []);
  const got = await chrome.storage.local.get(["taskVerdicts", "taskSettings", "loops", "taskPairs", "taskSplits"]);
  return taskList(queue, {
    verdicts: got.taskVerdicts ?? {},
    hidePersonal: !!got.taskSettings?.hidePersonal,
    loops: got.loops ?? {},
    pairs: got.taskPairs ?? {},
    splits: got.taskSplits ?? {},
  });
}

// The row an entry id stands in: an answer on it is an answer on all of its entries.
const rowOf = async (id) => (await toDo()).find((e) => e.id === id || e.members?.includes(id)) ?? { id };

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
  if (name === "attention-heartbeat") {
    connectBridge();
    sense(activeTab);
  } else if (name === "attention-wake") tick();
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
  // The day's greeting too: a restart is not a new day.
  const { mode, sessionDay = null } = await chrome.storage.local.get(["mode", "sessionDay"]);
  let s = { ...initialState(), sessionDay };
  if (mode && mode !== "focus")
    s = (await apply(s, { type: "session", ts, kind: "mode", payload: { mode } }, cfg)).state;
  const st = await store;
  const intent = await st.activeIntent();
  if (intent && isExpired(intent, ts, ts, cfg)) {
    await st.putIntent({ ...intent, expiredAt: ts });
    await summarizeEnded();
  } else if (intent) {
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
  if (s.mode === "off" && !["session", "response", "agent"].includes(input.type)) return s;

  // A goal left over from yesterday (or hours ago) becomes an open loop.
  if (input.type === "context" && s.intent) {
    const intent = await (await store).activeIntent();
    if (intent && isExpired(intent, input.ts, s.lastActiveTs ?? input.ts, cfg)) {
      await (await store).putIntent({ ...intent, expiredAt: input.ts });
      const done = { type: "session", ts: input.ts, kind: "intent_done", payload: { id: intent.id, expired: true } };
      s = (await apply(s, done, cfg)).state;
      await summarizeEnded();
    }
  }
  return (await apply(s, input, cfg)).state;
}

async function apply(s, input, cfg) {
  if (input.type === "agent") await chrome.storage.session.remove("agentWordToSay"); // old news now
  const r = step(s, input, cfg);
  await saveEngine(r.state);
  if (r.state.sessionDay !== s.sessionDay) await chrome.storage.local.set({ sessionDay: r.state.sessionDay });
  await log(input); // ticks too: replay tells sleep from a long stay by them
  // Tucked away, a page switched to lets go of a Tuck left there; a word drawn below comes back.
  if (input.type === "context" && pageChanged(s, r.state) && (await isAway()))
    await chrome.tabs.sendMessage(input.tabId, { type: "tuck-hide" }).catch(() => {});
  for (const o of r.out) {
    if (o.type === "need_relevance") askRelevance(o);
    else if (o.type === "read_ahead") readAhead(o);
    else if (o.type === "need_second_look") secondLook(o);
    else {
      await log(o);
      if (o.type === "trigger") await showTrigger(o, r.state);
      if (o.type === "agent_resumed") await agentResumed(o.ts);
      // Tuck's words take the model a few seconds: start writing them before they are needed.
      if (o.type === "state" && o.to === "detour") draftNudge(r.state, 1, cfg);
      if (o.type === "trigger" && o.kind === "drift" && o.level >= 1 && !o.suppressedBy)
        draftNudge(r.state, o.level + 1, cfg);
      if (o.type === "state" && ["focused", "no_intent", "paused", "agent_working"].includes(o.to))
        await setBadge(null);
      // Back on a work page before answering (a new tab or a search is not back yet).
      const backAtWork = o.type === "state" && o.to === "focused" && ENDS_DETOUR.includes(r.state.current?.label);
      if (backAtWork && ["detour", "drifting", "agent_working"].includes(o.from)) await selfReturn(o.ts);
      // Waiting for the agent now: a word about drifting no longer holds.
      if (o.type === "state" && o.to === "agent_working" && o.from !== "agent_working") await selfReturn(o.ts);
    }
  }
  if (input.type === "context") await presence(s, r.state, input);
  await restingPoseChanged(s, r.state);
  if (input.type === "context" && !r.state.intent && !["dnd", "off"].includes(r.state.mode)) {
    const { pendingGreeting } = await chrome.storage.session.get("pendingGreeting");
    if (pendingGreeting) await greet(input.tabId);
  }
  if (input.type === "context" && !r.state.away) await sayHeldAgentWord(input.tabId, r.state);
  scheduleWake(r.state, cfg);
  return r;
}

const feed = (input) => enqueue(() => process(input));
const tick = () => feed({ type: "tick", ts: Date.now() });

// A coding agent's status, from the local bridge (bridge/host.mjs), when one is installed.
const AGENT_STATUS = ["working", "waiting_for_user", "completed", "failed", "unknown"];
// What the bridge knows of the turn (#67): the folder's name, minutes since its prompt by
// the bridge's own clock, and the tool an approval is for.
const agentFacts = ({ folder, startedAt, ts, tool }) => ({
  ...(typeof folder === "string" && folder && { folder: folder.slice(0, 64) }),
  ...(Number.isFinite(startedAt) &&
    Number.isFinite(ts) &&
    ts >= startedAt && {
      minutes: Math.round((ts - startedAt) / 60000),
    }),
  ...(typeof tool === "string" && tool && { tool: tool.slice(0, 64) }),
});
function agentStatus(line) {
  const { status, session, preview } = line;
  // A turn's end is news even when the status repeats, and is said as finished (not waiting).
  const done = !!line.turnEnd;
  if (!AGENT_STATUS.includes(status)) return null;
  // A turn's end the bridge still holds: write its word now, say it when it comes.
  if (preview) return void draftAgentWord({ status, session, done, ...agentFacts(line) }, false);
  return feed({ type: "agent", ts: Date.now(), status, session, ...(done && { turnEnd: true }), ...agentFacts(line) });
}
let bridge = null;
function connectBridge() {
  if (bridge) return;
  try {
    bridge = chrome.runtime.connectNative("com.tuck.bridge");
    bridge.onMessage.addListener(agentStatus);
    bridge.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // no host installed: nothing changes
      bridge = null;
    });
  } catch {
    bridge = null;
  }
}
connectBridge();

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
  const surface = await surfaceOf(tab.id, url, flags, cfg);
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
// frozen) must not hold it up: it then counts as a page, and the second look keeps what
// it reads in a chat away from that page (judgeExcerpt).
const PLAIN_PAGE = { kind: "page", labels: [] };
async function surfaceOf(tabId, url, { browserFocused }, cfg) {
  if (!url || !browserFocused || !mayRead(url, await readingNow())) return PLAIN_PAGE;
  // Installed here, not when Tuck appears: a reload wipes it with the tab and URL unchanged.
  const look = inPage(tabId, watchRegion).then(() => inPage(tabId, readRegion));
  const region = await Promise.race([look, sleep(cfg.regionWaitMs).then(() => "late")]);
  // Too late to tell: judged as the page, and marked so the log shows it (#38).
  if (region === "late") return { ...PLAIN_PAGE, late: true };
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
        ENDS_DETOUR.includes(look?.label) &&
        look.confidence >= cfg.unsureConfidence &&
        now - look.ts < cfg.lookHoldMin * 60000
      )
        return { label: look.label, confidence: look.confidence, source: "look" };
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
const COMMITMENTS_SENT = 5; // the most urgent, by the to-do list's own order
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

// What a relevance call was given, as counts: the log can say why a page was judged as it
// was, but keeps none of the notes, profile or to-do titles themselves.
function sentCounts(input) {
  return {
    examples: input.examples?.length ?? 0,
    notes: input.notes.length,
    profile: Boolean(input.profile),
    conversation: Boolean(input.conversationWith),
    commitments: input.commitments.length,
  };
}

// What else is on the to-do list: time on a page for one of these is not drift.
// The goal itself is left out by id where it came from the list, else by title. A failed
// read sends no list: the page is still judged.
async function otherCommitments(intent) {
  const open = await Promise.all([toDo(), loadLoops()]).then(
    ([todo, loops]) => stillOpen(todo, loops),
    () => [],
  );
  return open
    .filter((e) => e.id !== intent.fromLoopId && !e.members?.includes(intent.fromLoopId) && e.title !== intent.title)
    .slice(0, COMMITMENTS_SENT)
    .map((e) => redact(e.title).text);
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
  let input;
  let r;
  try {
    input = {
      intent,
      url: need.url,
      title: need.title,
      examples,
      profile: await (await memory).profile().catch(() => null),
      notes: await notesFor(need.url, need.title, need.surface),
      conversationWith: need.surface?.labels?.[0],
      commitments: await otherCommitments(intent),
    };
    r = await classifyRelevance(modelClient(used), input);
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
    ...(input && { sent: sentCounts(input) }),
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
    .then((v) => ENDS_DETOUR.includes(v.label) && feed({ type: "second_look", ts: Date.now(), key: need.key, ...v }))
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
// field the person types in) or "view" (the conversation last touched, else the middle of
// the window). A verdict counts for cfg.lookHoldMin minutes, so a page is not read again
// on every drift word.
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
  // A verdict counts only where it was read. A chat read while the engine has the page in
  // front (the region read ran out), or the page read while it has the chat, says nothing
  // of what is in front: neither kept nor given to it, so a chat never makes a feed work (#38).
  if ((page.from === "conversation") !== (need.surface?.kind === "conversation")) return { skipped: "elsewhere" };
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
  const input = {
    intent,
    url: need.url,
    title: need.title,
    profile,
    excerpt: text,
    notes: await notesFor(need.url, need.title, need.surface),
    conversationWith: need.surface?.labels?.[0],
    commitments: await otherCommitments(intent),
  };
  const r = await classifyRelevance(complete, input);
  await log({
    type: "llm",
    ts: Date.now(),
    node: "secondLook",
    model: settings.model ?? settings.provider ?? null,
    latencyMs: r.latencyMs,
    ok: r.source === "llm",
    chars: text.length, // the size only: neither the text nor the model's reason, which may retell it
    redactions: count,
    sent: sentCounts(input),
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
  // Tuck away: only a drift, the agent's word and the greeting come. A reminder that would
  // have ridden on the others waits for the next visible moment.
  if ((await isAway()) && !comesWhileAway(t.kind)) {
    await log({ type: "feedback", ts: Date.now(), kind: "away_held", payload: { trigger: t.kind } });
    return;
  }
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
  const drawn = await showTuck(s.current?.tabId, view);
  if (t.kind === "agent" && !drawn) await chrome.storage.session.set({ agentWordToSay: view });
}

// An agent's word comes once, so one that met a page Tuck cannot draw on (a new tab, the
// Web Store) waits for the next page it can.
async function sayHeldAgentWord(tabId, s) {
  const { agentWordToSay: view } = await chrome.storage.session.get("agentWordToSay");
  if (!view || ["dnd", "off"].includes(s.mode) || s.state === "break") return;
  const { lastTrigger } = await chrome.storage.local.get("lastTrigger");
  const answered = lastTrigger?.respondedAt || lastTrigger?.resolvedAt;
  if (answered || (await showTuck(tabId, view))) await chrome.storage.session.remove("agentWordToSay");
}

// Shows Tuck with the most urgent thing worth a word, if any. It counts as said only
// once it is on screen. Returns whether Tuck was shown.
async function showWithReminder(tabId, view, goalTitle) {
  const today = localDate();
  const { mode } = await loadEngine();
  const quiet = mode === "dnd" || mode === "off";
  const item =
    view?.bubble && !quiet ? pickReminder(await toDo(today), { goalTitle, loops: await loadLoops(), today }) : null;
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

// On it: nothing more today, already noted when it was said. Done stays done, and so does
// Not a task (from settings), for every entry in the row. Not the same (from settings):
// the row's entries are listed apart from now on. Switch: it becomes the goal.
async function reminderAnswer({ id, title, choice }, sender) {
  await log({ type: "feedback", ts: Date.now(), kind: "reminder", payload: { id, choice } });
  const row = choice === "switch" ? null : await rowOf(id);
  if (choice === "done") await saveLoops(markAll(markDone, await loadLoops(), row, Date.now()));
  if (choice === "not_task") await saveLoops(markAll(markNotTask, await loadLoops(), row, Date.now()));
  if (choice === "not_same") {
    const { taskSplits = {} } = await chrome.storage.local.get("taskSplits");
    await chrome.storage.local.set({ taskSplits: splitRow(taskSplits, row, Date.now()) });
  }
  // Off the list now: a page judged as that commitment is judged again.
  if (choice === "done" || choice === "not_task") await memoryChanged();
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

// Tuck's words about Muse (#67). The model takes 6 to 15 s a line (live, low effort), and
// waiting for it in the queue held every other input back, so a word is the model's only
// if its line is ready when the word is due; otherwise the template is said at once. Lines
// are written ahead where the moment is known: a turn's end while the bridge holds it, and
// the ask again once the first wait is said.
const agentDrafts = new Map(); // key → { message }
const agentKey = (a, again) =>
  JSON.stringify([a.session ?? null, a.status, !!a.done, a.folder ?? null, a.minutes ?? null, a.tool ?? null, again]);

function draftAgentWord(facts, again) {
  const key = agentKey(facts, again);
  if (agentDrafts.has(key)) return;
  const draft = { message: null };
  agentDrafts.set(key, draft);
  if (agentDrafts.size > 8) agentDrafts.delete(agentDrafts.keys().next().value);
  writeAgentWord(facts, again).then(
    (message) => (draft.message = message),
    (err) => log({ type: "llm", ts: Date.now(), node: "composeNudge", kind: "agent", ok: false, error: String(err) }),
  );
}

async function writeAgentWord({ status, done, folder, minutes, tool }, again) {
  const settings = await loadModelSettings();
  if (!settings) return null;
  const intent = await (await store).activeIntent();
  const s = await loadEngine();
  const used = privateSettings(settings);
  const r = await composeNudge(
    modelClient(used),
    {
      kind: "agent",
      agent: { status, done: !!done, folder, minutes, tool: tool && toolKind(tool), again },
      task: intent ? { title: intent.title, step: intent.steps?.[0] } : undefined,
      onWork: s.current ? s.current.label === "related" : undefined,
      hour: new Date().getHours(),
      today: todayLabel(),
    },
    { effort: "low" },
  );
  await log({
    type: "llm",
    ts: Date.now(),
    node: "composeNudge",
    kind: "agent",
    model: used.model ?? used.provider ?? null,
    latencyMs: r.latencyMs,
    ok: r.source === "llm",
    ...(r.error && { error: r.error }),
    ...(r.message && { message: r.message }),
  });
  return r.message;
}

// The model's line if it is ready now, else null and the template.
function agentWord(t, s) {
  const a = s.agent ?? {};
  const again = !!t.evidence?.agentAgain;
  // Asking again is only for a wait in the middle of a turn, never after it ended.
  if (a.status === "waiting_for_user" && !again && !a.done) draftAgentWord(a, true);
  return agentDrafts.get(agentKey(a, again))?.message ?? null;
}

// The drafted line, if it was written for this very nudge.
async function draftFor(t, s) {
  if (t.kind === "agent") return agentWord(t, s);
  if (t.kind !== "drift") return null;
  const { nudgeDraft: d } = await chrome.storage.session.get("nudgeDraft");
  const unsure = !!t.evidence?.unsure;
  return d && d.key === s.current?.key && d.level === t.level && d.unsure === unsure ? d.message : null;
}

// ---- Tuck on the page ----------------------------------------------------

// The chosen skin (src/tuck/skins/<id>/) and what Tuck wears or carries in it.
const tuckAssets = new Map();
async function assets() {
  const { DEFAULT_SKIN, loadSkin } = globalThis.tuckSkins;
  const { tuckSkin, tuckItem, tuckMotion } = await chrome.storage.local.get({
    tuckSkin: DEFAULT_SKIN,
    tuckItem: "bandana",
    tuckMotion: "system",
  });
  const load = async (id) => {
    if (!tuckAssets.has(id)) {
      const url = (file) => chrome.runtime.getURL(`tuck/skins/${id}/${file}`);
      tuckAssets.set(id, await loadSkin(async (file) => (await fetch(url(file))).text(), url));
    }
    return tuckAssets.get(id);
  };
  // A skin that is no longer there must not keep Tuck off every page.
  const skin = await load(tuckSkin).catch(() => load(DEFAULT_SKIN));
  // readAt: a page keeps the newest look it was sent; a word drawn with assets read before
  // a look change must not put the old skin back (overlay ensureRoot).
  return { ...skin, item: tuckItem, motion: tuckMotion, readAt: Date.now() };
}

// The person picked another look in settings: Tuck on the page changes in place (a word on
// screen stays; a Tuck tucked away stays away), and the toolbar icon is the skin's.
async function lookChanged() {
  const a = await assets();
  // Every tab that holds Tuck changes, not only the last one drawn on; a tab without the
  // overlay has nobody listening and the message is dropped.
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: "tuck-look", assets: a }).catch(() => {})));
  const path = Object.fromEntries([16, 32, 48, 128].map((n) => [n, `tuck/skins/${a.manifest.id}/icons/${n}.png`]));
  await chrome.action.setIcon({ path }).catch(() => {});
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.tuckSkin || changes.tuckItem || changes.tuckMotion)) lookChanged();
});
chrome.runtime.onStartup.addListener(lookChanged);
chrome.runtime.onInstalled.addListener(lookChanged);

// Draw a view (present.js) in a tab. False when Chrome does not allow it there
// (chrome:// pages, the Web Store, this extension's own pages).
async function showTuck(tabId, view) {
  if (tabId == null || !view) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["tuck/layout.js", "tuck/skins.js", "tuck/overlay.js"],
    });
    await chrome.tabs.sendMessage(tabId, { type: "tuck-show", view, assets: await assets() });
    await chrome.storage.session.set({ tuckTab: tabId });
    return true;
  } catch {
    return false;
  }
}

// The person tucked Tuck away (card or popup button); Bring Tuck back in the popup undoes it.
const isAway = async () => (await chrome.storage.local.get({ tuckAway: false })).tuckAway === true;

async function hideTuck(type = "tuck-hide") {
  const { tuckTab } = await chrome.storage.session.get("tuckTab");
  if (tuckTab != null) await chrome.tabs.sendMessage(tuckTab, { type }).catch(() => {});
}
// Close the bubble and settle back to resting, staying on the page.
const restTuck = () => hideTuck("tuck-rest");

// Tuck's pose on the page while it has nothing to say: it rests, works while the coding
// agent does, sleeps on a break. Null: not on the page (no goal, paused or off).
function restingView(s) {
  if (!s.intent || s.state === "paused") return null;
  if (s.state === "break") return present({ event: "break" });
  return present({ event: "presence", agent: s.agent?.status });
}

// With no goal, Tuck greets on each new page with the goal form, as on the day's first
// page; closed without a goal, it rests there quietly for a while and a click opens the form.
const GOAL_FORM_SNOOZE_MS = 10 * 60 * 1000;
async function noGoalView(s) {
  if (s.intent || s.state === "paused") return null;
  const { goalFormClosedAt, greeted, pendingGreeting } = await chrome.storage.session.get([
    "goalFormClosedAt",
    "greeted",
    "pendingGreeting",
  ]);
  // The day's greeting is waiting for this page (greet runs right after): it is the form.
  if (pendingGreeting) return null;
  // The day's greeting was just drawn on this page: it is the goal form already.
  if (greeted?.tabId === s.current?.tabId && Date.now() - greeted.at < 5000) return null;
  if (goalFormClosedAt && Date.now() - goalFormClosedAt < GOAL_FORM_SNOOZE_MS)
    return present({ event: "presence", agent: s.agent?.status });
  // The same greeting as the day's first page (with how the last goal went, #46).
  return { greet: true };
}

const pageChanged = (prev, s) => prev.current?.tabId !== s.current?.tabId || prev.current?.url !== s.current?.url;

// Back from tucked away (Bring Tuck back in the popup): Tuck is on the page in front at
// once, as presence would draw it there.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || changes.tuckAway?.newValue !== false || changes.tuckAway.oldValue !== true) return;
  enqueue(async () => {
    const s = await loadEngine();
    const view = restingView(s);
    if (view && s.current?.url) await showTuck(s.current.tabId, view);
  });
});

// While there is a goal, Tuck is on every page (not paused or off), asleep on a break.
async function presence(prev, s, input) {
  if (!s.current?.url || (await isAway())) return;
  const changed = pageChanged(prev, s);
  const view = restingView(s) ?? (await noGoalView(s));
  // A reload keeps the tab and URL but wipes Tuck from the page: it comes back at once,
  // where it was. A page that cannot be scripted answers null, not false.
  const reloaded = !changed && view && (await inPage(input.tabId, tuckThere)) === false;
  if (!changed && !reloaded) return;
  // Typing is noted from the start of the page (its time only), for the second look.
  if (view && s.state !== "break") await inPage(input.tabId, watchTyping);
  if (view?.greet) await greet(input.tabId);
  else if (view) await showTuck(input.tabId, { ...view, ...(reloaded && { instant: true }) });
  else if (s.state === "paused") await chrome.tabs.sendMessage(input.tabId, { type: "tuck-hide" }).catch(() => {});
}

// The agent started or stopped working, or a break began or ended with nothing to say:
// the Tuck on the page changes pose quietly (no bubble, no entrance; a word on screen stays).
async function restingPoseChanged(prev, s) {
  const [was, now] = [restingView(prev), restingView(s)];
  if (!was || !now || was.pose === now.pose || (await isAway())) return;
  const { tuckTab } = await chrome.storage.session.get("tuckTab");
  await showTuck(tuckTab, now);
}

// The day's greeting with the goal form. If the first page cannot hold Tuck (a new
// tab, settings), the greeting waits for the next page that can.
async function greet(tabId) {
  // A new day starts with Tuck visible.
  await chrome.storage.local.set({ tuckAway: false });
  const st = await store;
  const expired = await st.latestIntent();
  // The goal form offers what is running out first. The title stays exactly as it is
  // stored: tapping the chip sends it straight to set-intent, so a "(tomorrow)" glued
  // on here would become part of the goal, change its topic slug every day, and could
  // push a long title past the 120-character limit an entry validates against.
  const loops = [
    ...(expired?.expiredAt && !expired.doneAt ? [{ title: expired.title }] : []),
    ...stillOpen(await toDo(), await loadLoops()).map((e) => ({ title: e.title })),
  ];
  const message = await lastTimeLine();
  const view = present({ trigger: { kind: "session_start", level: 2, id: "greeting", message }, loops });
  const shown = await showWithReminder(tabId, view, expired?.expiredAt && !expired.doneAt ? expired.title : null);
  await chrome.storage.session.set({ pendingGreeting: !shown, ...(shown && { greeted: { tabId, at: Date.now() } }) });
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
    const agent = s.agent?.status;
    // Tuck came for this word alone: it leaves with the answer.
    if (await isAway()) await hideTuck();
    else if (choice === "related") await showTuck(before.current?.tabId, present({ event: "resolved", agent }));
    // A break or "Take me back" closes the word first: their pose is quiet, or comes after it.
    else if (choice === "break") (await restTuck(), await showTuck(before.current?.tabId, present({ event: "break" })));
    else if (choice === "back")
      (await restTuck(), await showTuck(before.current?.tabId, present({ event: "back", agent })));
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
  if (await isAway()) await hideTuck();
  else {
    await restTuck();
    const s = await loadEngine();
    await showTuck(s.current?.tabId, present({ event: "resolved", agent: s.agent?.status }));
  }
  await log({
    type: "feedback",
    ts,
    kind: "self_return",
    payload: { triggerId: lastTrigger.id, afterMs: ts - lastTrigger.ts },
  });
}

// Muse works again: the person answered it in the terminal, so its waiting word is over
// (#66). A word since about something else stays.
async function agentResumed(ts) {
  const { lastTrigger } = await chrome.storage.local.get("lastTrigger");
  if (lastTrigger?.kind !== "agent" || lastTrigger.evidence?.agent !== "waiting_for_user") return;
  if (lastTrigger.respondedAt || lastTrigger.resolvedAt) return;
  await chrome.storage.local.set({ lastTrigger: { ...lastTrigger, resolvedAt: ts, resolvedBy: "agent" } });
  await setBadge(null);
  await restTuck();
  await log({
    type: "feedback",
    ts,
    kind: "agent_resumed",
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
  // Shown in settings, where a label can be forgotten. The memory entry it wrote, if any,
  // goes with it (Forget).
  const stored = {
    ...label,
    ...(chat && { who: page.surface.labels?.[0] }),
    ...(prev?.label === "related" && prev.memoryEntry && { memoryEntry: prev.memoryEntry }),
  };
  await st.putLabel(stored);
  await log({ type: "feedback", ts, kind: "label", payload: label });
  if (verdict !== "related") return;
  if (key !== noKey) await st.deleteLabel(noKey); // a yes takes back an earlier no
  const lastedBefore = prev?.label === "related" && prev.days && prev.until == null;
  if (label.until != null || lastedBefore) return;
  const entry = await (
    await memory
  ).add({
    kind: "preference",
    topic: intent.topic,
    title: preferenceTitle({ topic: intent.topic, host: page.host, chat, who: stored.who }),
    context: "Marked by the user from a nudge.",
    result: "related",
  });
  await st.putLabel({ ...stored, memoryEntry: { id: entry.id, key: entryKey(entry) } });
}

// What a lasting "This is for my task" says in memory. One person's answer says nothing
// of the rest of the site.
const preferenceTitle = ({ topic, host, chat, who }) =>
  `${chat ? `Conversations with ${who ?? "this person"} on ${host} count` : `${host} counts`} as work for ${topic}`.slice(
    0,
    120,
  );

// Forget on a label also takes back the preference it wrote, so notesFor stops sending it
// to the model. A label from before the entry was kept on it is matched by its title.
// Returns whether an entry was removed.
async function forgetPreference(label) {
  if (label?.label !== "related") return false;
  const m = await memory;
  if (label.memoryEntry) return (await m.remove(label.memoryEntry.id, { key: label.memoryEntry.key })).removed > 0;
  const title = preferenceTitle({ ...label, chat: label.surface === "conversation" });
  const hits = (await m.recall(title, { limit: 20 })).filter(
    (h) => h.item.kind === "preference" && h.item.topic === label.topic && h.item.title === title,
  );
  let removed = 0;
  for (const h of hits) removed += (await m.remove(h.item.id)).removed;
  return removed > 0;
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

// Which open loops are real tasks (LLM#6), at re-sync. Only new or changed entries cost a
// call; the settings page runs the same step after its own imports.
async function refreshTaskList() {
  const settings = await loadModelSettings();
  if (!settings) return { source: "no-model" };
  const used = privateSettings(settings);
  const started = Date.now();
  const r = await refreshTasks(modelClient(used), {
    memory: await memory,
    storage: chrome.storage.local,
    today: localDate(),
    clean: (text) => redact(text).text,
  });
  await log({
    type: "llm",
    ts: Date.now(),
    node: "extractTasks",
    model: used.model ?? used.provider ?? null,
    latencyMs: Date.now() - started,
    ok: r.failed === 0,
    ...(r.errors.length && { error: r.errors.join(" | ") }),
  });
  return r;
}

// ---- How a goal went (#46) -----------------------------------------------

// A goal that ended (done, replaced or run out) gets one entry in memory about its day
// (attention/summary.js), and the next greeting's line is drafted. Runs inside the queue.
async function summarizeEnded() {
  const st = await store;
  const cfg = await config();
  for (const intent of await st.endedIntents()) {
    const sum = daySummary(await st.eventsSince(intent.createdAt), intent, cfg);
    await st.putIntent({ ...intent, summarizedAt: Date.now() });
    if (!sum) continue;
    await (await memory).add(summaryEntry(sum)).catch(() => {});
    // The last page's title stays out of what is kept: the line below is made from it now.
    const { lastWork: _, ...lastDay } = sum;
    await chrome.storage.local.set({ lastDay });
    draftGreeting(sum);
  }
}

// The greeting's words for how the last goal summed up went: the model's line when it
// was ready, else the template, from the same facts.
async function lastTimeLine() {
  const { lastDay, greetingLine } = await chrome.storage.local.get(["lastDay", "greetingLine"]);
  if (!lastDay) return null;
  if (greetingLine?.intentId === lastDay.intentId) return greetingLine.message;
  return templateGreeting(lastDay, whenSaid(lastDay.date, dayKey(Date.now(), await config())));
}

// Written when the goal ends, so the greeting never waits for the model. Outside the
// queue; a failure leaves the template.
function draftGreeting(sum) {
  writeGreeting(sum).catch((err) =>
    log({ type: "llm", ts: Date.now(), node: "composeNudge", ok: false, error: String(err) }),
  );
}

async function writeGreeting(sum) {
  const settings = await loadModelSettings();
  if (!settings) return;
  const used = privateSettings(settings);
  const r = await composeNudge(modelClient(used), {
    kind: "session_start",
    task: { title: sum.goal },
    last: { onGoalMin: sum.onGoalMin, finished: sum.finished, site: sum.site && siteName(sum.site) },
    lastWork: sum.lastWork,
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
  if (r.message) await chrome.storage.local.set({ greetingLine: { intentId: sum.intentId, message: r.message } });
}

// ---- The agent loop (#81) ------------------------------------------------

// At a moment the engine or the person chose, the model looks things up with the tools in
// agent/tools.js and proposes words, a plan or a step (agent/moments.js). Always outside
// the queue: no moment waits for it (#67). Only a short write of what it found goes in.

const ACTIVITY_MIN = 30;

// The pages of the last ACTIVITY_MIN minutes, newest first, with what each was judged.
async function recentPages() {
  const events = await (await store).eventsSince(Date.now() - ACTIVITY_MIN * 60000);
  const labels = new Map(events.filter((e) => e.type === "relevance").map((e) => [e.key, e.label]));
  const seen = new Set();
  const pages = [];
  for (const e of events.reverse()) {
    if (e.type !== "context" || !e.title || seen.has(e.title)) continue;
    seen.add(e.title);
    pages.push({
      title: redact(e.title).text,
      host: e.host,
      label: e.label ?? labels.get(e.key) ?? "unknown",
      minutesAgo: Math.round((Date.now() - e.ts) / 60000),
    });
  }
  return pages;
}

// The last work page's excerpt, as the second look reads it: never on the never-read
// sites or a page with a password field, and only where the tab still shows that page.
async function lastWorkExcerpt() {
  const last = (await loadEngine()).lastRelevant;
  if (!last) return { skipped: "no work page yet" };
  if (!mayRead(last.url, await readingNow())) return { skipped: "settings" };
  const tab = await chrome.tabs.get(last.tabId).catch(() => null);
  if (!tab || !sameDocument(tab.url, last.url)) return { skipped: "closed" };
  const page = await inPage(last.tabId, readExcerpt, [last.url, EXCERPT_CHARS, EXCERPT_MIN_CHARS, false]);
  if (!page) return { skipped: "unreadable" };
  if (page.password) return { skipped: "password" };
  return { title: redact(last.title ?? "").text, excerpt: redact(page.text).text };
}

// What the agent's read tools see, through code that already exists.
function agentDeps(intent) {
  return {
    recall: async (query) =>
      (await (await memory).recall(query, { limit: NOTES_SEARCHED }).catch(() => []))
        // Tuck's own records (goals and how their days went, topic "focus") are not the
        // person's notes. Each is dated by the person's day (agent/notes.js, #90).
        .filter((h) => h.item && h.item.topic !== "focus")
        .slice(0, 5)
        .map((h) => noteOf(h)),
    tasks: async () =>
      stillOpen(await toDo(), await loadLoops())
        .filter((e) => e.id && e.title !== intent?.title)
        .map((e) => ({
          id: e.id,
          title: redact(e.title).text,
          when: e.daysLeft != null ? dueLabel(e.daysLeft) : null,
        })),
    activity: recentPages,
    page: lastWorkExcerpt,
    goal: async () => {
      const i = (await (await store).activeIntent()) ?? intent;
      return i ? { title: i.title, step: i.steps?.[0] ?? null, plan: i.plan?.steps?.map((s) => s.step) ?? null } : null;
    },
  };
}

// The model, through privateSettings: the agent reads the person's notes (AGENTS rule 5).
async function agentChat() {
  const settings = await loadModelSettings();
  if (!settings) return null;
  const used = privateSettings(settings);
  try {
    return { chat: toolClient(used), model: used.model ?? used.provider ?? null };
  } catch {
    return null;
  }
}

// One record per run: the tools it called, with short arguments and results, never a
// note's text. Settings shows these as "What Tuck looked at".
const logRun = (moment, r, model, said) =>
  log({
    type: "agent",
    ts: Date.now(),
    moment,
    model,
    source: r.source,
    steps: r.steps,
    latencyMs: r.latencyMs,
    trail: r.trail,
    ...(said && { said }),
    ...(r.error && { error: r.error }),
  });

// #78: a plan for the goal just set, from the person's notes. Its first step becomes the
// goal's step unless the person gave one, so drift words say "Next up: <step>".
function planAhead(intent) {
  writePlan(intent).catch((err) =>
    log({ type: "agent", ts: Date.now(), moment: "plan", source: "fallback", error: String(err) }),
  );
}

async function writePlan(intent) {
  const agent = await agentChat();
  if (!agent) return;
  const r = await planFor(agent.chat, agentDeps(intent), { title: intent.title });
  await logRun("plan", r, agent.model, r.value && r.value.steps.map((s) => s.step));
  if (!r.value) return;
  // The goal may have ended or changed while the model worked.
  await enqueue(async () => {
    const st = await store;
    const now = await st.activeIntent();
    if (now?.id !== intent.id) return;
    await st.putIntent({ ...now, plan: r.value, steps: now.steps?.length ? now.steps : [r.value.steps[0].step] });
  });
}

// #61: one small next step, asked for by the person ("I'm stuck"). It may take the model
// a few seconds; the template answers when there is no model or the loop finds nothing.
// Returns {step, minutes, source}.
async function stuck() {
  const st = await store;
  const intent = await st.activeIntent();
  if (!intent) return { ok: false, reason: "no goal" };
  const last = (await loadEngine()).lastRelevant;
  const template = { step: stuckTemplate(last?.title, intent.title), minutes: 10, source: "template" };
  const agent = await agentChat();
  if (!agent) return { ok: true, ...template };
  const r = await stuckStep(agent.chat, agentDeps(intent), { title: intent.title, step: intent.steps?.[0] });
  await logRun("stuck", r, agent.model, r.value?.step);
  return r.value ? { ok: true, ...r.value, source: "agent" } : { ok: true, ...template };
}

// "Open cart.js · acme/shop and do one line of it", at most 12 words.
function stuckTemplate(lastTitle, goal) {
  const short = (t, n) => t.split(/\s+/).slice(0, n).join(" ");
  return lastTitle ? `Open ${short(lastTitle, 4)} and do one line of it` : `Do one small piece of ${short(goal, 6)}`;
}

// "Start this": the step becomes the goal's next step, and the person goes back to work.
async function startStep({ step }) {
  const text = String(step ?? "")
    .trim()
    .slice(0, 200);
  if (!text) return { ok: false };
  const s = await enqueue(async () => {
    const st = await store;
    const intent = await st.activeIntent();
    if (intent) await st.putIntent({ ...intent, steps: [text, ...(intent.steps ?? []).filter((x) => x !== text)] });
    await log({ type: "feedback", ts: Date.now(), kind: "stuck_start", payload: { intentId: intent?.id ?? null } });
    return loadEngine();
  });
  await restTuck();
  if (s.lastRelevant) await takeMeBack(s.lastRelevant);
  return { ok: true };
}

// What to say when the goal is done, drafted while the person works on it: at Done the
// line is used only if it is ready, and its task only if still open. Nothing waits for it
// and nothing is redrawn later, so a goal being typed in the form is never wiped (#67).
const nextDrafts = new Map(); // intent id → {message, task}

function nextAhead(intent) {
  writeNext(intent).catch((err) =>
    log({ type: "agent", ts: Date.now(), moment: "next", source: "fallback", error: String(err) }),
  );
}

async function writeNext(intent) {
  const agent = await agentChat();
  if (!agent) return;
  const r = await nextAfter(agent.chat, agentDeps(intent), { title: intent.title });
  await logRun("next", r, agent.model, r.value?.message);
  if (!r.value) return;
  nextDrafts.set(intent.id, r.value);
  if (nextDrafts.size > 4) nextDrafts.delete(nextDrafts.keys().next().value);
}

// The goal-done view: the agent's line and task when drafted, else the template.
async function goalDoneView(intent) {
  const view = present({ event: "goal_done" });
  const next = nextDrafts.get(intent.id);
  if (!next) return view;
  const open = next.task && stillOpen(await toDo(), await loadLoops()).some((e) => e.id === next.task.id);
  return {
    ...view,
    bubble: { ...view.bubble, text: next.message, ...(open && { pickUp: [next.task.title] }) },
  };
}

// ---- Goals and modes -----------------------------------------------------

async function setIntent({ title, next, from, fromLoopId }, sender) {
  const intent = await enqueue(async () => {
    const st = await store;
    const previous = await st.activeIntent();
    if (previous) {
      await st.putIntent({ ...previous, doneAt: Date.now(), replaced: true });
      await summarizeEnded();
    }
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
    // The greeting's goal form can come while Tuck is away; the "Got it" note does not.
    if (from === "tuck" && (await isAway())) await hideTuck();
    else if (from === "tuck")
      await showTuck(sender?.tab?.id, present({ event: "goal_set", agent: (await loadEngine()).agent?.status }));
    return intent;
  });
  // After the queue: the goal is set; the plan and the word for its end come when they come.
  planAhead(intent);
  nextAhead(intent);
  return intent;
}

async function completeIntent() {
  return enqueue(async () => {
    const st = await store;
    const intent = await st.activeIntent();
    if (!intent) return null;
    if (intent.memoryEntryId) await (await memory).completeIntent(intent.memoryEntryId).catch(() => {});
    await st.putIntent({ ...intent, doneAt: Date.now() });
    if (intent.fromLoopId)
      await saveLoops(markAll(markDone, await loadLoops(), await rowOf(intent.fromLoopId), Date.now()));
    await process({ type: "session", ts: Date.now(), kind: "intent_done", payload: { id: intent.id } });
    await summarizeEnded();
    // Tuck asks what's next, on the page in front, in the agent's words when they are ready,
    // unless it is tucked away.
    if (await isAway()) await hideTuck();
    else await showWithReminder((await loadEngine()).current?.tabId, await goalDoneView(intent), intent.title);
    return intent;
  });
}

const setMode = ({ mode }) =>
  enqueue(async () => {
    const quiet = (m) => m === "dnd" || m === "off";
    const { mode: was } = await chrome.storage.local.get({ mode: "focus" });
    await chrome.storage.local.set({ mode });
    if (quiet(mode)) await hideTuck();
    const s = await process({ type: "session", ts: Date.now(), kind: "mode", payload: { mode } });
    // Switched on with no goal: Tuck asks for one now. The day's greeting may have passed
    // unseen while it was off; a page that cannot hold Tuck passes it to the next one.
    if (quiet(was) && !quiet(mode) && !s.intent) await greet(s.current?.tabId);
    return s;
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
  // Clicking Tuck with no nudge: the goal card (or the goal form when there is none). A
  // Tuck still on a page while tucked away just leaves.
  "tuck-click": async (_msg, sender) =>
    (await isAway())
      ? chrome.tabs.sendMessage(sender?.tab?.id, { type: "tuck-hide" }).catch(() => {})
      : showTuck(sender?.tab?.id, present({ event: "card", intent: await (await store).activeIntent() })),
  // Every tab lets Tuck go, not just the one in front. From the card, Tuck says how to
  // bring it back and then leaves that page too (the popup's button has its own way back).
  "tuck-away": async (_msg, sender) => {
    await chrome.storage.local.set({ tuckAway: true });
    const from = sender?.tab?.id;
    const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== from);
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: "tuck-hide" }).catch(() => {})));
    if (from != null) await showTuck(from, present({ event: "away" }));
  },
  "goal-form-closed": () => chrome.storage.session.set({ goalFormClosedAt: Date.now() }),
  "tuck-change": async (_msg, sender) => showTuck(sender?.tab?.id, present({ event: "card", intent: null })),
  maintain,
  // The brain, then every other connected folder (read only); none of them asks for
  // permission from here. Returns the brain's result, with the folders' under `folders`.
  "sync-brain": async () => {
    const m = await memory;
    const r = await m.syncBrain();
    const folders = [];
    for (const { origin } of (await m.sources()).filter((x) => x.connected && x.kind !== "brain"))
      folders.push({ origin, ...(await m.syncSource(origin).catch((err) => ({ error: err.message }))) });
    r.folders = folders;
    if ((r.connected && !r.needsPermission) || folders.some((f) => f.entries != null)) {
      await memoryChanged();
      refreshProfile().catch(() => {});
      refreshTaskList().catch(() => {});
    }
    return r;
  },
  "refresh-profile": refreshProfile,
  "reminder-answer": reminderAnswer,
  // The agent (#81): "I'm stuck" asks for one step; "Start this" makes it the next step.
  stuck,
  "start-step": startStep,
  // What Tuck looked at, for settings: the last agent runs, newest first.
  "agent-runs": async () => recentRuns(await (await store).eventsSince(Date.now() - 24 * 3600 * 1000)),
  "agent-status": agentStatus,
  // What Tuck has learned from answers, for settings. Forgetting one has the page in
  // front judged again.
  "get-labels": async () => (await (await store).recentLabels(50)).filter((l) => labelHolds(l, Date.now())),
  "delete-label": async ({ key }) => {
    const st = await store;
    const label = await st.getLabel(key);
    await st.deleteLabel(key);
    // A note left memory: verdicts judged with it are judged again.
    if (await forgetPreference(label)) await memoryChanged();
    else await feed({ type: "session", ts: Date.now(), kind: "memory" });
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

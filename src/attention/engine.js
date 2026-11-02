// The attention engine: a pure reducer over browsing inputs. It keeps the drift
// budget and the state machine, and proposes trigger candidates that the policy
// turns into interventions. No Chrome, no clock: time comes from the inputs, so a
// recorded log replays exactly. Design: docs/superpowers/specs/2026-10-31-attention-agent-design.md §6.1.
import { DEFAULTS } from "./config.js";
import { isUnsure } from "./relevance.js";
import { initialPolicy, decide as policyDecide } from "./policy.js";
import { dayKey } from "./intents.js";

const S = 1000;

export function initialState() {
  return {
    mode: "focus",
    intent: null,
    state: "no_intent",
    budgetSec: 0,
    lastTs: null,
    lastActiveTs: null, // the last input showing the person at the browser
    offTaskSince: null, // when the person last left work for something unrelated
    current: null,
    lastRelevant: null,
    timeline: [],
    away: false,
    awaySince: null,
    breakUntil: null,
    sessionDay: null,
    asked: {},
    lastDriftBudget: null, // the budget at the last drift word: the next needs more time off task
    lastDriftKey: null, // the page the last drift word was about
    waited: {}, // seconds in front per page still waiting for its verdict, by key
    fragFiredTs: null,
    policy: initialPolicy(),
    tolerance: {},
    look: null, // the second look for the next drift word: {key, askedTs, answer}
    lookWaitSince: null, // when the next drift word started waiting for a look
    readAheadKey: null, // the page whose excerpt the background was asked to read ahead
    holds: 0, // holds in this drift because the person was typing
    holdUntil: null,
    holdKey: null, // the page the person was typing on
    agent: null, // a coding agent's status: {status, ts, session}
    agentPending: false, // it stopped while the browser was away: say so on return
  };
}

export function effectiveTolerance(state, cfg = DEFAULTS) {
  const base = state.tolerance[state.current?.host] ?? cfg.toleranceSec;
  return base * (state.mode === "gentle" ? cfg.gentleMultiplier : 1);
}

const labelOf = (current) => (!current || current.pending ? "neutral" : current.label);
const onBreak = (s, ts) => s.breakUntil != null && ts < s.breakUntil;
const agentWorking = (s) => s.agent?.status === "working";
const AGENT_STOPS = ["waiting_for_user", "completed", "failed"];

// The state before modes: what the person is doing.
function coreState(s, ts, cfg) {
  if (!s.intent) return "no_intent";
  if (onBreak(s, ts)) return "break";
  if (s.away) return "away";
  if (labelOf(s.current) === "unrelated") {
    if (agentWorking(s)) return "agent_working"; // waiting for the agent, not drifting from work
    return s.budgetSec >= effectiveTolerance(s, cfg) ? "drifting" : "detour";
  }
  return "focused";
}

function shownState(s, ts, cfg) {
  return s.mode === "dnd" || s.mode === "off" ? "paused" : coreState(s, ts, cfg);
}

function advance(s, dt, cfg) {
  if (!s.intent || s.away || s.mode === "off" || onBreak(s, s.lastTs)) return;
  const label = labelOf(s.current);
  if (label === "unrelated" && !agentWorking(s)) s.budgetSec += dt;
  else if (label === "related") s.budgetSec = Math.max(0, s.budgetSec - dt * cfg.decayRate);
  else if (s.current?.pending && !agentWorking(s)) s.waited[s.current.key] = (s.waited[s.current.key] ?? 0) + dt;
}

function windowStats(s, ts, cfg) {
  const from = ts - cfg.fragWindowSec * S;
  const inWindow = s.timeline.filter((e) => e.ts >= from);
  let unrelatedMs = 0;
  let totalMs = 0;
  s.timeline.forEach((e, i) => {
    const start = Math.max(e.ts, from);
    const end = s.timeline[i + 1]?.ts ?? ts;
    if (end <= start) return;
    totalMs += end - start;
    if (e.label === "unrelated") unrelatedMs += end - start;
  });
  return { switches: inWindow.length, unrelatedShare: totalMs ? unrelatedMs / totalMs : 0 };
}

function evidence(s, ts, cfg) {
  const entered = s.timeline.at(-1)?.ts ?? ts;
  return {
    url: s.current?.url ?? "",
    host: s.current?.host ?? "",
    title: s.current?.title ?? "",
    surface: s.current?.surface ?? null,
    key: s.current?.key ?? null,
    agent: s.agent?.status ?? null,
    dwellSec: Math.round((ts - entered) / S),
    awaySec: s.offTaskSince == null ? 0 : Math.round((ts - s.offTaskSince) / S),
    budgetSec: Math.round(s.budgetSec),
    switches2m: windowStats(s, ts, cfg).switches,
    lastRelevant: s.lastRelevant,
    unsure: s.current ? isUnsure(s.current, cfg) : false,
  };
}

function rememberRelated(s, ts) {
  // A page with no URL (this extension's own pages) is never a place to go back to, nor
  // one that is work only by what its excerpt said (a chat on a feed page), nor a
  // conversation: its URL opens the page around it, not the chat.
  const chat = s.current?.surface?.kind === "conversation";
  if (s.current?.label === "related" && !s.current.pending && s.current.url && s.current.source !== "look" && !chat) {
    const { tabId, url, title } = s.current;
    s.lastRelevant = { tabId, url, title, ts };
  }
}

function applyContext(s, input, candidates, cfg) {
  const away = input.browserFocused === false || (input.idleState !== "active" && !input.audible);
  if (away) {
    if (!s.away) s.awaySince = input.ts;
    s.away = true;
    return [];
  }
  if (s.away && s.awaySince != null && s.intent && input.ts - s.awaySince >= cfg.returnAwaySec * S)
    candidates.push("return");
  s.away = false;
  s.awaySince = null;
  s.lastActiveTs = input.ts;
  if (s.agentPending) {
    s.agentPending = false;
    candidates.push("agent");
  }
  const today = dayKey(input.ts, cfg);
  if (!s.intent && s.sessionDay !== today) {
    candidates.push("session_start");
    s.sessionDay = today;
  }

  const out = [];
  const pending = !input.label;
  // A title change or load event on the same tab and URL is the same page, not a switch.
  const samePage = s.current && s.current.tabId === input.tabId && s.current.url === input.url;
  if (samePage && s.current.key !== input.key) {
    const last = s.timeline.at(-1);
    if (last) Object.assign(last, { key: input.key, label: pending ? "neutral" : input.label });
  } else if (!samePage) {
    s.timeline.push({ ts: input.ts, key: input.key, label: pending ? "neutral" : input.label });
    // Keep the window, plus the entry running into it.
    const firstIn = s.timeline.findIndex((e) => e.ts >= input.ts - cfg.fragWindowSec * S);
    if (firstIn > 0) s.timeline = s.timeline.slice(firstIn - 1);
  }
  const same = s.current?.key === input.key ? s.current : null;
  s.current = {
    key: input.key,
    tabId: input.tabId,
    url: input.url,
    host: input.host,
    title: input.title,
    label: pending ? (same?.label ?? "neutral") : input.label,
    confidence: pending ? (same?.confidence ?? 0) : (input.confidence ?? 1),
    pending: pending ? (same ? same.pending : true) : false,
    source: pending ? (same?.source ?? null) : (input.source ?? null),
    surface: input.surface ?? null,
  };
  const askedAt = s.asked[input.key];
  if (s.intent && s.current.pending && (askedAt == null || input.ts - askedAt >= cfg.relevanceRetrySec * S)) {
    s.asked[input.key] = input.ts;
    out.push({
      type: "need_relevance",
      ts: input.ts,
      key: input.key,
      url: input.url,
      host: input.host,
      title: input.title,
      surface: s.current.surface,
    });
  }
  rememberRelated(s, input.ts);
  return out;
}

function applyRelevance(s, input) {
  delete s.asked[input.key];
  // The model takes seconds: time spent waiting for it, on this page or one since left,
  // counts now. Otherwise whoever hops faster than it answers is never drifting.
  if (input.label === "unrelated") s.budgetSec += s.waited[input.key] ?? 0;
  delete s.waited[input.key];
  if (s.current?.key !== input.key) return;
  Object.assign(s.current, {
    label: input.label,
    confidence: input.confidence,
    pending: false,
    source: input.source ?? null,
  });
  const last = s.timeline.at(-1);
  if (last?.key === input.key) last.label = input.label;
  rememberRelated(s, input.ts);
}

function applySession(s, input) {
  if (input.kind === "intent_set") {
    s.intent = input.payload;
    s.budgetSec = 0;
    s.waited = {};
    s.policy = initialPolicy();
  } else if (input.kind === "intent_done") {
    s.intent = null;
    s.budgetSec = 0;
    s.waited = {};
    s.policy.episode = null;
  } else if (input.kind === "mode") {
    s.mode = input.payload.mode;
  } else if (input.kind === "memory") {
    // The person's notes changed: what the page in front means is an open question again.
    s.asked = {};
    if (s.current) Object.assign(s.current, { label: "neutral", confidence: 0, pending: true, source: null });
  }
}

function applyResponse(s, input, cfg) {
  if (input.choice === "back" || input.choice === "related" || input.choice === "break") {
    s.budgetSec = 0;
    s.policy.episode = null;
    s.lastDriftBudget = null;
  }
  // The nudged page; the person may have moved on since (pageUrl absent: the page in front).
  // On one URL a chat, another chat and a feed are different pages (pageKey absent: an older log).
  const nudgedIsCurrent = input.pageKey
    ? input.pageKey === s.current?.key
    : !input.pageUrl || input.pageUrl === s.current?.url;
  if (input.choice === "related" && s.current && nudgedIsCurrent) {
    Object.assign(s.current, { label: "related", confidence: 1, pending: false, source: "label" });
    const last = s.timeline.at(-1);
    if (last?.key === s.current.key) last.label = "related";
    rememberRelated(s, input.ts);
  }
  if (input.choice === "break") s.breakUntil = input.ts + cfg.breakMin * 60 * S;
  if (input.choice === "dismiss" && s.policy.episode)
    s.policy.cooldownUntil[s.policy.episode.kind] = input.ts + cfg.cooldownSec * S;
}

// Whose turn it is in a coding agent (bridge/). A word when it stops, once: the same
// stop can arrive twice (an approval request, then its notification).
function applyAgent(s, input, candidates) {
  const before = s.agent?.status;
  s.agent = { status: input.status, ts: input.ts, session: input.session ?? null };
  s.agentPending = false;
  if (!AGENT_STOPS.includes(input.status) || before === input.status) return;
  // Time to take it in: a drift word right after this one would drown it.
  s.budgetSec = 0;
  if (s.away) s.agentPending = true;
  else candidates.push("agent");
}

// ---- The second look -------------------------------------------------------
// URL and title cannot tell a work chat from a feed on the same page. Before a drift
// word about a page the background looks at it again (background/index.js secondLook):
// is the person typing there right now, and what does a short excerpt say. The excerpt
// takes a model call, so it is read ahead, a little before the tolerance runs out
// (`read_ahead`); a "related" verdict then ends the detour before any word. Typing is
// checked fresh for every drift word, when it is due (`need_second_look`). Answers are
// inputs, so a recorded log replays exactly.

const looking = (s, cfg) => cfg.secondLook && !["dnd", "off"].includes(s.mode);

function requestLook(s, ts, out) {
  const c = s.current;
  s.look = { key: c.key, askedTs: ts, answer: null };
  out.push({
    type: "need_second_look",
    ts,
    key: c.key,
    tabId: c.tabId,
    url: c.url,
    host: c.host,
    title: c.title,
    surface: c.surface,
  });
}

function applySecondLook(s, input, cfg) {
  // An answer for a page already left changes nothing.
  if (s.look?.key === input.key)
    s.look.answer = { composing: !!input.composing, label: input.label ?? null, confidence: input.confidence ?? 0 };
  // The excerpt shows work (read ahead or at the word): the page counts as related, but
  // is no place to go back to.
  if (input.label === "related" && (input.confidence ?? 0) >= cfg.unsureConfidence && s.current?.key === input.key) {
    Object.assign(s.current, { label: "related", confidence: input.confidence, pending: false, source: "look" });
    const last = s.timeline.at(-1);
    if (last?.key === input.key) last.label = "related";
  }
}

// May the drift word that is due be said now? Waits for the look at the page in front,
// and holds while the person is typing there, at most cfg.maxHolds times per drift.
function lookAllows(s, ts, cfg) {
  if (!looking(s, cfg)) return true;
  if (s.holdUntil != null) {
    if (ts < s.holdUntil) return false;
    s.holdUntil = null;
  }
  const a = s.look?.key === s.current.key ? s.look.answer : null;
  if (!a) {
    // One wait per word, however many pages pass meanwhile (hopping faster than the
    // model answers, or a worker that died): then the word goes ahead.
    s.lookWaitSince ??= ts;
    return ts - s.lookWaitSince >= cfg.lookTimeoutSec * S;
  }
  if (a.composing && s.holds < cfg.maxHolds) {
    s.holds += 1;
    s.holdUntil = ts + cfg.holdSec * S;
    s.holdKey = s.current.key;
    s.look = null; // look again when the hold ends
    s.lookWaitSince = null;
    return false;
  }
  return true;
}

export function step(prev, input, cfg = DEFAULTS) {
  const decide = cfg.decide ?? policyDecide;
  const s = structuredClone(prev);
  const ts = input.ts;
  const before = s.state;
  const out = [];
  const candidates = [];

  // Turning Off back on: the time spent off is not time away.
  const wakingUp = input.type === "session" && input.kind === "mode" && s.mode === "off";
  if (wakingUp) {
    s.away = false;
    s.awaySince = null;
  }

  // An agent that went quiet (a crash sends nothing) no longer excuses the wait.
  if (agentWorking(s) && ts - s.agent.ts > cfg.agentQuietSec * S) s.agent = { ...s.agent, status: "unknown" };

  // 1. Time passes on the page that was in front.
  if (s.lastTs != null && ts > s.lastTs && !wakingUp) {
    const dt = (ts - s.lastTs) / S;
    if (dt > cfg.maxGapSec) {
      // Sleep or a crash: the silence is time away, never time on the page.
      if (!s.away) s.awaySince = s.lastTs;
      s.away = true;
    } else {
      advance(s, dt, cfg);
    }
  }
  s.lastTs = Math.max(s.lastTs ?? ts, ts);

  // 2. The input itself.
  if (input.type === "context") out.push(...applyContext(s, input, candidates, cfg));
  else if (input.type === "relevance") applyRelevance(s, input);
  else if (input.type === "session") applySession(s, input);
  else if (input.type === "response") applyResponse(s, input, cfg);
  else if (input.type === "second_look") applySecondLook(s, input, cfg);
  else if (input.type === "agent") applyAgent(s, input, candidates);

  if (s.breakUntil != null && ts >= s.breakUntil) {
    s.breakUntil = null;
    // Already back at work: nothing to say.
    if (s.intent && labelOf(s.current) !== "related") candidates.push("break_over");
  }

  // Off task since the first unrelated page after work; neutral stops keep the count.
  const label = labelOf(s.current);
  if (label === "related") s.offTaskSince = null;
  else if (label === "unrelated" && s.offTaskSince == null) s.offTaskSince = s.timeline.at(-1)?.ts ?? ts;

  // 3. Where that leaves the person.
  const core = coreState(s, ts, cfg);
  s.state = shownState(s, ts, cfg);
  if (s.state !== before)
    out.push({
      type: "state",
      ts,
      from: before,
      to: s.state,
      budgetSec: Math.round(s.budgetSec),
      switches2m: windowStats(s, ts, cfg).switches,
    });

  // 4. What might deserve a word.
  if (core !== "detour" && core !== "drifting") {
    s.look = null;
    s.lookWaitSince = null;
    s.readAheadKey = null;
    s.holds = 0;
    s.holdUntil = null;
  }
  // A hold is for typing on that page: another page ends it.
  if (s.holdUntil != null && s.holdKey !== s.current?.key) s.holdUntil = null;
  const offTask = core === "detour" || core === "drifting";
  if (
    offTask &&
    looking(s, cfg) &&
    s.readAheadKey !== s.current.key &&
    s.budgetSec >= effectiveTolerance(s, cfg) - cfg.lookLeadSec
  ) {
    const c = s.current;
    s.readAheadKey = c.key;
    out.push({
      type: "read_ahead",
      ts,
      key: c.key,
      tabId: c.tabId,
      url: c.url,
      host: c.host,
      title: c.title,
      surface: c.surface,
    });
  }
  // One drift, however often the person glances elsewhere: it ends on a real absence or
  // once work has drained the budget well below the tolerance. Words are spaced by time
  // off task, so neither a glance nor a moment on work can bring the next one sooner.
  if (s.lastDriftBudget != null) {
    const floor = Math.max(0, Math.min(s.lastDriftBudget, effectiveTolerance(s, cfg)) - cfg.escalateAfterSec);
    if (candidates.includes("return") || s.budgetSec <= floor) {
      s.policy.episode = null;
      s.lastDriftBudget = null;
    }
  }
  if (core === "drifting") {
    // Every drift word is looked at first, when it is due: typing then is what counts.
    const due = s.lastDriftBudget == null || s.budgetSec >= s.lastDriftBudget + cfg.escalateAfterSec;
    const holding = s.holdUntil != null && ts < s.holdUntil;
    if (due && looking(s, cfg) && !holding && s.look?.key !== s.current.key) requestLook(s, ts, out);
    if (due && lookAllows(s, ts, cfg)) {
      candidates.push("drift");
      s.lastDriftBudget = s.budgetSec;
      s.look = null;
      s.lookWaitSince = null;
    }
  }
  // One nudge at a time: hopping during a drift is part of that drift.
  if (
    core !== "drifting" &&
    core !== "agent_working" &&
    s.intent &&
    !s.away &&
    (s.fragFiredTs == null || ts - s.fragFiredTs >= cfg.fragWindowSec * S)
  ) {
    const w = windowStats(s, ts, cfg);
    if (w.switches >= cfg.fragMinSwitches && w.unrelatedShare >= cfg.fragUnrelatedShare) {
      candidates.push("fragmentation");
      s.fragFiredTs = ts;
    }
  }

  if (s.mode !== "off") {
    const ctx = { mode: s.mode, unsure: s.current ? isUnsure(s.current, cfg) : false };
    for (const kind of candidates) {
      const candidate = { kind, ts, id: `${kind}-${ts}`, evidence: evidence(s, ts, cfg) };
      let r = decide(s.policy, candidate, ctx, cfg);
      // Out of words about another page: this one is news, and starts them over.
      if (!r.trigger && kind === "drift" && s.current?.key !== s.lastDriftKey)
        r = decide({ ...s.policy, episode: null }, candidate, ctx, cfg);
      s.policy = r.policy;
      if (r.trigger) out.push({ type: "trigger", ...r.trigger });
      if (r.trigger && kind === "drift") s.lastDriftKey = s.current?.key ?? null;
    }
  }
  return { state: s, out };
}

// The earliest time a tick could change the outcome, or null.
export function nextWakeAt(s, cfg = DEFAULTS) {
  if (s.lastTs == null || s.mode === "off") return null;
  const times = [];
  if (s.breakUntil != null) times.push(s.breakUntil);
  const core = coreState(s, s.lastTs, cfg);
  if (core === "detour") times.push(s.lastTs + (effectiveTolerance(s, cfg) - s.budgetSec) * S);
  // Times already past are done with or blocked (a read-ahead sent at the last step, an
  // escalation waiting for its look or a hold, a timeout): waking for them would loop.
  const pending = (t) => t != null && t > s.lastTs && times.push(t);
  if (agentWorking(s)) pending(s.agent.ts + (cfg.agentQuietSec + 1) * S);
  if (core === "drifting" && s.lastDriftBudget != null)
    pending(s.lastTs + (s.lastDriftBudget + cfg.escalateAfterSec - s.budgetSec) * S);
  if (core === "detour" && looking(s, cfg) && s.readAheadKey !== s.current?.key)
    pending(s.lastTs + (effectiveTolerance(s, cfg) - cfg.lookLeadSec - s.budgetSec) * S);
  if (core === "drifting" && s.lookWaitSince != null) pending(s.lookWaitSince + cfg.lookTimeoutSec * S);
  pending(s.holdUntil);
  return times.length ? Math.min(...times) : null;
}

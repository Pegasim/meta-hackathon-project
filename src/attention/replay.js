// Replays a recorded event log through the engine. Only inputs (and logged heartbeat
// ticks) are fed; logged
// outputs (states, triggers) and side records (llm, feedback) are recomputed or
// ignored, so a log recorded by an older engine still measures the current one.
import { DEFAULTS } from "./config.js";
import { initialState, step } from "./engine.js";

const INPUTS = new Set(["context", "relevance", "session", "response", "tick", "agent"]);

// What the live worker saw on each page (its second_look answers), by page key. The
// engine asks again on its own schedule, so each request gets the answer recorded
// nearest to it: the first one within cfg.lookTimeoutSec after it, else the last one
// within cfg.lookHoldMin before it. A log replays as it ran, and a replay with other
// settings still finds the page as it was. A log from before the second look holds
// none: every look is "nothing seen", which is how that engine behaved.
function recordedLooks(events, cfg) {
  const byKey = new Map();
  for (const e of events.filter((e) => e.type === "second_look").sort((a, b) => a.ts - b.ts)) {
    if (!byKey.has(e.key)) byKey.set(e.key, []);
    byKey.get(e.key).push(e);
  }
  return (key, ts) => {
    const seen = byKey.get(key) ?? [];
    return (
      seen.find((a) => a.ts >= ts && a.ts - ts <= cfg.lookTimeoutSec * 1000) ??
      seen.filter((a) => a.ts < ts && ts - a.ts <= cfg.lookHoldMin * 60 * 1000).at(-1) ??
      null
    );
  };
}

export function replay(log, { cfg = DEFAULTS, tickSec = 1 } = {}) {
  const inputs = log.events.filter((e) => INPUTS.has(e.type)).sort((a, b) => a.ts - b.ts);
  const recorded = recordedLooks(log.events, cfg);
  const out = [];
  let state = initialState();
  const feed = (input) => {
    const r = step(state, input, cfg);
    state = r.state;
    out.push(...r.out);
    for (const o of r.out) {
      if (o.type !== "read_ahead" && o.type !== "need_second_look") continue;
      const a = recorded(o.key, o.ts);
      const verdict = a?.label ? { label: a.label, confidence: a.confidence } : {};
      // As live: a read-ahead speaks only when it found work; a look always answers.
      if (o.type === "read_ahead" && verdict.label === "related")
        feed({ type: "second_look", ts: o.ts, key: o.key, ...verdict });
      else if (o.type === "need_second_look")
        feed({ type: "second_look", ts: o.ts, key: o.key, composing: !!a?.composing, ...verdict });
    }
  };
  inputs.forEach((input, i) => {
    feed(input);
    const next = inputs[i + 1]?.ts ?? input.ts;
    // The live worker ticks (and logs) at least every 30 s while the machine is awake,
    // so a longer silence in the log is sleep: leave it to the engine as time away.
    if (next - input.ts > cfg.maxGapSec * 1000) return;
    for (let ts = input.ts + tickSec * 1000; ts < next; ts += tickSec * 1000) feed({ type: "tick", ts });
  });
  return {
    triggers: out.filter((o) => o.type === "trigger"),
    states: out.filter((o) => o.type === "state"),
  };
}

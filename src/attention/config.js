// Engine constants. Values start from the design (docs/superpowers/specs/
// 2026-10-31-attention-agent-design.md §6.1) and are tuned by replay.

export const DEFAULTS = Object.freeze({
  toleranceSec: 45, // drift budget that triggers a drift
  decayRate: 2, // related time drains the budget this many times faster than unrelated fills it
  unsureConfidence: 0.6, // an "unrelated" below this is unsure: never past L1
  fragmentation: false, // the tab-hopping nudge: off, it read fast work as drift (#30); drift covers most of it
  fragWindowSec: 120,
  fragMinSwitches: 6,
  fragUnrelatedShare: 0.5,
  escalateAfterSec: 30, // this much more time off task after a drift word → next level
  cooldownSec: 120,
  gentleMultiplier: 2,
  returnAwaySec: 300,
  idleAfterSec: 120, // no keyboard or mouse this long (system-wide) = away
  maxGapSec: 120, // a longer silence between inputs is time away (sleep, crash)
  breakMin: 5,
  agentQuietSec: 900, // no word from a working agent this long: its status is unknown
  agentAskAgainSec: 30, // the agent still waits after this long in the browser: ask again, then twice as long
  relevanceRetrySec: 30, // ask the model again if an answer never came (worker died mid-call)
  secondLook: true, // look at a page again before a drift word about it (typing? an excerpt)
  lookLeadSec: 15, // read the excerpt ahead this long before the tolerance runs out
  lookTimeoutSec: 20, // no answer by then (worker died): the word goes ahead without it
  holdSec: 120, // typing on the page: wait this long, then look again
  maxHolds: 2, // per drift; then the word comes anyway (the first one at L1)
  lookHoldMin: 5, // an excerpt's verdict counts for the page this long
  typingRecentSec: 60, // a key pressed this recently, with the focus in a text field = typing
  regionWaitMs: 500, // the page has this long to say where the person works on it (background surfaceOf)
  labelMin: 30, // "This is for my task" on a whole site lasts this long…
  labelDays: 3, // …until it has been given on this many different days
  dayBoundaryHour: 4,
  expireAwayHours: 6,
  retentionDays: 7,
  summaryMinSec: 60, // a goal in front of the person less than this gets no entry about its day (#46)
  tzOffsetMin: null, // null = the machine's time zone; tests pin it
});

export function withOverrides(overrides = {}) {
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(overrides ?? {})) if (k in DEFAULTS) cfg[k] = v;
  return cfg;
}

// Shadow intents: the goal record attention owns (stable id, steps, topic), linked
// to memory's todo entry. A goal not finished by the end of the day becomes an open
// loop for the next morning. Design §9.1 and §9.4.

const H = 3600 * 1000;

// The local date, with the day turning at cfg.dayBoundaryHour rather than midnight.
export function dayKey(ts, cfg, tzOffsetMin = cfg.tzOffsetMin ?? new Date(ts).getTimezoneOffset()) {
  return new Date(ts - tzOffsetMin * 60 * 1000 - cfg.dayBoundaryHour * H).toISOString().slice(0, 10);
}

function slug(title) {
  return (
    title
      .replace(/[İIı]/g, "i")
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .match(/[a-z0-9]+/g)
      ?.join("-")
      .slice(0, 40)
      .replace(/-$/, "") ?? "focus"
  );
}

export function makeIntent(
  { title, steps = [], estMin = null, topic, memoryEntryId = null, fromLoopId = null },
  ts,
  id = crypto.randomUUID(),
) {
  return {
    id,
    title,
    steps,
    estMin,
    topic: topic ?? slug(title),
    createdAt: ts,
    doneAt: null,
    expiredAt: null,
    memoryEntryId,
    fromLoopId,
    focusMs: 0, // time in Focus mode on this goal, paused in breaks and Do not disturb
    focusSince: null, // when the running stretch began; null while paused
    stepIndex: 0, // which plan step (#78) is the one on now
  };
}

// The goal card's "Focus 18m". active: Focus mode and not on a break. Plain time, no page
// verdicts: a wrong verdict cannot bend it. Same object back when nothing flips.
export function syncFocus(intent, active, now) {
  const running = intent.focusSince != null;
  if (active === running) return intent;
  return active
    ? { ...intent, focusSince: now }
    : { ...intent, focusMs: (intent.focusMs ?? 0) + (now - intent.focusSince), focusSince: null };
}

export const focusMinutes = (intent, now) =>
  Math.floor(((intent.focusMs ?? 0) + (intent.focusSince != null ? now - intent.focusSince : 0)) / 60000);

// "Step done" on the card: the next plan step becomes the one on now. The last step, or a
// goal with no plan, stays as it is.
export function stepDone(intent) {
  const steps = intent.plan?.steps ?? [];
  const next = (intent.stepIndex ?? 0) + 1;
  if (next >= steps.length) return intent;
  return { ...intent, stepIndex: next, steps: [steps[next].step] };
}

export function isExpired(intent, nowTs, lastActiveTs, cfg, tzOffsetMin) {
  if (dayKey(nowTs, cfg, tzOffsetMin) !== dayKey(intent.createdAt, cfg, tzOffsetMin)) return true;
  return nowTs - lastActiveTs >= cfg.expireAwayHours * H;
}

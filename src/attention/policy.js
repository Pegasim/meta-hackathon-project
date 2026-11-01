// Intervention policy: turns the engine's candidates into triggers with a level.
// L1 = the avatar looks, L2 = a short question, L3 = the goal and where you left off.
// Pure and deterministic. Design §6.1 "Policy".

const S = 1000;
const IMMEDIATE = ["session_start", "return", "break_over", "agent"];

export function initialPolicy() {
  return { episode: null, cooldownUntil: {}, lastLoudTs: {} };
}

const maxLevel = ({ mode, unsure }) => (unsure ? 1 : mode === "gentle" ? 2 : 3);

// policy: as initialPolicy(); candidate: {kind, ts, id, evidence}; ctx: {mode, unsure}.
export function decide(policy, candidate, ctx, cfg) {
  if (ctx.mode === "off") return { policy, trigger: null };
  const { kind, ts } = candidate;
  if (ctx.mode === "dnd") return { policy, trigger: { ...candidate, level: 0, suppressedBy: "dnd" } };

  const p = { ...policy, cooldownUntil: { ...policy.cooldownUntil }, lastLoudTs: { ...(policy.lastLoudTs ?? {}) } };
  let level;
  let startedTs = ts;
  if (IMMEDIATE.includes(kind)) {
    level = 2;
  } else {
    const ep = p.episode?.kind === kind ? p.episode : null;
    level = ep ? ep.level + 1 : 1;
    startedTs = ep ? ep.startedTs : ts;
    if (level > maxLevel(ctx)) return { policy, trigger: null };
  }

  // Louder words wait: after a dismiss, and after the last L2+ of an earlier episode.
  const lastLoud = p.lastLoudTs[kind];
  const coolingDown =
    ts < (p.cooldownUntil[kind] ?? 0) ||
    (lastLoud != null && lastLoud < startedTs && ts - lastLoud < cfg.cooldownSec * S);
  if (level >= 2 && coolingDown) {
    if (!IMMEDIATE.includes(kind) && !p.episode) p.episode = { kind, level: 1, startedTs, triggerId: candidate.id };
    return { policy: p, trigger: { ...candidate, level: 1, suppressedBy: "cooldown" } };
  }

  if (!IMMEDIATE.includes(kind))
    p.episode = { kind, level, startedTs, triggerId: p.episode?.triggerId ?? candidate.id };
  if (level >= 2) p.lastLoudTs[kind] = ts;
  return { policy: p, trigger: { ...candidate, level } };
}

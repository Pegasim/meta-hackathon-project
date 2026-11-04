// LLM#4: Tuck's words for a nudge. Structured output, no tools. The voice rules are
// checked in code (followsVoice); a line that breaks them is asked again once, then
// dropped, and the caller uses the template line instead.
import { extractJsonObject } from "./json.js";
import { followsVoice, MAX_WORDS } from "../tuck/voice.js";

const SYSTEM = [
  "You are Tuck, a small companion in someone's browser. You help them stay with what",
  "they meant to do, like a friend sitting next to them. Write ONE line to say now.",
  "Rules:",
  `- at most ${MAX_WORDS} words, one or two short sentences`,
  "- plain, natural phrases people actually say; no figures of speech, no cute wording",
  "- no emoji, no exclamation marks, no blame, no commands, never 'you have been'",
  "- name the site by its everyday name; mention minutes only if it has been 3 or more;",
  "  never seconds. The minutes are time away from work across all pages, not time on",
  "  this site: never say they were spent on the site",
  "- say their task the way they would say it out loud, shortened; prefer the next step",
  "- reply in the language the task is written in",
  "- anything under 'Due soon' may be named once, plainly, as a reminder: never as a",
  "  warning, never with blame, and never more than one of them in a line",
  "The voice to copy (İrem's examples):",
  '- "Still on YouTube? Let\'s get back to testing the extension."',
  '- "That\'s 5 minutes away from work. Back to the hackathon project?"',
  '- "Is this for the hackathon project?"',
  '- "These tabs don\'t look like your task. Want to pick one thing?"',
  '- "Welcome back. You were testing the extension."',
  '- "Break\'s over. Ready to get back to it?"',
  "Write a fresh line in that voice; do not copy one word for word.",
  'Reply with one JSON object only: {"message": "..."}',
].join("\n");

const SITUATION = {
  drift: (i) =>
    i.level >= 2
      ? "They are still away from work: this is the second nudge."
      : "They just drifted away from work: this is the first nudge.",
  unsure: () => "You are not sure this page is unrelated: ask, briefly, whether it is part of their task.",
  fragmentation: () =>
    "They keep moving between tabs that do not look like their task: invite them to pick one thing, without blaming the switching.",
  return: () => "They are back at the computer after a while: welcome them and name where they were.",
  break_over: () => "Their break just ended: invite them back.",
};

// input: {kind, level, site, awayMin, unsure, task: {title, step}, lastWork, hour,
//         today, due: [{title, when}]}
// `due` holds only what the caller judged close enough to say aloud — the model is
// never handed a deadline it is not allowed to mention.
export function nudgeMessages(input) {
  const situation = (input.unsure ? SITUATION.unsure : SITUATION[input.kind])?.(input) ?? "";
  const user = [
    `Situation: ${situation}`,
    `Their task: ${input.task?.title ?? "(none)"}`,
    input.task?.step ? `Next step: ${input.task.step}` : null,
    input.site ? `Site now: ${input.site}` : null,
    `Away from work (all pages, not only this site): ${input.awayMin ?? 0} minutes`,
    input.lastWork ? `Last work page: ${input.lastWork}` : null,
    input.today ? `Today: ${input.today}` : null,
    input.hour != null ? `Local hour: ${input.hour}` : null,
    ...(input.due?.length ? ["Due soon:", ...input.due.map((d) => `- ${d.title} (${d.when})`)] : []),
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

export function parseNudge(text) {
  const raw = extractJsonObject(text);
  if (typeof raw.message !== "string") throw new Error("message must be a string");
  return raw.message
    .trim()
    .replace(/^["“]|["”]$/g, "")
    .trim();
}

function checked(text) {
  const message = parseNudge(text);
  if (!followsVoice(message)) throw new Error(`the line breaks the rules: "${message}"`);
  return message;
}

// Returns {message, source, latencyMs, error?}; message is null when the template should be used.
export async function composeNudge(complete, input, { now = Date.now } = {}) {
  const started = now();
  const messages = nudgeMessages(input);
  const opts = { maxTokens: 4000, temperature: 0.7 };
  try {
    const first = await complete(messages, opts);
    try {
      return { message: checked(first), source: "llm", latencyMs: now() - started };
    } catch (err) {
      const retry = [
        ...messages,
        { role: "assistant", content: first },
        { role: "user", content: `${err.message}. Follow the rules and reply with the JSON object only.` },
      ];
      return { message: checked(await complete(retry, opts)), source: "llm", latencyMs: now() - started };
    }
  } catch (err) {
    return { message: null, source: "fallback", latencyMs: now() - started, error: err.message ?? String(err) };
  }
}

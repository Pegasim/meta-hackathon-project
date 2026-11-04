// Tuck's voice: everyday site names, the task said as a phrase, and the template
// lines used when the model's own words are not ready. Pure. Rules (İrem): at most
// 12 words, no emojis, no exclamation marks, plain phrases a friend would say, never
// seconds, minutes only when it has been a few.

const NAMES = {
  "youtube.com": "YouTube",
  "linkedin.com": "LinkedIn",
  "x.com": "X",
  "twitter.com": "X",
  "reddit.com": "Reddit",
  "instagram.com": "Instagram",
  "facebook.com": "Facebook",
  "tiktok.com": "TikTok",
  "netflix.com": "Netflix",
  "open.spotify.com": "Spotify",
  "spotify.com": "Spotify",
  "mail.google.com": "Gmail",
  "docs.google.com": "Google Docs",
  "github.com": "GitHub",
  "news.ycombinator.com": "Hacker News",
  "amazon.com": "Amazon",
  "twitch.tv": "Twitch",
  "pinterest.com": "Pinterest",
};

export function siteName(host = "") {
  const h = host.replace(/^(www|m)\./, "");
  return NAMES[h] ?? h;
}

// "Testing the extension" → "testing the extension"; acronyms ("SUT …") stay as they are.
function asPhrase(text) {
  const t = text.trim();
  return /^[A-Z][a-z]/.test(t) ? t[0].toLowerCase() + t.slice(1) : t;
}

export function taskPhrase({ title, step } = {}) {
  const t = step || title;
  return t ? asPhrase(t) : "your goal";
}

// What an approval is for, said plainly, from the tool's name alone (#67); null when unclear.
export function toolKind(tool = "") {
  if (/bash|shell|exec|command|terminal/i.test(tool)) return "run a command";
  if (/edit|write|patch|replace/i.test(tool)) return "edit a file";
  if (/fetch|web|browse|url/i.test(tool)) return "open a web page";
  return null;
}

// Where and how long, for a word about Muse: " in bilun", ", after 4 minutes".
const inFolder = (folder) => (folder ? ` in ${folder}` : "");
const after = (minutes) => (minutes >= 3 ? `, after ${minutes} minutes` : "");

// kind, level, site, awayMin, unsure, task: {title, step}; for an agent word, agent (its
// status) and agentFacts: {folder, minutes, tool}.
export function templateNudge({
  kind,
  level,
  site,
  awayMin = 0,
  unsure = false,
  task,
  agent,
  again = false,
  agentFacts = {},
}) {
  const what = taskPhrase(task);
  switch (kind) {
    case "drift":
      // "Next up: …" reads well whatever the step's wording ("testing …", "write …").
      if (unsure) return "Is this page part of your task?";
      if (level >= 2 && awayMin >= 3) return `That's ${awayMin} minutes on ${site}. Next up: ${what}.`;
      if (level >= 2) return `Still on ${site}. Want to get back to it?`;
      return `Still on ${site}? Next up: ${what}.`;
    case "fragmentation":
      return "These tabs don't look like your task. Want to pick one thing?";
    case "return":
      return `Welcome back. Next up: ${what}.`;
    case "break_over":
      return "Break's over. Ready to get back to it?";
    case "agent": {
      const { folder, minutes, tool } = agentFacts;
      if (agent === "failed") return `Muse stopped on an error${inFolder(folder)}.`;
      if (agent === "completed") return `Muse is done${inFolder(folder)}${after(minutes)}.`;
      if (again) return "Is Muse still waiting on you?";
      const asks = toolKind(tool ?? "");
      return asks ? `Muse wants your OK to ${asks}${inFolder(folder)}.` : `Muse is waiting on you${inFolder(folder)}.`;
    }
    case "session_start":
      return "Hi. What are we working on today?";
    default:
      return "";
  }
}

// The day's greeting once the last goal is known (attention/summary.js): how it went, in
// plain facts. The goal itself is offered below it, to pick up. when: whenSaid().
export function templateGreeting({ goal, onGoalMin = 0, site, finished }, when) {
  const what = asPhrase(goal);
  if (finished) return `Done ${when.toLowerCase()}: ${what}. What's next?`;
  const time = onGoalMin >= 3 ? `${spokenTime(onGoalMin)} on ${what}` : what;
  return site ? `${when}: ${time}, last on ${siteName(site)}.` : `${when}: ${time}.`;
}

function spokenTime(min) {
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h}h ${min % 60}m` : `${h} hour${h === 1 ? "" : "s"}`;
}

// The day a goal was on, from today's: both as dayKey() gives them (YYYY-MM-DD).
export function whenSaid(date, today) {
  if (date === today) return "Earlier today";
  const yesterday = new Date(`${today}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return date === yesterday.toISOString().slice(0, 10) ? "Yesterday" : "Last time";
}

// A deadline said aloud at a natural moment. when: "today", "tomorrow", "3 days ago".
export function reminderLine(when) {
  return /ago|yesterday/.test(when) ? `That was due ${when}. Still on your list?` : `Due ${when}. Still on your list?`;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const SECONDS = /\b\d+\s*(s|sec|secs|seconds?)\b/i;
export const MAX_WORDS = 12;

export function followsVoice(line) {
  const words = line.trim().split(/\s+/).filter(Boolean);
  return (
    words.length > 0 && words.length <= MAX_WORDS && !EMOJI.test(line) && !line.includes("!") && !SECONDS.test(line)
  );
}

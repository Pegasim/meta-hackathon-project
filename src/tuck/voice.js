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

// kind, level, site, awayMin, unsure, task: {title, step}.
export function templateNudge({ kind, level, site, awayMin = 0, unsure = false, task, agent }) {
  const what = taskPhrase(task);
  switch (kind) {
    case "drift":
      // "Next up: …" reads well whatever the step's wording ("testing …", "write …").
      if (unsure) return "Is this page part of your task?";
      if (level >= 2 && awayMin >= 3) return `That's ${awayMin} minutes on ${site}. Next up: ${what}.`;
      if (level >= 2) return `Still on ${site}. Want to get back to it?`;
      return `Still on ${site}? Next up: ${what}.`;
    case "fragmentation":
      return "Lots of tab switching. Want to pick one thing?";
    case "return":
      return `Welcome back. Next up: ${what}.`;
    case "break_over":
      return "Break's over. Ready to get back to it?";
    case "agent":
      if (agent === "failed") return "Muse stopped on an error.";
      return agent === "completed" ? "Muse is done." : "Muse is waiting on you.";
    case "session_start":
      return "Hi. What are we working on today?";
    default:
      return "";
  }
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

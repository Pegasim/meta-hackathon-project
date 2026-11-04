// GitHub lookups (#91): whether a PR or issue a note names is still open. Notes go stale
// about code, and only the live repository knows. Public repositories only, through
// GitHub's REST API with no token (60 requests an hour per IP), so answers are cached for
// a few minutes. Only names, numbers, states and titles come back: no code, diffs or
// comments. A failed or rate-limited call is "could not check", which drops nothing.

export const GITHUB_API = "https://api.github.com";
export const CACHE_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MERGED_DAYS = 7;
const LISTED = 10; // titles per list

const REPO = /^[\w.-]+\/[\w.-]+$/;

// Settings' text, one repository per line: "owner/name" or its github.com address.
// Returns {repos, bad}: the repositories, once each, and the lines that are not one.
export function parseRepos(text = "") {
  const repos = [];
  const bad = [];
  for (const line of String(text).split("\n")) {
    const l = line
      .trim()
      .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
      .replace(/(\.git)?\/*$/, "");
    if (!l) continue;
    if (!REPO.test(l)) bad.push(line.trim());
    else if (!repos.some((r) => r.toLowerCase() === l.toLowerCase())) repos.push(l);
  }
  return { repos, bad };
}

// The PRs and issues a text names: "owner/name#12" for a listed repository, and, when
// exactly one is listed, "#12", "PR 12", "PR #12" and "issue 12" too. A repository not
// listed is never asked about. Returns [{repo, number}], once each.
export function refsIn(text = "", repos = []) {
  const out = [];
  const add = (repo, n) => {
    const number = Number(n);
    if (number > 0 && !out.some((r) => r.repo === repo && r.number === number)) out.push({ repo, number });
  };
  const rest = String(text).replace(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g, (_, name, n) => {
    const repo = repos.find((r) => r.toLowerCase() === name.toLowerCase());
    if (repo) add(repo, n);
    return " ";
  });
  if (repos.length === 1)
    for (const m of rest.matchAll(/(?:\b(?:PR|pull request|issue)\s*#?|(?<![\w&/])#)(\d+)\b/gi)) add(repos[0], m[1]);
  return out;
}

const pick = (items, clean) => items.slice(0, LISTED).map((i) => ({ number: i.number, title: clean(i.title ?? "") }));

// repos: the listed "owner/name"s. cache: {get(key) -> {at, data} | undefined, set(key,
// value)}, sync or async (the background keeps it in chrome.storage.session, which
// outlives the worker). clean: what a title goes through (the background's redact).
export function githubLookup({
  repos = [],
  fetch = globalThis.fetch,
  now = Date.now,
  cache = new Map(),
  clean = (t) => t,
} = {}) {
  let quietUntil = 0; // after a 403 or 429, GitHub is not asked again for a while
  const asking = new Map(); // path → its request, so two asks at once make one

  function get(path) {
    if (!asking.has(path))
      asking.set(
        path,
        ask(path).finally(() => asking.delete(path)),
      );
    return asking.get(path);
  }

  async function ask(path) {
    const hit = await cache.get(path);
    if (hit && now() - hit.at < CACHE_MS) return hit.data;
    if (now() < quietUntil) throw new Error("rate limited");
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 403 || res.status === 429) {
      quietUntil = now() + CACHE_MS;
      throw new Error("rate limited");
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const data = await res.json();
    await cache.set(path, { at: now(), data });
    return data;
  }

  return {
    repos,
    // One PR or issue: {repo, number, kind: "pr"|"issue", state: "open"|"merged"|"closed",
    // since, title}, or {repo, number, state: "unknown"} when it could not be checked.
    async state(repo, number) {
      try {
        const issue = await get(`/repos/${repo}/issues/${number}`);
        const pr = issue.pull_request;
        // The issue's own record of a PR carries merged_at; an older reply may not.
        const merged =
          pr && ("merged_at" in pr ? pr.merged_at : (await get(`/repos/${repo}/pulls/${number}`)).merged_at);
        const state = merged ? "merged" : issue.state === "closed" ? "closed" : "open";
        const since = merged ?? (state === "closed" ? issue.closed_at : issue.created_at);
        return {
          repo,
          number,
          kind: pr ? "pr" : "issue",
          state,
          since: since?.slice(0, 10) ?? null,
          title: clean(issue.title ?? ""),
        };
      } catch {
        return { repo, number, state: "unknown" };
      }
    },
    // What is going on in a repository, titles only: {repo, open_prs, merged_last_7_days,
    // open_issues}, or {repo, error} when it could not be checked.
    async overview(repo) {
      try {
        const [open, closed, issues] = await Promise.all([
          get(`/repos/${repo}/pulls?state=open&per_page=${LISTED}`),
          get(`/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`),
          get(`/repos/${repo}/issues?state=open&per_page=30`),
        ]);
        const after = now() - MERGED_DAYS * 24 * 3600 * 1000;
        return {
          repo,
          open_prs: pick(open, clean),
          merged_last_7_days: pick(
            closed.filter((p) => p.merged_at && Date.parse(p.merged_at) >= after),
            clean,
          ),
          open_issues: pick(
            issues.filter((i) => !i.pull_request),
            clean,
          ),
        };
      } catch {
        return { repo, error: "could not check" };
      }
    },
  };
}

// Which of these texts name a PR or issue that is merged or closed, checked in code, not
// by the model (INTENT: facts are deterministic). Returns Map(index → {ref, state}). A
// lookup that fails keeps the text.
export async function closedRefs(github, texts) {
  const out = new Map();
  if (!github?.repos?.length) return out;
  await Promise.all(
    texts.map(async (text, i) => {
      for (const { repo, number } of refsIn(text, github.repos)) {
        const s = await github.state(repo, number);
        if (s.state === "merged" || s.state === "closed") {
          out.set(i, { ref: `${repo}#${number}`, state: s.state });
          return;
        }
      }
    }),
  );
  return out;
}

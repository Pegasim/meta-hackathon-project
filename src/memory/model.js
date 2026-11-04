// Model client for OpenAI-compatible chat completions.
// "meta" (the default) and "meta-contributor" are Meta's Model API: same model;
// Contributor costs far less, Meta may train on its inputs and outputs, and it is
// only offered in some countries. Tuck sends people's notes to the model, so
// Contributor is not offered in settings: it stays resolvable only so settings
// saved earlier still load, and privateSettings() swaps it out of every call.
// Muse Spark Open and Muse Glimmer are not
// served on the Model API: the Spark Open entries are the hosts Meta's deploy
// docs list; Glimmer is on OpenRouter or runs locally through Ollama.

export const DEFAULT_PROVIDER = "meta";

export const PROVIDERS = {
  "meta-contributor": { baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3-contributor" },
  meta: { baseUrl: "https://api.meta.ai/v1", model: "muse-spark-1.3" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "meta/muse-glimmer-30b" },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "muse-glimmer" },
  together: { baseUrl: "https://api.together.xyz/v1", model: "meta-models/muse-spark-open" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", model: "accounts/fireworks/models/muse-spark-open" },
  baseten: { baseUrl: "https://inference.baseten.co/v1", model: "meta-models/muse-spark-open" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", model: "meta-models/muse-spark-open" },
  nebius: { baseUrl: "https://api.tokenfactory.us-north1.nebius.com/v1", model: "meta-models/muse-spark-open" },
};

export function resolveConfig({ provider = DEFAULT_PROVIDER, baseUrl, model, apiKey } = {}) {
  const p = PROVIDERS[provider] ?? {};
  const config = { baseUrl: (baseUrl ?? p.baseUrl ?? "").replace(/\/$/, ""), model: model ?? p.model, apiKey };
  if (!config.baseUrl || !config.model) throw new Error(`unknown provider "${provider}" and no baseUrl/model given`);
  // A local Ollama server needs no key.
  if (!config.apiKey && provider !== "ollama") throw new Error("no API key set");
  return config;
}

// Why a reply came back without usable text. A reasoning model's hidden reasoning counts
// against max_tokens, so it can use the whole budget and leave no reply. err.cut: the
// limit did it, so a smaller request may fit.
function emptyReply({ choices, usage }) {
  const finish = choices?.[0]?.finish_reason ?? null;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  const spent = reasoning ? `: ${reasoning.toLocaleString("en-US")} reasoning tokens` : "";
  const cut = finish === "length";
  const why = cut
    ? "reply cut at max_tokens (length)"
    : `model reply has no message content (${finish ?? "no finish_reason"})`;
  return Object.assign(new Error(why + spent), { cut });
}

async function post(fetchImpl, { baseUrl, model, apiKey }, messages, opts, extra = {}) {
  const { maxTokens = 4000, temperature = 0.2, reasoningEffort } = opts;
  const res = await fetchImpl(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
      ...extra,
    }),
  });
  if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Returns complete(messages, opts) -> reply text. reasoningEffort is sent only when set,
// since not every provider takes it. whole: a reply cut at the limit is an error even if
// it has some text, for a caller that can only use all of it.
export function modelClient(settings, fetchImpl = globalThis.fetch) {
  const config = resolveConfig(settings);
  return async function complete(messages, opts = {}) {
    const data = await post(fetchImpl, config, messages, opts);
    const { whole = false } = opts;
    const text = data.choices?.[0]?.message?.content;
    const cut = data.choices?.[0]?.finish_reason === "length";
    if (typeof text !== "string" || (cut && (whole || !text))) throw emptyReply(data);
    return text;
  };
}

// For the agent loop (agent/loop.js): returns chat(messages, {tools, ...opts}) -> the
// assistant message, {role, content, tool_calls}, as the provider sent it (OpenAI-style
// `tools`). A reply with neither text nor a tool call is an error.
export function toolClient(settings, fetchImpl = globalThis.fetch) {
  const config = resolveConfig(settings);
  return async function chat(messages, { tools, ...opts } = {}) {
    const data = await post(fetchImpl, config, messages, opts, tools?.length ? { tools, tool_choice: "auto" } : {});
    const message = data.choices?.[0]?.message;
    if (!message || (!message.tool_calls?.length && typeof message.content !== "string")) throw emptyReply(data);
    return {
      role: "assistant",
      content: message.content ?? null,
      ...(message.tool_calls && { tool_calls: message.tool_calls }),
    };
  };
}

// Settings live in chrome.storage.session (memory only, gone when the browser
// closes) unless the user asks to remember them on this device.
const KEY = "modelSettings";

export async function loadModelSettings() {
  const { [KEY]: session } = await chrome.storage.session.get(KEY);
  if (session) return session;
  const { [KEY]: local } = await chrome.storage.local.get(KEY);
  return local;
}

export async function saveModelSettings(settings, { remember = false } = {}) {
  await chrome.storage.session.set({ [KEY]: settings });
  if (remember) await chrome.storage.local.set({ [KEY]: settings });
  else await chrome.storage.local.remove(KEY);
}

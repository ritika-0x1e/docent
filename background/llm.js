// B3: section headings + one-line summaries, on demand (the panel's "Generate headings" button),
// via Gemini Flash-Lite or a local Ollama model (E5). Never blocks anything — any failure leaves
// fallback headings and null summaries. Prompt/response logic is in lib/section-prompt.js.
// Loaded into the service worker with importScripts().

// Stable models per Google's model list (checked 2026-11-05). Not "-latest" aliases, which are
// swapped to new releases and could change output mid-project.
// Free tier for 3.6 Flash is only 5 RPM / 20 RPD (AI Studio, 2026-11-05), so B3 uses Flash-Lite
// and leaves Flash's quota for chat (phase 6).
const GEMINI_CHAT_MODEL = "gemini-3.6-flash";
const GEMINI_LABEL_MODEL = "gemini-3.5-flash-lite";
const geminiUrl = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
// An idle MV3 service worker can be stopped after ~30s, so never sleep longer than this on a 429.
const MAX_RETRY_WAIT_MS = 20000;
const DEFAULT_RETRY_WAIT_MS = 5000;

// E5: local Ollama. Ollama rejects (403) any browser Origin it wasn't told to allow, and changing
// OLLAMA_ORIGINS on a system install needs root. Instead a session rule drops the Origin header from
// this extension's own requests to Ollama (other sites keep Ollama's protection), and the narrow
// localhost:11434 host permission lets the service worker read the reply (spec §7.1).
const OLLAMA_URL = "http://localhost:11434";
const OLLAMA_ORIGIN_RULE_ID = 1;

async function installOllamaOriginRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [OLLAMA_ORIGIN_RULE_ID],
    addRules: [
      {
        id: OLLAMA_ORIGIN_RULE_ID,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
        condition: { urlFilter: `|${OLLAMA_URL}/`, initiatorDomains: [chrome.runtime.id], resourceTypes: ["xmlhttprequest"] },
      },
    ],
  });
}

function retryDelayMs(response, body) {
  const header = Number(response.headers.get("retry-after"));
  if (header > 0) return header * 1000;
  const info = body?.error?.details?.find((d) => String(d["@type"] || "").endsWith("RetryInfo"));
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(info?.retryDelay || "");
  return seconds ? Number(seconds[1]) * 1000 : DEFAULT_RETRY_WAIT_MS;
}

// "gemini" (default: Gemini, falling back to Ollama on quota exhaustion when a model is set) or "ollama".
async function getLlmConfig() {
  const { geminiApiKey, llmProvider, ollamaModel } = await chrome.storage.local.get(["geminiApiKey", "llmProvider", "ollamaModel"]);
  return { geminiKey: geminiApiKey || null, provider: llmProvider === "ollama" ? "ollama" : "gemini", ollamaModel: ollamaModel || null };
}

function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });
}

// The key goes in a header, not the URL, so it never shows up in logged request URLs.
async function callGemini(body, key, { model = GEMINI_LABEL_MODEL, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(geminiUrl(model), {
      signal,
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (response.ok) return json;

    const wait = retryDelayMs(response, json);
    // 429 (rate limit) and 503 ("model overloaded", seen during the combined run) are both temporary.
    if ((response.status === 429 || response.status === 503) && attempt === 0 && wait <= MAX_RETRY_WAIT_MS) {
      await abortableSleep(wait, signal); // Stop shouldn't wait out a retry delay

      continue;
    }
    throw Object.assign(new Error(`Gemini HTTP ${response.status}: ${json?.error?.message ?? "no details"}`), { status: response.status });
  }
}

// Opens an Ollama /api/chat request and returns the (ok) response, or throws a readable error.
// Aborting (signal) closes the connection, and Ollama cancels the job when its client goes away.
async function fetchOllama(body, { signal } = {}) {
  await installOllamaOriginRule(); // idempotent; session rules don't survive a browser restart
  let response;
  try {
    response = await fetch(`${OLLAMA_URL}/api/chat`, { signal, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`Couldn't reach Ollama at ${OLLAMA_URL}. Is it running?`);
  }
  if (response.status === 403) throw new Error("Ollama refused the request (HTTP 403): its origin check still saw the extension. Reload the extension; if it persists, set OLLAMA_ORIGINS=chrome-extension://* for Ollama.");
  if (response.status === 404) throw new Error(`Ollama has no model "${body.model}". Run: ollama pull ${body.model}`);
  if (!response.ok) {
    const json = await response.json().catch(() => null);
    throw new Error(`Ollama HTTP ${response.status}: ${json?.error ?? "no details"}`);
  }
  return response;
}

async function callOllama(body, { signal } = {}) {
  const response = await fetchOllama(body, { signal });
  // Streamed reply: bytes keep arriving while the model works, so MV3 doesn't stop the service
  // worker for a fetch that seems stalled (it does after ~30s without a response).
  return ollamaToGeminiShape(joinOllamaStream(await response.text()));
}

/**
 * @param {{onBatch?: (sections) => void, signal?: AbortSignal}} opts  onBatch gets each batch's labelled
 *   sections as it lands; aborting signal ("Stop" in the panel) ends the run, keeping finished batches
 * @returns {Promise<{sections, stats: {skipped?: string, provider, fallback, batches, labelled, errors, ms}}>}
 *   skipped: "no-key" (nothing configured) | "no-ollama-model"; fallback: why Ollama took over, if it did;
 *   stopped: true if aborted
 */
async function labelSections(sections, pageTitle, { onBatch = () => {}, signal } = {}) {
  // A local model can take minutes; an extension API call every 20s resets MV3's 30s idle timer.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    return await labelSectionsInner(sections, pageTitle, onBatch, signal);
  } finally {
    clearInterval(keepAlive);
  }
}

async function labelSectionsInner(sections, pageTitle, onBatch, signal) {
  const t0 = Date.now();
  const { geminiKey, provider, ollamaModel } = await getLlmConfig();

  let backend = provider;
  let fallback = null;
  if (backend === "gemini" && !geminiKey) {
    if (ollamaModel) [backend, fallback] = ["ollama", "no-gemini-key"];
    else return skippedLabels(sections, "no-key");
  }
  if (backend === "ollama" && !ollamaModel) return skippedLabels(sections, "no-ollama-model");

  const results = new Map();
  const errors = [];
  let batches = 0;
  let remaining = sections;
  while (remaining.length && !signal?.aborted) {
    const batch = remaining.slice(0, backend === "gemini" ? LLM_BATCH_SIZE : OLLAMA_BATCH_SIZE);
    try {
      const reply =
        backend === "gemini"
          ? await callGemini(buildRequestBody(batch, pageTitle), geminiKey, { signal })
          : await callOllama(buildOllamaBody(batch, pageTitle, ollamaModel), { signal });
      batches++;
      const { results: batchResults, error } = parseResponse(batch, reply);
      for (const [id, r] of batchResults) results.set(id, r);
      if (error) errors.push(error);
      onBatch(applyResults(batch, batchResults));
    } catch (err) {
      if (signal?.aborted) break;
      // Any Gemini failure (quota, overload after the retry, bad key, network error…): hand this
      // batch and the rest to the local model instead (E5). Ollama's own failures are just errors.
      if (backend === "gemini" && ollamaModel) {
        console.warn("[B3] Gemini failed, falling back to Ollama:", err.message);
        [backend, fallback] = ["ollama", err.status === 429 ? "gemini-quota" : err.status === 503 ? "gemini-overloaded" : "gemini-error"];
        continue;
      }
      batches++;
      errors.push(err.message);
    }
    remaining = remaining.slice(batch.length);
  }
  return {
    sections: applyResults(sections, results),
    stats: { provider: backend, fallback, stopped: Boolean(signal?.aborted), batches, labelled: results.size, errors, ms: Date.now() - t0 },
  };
}

function skippedLabels(sections, skipped) {
  return {
    sections: applyResults(sections, new Map()),
    stats: { skipped, provider: null, fallback: null, batches: 0, labelled: 0, errors: [], ms: 0 },
  };
}

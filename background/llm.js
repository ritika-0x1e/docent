// B3: section headings + one-line summaries via Gemini. Batched; never blocks the pipeline — any
// failure leaves fallback headings and null summaries. Prompt/response logic is in lib/section-prompt.js.
// Loaded into the service worker with importScripts().

// Stable model per Google's model list (checked 2026-11-03). Not the "-latest" alias, which is
// swapped to new releases and could change output mid-project. Free-tier availability unverified.
const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
// An idle MV3 service worker can be stopped after ~30s, so never sleep longer than this on a 429.
const MAX_RETRY_WAIT_MS = 20000;
const DEFAULT_RETRY_WAIT_MS = 5000;

async function getGeminiKey() {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  return geminiApiKey || null;
}

function retryDelayMs(response, body) {
  const header = Number(response.headers.get("retry-after"));
  if (header > 0) return header * 1000;
  const info = body?.error?.details?.find((d) => String(d["@type"] || "").endsWith("RetryInfo"));
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(info?.retryDelay || "");
  return seconds ? Number(seconds[1]) * 1000 : DEFAULT_RETRY_WAIT_MS;
}

// The key goes in a header, not the URL, so it never shows up in logged request URLs.
async function callGemini(body, key) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (response.ok) return json;

    const wait = retryDelayMs(response, json);
    if (response.status === 429 && attempt === 0 && wait <= MAX_RETRY_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    throw new Error(`Gemini HTTP ${response.status}: ${json?.error?.message ?? "no details"}`);
  }
}

/**
 * @param {{llm?: boolean}} opts  llm: false skips the network entirely (fallback headings only)
 * @returns {Promise<{sections, stats: {skipped?: string, batches, labelled, errors, ms}}>}
 */
async function labelSections(sections, pageTitle, { llm = true } = {}) {
  const t0 = Date.now();
  const key = llm ? await getGeminiKey() : null;
  if (!key) {
    return {
      sections: applyResults(sections, new Map()),
      stats: { skipped: llm ? "no-key" : "disabled", batches: 0, labelled: 0, errors: [], ms: 0 },
    };
  }

  const results = new Map();
  const errors = [];
  const batches = batchSections(sections);
  for (const batch of batches) {
    try {
      const { results: batchResults, error } = parseResponse(batch, await callGemini(buildRequestBody(batch, pageTitle), key));
      for (const [id, r] of batchResults) results.set(id, r);
      if (error) errors.push(error);
    } catch (err) {
      // "Failed to fetch" here would mean CORS blocked the call: add the narrow host permission (plan, B3).
      errors.push(err.message);
    }
  }
  return {
    sections: applyResults(sections, results),
    stats: { batches: batches.length, labelled: results.size, errors, ms: Date.now() - t0 },
  };
}

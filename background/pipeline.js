// A → B → C scan pipeline for one tab, run by the side panel's Start scan (H2) and the console helpers.
// Moved out of the Phase A–C harness unchanged; it now also reports progress stages for the panel.
// Loaded into the service worker with importScripts().

const HANDSHAKE_TIMEOUT_MS = 2000;

const CONTENT_FILES = [
  "content/vendor/readability.js",
  "lib/classify.js",
  "lib/text.js",
  "lib/sections-headings.js",
  "lib/gdocs.js",
  "lib/markdown-blocks.js",
  "content/extract.js",
  "content/classify.js",
  "content/blocks.js",
  "content/anchor.js",
  "content/sources.js",
  "content/bootstrap.js",
];

// Starts listening for the content script's "ready" message. Must be called *before* injecting:
// bootstrap.js sends "ready" as soon as it runs, which can arrive before executeScript's promise
// resolves — a listener registered afterwards would miss it and misreport a normal page as blocked.
// Returns { promise, cancel } — cancel() tears down the listener if injection fails.
function listenForHandshake(tabId, timeoutMs) {
  let listener;
  let timer;
  let resolveFn;
  let settled = false;

  const settle = (result) => {
    if (settled) return;
    settled = true;
    chrome.runtime.onMessage.removeListener(listener);
    clearTimeout(timer);
    resolveFn(result);
  };

  const promise = new Promise((resolve) => {
    resolveFn = resolve;

    listener = (message, sender) => {
      if (sender.tab?.id !== tabId) return;
      if (message?.type !== "ready") return;
      settle(message.error ? { blocked: true, reason: "ready-with-error", detail: message.error } : { blocked: false });
    };

    chrome.runtime.onMessage.addListener(listener);
  });

  return {
    promise,
    startTimeout: () => {
      timer = setTimeout(() => settle({ blocked: true, reason: "handshake-timeout" }), timeoutMs);
    },
    cancel: () => settle({ blocked: true, reason: "cancelled" }),
  };
}

// Content scripts persist in the tab's isolated world until navigation, so a second scan on the
// same page must not re-inject: lib/classify.js's top-level consts would throw on redeclaration
// and bootstrap.js would stack a duplicate onMessage listener. bootstrap.js sets this flag once it's up.
// This probe is itself an executeScript call, so restricted URLs reject here (A4: injection-rejected).
async function isAlreadyInjected(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => globalThis.__summarizerContentLoaded === true,
  });
  return injection?.result === true;
}

async function attemptScan(tabId, { force = false } = {}) {
  let alreadyInjected;
  try {
    alreadyInjected = await isAlreadyInjected(tabId);
  } catch (e) {
    return { blocked: true, reason: "injection-rejected", detail: e.message };
  }

  if (!alreadyInjected) {
    const handshake = listenForHandshake(tabId, HANDSHAKE_TIMEOUT_MS);
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    } catch (e) {
      handshake.cancel();
      return { blocked: true, reason: "injection-rejected", detail: e.message };
    }
    handshake.startTimeout();
    const result = await handshake.promise;
    if (result.blocked) return result;
  }

  const response = await chrome.tabs.sendMessage(tabId, { type: "scan", force });
  return { blocked: false, response };
}

// The content script's non-ok scan results, as panel progress stages.
function scanOutcomeStage(scan) {
  if (scan.blocked) return { stage: "blocked", reason: scan.reason, detail: scan.detail ?? null };
  const { response } = scan;
  if (response.status === "needs-force-scan") return { stage: "needs-force", classifyResult: response.classifyResult };
  if (response.status === "source-error") return { stage: "source-error", source: response.source, reason: response.reason, error: response.error };
  return { stage: "error", message: response.error ?? `unexpected scan status: ${response.status}` };
}

/**
 * A: extraction/anchoring/B1 in the content script, then B2 (if no headings), B3 ∥ C1, and C2 here.
 * The finished sections are kept in session storage per tab, so the console helpers still work
 * after the service worker has been stopped and restarted.
 * @param {(progress: {stage: string}) => void} onProgress  stages: extracting, sectioning, sectioned,
 *   labelling (+ a "summaries" message per B3 batch), saving, then one of done | needs-force | blocked |
 *   source-error (errors are thrown)
 */
async function runScan(tabId, { force = false, llm = true } = {}, onProgress = () => {}) {
  onProgress({ stage: "extracting" });
  const scan = await attemptScan(tabId, { force });
  if (scan.blocked || scan.response?.status !== "ok") {
    onProgress(scanOutcomeStage(scan));
    return scan;
  }

  const { response } = scan;
  let raw = response.sections;
  let b2 = null;
  if (!raw) {
    onProgress({ stage: "sectioning", detail: { semantic: true, blocks: response.blocks.length } });
    b2 = await sectionSemantically(response.blocks);
    raw = b2.sections;
  }
  const finalized = finalizeSections(raw, response.blocks);
  // Fallback headings for now; B3's generated headings and summaries arrive with "done".
  onProgress({ stage: "sectioned", sections: applyResults(finalized, new Map()) });

  // B3 and C1 run in parallel: chunk text uses only HTML headings, never generated ones.
  onProgress({ stage: "labelling", detail: { sections: finalized.length } });
  const [b3, embedded] = await Promise.all([
    labelSections(finalized, response.article.title, { llm, onBatch: (sections) => onProgress({ stage: "summaries", sections }) }),
    embedSectionChunks(finalized),
  ]);

  onProgress({ stage: "saving", detail: { chunks: embedded.chunks.length } });
  const tab = await chrome.tabs.get(tabId);
  let corpusId = null;
  let storeError = null;
  try {
    corpusId = await saveCorpus({
      url: tab.url,
      title: response.article.title,
      source: response.source,
      embeddingModel: embedded.stats.model,
      sections: b3.sections,
      chunks: embedded.chunks,
    });
  } catch (err) {
    storeError = err.message; // sections stay usable in session storage; only persistence failed
  }

  await chrome.storage.session.set({ [`scan:${tabId}`]: { url: tab.url, source: response.source, corpusId, sections: b3.sections } });
  const result = {
    ...scan,
    sections: b3.sections,
    b2Stats: b2?.stats ?? null,
    b3Stats: b3.stats,
    cStats: { corpusId, storeError, chunks: embedded.chunks.length, ...embedded.stats },
  };
  onProgress({
    stage: "done",
    sections: b3.sections,
    corpusId,
    detail: { source: response.source, title: response.article.title, b3Skipped: b3.stats.skipped ?? null, b3Errors: b3.stats.errors.length, storeError },
  });
  return result;
}

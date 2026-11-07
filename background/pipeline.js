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

// Injects the content scripts unless they're already there; { blocked: false } once they answer.
async function ensureInjected(tabId) {
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
  return { blocked: false };
}

async function attemptScan(tabId, { force = false } = {}) {
  const injected = await ensureInjected(tabId);
  if (injected.blocked) return injected;
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
 * A: extraction/anchoring/B1 in the content script, then B2 (if no headings), C1 and C2 here.
 * B3 (headings/summaries) is on demand since 2026-11-05 (the panel's "Generate headings"), so a scan
 * never spends LLM quota; sections carry fallback headings and null summaries until then.
 * The finished sections are kept in session storage per tab, so the console helpers still work
 * after the service worker has been stopped and restarted.
 * @param {(progress: {stage: string}) => void} onProgress  stages: extracting, sectioning, sectioned,
 *   embedding, saving, then one of done | needs-force | blocked | source-error (errors are thrown)
 */
async function runScan(tabId, { force = false } = {}, onProgress = () => {}) {
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
  const sections = applyResults(finalizeSections(raw, response.blocks), new Map()); // fallback headings
  onProgress({ stage: "sectioned", sections });

  onProgress({ stage: "embedding", detail: { sections: sections.length } });
  const embedded = await embedSectionChunks(sections);

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
      sections,
      chunks: embedded.chunks,
    });
  } catch (err) {
    storeError = err.message; // sections stay usable in session storage; only persistence failed
  }

  await chrome.storage.session.set({ [`scan:${tabId}`]: { url: tab.url, source: response.source, corpusId, sections } });
  const result = {
    ...scan,
    sections,
    b2Stats: b2?.stats ?? null,
    cStats: { corpusId, storeError, chunks: embedded.chunks.length, ...embedded.stats },
  };
  onProgress({
    stage: "done",
    sections,
    corpusId,
    detail: { source: response.source, title: response.article.title, storeError },
  });
  return result;
}

/**
 * G3 / H2: Start scan into the tab's thread (null = a new thread), per the §3.11 matrix.
 *   new-thread → full scan, then a thread is created with this page
 *   append     → full scan, then the page is added to the thread
 *   cache-hit  → no scan: the saved corpus is loaded and its anchors rebuilt in the tab (H3)
 *   rescan     → (decision 2) full scan, and the page's corpus in the thread is replaced
 * Progress goes through onProgress like runScan's; the final "done" also carries the thread.
 */
async function scanIntoThread(tabId, { threadId = null, force = false, rescan = false } = {}, onProgress = () => {}) {
  const thread = threadId ? await getThread(threadId) : null;
  if (threadId && !thread) {
    onProgress({ stage: "error", message: "That thread was deleted. Close it (×) and scan again to start a new one." });
    return null;
  }

  const url = (await chrome.tabs.get(tabId)).url;
  const action = scanAction(thread, url); // url is undefined without access: the scan reports that
  const page = findPage(thread, url);
  if (action === "cache-hit" && !rescan) {
    const stored = await getCorpus(page.corpusRef);
    if (stored) return loadSavedScan(tabId, thread, stored, onProgress);
    // Its corpus is gone (e.g. clearCorpora): scan again into the same place.
  }

  let done = null;
  const result = await runScan(tabId, { force }, (progress) => (progress.stage === "done" ? (done = progress) : onProgress(progress)));
  if (!done) return result; // needs-force, blocked, source-error: already reported

  let saved = thread;
  if (done.corpusId) {
    const tabUrl = (await chrome.tabs.get(tabId)).url;
    const entry = { url: tabUrl, title: done.detail.title, corpusRef: done.corpusId };
    const now = Date.now();
    if (!thread) saved = await saveThread(newThread({ id: crypto.randomUUID(), page: entry, now }));
    // Applied to the thread as stored now: chat may have added messages while this page scanned.
    else saved = await updateThread(thread.id, (fresh) => (page ? replacePage(fresh, page.url, entry, now) : withPage(fresh, entry, now)));
    if (!saved) {
      onProgress({ stage: "error", message: "That thread was deleted during the scan. Scan again to start a new one." });
      await deleteCorpus(done.corpusId).catch(() => {});
      return result;
    }
    await setTabThread(tabId, { threadId: saved.id });
    if (page && page.corpusRef !== done.corpusId) await deleteCorpus(page.corpusRef).catch(() => {});
    await chrome.storage.session.set({ [`scan:${tabId}`]: { ...(await getLastScanRecord(tabId)), threadId: saved.id } });
  }
  onProgress({ ...done, threadId: saved?.id ?? null, thread: saved, cacheHit: false });
  return result;
}

// H3: the page is already in the thread. Rebuild its live ranges from the stored anchors (Google
// Docs has none; jump works without), then hand the saved sections to the panel.
async function loadSavedScan(tabId, thread, { corpus, sections }, onProgress) {
  onProgress({ stage: "loading" });
  const injected = await ensureInjected(tabId);
  if (injected.blocked) {
    onProgress(scanOutcomeStage(injected));
    return null;
  }

  let live = sections;
  if (corpus.source !== "gdocs") {
    const blocks = sections.flatMap((s) => s.blocks).filter((b) => b.anchor);
    const reply = await chrome.tabs.sendMessage(tabId, { type: "reanchor-blocks", blocks });
    const anchored = new Set(reply?.anchored ?? []);
    live = sections.map((s) => ({ ...s, blocks: s.blocks.map((b) => ({ ...b, anchored: anchored.has(b.id) })) }));
    const total = blocks.length;
    console.log(`[Summarizer/G3] cache hit: ${corpus.title}; re-anchored ${anchored.size}/${total} blocks, nothing embedded`);
  } else {
    console.log(`[Summarizer/G3] cache hit: ${corpus.title} (Google Doc, jump only), nothing embedded`);
  }

  await chrome.storage.session.set({
    [`scan:${tabId}`]: { url: corpus.url, source: corpus.source, corpusId: corpus.corpusId, threadId: thread.id, sections: live },
  });
  await setTabThread(tabId, { threadId: thread.id });
  onProgress({
    stage: "done",
    sections: live,
    corpusId: corpus.corpusId,
    threadId: thread.id,
    thread,
    cacheHit: true,
    detail: { source: corpus.source, title: corpus.title, storeError: null },
  });
  return { cacheHit: true, sections: live };
}

async function getLastScanRecord(tabId) {
  const key = `scan:${tabId}`;
  return (await chrome.storage.session.get(key))[key] ?? {};
}

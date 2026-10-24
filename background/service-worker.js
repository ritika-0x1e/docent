// Phase A test harness (temporary — see docs/phased-implementation-plan/phase-A-extraction-classification.md).
// Real orchestration moves to H2's "Start scan" button in phase 4; this exists only so A1-A4
// can be verified in isolation before the side panel (I1) is built.
//
// Usage: click the toolbar icon on any tab, then check this file's output in
// chrome://extensions -> Summarizer -> "service worker" devtools console.

const HANDSHAKE_TIMEOUT_MS = 2000;

const CONTENT_FILES = [
  "content/vendor/readability.js",
  "content/extract.js",
  "content/classify.js",
  "lib/classify.js",
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

// Content scripts persist in the tab's isolated world until navigation, so a second toolbar click
// on the same page must not re-inject: lib/classify.js's top-level consts would throw on redeclaration
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

async function runHarness(tabId) {
  console.log(`[Summarizer/A] scanning tab ${tabId}...`);
  const result = await attemptScan(tabId);

  if (result.blocked) {
    console.warn(`[Summarizer/A] site restricts extension access (${result.reason})`, result.detail || "");
    return;
  }

  const { response } = result;
  if (response.status === "ok") {
    console.log("[Summarizer/A] extracted:", response.article?.title, `(${response.classifyResult.wordCount} words)`);
    console.log("[Summarizer/A] classification:", response.classifyResult);
  } else if (response.status === "needs-force-scan") {
    console.log("[Summarizer/A] sparse/media-dominated page — would show banner+force-scan in side panel (A3).", response.classifyResult);
    console.log(`[Summarizer/A] to simulate the override, run: forceScan(${tabId})`);
  } else {
    console.error("[Summarizer/A] content script reported an error:", response.error);
  }
}

// Exposed for manual testing from the service worker devtools console (A3 override simulation).
globalThis.forceScan = async (tabId) => {
  const response = await chrome.tabs.sendMessage(tabId, { type: "scan", force: true });
  console.log("[Summarizer/A] forced scan result:", response);
  return response;
};

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  runHarness(tab.id);
});

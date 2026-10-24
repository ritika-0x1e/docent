// A4: entry point for the injected content script bundle.
// Sends a "ready" handshake so the background worker can distinguish
// "injection blocked outright" from "injected but broke before it could respond"
// (e.g. a Trusted Types violation) — background times out waiting for this if it never arrives.
//
// A1/A2 orchestration also lives here for now, since there's no side panel (I1) yet to own it.

(function bootstrap() {
  try {
    chrome.runtime.sendMessage({ type: "ready" });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== "scan") return; // not ours to handle

      try {
        const article = extractArticle();
        const measurements = measurePage(article);
        const classifyResult = classifyPage(measurements);

        const proceed = message.force || classifyResult.classification === "text";

        sendResponse({
          status: proceed ? "ok" : "needs-force-scan",
          article: article ? { title: article.title, textContent: article.textContent, excerpt: article.excerpt } : null,
          classifyResult,
        });
      } catch (err) {
        sendResponse({ status: "error", error: String(err && err.message ? err.message : err) });
      }

      return true; // keep the message channel open in case sendResponse is deferred by an engine quirk
    });

    // Read by background's isAlreadyInjected() so repeat scans on this page skip re-injection.
    globalThis.__summarizerContentLoaded = true;
  } catch (err) {
    // Best-effort: if something (e.g. a page-level restriction) breaks even this,
    // background's handshake timeout is the real backstop — this send may never land.
    try {
      chrome.runtime.sendMessage({ type: "ready", error: String(err && err.message ? err.message : err) });
    } catch (_) {
      /* nothing more we can do */
    }
  }
})();

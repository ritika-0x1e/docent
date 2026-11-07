// A4: entry point for the injected content script bundle.
// Sends a "ready" handshake so the background worker can distinguish
// "injection blocked outright" from "injected but broke before it could respond"
// (e.g. a Trusted Types violation) — background times out waiting for this if it never arrives.
//
// The DOM-bound half of the pipeline runs here: source detection (A5), extraction (A1/A5),
// classification (A2), blocks + anchoring and the B1 heading split. B2 (embeddings) and B3 (LLM)
// run in the background, which needs only the blocks returned from here.

async function extractBlocks(source) {
  if (source.kind === "gdocs") {
    const { title, blocks } = await extractGoogleDoc(source.docs);
    return { title, excerpt: null, blocks, measurements: measureBlocks(blocks), articleChars: null };
  }
  if (source.kind === "markdown") {
    const { title, blocks } = extractMarkdown();
    return { title, excerpt: null, blocks, measurements: measureBlocks(blocks), articleChars: null };
  }
  const article = extractArticle();
  return {
    title: article?.title ?? document.title,
    excerpt: article?.excerpt ?? null,
    blocks: dropTrailingBackMatter(parseBlocks(article?.content)),
    measurements: measurePage(article),
    articleChars: normalizeText(article?.textContent || "").length,
  };
}

async function handleScan(message) {
  const source = detectSource();
  const t0 = performance.now();

  let extracted;
  try {
    extracted = await extractBlocks(source);
  } catch (err) {
    if (err instanceof SourceError) return { status: "source-error", source: source.kind, reason: err.reason, error: err.message };
    throw err;
  }
  const { title, excerpt, blocks, measurements, articleChars } = extracted;
  const classifyResult = classifyPage(measurements);
  const article = { title, excerpt };

  if (!message.force && classifyResult.classification !== "text") {
    return { status: "needs-force-scan", source: source.kind, article, classifyResult };
  }

  const t1 = performance.now();
  const anchored = source.kind === "gdocs" ? skipAnchoring(blocks) : anchorBlocks(blocks);
  const t2 = performance.now();

  // B1 here; null means fewer than 2 headings and the background runs B2 on the blocks.
  const sections = splitByHeadings(anchored);
  if (sections && source.kind === "gdocs") addOutlineJumps(sections, anchored);

  const blockChars = blocks.reduce((n, b) => n + b.text.length, 0);
  return {
    status: "ok",
    source: source.kind,
    article,
    classifyResult,
    blocks: anchored,
    sections,
    stats: {
      blocks: blocks.length,
      anchoredExact: anchored.filter((b) => b.match === "exact").length,
      anchoredEdges: anchored.filter((b) => b.match === "edges").length,
      unanchored: anchored.filter((b) => !b.anchored).length,
      anchoringSkipped: source.kind === "gdocs",
      // Share of Readability's text that landed in some block; low values mean blocks.js misses content.
      blockCoverage: articleChars ? blockChars / articleChars : null,
      msExtract: Math.round(t1 - t0),
      msAnchoring: Math.round(t2 - t1),
    },
  };
}

(function bootstrap() {
  try {
    chrome.runtime.sendMessage({ type: "ready" });

    const handlers = {
      scan: handleScan,
      "highlight-blocks": (message) => debugHighlight(message.blockIds),
      "reanchor-blocks": (message) => ({ ok: true, anchored: reanchorBlocks(message.blocks) }),
      // E3: the text selected on the page when a question is sent ("" if none).
      "get-selection": () => ({ ok: true, text: normalizeText(String(window.getSelection() ?? "")) }),
      "jump-to-outline-heading": (message) => jumpToOutlineHeading(message.jump),
      "clear-highlight": () => (clearDebugHighlight(), { ok: true }),
    };

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const handler = handlers[message?.type];
      if (!handler) return; // not ours to handle

      Promise.resolve()
        .then(() => handler(message))
        .then(sendResponse, (err) => sendResponse({ status: "error", error: String(err && err.message ? err.message : err) }));

      return true; // response is async (the Google Docs export fetch)
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

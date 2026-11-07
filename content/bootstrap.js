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
  const links = harvestLinks(article?.content ?? null); // D1: before parseBlocks reshapes the content
  return {
    title: article?.title ?? document.title,
    excerpt: article?.excerpt ?? null,
    links,
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
  const { title, excerpt, blocks, measurements, articleChars, links = [] } = extracted;
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
    links, // D1 (phase 9): raw link occurrences, cleaned and scored in the background
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

// E3 explain mode: the selected text, plus the paragraph it sits in, so a word or phrase is explained
// in context. A selection spanning blocks is its own context.
var CONTEXT_BLOCK = "p, li, dd, dt, td, th, blockquote, figcaption, h1, h2, h3, h4, h5, h6, pre";
// Pages that draw their text on a canvas keep the real selection elsewhere. Google Docs mirrors it
// into a hidden same-origin frame it uses for copy and paste (checked 2026-11-07): read it there.
function frameSelectionText() {
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      const text = normalizeText(String(frame.contentWindow?.getSelection() ?? ""));
      if (text) return text;
    } catch {
      /* another origin: not readable, and not where a page keeps its own selection */
    }
  }
  return "";
}

function selectionWithContext() {
  const selection = window.getSelection();
  const text = normalizeText(String(selection ?? ""));
  if (!text) return { ok: true, text: frameSelectionText(), context: "" }; // the background finds a Doc's paragraph in its saved scan
  if (!selection.rangeCount) return { ok: true, text, context: "" };
  const range = selection.getRangeAt(0);
  const blockOf = (node) => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest(CONTEXT_BLOCK);
  const start = blockOf(range.startContainer);
  const context = start && start === blockOf(range.endContainer) ? normalizeText(readableText(start)) : "";
  return { ok: true, text, context: context === text ? "" : context };
}

// Ctrl+Esc with text selected: send it to the panel's chat as a quote (user, 2026-11-07). Only when
// something is selected, so the key still does whatever else the page uses it for.
// After the extension is reloaded, scripts already in open pages are left behind, cut off from it;
// their listeners still fire, and chrome.runtime throws "Extension context invalidated". Such a
// script quietly does nothing instead (chrome.runtime.id is gone once it's cut off).
function extensionAlive() {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function sendToExtension(message) {
  if (!extensionAlive()) return;
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch {
    /* cut off between the check and the call */
  }
}

// In Google Docs the keys go to its hidden frame, never this document, so same-origin frames get
// the listener too (now, and again after a click, in case the page added one).
function onQuoteKey(event) {
  if (event.key !== "Escape" || !event.ctrlKey || !extensionAlive()) return;
  const { text, context } = selectionWithContext();
  if (!text) return;
  event.preventDefault();
  sendToExtension({ type: "selection-to-chat", text, context });
}

// Every load of this script installs its own listener and removes the previous load's: after an
// extension reload the old one is cut off, and a "register once" flag would leave only that one.
function listenForQuoteKey() {
  const previous = globalThis.__summarizerQuoteHandler;
  globalThis.__summarizerQuoteHandler = onQuoteKey;
  const docs = [document];
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      if (frame.contentDocument) docs.push(frame.contentDocument);
    } catch {
      /* another origin */
    }
  }
  for (const doc of docs) {
    if (previous && previous !== onQuoteKey) doc.removeEventListener("keydown", previous, true);
    doc.addEventListener("keydown", onQuoteKey, true); // adding the same listener twice is a no-op
  }
}

listenForQuoteKey();
document.removeEventListener("mousedown", globalThis.__summarizerQuoteRescan ?? listenForQuoteKey, true);
globalThis.__summarizerQuoteRescan = listenForQuoteKey;
document.addEventListener("mousedown", listenForQuoteKey, true);

(function bootstrap() {
  try {
    chrome.runtime.sendMessage({ type: "ready" });

    const handlers = {
      // Answered only by a live script: one left behind by an extension reload can't reply.
      ping: () => ({ ok: true }),
      scan: handleScan,
      "highlight-blocks": (message) => debugHighlight(message.blockIds),
      "reanchor-blocks": (message) => ({ ok: true, anchored: reanchorBlocks(message.blocks) }),
      // E3: the text selected on the page when a question is sent ("" if none).
      "get-selection": () => selectionWithContext(),
      "jump-to-outline-heading": (message) => jumpToOutlineHeading(message.jump),
      // F1/F2 (phase 7): a citation's passage and section; Show on page for a reading-view card.
      "highlight-citation": (message) => highlightCitation(message.blocks, message.passages),
      "clear-citation": () => ({ ok: true, cleared: clearCitation() }),
      "flash-section": (message) => flashSection(message.blocks),
      // The panel closed: nothing it showed stays on the page.
      "clear-highlight": () => (clearDebugHighlight(), clearCitation(), clearFlash(), { ok: true }),
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

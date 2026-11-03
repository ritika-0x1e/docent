// Phase A-B test harness (temporary — see docs/phased-implementation-plan/phase-B-sectioning.md).
// Real orchestration moves to H2's "Start scan" button in phase 4 (background/pipeline.js); this
// exists only so A, A5 and B can be verified before the side panel (I1) is built.
//
// Usage: click the toolbar icon on any tab, then check this file's output in
// chrome://extensions -> Summarizer -> "service worker" devtools console.

importScripts(
  "offscreen-client.js",
  "../lib/vector.js",
  "../lib/breakpoints.js",
  "../lib/sections.js",
  "../lib/section-prompt.js",
  "../lib/chunk.js",
  "../lib/retrieval.js",
  "vendor/idb.js",
  "sectioning.js",
  "llm.js",
  "embedder.js",
  "store.js",
  "retriever.js"
);

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

const DEBUG_HIGHLIGHT_CSS = "::highlight(summarizer-debug) { background-color: #ffe066; color: #000; }";

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

// A → B: content script extraction/anchoring/B1, then B2 (if no headings) and B3 here.
// The finished sections are kept in session storage per tab, so the console helpers below still
// work after the service worker has been stopped and restarted.
async function runPipeline(tabId, { force = false, llm = true } = {}) {
  const scan = await attemptScan(tabId, { force });
  if (scan.blocked || scan.response?.status !== "ok") return scan;

  const { response } = scan;
  let raw = response.sections;
  let b2 = null;
  if (!raw) {
    b2 = await sectionSemantically(response.blocks);
    raw = b2.sections;
  }
  const finalized = finalizeSections(raw, response.blocks);

  // B3 and C1 run in parallel: chunk text uses only HTML headings, never generated ones.
  const [b3, embedded] = await Promise.all([
    labelSections(finalized, response.article.title, { llm }),
    embedSectionChunks(finalized),
  ]);

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
  return {
    ...scan,
    sections: b3.sections,
    b2Stats: b2?.stats ?? null,
    b3Stats: b3.stats,
    cStats: { corpusId, storeError, chunks: embedded.chunks.length, ...embedded.stats },
  };
}

async function getLastScan(tabId) {
  const key = `scan:${tabId}`;
  return (await chrome.storage.session.get(key))[key] ?? null;
}

function logSections({ response, sections, b2Stats, b3Stats, cStats }) {
  const { stats } = response;
  const method = sections[0]?.method ?? "none";
  const anchored = stats.anchoredExact + stats.anchoredEdges;
  const rate = stats.blocks ? ((100 * anchored) / stats.blocks).toFixed(1) : "0";

  console.log(
    `[Summarizer/B] source ${response.source}; ${sections.length} sections (${method}); ` +
      (stats.anchoringSkipped
        ? "anchoring skipped (Google Docs: canvas page, citations use snippet + jump); "
        : `anchored ${anchored}/${stats.blocks} blocks = ${rate}% (exact ${stats.anchoredExact}, edges ${stats.anchoredEdges}, unanchored ${stats.unanchored}); `) +
      (stats.blockCoverage === null ? "" : `block coverage ${(100 * stats.blockCoverage).toFixed(1)}%; `) +
      `extract ${stats.msExtract}ms, anchoring ${stats.msAnchoring}ms`
  );
  if (b2Stats) {
    console.log(
      `[Summarizer/B2] ${b2Stats.units} units embedded; model load ${b2Stats.msModelLoad}ms, embed ${b2Stats.msEmbed}ms`
    );
  }
  if (b3Stats.skipped) {
    console.log(`[Summarizer/B3] skipped (${b3Stats.skipped}) — fallback headings used. ${b3Stats.skipped === "no-key" ? 'Set a key with setGeminiKey("…").' : ""}`);
  } else {
    console.log(`[Summarizer/B3] ${b3Stats.labelled}/${sections.length} sections labelled in ${b3Stats.batches} batches, ${b3Stats.ms}ms`);
    for (const err of b3Stats.errors) console.warn("[Summarizer/B3]", err);
  }

  console.table(
    sections.map((s, i) => ({
      i,
      heading: s.heading,
      source: s.headingSource,
      path: s.headingPath.join(" > "),
      words: s.wordCount,
      anchored: `${s.blocks.filter((b) => b.anchored).length}/${s.blocks.length}`,
      jump: s.jump ? "yes" : "",
      summary: s.summary ?? "",
    }))
  );
  console.log(
    stats.anchoringSkipped
      ? "[Summarizer/B] jump to a section with: jumpTo(tabId, i)"
      : "[Summarizer/B] check a section on the page with: highlightSection(tabId, i)"
  );

  if (cStats.storeError) {
    console.error(`[Summarizer/C] corpus NOT stored: ${cStats.storeError}`);
  } else {
    console.log(
      `[Summarizer/C] stored corpus ${cStats.corpusId}: ${cStats.chunks} chunks embedded in ${cStats.msEmbed}ms. ` +
        `Ask it something with: query(tabId, "your question")`
    );
  }
}

async function runHarness(tabId, opts = {}) {
  console.log(`[Summarizer/A] scanning tab ${tabId}${opts.force ? " (forced)" : ""}${opts.llm === false ? " (no LLM)" : ""}...`);
  const result = await runPipeline(tabId, opts);

  if (result.blocked) {
    console.warn(`[Summarizer/A] site restricts extension access (${result.reason})`, result.detail || "");
    return result;
  }

  const { response } = result;
  if (response.status === "ok") {
    console.log("[Summarizer/A] extracted:", response.article?.title, `(${response.classifyResult.wordCount} words)`);
    console.log("[Summarizer/A] classification:", response.classifyResult);
    logSections(result);
  } else if (response.status === "needs-force-scan") {
    console.log("[Summarizer/A] sparse/media-dominated page — would show banner+force-scan in side panel (A3).", response.classifyResult);
    console.log(`[Summarizer/A] to simulate the override, run: forceScan(${tabId})`);
  } else if (response.status === "source-error") {
    console.warn(`[Summarizer/A5] couldn't read this ${response.source} source (${response.reason}): ${response.error}`);
  } else {
    console.error("[Summarizer/A] content script reported an error:", response.error);
  }
  return result;
}

// Exposed for manual testing from the service worker devtools console.
globalThis.scan = (tabId, opts) => runHarness(tabId, opts); // opts: {llm: false} skips B3
globalThis.forceScan = (tabId, opts) => runHarness(tabId, { ...opts, force: true }); // A3 override

globalThis.highlightSection = async (tabId, index) => {
  const section = (await getLastScan(tabId))?.sections[index];
  if (!section) return console.warn(`[Summarizer/B] no section ${index} for tab ${tabId} — scan it first`);
  if (!section.blocks.some((b) => b.anchored)) {
    return console.warn(`[Summarizer/B] section ${index} has no anchored text${section.jump ? " — try jumpTo(tabId, i)" : ""}`);
  }
  // insertCSS styles the highlight without touching the page DOM and isn't subject to page CSP.
  await chrome.scripting.insertCSS({ target: { tabId }, css: DEBUG_HIGHLIGHT_CSS });
  const result = await chrome.tabs.sendMessage(tabId, { type: "highlight-blocks", blockIds: section.blocks.map((b) => b.id) });
  console.log(`[Summarizer/B] highlightSection(${index}):`, result);
  return result;
};

globalThis.clearHighlight = (tabId) => chrome.tabs.sendMessage(tabId, { type: "clear-highlight" });

// A5a: Google Docs citations can't highlight (canvas), so they jump to the heading instead,
// by clicking its entry in the doc's outline sidebar (content/sources.js).
globalThis.jumpTo = async (tabId, index) => {
  const section = (await getLastScan(tabId))?.sections[index];
  if (!section) return console.warn(`[Summarizer/A5] no section ${index} for tab ${tabId} — scan it first`);
  if (!section.jump) return console.warn(`[Summarizer/A5] section ${index} has no heading to jump to — snippet only`);
  const result = await chrome.tabs.sendMessage(tabId, { type: "jump-to-outline-heading", jump: section.jump });
  if (result.ok) console.log(`[Summarizer/A5] jumped to "${section.heading}"`, result);
  else console.warn(`[Summarizer/A5] couldn't jump to "${section.heading}": ${result.error}`);
  return result;
};

// Stand-in for retrieval until Phase C: plain case-insensitive text search over the last scan's
// sections, so "find some content → highlight or jump to its section" can be tried end to end.
globalThis.findSection = async (tabId, query) => {
  const scan = await getLastScan(tabId);
  if (!scan) return console.warn(`[Summarizer/B] no scan for tab ${tabId} — scan it first`);
  const needle = query.toLowerCase();
  const hits = scan.sections
    .map((s, i) => ({ s, i, at: `${s.heading}\n${s.text}`.toLowerCase().indexOf(needle) }))
    .filter((h) => h.at !== -1);
  if (hits.length === 0) return console.log(`[Summarizer/B] no section contains "${query}"`);

  console.table(
    hits.map(({ s, i, at }) => {
      const body = `${s.heading}\n${s.text}`;
      return {
        i,
        heading: s.heading,
        snippet: `…${body.slice(Math.max(0, at - 40), at + needle.length + 60).replace(/\s+/g, " ")}…`,
        next: s.jump ? `jumpTo(${tabId}, ${i})` : s.blocks.some((b) => b.anchored) ? `highlightSection(${tabId}, ${i})` : "snippet only",
      };
    })
  );
};

// C3 (CP-C1): semantic retrieval over the tab's stored corpus. Works after a service-worker restart:
// the corpus id is in session storage and everything else is in IndexedDB.
globalThis.query = async (tabId, question, k = 5) => {
  const scan = await getLastScan(tabId);
  if (!scan?.corpusId) return console.warn(`[Summarizer/C] no stored corpus for tab ${tabId} — scan it first`);

  const t0 = Date.now();
  const { hits, staleCorpora } = await retrieve([scan.corpusId], question, k);
  if (staleCorpora.length) console.warn("[Summarizer/C] corpus was embedded with a different model — re-scan it");
  console.log(`[Summarizer/C] top ${hits.length} for "${question}" (${Date.now() - t0}ms)`);
  console.table(
    hits.map((h, rank) => ({
      rank: rank + 1,
      i: h.section.order,
      score: h.score.toFixed(3),
      heading: h.section.heading,
      chunk: h.bestChunkIndex,
      preview: h.section.text.slice(0, 80),
    }))
  );

  // Show the top hit on the page, the same way a citation will.
  const top = hits[0]?.section;
  if (top?.blocks.some((b) => b.anchored)) await highlightSection(tabId, top.order);
  else if (top?.jump) await jumpTo(tabId, top.order);
  return hits;
};

globalThis.listCorpora = async () => {
  const corpora = await listStoredCorpora();
  console.table(
    corpora.map((c) => ({
      corpusId: c.corpusId,
      title: c.title,
      source: c.source,
      sections: c.sectionCount,
      chunks: c.chunkCount,
      scanned: new Date(c.scannedAt).toLocaleString(),
    }))
  );
  return corpora;
};

globalThis.clearCorpora = async () => {
  await clearStoredCorpora();
  console.log("[Summarizer/C] all stored corpora deleted");
};

globalThis.setGeminiKey = async (key) => {
  await chrome.storage.local.set({ geminiApiKey: key });
  console.log("[Summarizer/B3] Gemini key saved"); // never log the key itself
};

// CP-B2: confirms the offscreen document + embedding worker + model load end to end.
globalThis.embed = async (texts) => {
  const { vectors, stats } = await embedTexts(texts);
  console.log(
    `[Summarizer/B] embedded ${stats.count} texts → dims [${vectors.map((v) => v.length).join(", ")}]; ` +
      `model load ${stats.msModelLoad}ms${stats.msModelLoad ? " (cold start)" : " (already loaded)"}, embed ${stats.msEmbed}ms`
  );
  return vectors;
};

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  runHarness(tab.id);
});

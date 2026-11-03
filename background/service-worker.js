// Background service worker: opens the side panel on toolbar click (I1), runs scans for it over a
// port (H2, background/pipeline.js), and keeps the Phase A–C console helpers for debugging until
// their real replacements exist (phase-4 plan, "Harness changes").
//
// Console: chrome://extensions -> Summarizer -> "service worker" devtools console.

importScripts(
  "offscreen-client.js",
  "pipeline.js",
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

const DEBUG_HIGHLIGHT_CSS = "::highlight(summarizer-debug) { background-color: #ffe066; color: #000; }";

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
  const result = await runScan(tabId, opts);

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

// The panel's requests about a scanned tab (phase 4: reading view + the temporary find-sections box,
// decision 2 — deleted when chat (I3) lands). Content scripts never send these.
const panelHandlers = {
  // Show a section on the page: live highlight when anchored, outline jump on Google Docs.
  "panel-show-section": async ({ tabId, index }) => {
    const section = (await getLastScan(tabId))?.sections[index];
    if (!section) return { ok: false, error: "This tab's scan is gone. Scan it again." };
    if (section.blocks.some((b) => b.anchored)) return highlightSection(tabId, index);
    if (section.jump) return jumpTo(tabId, index);
    return { ok: false, error: "This section can't be shown on the page." };
  },
  // Top-5 sections for a query, each with its best chunk's text as the snippet.
  "panel-find": async ({ tabId, query: text }) => {
    const scan = await getLastScan(tabId);
    if (!scan?.corpusId) return { ok: false, error: "Nothing stored for this tab yet. Scan it first." };
    const { hits, staleCorpora } = await retrieve([scan.corpusId], text, 5);
    if (staleCorpora.length) return { ok: false, error: "This scan used an older embedding model. Scan again." };
    return {
      ok: true,
      hits: hits.map((h) => {
        const chunk = chunkSection(h.section)[h.bestChunkIndex]?.text ?? h.section.text;
        return {
          index: h.section.order,
          score: h.score,
          heading: h.section.heading,
          headingSource: h.section.headingSource,
          headingPath: h.section.headingPath,
          snippet: chunk.slice(chunk.lastIndexOf("\n") + 1), // drop the heading-path prefix line
          action: h.section.blocks.some((b) => b.anchored) ? "highlight" : h.section.jump ? "jump" : null,
        };
      }),
    };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = panelHandlers[message?.type];
  if (!handler || sender.tab) return; // not ours, or from a content script
  handler(message).then(sendResponse, (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

// I1: the toolbar icon opens the panel; nothing scans until Start scan (H1).
// Opened from onClicked rather than setPanelBehavior({openPanelOnActionClick}): CP-4-1 showed the
// latter doesn't grant activeTab, while an onClicked click does. sidePanel.open() must run inside the
// click's user gesture, so nothing may be awaited before it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error("[Summarizer] sidePanel.open failed:", err));
  // An already-open panel can now read this tab's title; no receiver (panel just opening) is fine.
  chrome.runtime.sendMessage({ type: "action-clicked", tabId: tab.id }).catch(() => {});
});

// H2: the panel starts scans over a "scan" port and gets progress back on it. If the panel closes
// mid-scan the pipeline keeps going and the corpus is still saved; progress just has nowhere to go.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "scan") return;
  let connected = true;
  port.onDisconnect.addListener(() => (connected = false));
  const post = (message) => connected && port.postMessage(message);

  port.onMessage.addListener(async (message) => {
    if (message?.type !== "start") return;
    const { tabId, scanId, force = false } = message;
    try {
      await runScan(tabId, { force }, (progress) => post({ tabId, scanId, ...progress }));
    } catch (err) {
      console.error("[Summarizer] scan failed:", err);
      post({ tabId, scanId, stage: "error", message: String(err?.message ?? err) });
    }
  });
});

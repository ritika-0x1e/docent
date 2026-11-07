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
  "../lib/threads.js",
  "../lib/gemini-ladder.js",
  "../lib/chat-prompt.js",
  "../lib/grounding.js",
  "../lib/passages.js",
  "../lib/spelling.js",
  "../lib/web-search.js",
  "../lib/links.js",
  "../lib/explain-guard.js",
  "citation-styles.js",
  "vendor/idb.js",
  "sectioning.js",
  "llm.js",
  "embedder.js",
  "store.js",
  "tab-threads.js",
  "retriever.js",
  "crawl.js",
  "chat.js"
);

const DEBUG_HIGHLIGHT_CSS = "::highlight(summarizer-debug) { background-color: #ffe066; color: #000; }";

async function getLastScan(tabId) {
  const key = `scan:${tabId}`;
  return (await chrome.storage.session.get(key))[key] ?? null;
}

function logSections({ response, sections, b2Stats, cStats }) {
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
  console.log("[Summarizer/B3] on demand: run generateHeadings(tabId), or press Generate headings in the panel");

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
  console.log(`[Summarizer/A] scanning tab ${tabId}${opts.force ? " (forced)" : ""}...`);
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
globalThis.scan = (tabId, opts) => runHarness(tabId, opts);
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
  if (result?.ok) await rememberHighlight(tabId);
  console.log(`[Summarizer/B] highlightSection(${index}):`, result);
  return result;
};

// Highlights are cleared when the side panel that caused them closes. Tabs are recorded with their
// window in session storage, so this survives a service-worker restart between highlight and close.
const HIGHLIGHTED_KEY = "highlightedTabs"; // { [tabId]: windowId }

async function rememberHighlight(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return;
  const { [HIGHLIGHTED_KEY]: highlighted = {} } = await chrome.storage.session.get(HIGHLIGHTED_KEY);
  await chrome.storage.session.set({ [HIGHLIGHTED_KEY]: { ...highlighted, [tabId]: tab.windowId } });
}

async function clearHighlightsInWindow(windowId) {
  const { [HIGHLIGHTED_KEY]: highlighted = {} } = await chrome.storage.session.get(HIGHLIGHTED_KEY);
  const remaining = {};
  for (const [tabId, tabWindow] of Object.entries(highlighted)) {
    if (tabWindow !== windowId) remaining[tabId] = tabWindow;
    // The tab may have navigated (content script gone) or closed: nothing left to clear then.
    else chrome.tabs.sendMessage(Number(tabId), { type: "clear-highlight" }).catch(() => {});
  }
  await chrome.storage.session.set({ [HIGHLIGHTED_KEY]: remaining });
}

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
  console.log("[Summarizer/C] all stored corpora and threads deleted");
};

globalThis.listThreads = async () => {
  const threads = await listStoredThreads();
  console.table(
    threads.map((t) => ({ id: t.id, title: t.title, pages: t.pages.length, updated: new Date(t.updatedAt).toLocaleString(), urls: t.pages.map((p) => p.url).join("  ") }))
  );
  return threads;
};

globalThis.clearThreads = async () => {
  for (const t of await listStoredThreads()) await deleteThread(t.id);
  console.log("[Summarizer/G1] all threads and their corpora deleted");
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

// Only what the content script needs to find a section's text: ids and anchors, in page order.
function anchoredBlocks(section) {
  return section.blocks.filter((b) => b.anchored).map((b) => ({ id: b.id, anchor: { exact: b.anchor.exact } }));
}

const PAGE_LOAD_TIMEOUT_MS = 30000;

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const done = (ok) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(ok);
    };
    const listener = (id, info) => id === tabId && info.status === "complete" && done(true);
    const timer = setTimeout(() => done(false), PAGE_LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && done(true), () => done(false));
  });
}

// F3 (decision 4): a tab already showing the page (same normalized URL, this window first) is
// focused; otherwise the page opens in a new tab next to the current one. It joins the thread on its
// own: the thread already holds that page (tab-threads.js, page match).
async function focusOrOpen(pageUrl, fromTabId) {
  const from = await chrome.tabs.get(fromTabId).catch(() => null);
  const want = normalizeUrl(pageUrl);
  const tabs = await chrome.tabs.query({});
  const match = tabs.filter((t) => t.url && normalizeUrl(t.url) === want).sort((a, b) => (b.windowId === from?.windowId) - (a.windowId === from?.windowId))[0];
  let tab = match;
  if (match) {
    await chrome.tabs.update(match.id, { active: true });
    if (match.windowId !== from?.windowId) await chrome.windows.update(match.windowId, { focused: true });
  } else {
    tab = await chrome.tabs.create({ url: pageUrl, active: true, ...(from ? { windowId: from.windowId, index: from.index + 1 } : {}) });
  }
  return (await waitForTabLoad(tab.id)) ? tab.id : null;
}

async function showCitation(tabId, citation, open) {
  // A selection-mode answer's source is the selected text itself: one quote, no saved section.
  const section = citation.selection
    ? { blocks: [{ id: `selection:${citation.quote?.length}:${citation.quote?.slice(0, 40)}`, anchored: true, anchor: { exact: citation.quote ?? "" } }], jump: null }
    : (await getSections(citation.corpusId, [citation.sectionId]))[0];
  if (!section) return { ok: false, error: "This source's saved scan is gone." };
  let target = tabId;
  if (open) {
    if (!citation.pageUrl) return { ok: false, error: "This source has no page address." };
    target = await focusOrOpen(citation.pageUrl, tabId);
    if (target == null) return { ok: false, error: "The page didn't finish loading." };
  }
  const injected = await ensureInjected(target);
  if (injected.blocked) return { ok: false, needsAccess: true, tabId: target, error: "Can't reach that page. Allow site access and try again." };

  if (!section.blocks.some((b) => b.anchored)) {
    if (!section.jump) return { ok: false, tabId: target, error: "This source can't be shown on the page." };
    const result = await chrome.tabs.sendMessage(target, { type: "jump-to-outline-heading", jump: section.jump });
    return { ...result, tabId: target, jumped: true };
  }
  await ensureCitationStyles(target);
  const result = await chrome.tabs.sendMessage(target, { type: "highlight-citation", blocks: anchoredBlocks(section), passages: citation.passages ?? [] });
  if (!result?.ok) return { ...result, tabId: target };
  if (!result.highlighted) return { ok: false, tabId: target, error: "This text isn't on the page any more." };
  await rememberHighlight(target);
  console.log(`[Summarizer/F1] citation ${citation.n}: ${result.passages ? `${result.passages} passage(s)` : "whole section"} highlighted on tab ${target}${open ? " (opened from another page)" : ""}`);
  return { ...result, tabId: target };
}

// The panel's requests about a scanned tab (reading view, thread links). Chat has its own port
// (bottom of this file); phase 4's temporary find-sections box was removed with it. Content scripts
// never send these.
const panelHandlers = {
  // Reading-view card (phase 7, decision 3): scroll to the section and flash it, then it fades.
  // Outline jump on Google Docs.
  "panel-show-section": async ({ tabId, index }) => {
    const section = (await getLastScan(tabId))?.sections[index];
    if (!section) return { ok: false, error: "This tab's scan is gone. Scan it again." };
    if (section.blocks.some((b) => b.anchored)) {
      await ensureCitationStyles(tabId);
      const result = await chrome.tabs.sendMessage(tabId, { type: "flash-section", blocks: anchoredBlocks(section) });
      return result?.highlighted ? result : { ok: false, error: "This section's text isn't on the page any more." };
    }
    if (section.jump) return jumpTo(tabId, index);
    return { ok: false, error: "This section can't be shown on the page." };
  },
  // F1/F2/F3 (phase 7): highlight a citation's passage and section. open: the citation is from
  // another page, so that page's tab is focused, or opened next to this one, first (decision 4).
  "panel-show-citation": ({ tabId, citation, open }) => showCitation(tabId, citation, open),
  "panel-clear-citation": async ({ tabId }) => {
    const result = await chrome.tabs.sendMessage(tabId, { type: "clear-citation" }).catch(() => null);
    return { ok: true, cleared: Boolean(result?.cleared) };
  },
  // B3 on demand ("Generate headings"): label the saved scan's sections that have no summary yet,
  // streaming each batch to the panel, then save in place. No re-extraction or re-embedding: chunk
  // vectors never depend on generated headings. Also the retry path after a failure.
  "panel-relabel": ({ tabId }) => generateHeadings(tabId),
  // "Stop" while generating: aborts the running LLM request (Ollama drops the job when the connection
  // closes); finished batches are kept. false if nothing is running, e.g. after a worker restart.
  "panel-stop-relabel": async ({ tabId }) => {
    const running = generations.get(tabId);
    running?.abort();
    return { ok: true, stopped: Boolean(running) };
  },
  // G2 (revised 2026-11-06): the thread this tab is in or continues, and the one it can reattach.
  "panel-tab-thread": async ({ tabId }) => ({ ok: true, ...(await tabThread(tabId)) }),
  "panel-detach-thread": async ({ tabId }) => ({ ok: true, ...(await detachTabThread(tabId)) }),
  "panel-reattach-thread": async ({ tabId }) => ({ ok: true, ...(await reattachTabThread(tabId)) }),
  // Decision 3: removes the thread and every corpus it points to; tabs linked to it start fresh.
  // E2 (phase 8): "Search the web" opens the query as a results page in a new tab next to this one, a
  // plain redirect (nothing is fetched or read). Opened from this tab, so it continues the thread
  // (decision 4, tab-threads.js opener rule).
  "panel-web-search": async ({ tabId, query }) => {
    const from = await chrome.tabs.get(tabId).catch(() => null);
    const { webSearchEngine } = await chrome.storage.local.get("webSearchEngine");
    const tab = await chrome.tabs.create({ url: searchUrl(query, webSearchEngine), active: true, ...(from ? { index: from.index + 1, windowId: from.windowId, openerTabId: tabId } : {}) });
    // Linked here rather than by the opener rule, which looks at the new tab's address on its first
    // load and can miss a tab created this way (phases 8–10 run).
    const { threadId } = await tabThread(tabId);
    if (threadId) await setTabThread(tab.id, { threadId });
    console.log(`[Summarizer/E2] web search opened in tab ${tab.id}: "${query}" (${SEARCH_ENGINES[webSearchEngine]?.name ?? "DuckDuckGo"})`);
    return { ok: true, tabId: tab.id };
  },
  // D5 (phase 9): this tab's linked pages for the picklist: the top 20 (D4) and every link (for the
  // filter), minus pages already in the thread. Scans from before phase 9 have no links saved.
  "panel-links": async ({ tabId }) => {
    const scan = await getLastScan(tabId);
    const stored = scan?.corpusId ? await getCorpus(scan.corpusId) : null;
    if (!stored) return { ok: false, error: "Scan this page first." };
    if (!Array.isArray(stored.corpus.links)) return { ok: false, rescan: true, error: "This page was scanned before linked pages existed. Rescan it to list them." };
    const thread = scan.threadId ? await getThread(scan.threadId) : null;
    // Links already in the thread stay listed, ticked and disabled (user, 2026-11-07): the picklist is
    // where you see which linked pages were added. They're pinned first; the top 20 are from the rest.
    const inThread = new Set((thread?.pages ?? []).map((p) => normalizeUrl(p.url)));
    const all = stored.corpus.links.map((l) => ({ ...l, inThread: inThread.has(normalizeUrl(l.url)) }));
    const top = [...all.filter((l) => l.inThread), ...allocatePicklist(all.filter((l) => !l.inThread))];
    return { ok: true, threadId: thread?.id ?? null, threadPages: thread?.pages.length ?? 0, from: { url: stored.corpus.url, title: stored.corpus.title }, top, all };
  },
  // D6: add the ticked pages. Progress goes out as "crawl-progress" messages; the reply is the result.
  "panel-crawl": async ({ threadId, from, links }) => {
    try {
      const result = await crawlLinks({ threadId, from, links }, (progress) => chrome.runtime.sendMessage({ type: "crawl-progress", threadId, ...progress }).catch(() => {}));
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },
  "panel-stop-crawl": async ({ threadId }) => {
    crawls.get(threadId)?.abort();
    return { ok: true };
  },
  // The page's selection and its paragraph (a quote dropped onto the chat looks up its context here).
  "panel-selection": async ({ tabId }) => ({ ok: true, ...(await pageSelection(tabId)) }),
  // Clear chat: the thread's conversation goes; its pages and scans stay. Not while it's answering.
  "panel-clear-chat": async ({ threadId }) => {
    if ([...liveChats.values()].some((live) => live.threadId === threadId)) return { ok: false, error: "Wait for the answer to finish, or stop it, first." };
    const thread = await updateThread(threadId, (fresh) => ({ ...fresh, messages: [] }));
    return thread ? { ok: true, thread } : { ok: false, error: "This thread is gone." };
  },
  "panel-delete-thread": async ({ threadId }) => {
    const ok = await deleteThread(threadId);
    await forgetThreadLinks(threadId);
    return { ok };
  },
};

const generations = new Map(); // tabId → AbortController of the running "Generate headings"

async function generateHeadings(tabId) {
  generations.get(tabId)?.abort(); // a second Generate for the same tab replaces the first
  const controller = new AbortController();
  generations.set(tabId, controller);
  try {
    return await generateHeadingsFor(tabId, controller.signal);
  } finally {
    if (generations.get(tabId) === controller) generations.delete(tabId);
  }
}

async function generateHeadingsFor(tabId, signal) {
  const scan = await getLastScan(tabId);
  const stored = scan?.corpusId && (await getCorpus(scan.corpusId));
  if (!stored) return { ok: false, error: "This tab's saved scan is gone. Scan it again." };

  const { corpusId } = scan;
  const pending = sectionsToRelabel(stored.sections);
  const onBatch = (sections) => chrome.runtime.sendMessage({ type: "relabel-progress", tabId, corpusId, sections }).catch(() => {});
  const b3 = await labelSections(pending, stored.corpus.title, { onBatch, signal });
  const sections = mergeRelabelled(stored.sections, b3.sections);
  await updateSections(corpusId, b3.sections);
  await chrome.storage.session.set({ [`scan:${tabId}`]: { ...scan, sections } });

  const { stats } = b3;
  for (const err of stats.errors) console.warn("[Summarizer/B3]", err);
  console.log(
    stats.skipped
      ? `[Summarizer/B3] skipped (${stats.skipped}): set a Gemini key or an Ollama model in the panel's ⚙`
      : `[Summarizer/B3] ${stats.labelled}/${pending.length} sections labelled via ${stats.provider}${stats.fallback ? ` (fallback: ${stats.fallback})` : ""} in ${stats.batches} batches, ${stats.ms}ms${stats.stopped ? " (stopped)" : ""}`
  );
  return {
    ok: true,
    corpusId,
    sections,
    b3Skipped: stats.skipped ?? null,
    b3Errors: stats.errors.length,
    b3Provider: stats.provider,
    b3Fallback: stats.fallback,
    b3Stopped: stats.stopped,
  };
}
globalThis.generateHeadings = generateHeadings;

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
// Each open panel holds a "panel:<windowId>" port; Chrome drops it when the panel closes.
chrome.runtime.onConnect.addListener((port) => {
  const match = /^panel:(\d+)$/.exec(port.name);
  if (!match) return;
  port.onDisconnect.addListener(() => clearHighlightsInWindow(Number(match[1])));
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "scan") return;
  let connected = true;
  port.onDisconnect.addListener(() => (connected = false));
  const post = (message) => connected && port.postMessage(message);

  port.onMessage.addListener(async (message) => {
    if (message?.type !== "start") return;
    const { tabId, scanId, force = false, threadId = null, rescan = false } = message;
    try {
      await scanIntoThread(tabId, { threadId, force, rescan }, (progress) => post({ tabId, scanId, ...progress }));
    } catch (err) {
      console.error("[Summarizer] scan failed:", err);
      post({ tabId, scanId, stage: "error", message: String(err?.message ?? err) });
    }
  });
});

// Phase 6 chat (I3): the panel asks over a "chat" port and gets the answer streamed back.
//   panel → {type: "ask", chatId, tabId, threadId, question, force} | {type: "stop", chatId}
//         | {type: "watch", threadId}: also stream any answer still running in that thread
//   background → {chatId, type: "sources", mode, count} | {chatId, type: "delta", text} | {chatId, type: "checking"}
//              | {chatId, type: "live", threadId, question, text, mode, status, checking, force}
//              | {chatId, type: "done", thread, message} | {chatId, type: "error", error}
// Closing the panel doesn't stop an answer (user, 2026-11-07): it finishes and is saved on the thread,
// and a panel opened meanwhile picks it up with "watch". Only Stop aborts. chatId is the panel's
// random id, unique across panels.
const liveChats = new Map(); // chatId → {threadId, question, text, mode, status, checking, force, controller, watchers}

function broadcast(live, message) {
  for (const post of live.watchers) post(message);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat") return;
  let connected = true;
  const post = (message) => connected && port.postMessage(message);
  port.onDisconnect.addListener(() => {
    connected = false;
    for (const live of liveChats.values()) live.watchers.delete(post);
  });

  port.onMessage.addListener(async (message) => {
    if (message?.type === "stop") return liveChats.get(message.chatId)?.controller.abort();
    if (message?.type === "watch") {
      for (const [chatId, live] of liveChats) {
        if (live.threadId !== message.threadId || live.watchers.has(post)) continue;
        live.watchers.add(post);
        const { question, text, mode, status, checking, force } = live;
        post({ chatId, type: "live", threadId: live.threadId, question, text, mode, status, checking, force });
      }
      return;
    }
    if (message?.type !== "ask") return;
    const { chatId, tabId, threadId, question, force, quote } = message;
    const live = { threadId, question, text: "", mode: null, status: "Finding sources…", checking: false, force: Boolean(force), controller: new AbortController(), watchers: new Set([post]) };
    liveChats.set(chatId, live);
    try {
      const result = await answerQuestion(
        { tabId, threadId, question, force: Boolean(force), quote: quote?.text ? quote : null },
        {
          signal: live.controller.signal,
          onSources: (info) => {
            live.mode = info.mode;
            live.status = info.mode === "selection" ? "Reading your selection…" : info.count ? `Read ${info.count} sections. Writing…` : "Writing…";
            broadcast(live, { chatId, type: "sources", ...info });
          },
          onDelta: (text) => {
            live.text += text;
            broadcast(live, { chatId, type: "delta", text });
          },
          onChecking: () => {
            live.checking = true;
            broadcast(live, { chatId, type: "checking" });
          },
        }
      );
      broadcast(live, { chatId, type: "done", thread: result.thread, message: result.message });
    } catch (err) {
      const stopped = live.controller.signal.aborted;
      if (!stopped) console.error("[Summarizer] chat failed:", err);
      broadcast(live, { chatId, type: "error", error: stopped ? "Stopped before any answer arrived." : String(err?.message ?? err) });
    } finally {
      liveChats.delete(chatId);
    }
  });
});

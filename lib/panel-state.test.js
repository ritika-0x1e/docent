const test = require("node:test");
const assert = require("node:assert/strict");
const { initialPanelState, panelReducer, activeTab, threadView, scanControls } = require("./panel-state.js");

const run = (events, state = initialPanelState()) => events.reduce(panelReducer, state);
const open = (tabId, title = `Tab ${tabId}`) => ({ type: "tab-activated", tabId, title, url: `https://example.com/${tabId}` });
const start = (tabId, scanId = 1) => ({ type: "scan-started", tabId, scanId });
const progress = (tabId, stage, extra = {}, scanId = 1) => ({ type: "scan-progress", tabId, scanId, stage, ...extra });

test("a newly shown tab starts idle with nothing running (H1)", () => {
  const tab = activeTab(run([open(1)]));
  assert.equal(tab.status, "idle");
  assert.equal(tab.title, "Tab 1");
  assert.equal(tab.sections, null);
});

test("Start scan moves through scanning stages to ready", () => {
  const sections = [{ id: "s0" }];
  const state = run([open(1), start(1), progress(1, "extracting"), progress(1, "sectioned", { sections }), progress(1, "embedding")]);
  assert.equal(activeTab(state).status, "scanning");
  assert.equal(activeTab(state).stage, "embedding");
  assert.deepEqual(activeTab(state).sections, sections, "sections from 'sectioned' stay visible while later stages run");

  const done = panelReducer(state, progress(1, "done", { sections, corpusId: "c1" }));
  assert.equal(activeTab(done).status, "ready");
  assert.equal(activeTab(done).corpusId, "c1");
});

test("terminal stages map to their statuses", () => {
  const cases = [
    [{ stage: "needs-force", classifyResult: { wordCount: 40 } }, "needs-force"],
    [{ stage: "blocked", reason: "injection-rejected", detail: "Cannot access" }, "blocked"],
    [{ stage: "source-error", source: "gdocs", reason: "export-failed", error: "403" }, "source-error"],
    [{ stage: "error", message: "boom" }, "error"],
  ];
  for (const [extra, status] of cases) {
    assert.equal(activeTab(run([open(1), start(1), progress(1, extra.stage, extra)])).status, status);
  }
  const blocked = activeTab(run([open(1), start(1), progress(1, "blocked", { reason: "injection-rejected", detail: "Cannot access" })]));
  assert.deepEqual(blocked.detail, { reason: "injection-rejected", message: "Cannot access" });
});

test("switching tabs keeps each tab's state; switching back restores it", () => {
  const state = run([open(1), start(1), progress(1, "done", { sections: [{ id: "s0" }], corpusId: "c1" }), open(2)]);
  assert.equal(activeTab(state).status, "idle");
  const back = panelReducer(state, open(1));
  assert.equal(activeTab(back).status, "ready");
  assert.equal(activeTab(back).corpusId, "c1");
});

test("progress for a background tab updates that tab, not the active one", () => {
  const state = run([open(1), start(1), open(2), progress(1, "done", { sections: [], corpusId: "c1" })]);
  assert.equal(activeTab(state).status, "idle");
  assert.equal(state.tabs[1].status, "ready");
});

test("navigation resets a tab to idle and ignores the cut-off scan's late messages", () => {
  const state = run([open(1), start(1), { type: "tab-navigated", tabId: 1, title: "New" }, progress(1, "done", { sections: [], corpusId: "c1" })]);
  assert.equal(activeTab(state).status, "idle");
  assert.equal(activeTab(state).title, "New");
});

test("a re-scan ignores messages from the scan it replaced", () => {
  const state = run([open(1), start(1, 1), start(1, 2), progress(1, "done", { sections: [], corpusId: "old" }, 1)]);
  assert.equal(activeTab(state).status, "scanning");
  const done = panelReducer(state, progress(1, "done", { sections: [], corpusId: "new" }, 2));
  assert.equal(activeTab(done).corpusId, "new");
});

test("Start scan on a ready tab runs again from scratch (no-thread row)", () => {
  const state = run([open(1), start(1, 1), progress(1, "done", { sections: [{ id: "s0" }], corpusId: "c1" }, 1), start(1, 2)]);
  assert.equal(activeTab(state).status, "scanning");
  assert.equal(activeTab(state).sections, null);
  assert.equal(activeTab(state).corpusId, null);
});

test("closing the active tab clears it; events for unknown tabs are ignored", () => {
  const state = run([open(1), { type: "tab-closed", tabId: 1 }]);
  assert.equal(activeTab(state), null);
  assert.deepEqual(state.tabs, {});
  assert.equal(run([{ type: "tab-navigated", tabId: 9 }, { type: "tab-info", tabId: 9, title: "x" }], state), state);
});

test("tab-info fills in a title without touching scan state", () => {
  const state = run([open(1, undefined), start(1), { type: "tab-info", tabId: 1, title: "Loaded" }]);
  assert.equal(activeTab(state).title, "Loaded");
  assert.equal(activeTab(state).status, "scanning");
});

test("a missing grant is no-access (fixable); other injection failures stay blocked (A4)", () => {
  const missing = "Cannot access contents of the page. Extension manifest must request permission to access the respective host.";
  const noAccess = activeTab(run([open(1), start(1), progress(1, "blocked", { reason: "injection-rejected", detail: missing })]));
  assert.equal(noAccess.status, "no-access");

  for (const detail of ["Cannot access a chrome:// URL", "The extensions gallery cannot be scripted."]) {
    assert.equal(activeTab(run([open(1), start(1), progress(1, "blocked", { reason: "injection-rejected", detail })])).status, "blocked");
  }
  assert.equal(activeTab(run([open(1), start(1), progress(1, "blocked", { reason: "handshake-timeout" })])).status, "blocked");
});

test("Generate headings batches fill in by id while it runs; other scans' batches are ignored", () => {
  const sections = [
    { id: "s0", heading: "Intro", summary: null },
    { id: "s1", heading: "Start of s1…", headingSource: "fallback", summary: null },
  ];
  const busy = run([open(1), start(1), progress(1, "done", { sections, corpusId: "c1" }), { type: "relabel-started", tabId: 1 }]);
  const batch = { type: "relabel-progress", tabId: 1, corpusId: "c1", sections: [{ id: "s1", heading: "Generated", headingSource: "generated", summary: "One line." }] };
  const tab = activeTab(panelReducer(busy, batch));
  assert.equal(tab.relabeling, true);
  assert.equal(tab.sections[0], sections[0]);
  assert.equal(tab.sections[1].heading, "Generated");
  assert.equal(tab.sections[1].summary, "One line.");
  assert.equal(panelReducer(busy, { ...batch, corpusId: "other" }), busy);
});

test("Generate headings swaps in relabelled sections and clears the B3 warning", () => {
  const ready = run([open(1), start(1), progress(1, "done", { sections: [{ id: "s0", summary: null }], corpusId: "c1", detail: { b3Errors: 1 } })]);
  const busy = panelReducer(ready, { type: "relabel-started", tabId: 1 });
  assert.equal(activeTab(busy).relabeling, true);
  assert.equal(panelReducer(busy, { type: "relabel-started", tabId: 1 }), busy, "no double start");

  const relabelled = [{ id: "s0", summary: "Now summarised." }];
  const done = activeTab(panelReducer(busy, { type: "relabel-done", tabId: 1, corpusId: "c1", ok: true, sections: relabelled, b3Skipped: null, b3Errors: 0 }));
  assert.equal(done.relabeling, false);
  assert.deepEqual(done.sections, relabelled);
  assert.equal(done.detail.b3Errors, 0);
  assert.equal(done.status, "ready");
});

test("a Generate headings result for an older scan is dropped", () => {
  const state = run([
    open(1),
    start(1, 1),
    progress(1, "done", { sections: [], corpusId: "c1" }, 1),
    { type: "relabel-started", tabId: 1 },
    start(1, 2),
    progress(1, "done", { sections: [{ id: "new" }], corpusId: "c2" }, 2),
  ]);
  const tab = activeTab(panelReducer(state, { type: "relabel-done", tabId: 1, corpusId: "c1", ok: true, sections: [{ id: "old" }] }));
  assert.deepEqual(tab.sections, [{ id: "new" }]);
  assert.equal(tab.relabeling, false);
});

test("a failed Generate headings keeps the sections and records the error", () => {
  const busy = run([open(1), start(1), progress(1, "done", { sections: [{ id: "s0" }], corpusId: "c1", detail: { b3Errors: 1 } }), { type: "relabel-started", tabId: 1 }]);
  const tab = activeTab(panelReducer(busy, { type: "relabel-done", tabId: 1, corpusId: "c1", ok: false, error: "gone" }));
  assert.deepEqual(tab.sections, [{ id: "s0" }]);
  assert.equal(tab.detail.relabelError, "gone");
  assert.equal(tab.detail.b3Errors, 1);
});

test("a stopped Generate keeps the finished sections and records that it was stopped", () => {
  const sections = [{ id: "s0", summary: null }, { id: "s1", summary: null }];
  const busy = run([open(1), start(1), progress(1, "done", { sections, corpusId: "c1" }), { type: "relabel-started", tabId: 1 }]);
  const partial = [{ id: "s0", summary: "Done." }, { id: "s1", summary: null }];
  const tab = activeTab(panelReducer(busy, { type: "relabel-done", tabId: 1, corpusId: "c1", ok: true, sections: partial, b3Errors: 0, b3Stopped: true }));
  assert.equal(tab.relabeling, false);
  assert.deepEqual(tab.sections, partial);
  assert.equal(tab.detail.b3Stopped, true);
});

// Phase 5: threads, linked per tab (revised 2026-11-06: no picker).
const thread = (id, urls, updatedAt = 1) => ({ id, title: id, createdAt: 1, updatedAt, pages: urls.map((url, i) => ({ url, title: url, corpusRef: `${id}-c${i}`, addedAt: 1 })), messages: [] });
const link = (tabId, t, detached = null) => ({ type: "tab-thread", tabId, threadId: t?.id ?? null, detachedThreadId: detached?.id ?? null, threads: [t, detached].filter(Boolean) });
const done = (tabId, t, extra = {}, scanId = 1) => progress(tabId, "done", { sections: [{ id: "s0" }], corpusId: t.pages.at(-1).corpusRef, threadId: t.id, thread: t, ...extra }, scanId);

test("a tab with no thread shows nothing; its scan makes a thread and shows its name", () => {
  let state = run([open(1)]);
  assert.deepEqual(threadView(state), { mode: "none", thread: null });
  const t = thread("t1", ["https://example.com/1"]);
  state = run([start(1), done(1, t)], state);
  assert.equal(activeTab(state).threadId, "t1");
  assert.equal(threadView(state).mode, "in");
  assert.deepEqual(scanControls(state), { start: false, rescan: true, savedIn: t });
});

test("a tab linked to a thread it isn't in yet is 'continued'; Start scan appends", () => {
  const t = thread("t1", ["https://example.com/1"]);
  const state = run([open(2), link(2, t)]);
  assert.deepEqual(threadView(state), { mode: "continued", thread: t });
  assert.deepEqual(scanControls(state), { start: true, rescan: false, savedIn: null });
});

test("a page already in the linked thread is 'in' before scanning, and Start scan is a cache hit", () => {
  const t = thread("t1", ["https://example.com/1#top"]);
  let state = run([open(1), link(1, t)]);
  assert.equal(threadView(state).mode, "in");
  assert.deepEqual(scanControls(state), { start: true, rescan: false, savedIn: t });
  state = run([start(1), done(1, t, { cacheHit: true })], state);
  assert.equal(activeTab(state).cacheHit, true);
  assert.equal(scanControls(state).rescan, true);
});

test("× leaves only a reattach button, and reattaching continues the thread again", () => {
  const t = thread("t1", ["https://example.com/1"]);
  let state = run([open(2), link(2, t), link(2, null, t)]);
  assert.deepEqual(threadView(state), { mode: "detached", thread: t });
  assert.equal(activeTab(state).threadId, null, "a scan now makes a new thread");
  state = panelReducer(state, link(2, t));
  assert.equal(threadView(state).mode, "continued");
});

test("navigating keeps the tab's link: a link followed from a thread page continues it", () => {
  const t = thread("t1", ["https://example.com/1"]);
  const state = run([open(1), start(1), done(1, t), { type: "tab-navigated", tabId: 1, url: "https://example.com/next" }]);
  assert.equal(activeTab(state).status, "idle");
  assert.equal(activeTab(state).threadId, "t1");
  assert.equal(threadView(state).mode, "continued");
});

test("a ready tab keeps the thread its scan is in, whatever link arrives late", () => {
  const t = thread("t1", ["https://example.com/1"]);
  const state = run([open(1), start(1), done(1, t), link(1, null)]);
  assert.equal(activeTab(state).threadId, "t1");
});

test("deleting a thread resets tabs showing it and drops links to it", () => {
  const t = thread("t1", ["https://example.com/1"]);
  const state = run([open(1), start(1), done(1, t), open(2), link(2, t), open(3), link(3, null, t), { type: "thread-deleted", threadId: "t1" }]);
  assert.equal(state.threads.length, 0);
  assert.equal(state.tabs[1].status, "idle");
  assert.equal(state.tabs[1].title, "Tab 1");
  assert.equal(state.tabs[1].threadId, null);
  assert.equal(state.tabs[2].threadId, null);
  assert.equal(state.tabs[3].detachedThreadId, null);
});

test("thread-updated replaces the panel's copy of a thread (a saved chat answer)", () => {
  const t = thread("t1", ["https://example.com/1"]);
  const withChat = { ...t, messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] };
  const state = run([open(1), start(1), done(1, t), { type: "thread-updated", thread: withChat }]);
  assert.equal(state.threads.length, 1);
  assert.equal(state.threads[0].messages.length, 2);
});

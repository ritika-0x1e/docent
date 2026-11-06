const test = require("node:test");
const assert = require("node:assert/strict");
const { initialPanelState, panelReducer, activeTab } = require("./panel-state.js");

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

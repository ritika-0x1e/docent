// H1/H2: side panel state as a pure reducer, (state, event) → state.
// DOM- and Chrome-free so it's unit-testable; sidepanel/panel.js feeds it events and renders the result.
// Phase 5: threads and the full Start scan matrix (H2/H3). Revised 2026-11-06 (user): no picker.
// Each tab is linked to the thread it continues (from the background's tab links, which follow
// navigation and opener tabs); × detaches it so the page starts a new thread, and it can reattach.
//
// Per-tab status: idle → scanning → ready | needs-force | no-access | blocked | source-error | error
// The map only lives while the panel is open (phase-4 plan, "Per-tab memory").

const SCAN_STATUSES = ["idle", "scanning", "ready", "needs-force", "no-access", "blocked", "source-error", "error"];

// Chrome's wording when the extension simply hasn't been granted the tab (fixable: grant access or
// click the icon), as opposed to pages extensions may never script (chrome://, the Web Store).
const MISSING_PERMISSION = /must request permission to access/i;

function isMissingPermission(event) {
  return event.reason === "injection-rejected" && MISSING_PERMISSION.test(event.detail ?? "");
}

if (typeof scanAction === "undefined" && typeof require === "function") {
  // Node tests: lib/threads.js is a global in the panel (a <script> before this one), a module here.
  Object.assign(globalThis, require("./threads.js"));
}

function initialPanelState() {
  return { activeTabId: null, tabs: {}, threads: [] };
}

// threadId: the thread a scan of this tab goes into, or its scan is in (null: a new thread).
// detachedThreadId: the thread the user closed with ×, offered for reattaching.
function idleTab(info = {}) {
  return {
    title: info.title ?? null,
    url: info.url ?? null,
    status: "idle",
    relabeling: false,
    scanId: null,
    stage: null,
    detail: null,
    sections: null,
    corpusId: null,
    threadId: info.threadId ?? null,
    detachedThreadId: info.detachedThreadId ?? null,
    cacheHit: false,
  };
}

function updateTab(state, tabId, patch) {
  const prev = state.tabs[tabId] ?? idleTab();
  return { ...state, tabs: { ...state.tabs, [tabId]: { ...prev, ...patch } } };
}

// A "Generate headings" batch landed: swap in its labelled sections by id, keeping the rest.
function mergeSections(sections, labelled) {
  if (!sections) return sections;
  const byId = new Map(labelled.map((s) => [s.id, s]));
  return sections.map((s) => byId.get(s.id) ?? s);
}

// Background progress messages (background/pipeline.js) → tab patches.
function progressPatch(event) {
  switch (event.stage) {
    case "done":
      return {
        status: "ready",
        stage: null,
        sections: event.sections,
        corpusId: event.corpusId,
        threadId: event.threadId ?? null,
        detachedThreadId: null,
        cacheHit: Boolean(event.cacheHit),
        detail: event.detail ?? null,
      };
    case "needs-force":
      return { status: "needs-force", stage: null, detail: event.classifyResult };
    case "blocked":
      return { status: isMissingPermission(event) ? "no-access" : "blocked", stage: null, detail: { reason: event.reason, message: event.detail ?? null } };
    case "source-error":
      return { status: "source-error", stage: null, detail: { source: event.source, reason: event.reason, message: event.error } };
    case "error":
      return { status: "error", stage: null, detail: { message: event.message } };
    case "sectioned":
      return { status: "scanning", stage: event.stage, sections: event.sections, detail: event.detail ?? null };
    default:
      return { status: "scanning", stage: event.stage, detail: event.detail ?? null };
  }
}

function panelReducer(state, event) {
  switch (event.type) {
    // The panel's window switched to (or first shows) a tab. Known tabs keep their state.
    case "tab-activated": {
      const known = state.tabs[event.tabId];
      const next = known
        ? updateTab(state, event.tabId, { title: event.title ?? known.title, url: event.url ?? known.url })
        : { ...state, tabs: { ...state.tabs, [event.tabId]: idleTab(event) } };
      return { ...next, activeTabId: event.tabId };
    }
    // Title/URL arrived later (e.g. after a load finished) without a navigation.
    case "tab-info":
      if (!state.tabs[event.tabId]) return state;
      return updateTab(state, event.tabId, { title: event.title ?? state.tabs[event.tabId].title, url: event.url ?? state.tabs[event.tabId].url });
    // A navigation or reload drops the content script and its ranges: back to "not scanned".
    // The thread link stays: a link followed from a thread page continues that thread.
    case "tab-navigated": {
      const tab = state.tabs[event.tabId];
      if (!tab) return state;
      return updateTab(state, event.tabId, { ...idleTab({ ...event, threadId: tab.threadId, detachedThreadId: tab.detachedThreadId }), title: event.title ?? null, url: event.url ?? null });
    }
    case "tab-closed": {
      const { [event.tabId]: _, ...tabs } = state.tabs;
      return { ...state, tabs, activeTabId: state.activeTabId === event.tabId ? null : state.activeTabId };
    }
    // H2: Start scan (or Rescan) into the tab's thread; the background picks the matrix row.
    case "scan-started":
      return updateTab(state, event.tabId, { status: "scanning", scanId: event.scanId, stage: "starting", detail: null, sections: null, corpusId: null, cacheHit: false });
    // Only the tab's current scan counts: a scan cut off by a navigation or a re-scan may still report.
    // A finished scan links the tab to its thread (a new one, for a tab that had none).
    case "scan-progress": {
      const tab = state.tabs[event.tabId];
      if (tab?.status !== "scanning" || tab.scanId !== event.scanId) return state;
      const next = updateTab(state, event.tabId, progressPatch(event));
      if (event.stage !== "done" || !event.thread) return next;
      return { ...next, threads: upsertThread(next.threads, event.thread) };
    }
    // A thread changed elsewhere (a chat answer was saved on it): replace our copy.
    case "thread-updated":
      return event.thread ? { ...state, threads: upsertThread(state.threads, event.thread) } : state;
    // The background's link for a tab (on activation or navigation, after × or reattach).
    case "tab-thread": {
      const tab = state.tabs[event.tabId];
      if (!tab) return state;
      let threads = state.threads;
      for (const t of event.threads ?? []) threads = upsertThread(threads, t);
      // A ready tab keeps the thread its scan is in.
      const threadId = tab.status === "ready" && tab.threadId ? tab.threadId : event.threadId ?? null;
      return { ...updateTab(state, event.tabId, { threadId, detachedThreadId: event.detachedThreadId ?? null }), threads };
    }
    // Decision 3: the thread's corpora are gone too, so tabs showing them go back to "not scanned".
    case "thread-deleted": {
      const tabs = {};
      for (const [id, tab] of Object.entries(state.tabs)) {
        let next = tab;
        if (tab.threadId === event.threadId && tab.status === "ready") next = { ...idleTab(tab), title: tab.title, url: tab.url };
        if (next.threadId === event.threadId) next = { ...next, threadId: null };
        if (next.detachedThreadId === event.threadId) next = { ...next, detachedThreadId: null };
        tabs[id] = next;
      }
      return { ...state, tabs, threads: state.threads.filter((t) => t.id !== event.threadId) };
    }
    // "Generate headings" (B3, on demand) on a ready tab: sections stay visible while it runs.
    case "relabel-started": {
      const tab = state.tabs[event.tabId];
      if (tab?.status !== "ready" || tab.relabeling) return state;
      return updateTab(state, event.tabId, { relabeling: true });
    }
    // Batches stream in while it runs; like relabel-done, only for the scan it was started on.
    case "relabel-progress": {
      const tab = state.tabs[event.tabId];
      if (!tab?.relabeling || tab.status !== "ready" || tab.corpusId !== event.corpusId) return state;
      return updateTab(state, event.tabId, { sections: mergeSections(tab.sections, event.sections) });
    }
    // Applies only to the scan it was started on; a rescan or navigation since then wins.
    case "relabel-done": {
      const tab = state.tabs[event.tabId];
      if (!tab?.relabeling) return state;
      if (tab.status !== "ready" || tab.corpusId !== event.corpusId) return updateTab(state, event.tabId, { relabeling: false });
      const patch = { relabeling: false };
      if (event.ok) {
        patch.sections = event.sections;
        patch.detail = {
          ...tab.detail,
          b3Skipped: event.b3Skipped,
          b3Errors: event.b3Errors,
          b3Provider: event.b3Provider ?? null,
          b3Fallback: event.b3Fallback ?? null,
          b3Stopped: Boolean(event.b3Stopped),
          relabelError: null,
        };
      } else {
        patch.detail = { ...tab.detail, relabelError: event.error };
      }
      return updateTab(state, event.tabId, patch);
    }
    default:
      return state;
  }
}

function upsertThread(threads, thread) {
  return sortThreads([...threads.filter((t) => t.id !== thread.id), thread]);
}

function activeTab(state) {
  return state.activeTabId === null ? null : state.tabs[state.activeTabId] ?? null;
}

function threadById(state, id) {
  return id ? state.threads.find((t) => t.id === id) ?? null : null;
}

/**
 * What the header shows about the active tab's thread:
 *   none       a new thread (nothing shown)
 *   continued  linked to a thread this page isn't in yet: "Continuing <name>" + ×
 *   in         the page is in the thread (scanned, or saved there): its name as a heading
 *   detached   × was pressed: only a reattach button
 */
function threadView(state) {
  const tab = activeTab(state);
  const thread = threadById(state, tab?.threadId);
  if (thread) {
    const isIn = (tab.status === "ready" && tab.threadId) || findPage(thread, tab.url);
    return { mode: isIn ? "in" : "continued", thread };
  }
  const detached = threadById(state, tab?.detachedThreadId);
  return detached ? { mode: "detached", thread: detached } : { mode: "none", thread: null };
}

/**
 * Which scan buttons the active tab gets. Start scan follows the matrix (its row is shown in the
 * status line); a tab showing its thread's scan gets Rescan instead (decision 2).
 * savedIn: the tab's thread, when it already holds this page (Start scan is then a cache hit).
 */
function scanControls(state) {
  const tab = activeTab(state);
  if (!tab) return { start: false, rescan: false, savedIn: null };
  const thread = threadById(state, tab.threadId);
  const showing = tab.status === "ready" && tab.threadId !== null;
  return { start: !showing, rescan: showing, savedIn: scanAction(thread, tab.url) === "cache-hit" ? thread : null };
}

if (typeof module === "object") {
  module.exports = { SCAN_STATUSES, initialPanelState, panelReducer, activeTab, threadView, scanControls, isMissingPermission };
}

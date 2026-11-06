// H1/H2 (partial, no threads): side panel state as a pure reducer, (state, event) → state.
// DOM- and Chrome-free so it's unit-testable; sidepanel/panel.js feeds it events and renders the result.
// Phase 5 extends it with the thread-selected rows of the scan-button matrix.
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

function initialPanelState() {
  return { activeTabId: null, tabs: {} };
}

function idleTab(info = {}) {
  return { title: info.title ?? null, url: info.url ?? null, status: "idle", relabeling: false, scanId: null, stage: null, detail: null, sections: null, corpusId: null };
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
      return { status: "ready", stage: null, sections: event.sections, corpusId: event.corpusId, detail: event.detail ?? null };
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
    case "tab-navigated":
      if (!state.tabs[event.tabId]) return state;
      return updateTab(state, event.tabId, { ...idleTab(event), title: event.title ?? null, url: event.url ?? null });
    case "tab-closed": {
      const { [event.tabId]: _, ...tabs } = state.tabs;
      return { ...state, tabs, activeTabId: state.activeTabId === event.tabId ? null : state.activeTabId };
    }
    // H2, "no thread selected" row: Start scan always runs the full pipeline, even on a ready tab.
    case "scan-started":
      return updateTab(state, event.tabId, { status: "scanning", scanId: event.scanId, stage: "starting", detail: null, sections: null, corpusId: null });
    // Only the tab's current scan counts: a scan cut off by a navigation or a re-scan may still report.
    case "scan-progress": {
      const tab = state.tabs[event.tabId];
      if (tab?.status !== "scanning" || tab.scanId !== event.scanId) return state;
      return updateTab(state, event.tabId, progressPatch(event));
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

function activeTab(state) {
  return state.activeTabId === null ? null : state.tabs[state.activeTabId] ?? null;
}

if (typeof module === "object") {
  module.exports = { SCAN_STATUSES, initialPanelState, panelReducer, activeTab, isMissingPermission };
}

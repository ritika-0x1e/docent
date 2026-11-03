// Side panel controller: follows its window's active tab, starts scans over a port to the background,
// and feeds tab/progress events through lib/panel-state.js's reducer before rendering.

const dom = {
  tabTitle: document.getElementById("tab-title"),
  status: document.getElementById("status"),
  startScan: document.getElementById("start-scan"),
  banner: document.getElementById("banner"),
  readingView: document.getElementById("reading-view"),
  findForm: document.getElementById("find-form"),
  findInput: document.getElementById("find-input"),
  findSubmit: document.getElementById("find-submit"),
  findResults: document.getElementById("find-results"),
  settingsToggle: document.getElementById("settings-toggle"),
  settings: document.getElementById("settings"),
  geminiKey: document.getElementById("gemini-key"),
  geminiKeyClear: document.getElementById("gemini-key-clear"),
  settingsStatus: document.getElementById("settings-status"),
};

// Spec §7.1 (phase 4): host access is requested once for all sites, from a Start scan click,
// the first time a tab without access is scanned. Clicking the toolbar icon still works without it.
const ALL_SITES = { origins: ["http://*/*", "https://*/*"] };

let state = initialPanelState();
let windowId = null;
let port = null;
let nextScanId = 1;
let hasAllSites = false;
// Find-sections results per tab, tied to the corpus they were searched in (decision 2, temporary).
const findResults = new Map(); // tabId → {corpusId, result}

const handlers = {
  onForceScan: () => startScan({ force: true }),
  onAllowAccess: () => requestAllSites().then((granted) => granted && startScan()),
  onOpenSettings: () => toggleSettings(true),
  onShowSection: (index) => showSection(index),
};

function dispatch(event) {
  state = panelReducer(state, event);
  render();
}

function render() {
  const tab = activeTab(state);
  renderHeader(tab, dom, handlers);
  renderReadingView(state.activeTabId, tab, dom.readingView, handlers);
  const found = findResults.get(state.activeTabId);
  renderFindResults(found && found.corpusId === tab?.corpusId ? found.result : null, dom.findResults, handlers);
}

async function showSection(index) {
  const tabId = state.activeTabId;
  const result = await chrome.runtime.sendMessage({ type: "panel-show-section", tabId, index });
  if (!result?.ok) console.warn("[Summarizer] couldn't show section", index, result?.error);
}

async function findSections(query) {
  const tabId = state.activeTabId;
  const corpusId = activeTab(state)?.corpusId;
  if (!query || !corpusId) return;
  findResults.set(tabId, { corpusId, result: { pending: true } });
  render();
  const result = await chrome.runtime.sendMessage({ type: "panel-find", tabId, query }).catch((err) => ({ ok: false, error: err.message }));
  findResults.set(tabId, { corpusId, result });
  render();
}

// ⚙: the same chrome.storage.local key Phase B's setGeminiKey writes. The value is never displayed back.
function toggleSettings(open = dom.settings.hidden) {
  dom.settings.hidden = !open;
  dom.settingsToggle.setAttribute("aria-expanded", String(open));
  if (open) refreshKeyStatus();
}

async function refreshKeyStatus() {
  const { geminiApiKey } = await chrome.storage.local.get("geminiApiKey");
  dom.settingsStatus.textContent = geminiApiKey ? "A key is saved. Rescan a page to generate headings." : "No key saved.";
}

// Must be called synchronously from a click: Chrome only shows the prompt during a user gesture.
function requestAllSites() {
  return chrome.permissions.request(ALL_SITES).then(
    (granted) => (hasAllSites = granted),
    (err) => (console.warn("[Summarizer] permission request failed:", err), false)
  );
}

// The port is opened lazily and re-opened if the service worker restarted and dropped it.
function scanPort() {
  if (port) return port;
  port = chrome.runtime.connect({ name: "scan" });
  port.onMessage.addListener((message) => dispatch({ type: "scan-progress", ...message }));
  port.onDisconnect.addListener(() => {
    port = null;
    // A scan in flight lost its progress channel; the background may still finish and save it.
    for (const [tabId, tab] of Object.entries(state.tabs)) {
      if (tab.status === "scanning") {
        dispatch({ type: "scan-progress", tabId: Number(tabId), scanId: tab.scanId, stage: "error", message: "Lost connection to the background worker. Try Start scan again." });
      }
    }
  });
  return port;
}

// Chrome hides tab.url for tabs the extension can't access, so a missing URL means this scan would
// fail. Ask for access first; if it's declined, scan anyway and let the no-access banner explain.
function startScan({ force = false } = {}) {
  const tabId = state.activeTabId;
  if (tabId === null) return;
  if (!hasAllSites && !activeTab(state).url) {
    requestAllSites().then(() => launchScan(tabId, force));
    return;
  }
  launchScan(tabId, force);
}

function launchScan(tabId, force) {
  const scanId = nextScanId++;
  dispatch({ type: "scan-started", tabId, scanId });
  scanPort().postMessage({ type: "start", tabId, scanId, force });
}

async function refreshTabInfo(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) dispatch({ type: "tab-info", ...tabInfo(tab) });
}

// Without the "tabs" permission, title and URL are only visible for tabs the extension has access to
// (activeTab or a host grant), so either can be undefined; the header falls back to "This tab".
function tabInfo(tab) {
  return { tabId: tab.id, title: tab.title, url: tab.url };
}

async function init() {
  ({ id: windowId } = await chrome.windows.getCurrent());
  hasAllSites = await chrome.permissions.contains(ALL_SITES);
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) dispatch({ type: "tab-activated", ...tabInfo(tab) });
  else dispatch({ type: "noop" });

  chrome.tabs.onActivated.addListener(async (info) => {
    if (info.windowId !== windowId) return;
    const activated = await chrome.tabs.get(info.tabId).catch(() => null);
    dispatch({ type: "tab-activated", ...(activated ? tabInfo(activated) : { tabId: info.tabId }) });
  });

  // changeInfo.url/title are only reported with access to the tab, so a new load ("loading") is
  // what marks a navigation. Reloads count too: they drop the content script and its ranges.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, updated) => {
    if (changeInfo.status === "loading") dispatch({ type: "tab-navigated", ...tabInfo(updated) });
    else if (changeInfo.title !== undefined || changeInfo.status === "complete") dispatch({ type: "tab-info", ...tabInfo(updated) });
  });

  chrome.tabs.onRemoved.addListener((tabId) => dispatch({ type: "tab-closed", tabId }));

  // Clicking the toolbar icon grants activeTab, which makes the tab's title readable.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "action-clicked") refreshTabInfo(message.tabId);
  });

  // Granted here or revoked in Chrome's settings: titles of every known tab may have changed.
  const onPermissionsChanged = async () => {
    hasAllSites = await chrome.permissions.contains(ALL_SITES);
    for (const tabId of Object.keys(state.tabs)) refreshTabInfo(Number(tabId));
  };
  chrome.permissions.onAdded.addListener(onPermissionsChanged);
  chrome.permissions.onRemoved.addListener(onPermissionsChanged);

  dom.startScan.addEventListener("click", () => startScan());
  dom.findForm.addEventListener("submit", (e) => {
    e.preventDefault();
    findSections(dom.findInput.value.trim());
  });
  dom.settingsToggle.addEventListener("click", () => toggleSettings());
  dom.settings.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = dom.geminiKey.value.trim();
    if (!key) return;
    await chrome.storage.local.set({ geminiApiKey: key });
    dom.geminiKey.value = "";
    refreshKeyStatus();
  });
  dom.geminiKeyClear.addEventListener("click", async () => {
    await chrome.storage.local.remove("geminiApiKey");
    refreshKeyStatus();
  });
}

init();

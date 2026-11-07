// Side panel controller: follows its window's active tab, starts scans over a port to the background,
// and feeds tab/progress events through lib/panel-state.js's reducer before rendering.

const dom = {
  tabTitle: document.getElementById("tab-title"),
  status: document.getElementById("status"),
  startScan: document.getElementById("start-scan"),
  rescan: document.getElementById("rescan"),
  threadRow: document.getElementById("thread-row"),
  reattachThread: document.getElementById("reattach-thread"),
  toast: document.getElementById("toast"),
  banner: document.getElementById("banner"),
  readingView: document.getElementById("reading-view"),
  chatLog: document.getElementById("chat-log"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  chatSend: document.getElementById("chat-send"),
  chatStop: document.getElementById("chat-stop"),
  chatClear: document.getElementById("chat-clear"),
  settingsToggle: document.getElementById("settings-toggle"),
  settings: document.getElementById("settings"),
  geminiKey: document.getElementById("gemini-key"),
  geminiKeyClear: document.getElementById("gemini-key-clear"),
  settingsStatus: document.getElementById("settings-status"),
  genRow: document.getElementById("gen-row"),
  llmProvider: document.getElementById("llm-provider"),
  webEngine: document.getElementById("web-engine"),
  ollamaModel: document.getElementById("ollama-model"),
};

// Spec §7.1 (phase 4): host access is requested once for all sites, from a Start scan click,
// the first time a tab without access is scanned. Clicking the toolbar icon still works without it.
const ALL_SITES = { origins: ["http://*/*", "https://*/*"] };

let state = initialPanelState();
let windowId = null;
let port = null;
let nextScanId = 1;
let hasAllSites = false;
// The chat answer in progress (one at a time per panel): {chatId, threadId, question, text, mode, status, error}.
let pending = null;
let chatPort = null;
let confirmingDelete = false;
let toastTimer = null;

const handlers = {
  onForceScan: () => startScan({ force: true }),
  onAllowAccess: () => requestAllSites().then((granted) => granted && startScan()),
  onOpenSettings: () => toggleSettings(true),
  onShowSection: (index) => showSection(index),
  onGenerateHeadings: () => generateHeadings(),
  onStopGenerating: () => chrome.runtime.sendMessage({ type: "panel-stop-relabel", tabId: state.activeTabId }).catch(() => {}),
  onDetachThread: () => changeTabThread("panel-detach-thread"),
  onDeleteThread: () => onDeleteThread(),
  onAskAnyway: (question) => askQuestion(question, { force: true }),
  onCitation: (key, source, action) => toggleCitation(key, source, action),
  onOpenPicklist: () => openPicklist(),
  onWebSearch: (query) =>
    chrome.runtime.sendMessage({ type: "panel-web-search", tabId: state.activeTabId, query }).then(
      (r) => r?.ok || showToast("Couldn't open the search."),
      () => showToast("Couldn't open the search.")
    ),
};

function dispatch(event) {
  const before = activeTab(state)?.threadId;
  state = panelReducer(state, event);
  if (activeTab(state)?.threadId !== before) confirmingDelete = false;
  // H3: a cache hit is announced apart from the status line, so it can't pass for a finished scan.
  if (event.type === "scan-progress" && event.stage === "done" && event.cacheHit && event.tabId === state.activeTabId && !autoLoads.delete(event.scanId)) {
    showToast("Already scanned. Using saved data, nothing was re-read or re-embedded.");
  }
  render();
}

function render() {
  const tab = activeTab(state);
  renderThreadRow(state, dom, handlers, { confirmingDelete });
  renderHeader(state, dom, handlers);
  if (picklist && picklist.tabId === state.activeTabId) {
    if (picklist.view.el.parentElement !== dom.readingView) {
      dom.readingView.replaceChildren(picklist.view.el);
      dom.readingView.__rendered = null; // the sections render again once it closes
    }
  } else renderReadingView(state.activeTabId, tab, dom.readingView, handlers, threadView(state).mode);
  renderChat(state, { pending, failed, activeCitation, confirmingClear }, dom, handlers);
}

function showToast(text) {
  dom.toast.textContent = text;
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (dom.toast.hidden = true), 5000);
}

// The background keeps each tab's thread link (background/tab-threads.js); ask it for this tab's.
async function loadTabThread(tabId) {
  const result = await chrome.runtime.sendMessage({ type: "panel-tab-thread", tabId }).catch(() => null);
  if (!result?.ok) return;
  dispatch({ type: "tab-thread", tabId, ...result });
  if (result.threadId && !pending) chatChannel().postMessage({ type: "watch", threadId: result.threadId });
  autoLoadSaved(tabId);
}

// A page already saved in its thread loads by itself (user, 2026-11-07): a cache hit reads and embeds
// nothing, it only re-finds the saved sections on the page, so there's no reason to wait for Start
// scan. New pages still scan only on Start scan (spec §3.11).
const autoLoads = new Set(); // scanIds started here: their "already scanned" toast isn't shown
function autoLoadSaved(tabId) {
  if (tabId !== state.activeTabId) return;
  const tab = activeTab(state);
  if (tab?.status !== "idle" || !scanControls(state).savedIn) return;
  autoLoads.add(launchScan(tabId, { force: false, rescan: false }));
}

// × (detach) or reattach on the active tab.
async function changeTabThread(type) {
  const tabId = state.activeTabId;
  const result = await chrome.runtime.sendMessage({ type, tabId }).catch(() => null);
  if (result?.ok) dispatch({ type: "tab-thread", tabId, ...result });
}

// Two clicks: the first turns the button into a confirm, which resets after a few seconds.
let confirmTimer = null;
async function onDeleteThread() {
  const threadId = activeTab(state)?.threadId;
  if (!threadId) return;
  if (!confirmingDelete) {
    confirmingDelete = true;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => ((confirmingDelete = false), render()), 4000);
    return render();
  }
  confirmingDelete = false;
  clearTimeout(confirmTimer);
  const result = await chrome.runtime.sendMessage({ type: "panel-delete-thread", threadId }).catch((err) => ({ ok: false, error: err.message }));
  if (!result?.ok) console.warn("[Summarizer] couldn't delete thread", threadId, result?.error);
  dispatch({ type: "thread-deleted", threadId });
}

async function showSection(index) {
  const tabId = state.activeTabId;
  const result = await chrome.runtime.sendMessage({ type: "panel-show-section", tabId, index });
  if (!result?.ok) console.warn("[Summarizer] couldn't show section", index, result?.error);
}

// B3 on demand. Batches stream in as "relabel-progress" messages; the reply carries the final state.
async function generateHeadings() {
  const tabId = state.activeTabId;
  const corpusId = activeTab(state)?.corpusId;
  if (!corpusId) return;
  dispatch({ type: "relabel-started", tabId });
  const result = await chrome.runtime.sendMessage({ type: "panel-relabel", tabId }).catch((err) => ({ ok: false, error: err.message }));
  // The background reports the corpus it relabelled; fall back to ours if it failed before reading it.
  dispatch({ type: "relabel-done", tabId, corpusId: result?.corpusId ?? corpusId, ...(result ?? { ok: false, error: "no response" }) });
}

// I3: questions go to the background over a "chat" port; the answer streams back and is saved on
// the thread, which then replaces the panel's copy (so every tab in the thread shows it).
function chatChannel() {
  if (chatPort) return chatPort;
  chatPort = chrome.runtime.connect({ name: "chat" });
  chatPort.onMessage.addListener(onChatMessage);
  chatPort.onDisconnect.addListener(() => {
    chatPort = null;
    if (pending) {
      pending = { ...pending, error: "Lost connection to the background worker. Ask again." };
      finishPending();
    }
  });
  return chatPort;
}

function onChatMessage(message) {
  // An answer still running in this thread from before the panel was (re)opened.
  if (message.type === "live") {
    if (pending) return;
    failed = null;
    const { chatId, threadId, question, text, mode, status, checking, force } = message;
    pending = { chatId, threadId, question, text, mode, status, checking, force, error: null };
    return render();
  }
  if (!pending || message.chatId !== pending.chatId) return;
  if (message.type === "sources") {
    pending = { ...pending, mode: message.mode, status: message.mode === "selection" ? "Reading your selection…" : `Read ${message.count} sections. Writing…` };
  } else if (message.type === "delta") {
    pending = { ...pending, text: pending.text + message.text };
  } else if (message.type === "checking") {
    pending = { ...pending, checking: true };
  } else if (message.type === "done") {
    pending = null;
    dispatch({ type: "thread-updated", thread: message.thread });
    return;
  } else if (message.type === "error") {
    pending = { ...pending, error: message.error };
    return finishPending();
  }
  render();
}

// A failed answer isn't saved; it stays on screen until the next question.
let failed = null;
function finishPending() {
  failed = pending;
  pending = null;
  render();
}

// Clear chat: two clicks, like Delete thread; the first turns the button into a confirm for a few seconds.
let confirmingClear = false;
let clearTimer = null;
async function onClearChat() {
  const threadId = activeTab(state)?.threadId;
  if (!threadId || pending) return;
  if (!confirmingClear) {
    confirmingClear = true;
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => ((confirmingClear = false), render()), 4000);
    return render();
  }
  confirmingClear = false;
  clearTimeout(clearTimer);
  clearCitation();
  failed = null;
  const result = await chrome.runtime.sendMessage({ type: "panel-clear-chat", threadId }).catch((err) => ({ ok: false, error: err.message }));
  if (result?.ok) dispatch({ type: "thread-updated", thread: result.thread });
  else showToast(result?.error ?? "Couldn't clear the chat.");
}

// D5/D6 (phase 9): the linked-pages picklist for the active tab, in the reading view's place.
// {tabId, threadId, from, view} or null. Closing it while pages are being added only hides it; the
// crawl runs on in the background and the thread updates as pages are added.
let picklist = null;

async function openPicklist() {
  const tabId = state.activeTabId;
  const data = await chrome.runtime.sendMessage({ type: "panel-links", tabId }).catch((err) => ({ ok: false, error: err.message }));
  if (!data?.ok) return showToast(data?.error ?? "Couldn't list this page's links.");
  if (!data.threadId) return showToast("Scan this page into a thread first.");
  const view = createPicklist(data, {
    onAdd: (links) => addLinkedPages(picklist, links),
    onStop: () => chrome.runtime.sendMessage({ type: "panel-stop-crawl", threadId: data.threadId }).catch(() => {}),
    onClose: () => closePicklist(),
  });
  picklist = { tabId, threadId: data.threadId, from: data.from, view };
  render();
  dom.readingView.scrollTop = 0;
}

function closePicklist() {
  picklist = null;
  render();
}

async function addLinkedPages(current, links) {
  // Reading linked pages needs access to their site: ask now, while the click is a user gesture.
  if (!hasAllSites && !(await requestAllSites())) {
    current.view.setDone({ ok: false, error: "Site access is needed to read linked pages." });
    return;
  }
  const result = await chrome.runtime
    .sendMessage({ type: "panel-crawl", threadId: current.threadId, from: current.from, links })
    .catch((err) => ({ ok: false, error: err.message }));
  if (result?.thread) dispatch({ type: "thread-updated", thread: result.thread });
  current.view.setDone(result ?? { ok: false, error: "No answer from the background." });
}

// Phase 7: the one citation highlighted on a page, {key: "<message createdAt>:<n>", tabId}, or null.
let activeCitation = null;

function clearCitation() {
  if (!activeCitation) return;
  chrome.runtime.sendMessage({ type: "panel-clear-citation", tabId: activeCitation.tabId }).catch(() => {});
  activeCitation = null;
}

// Show on page / Open page and highlight / Clear highlight (decisions 2 and 4). Jumps (Google Docs)
// don't toggle: nothing stays on the page.
async function toggleCitation(key, source, action) {
  if (activeCitation?.key === key) {
    clearCitation();
    return render();
  }
  // Opening another page needs site access; ask now, while the click still counts as a user gesture.
  if (action.open && !hasAllSites && !(await requestAllSites())) return showToast("Site access is needed to open and highlight other pages.");
  clearCitation();
  const citation = { n: source.n, corpusId: source.corpusId, sectionId: source.sectionId, pageUrl: source.pageUrl, passages: source.passages ?? [], selection: source.selection, quote: source.quote };
  const result = await chrome.runtime
    .sendMessage({ type: "panel-show-citation", tabId: state.activeTabId, citation, open: action.open })
    .catch((err) => ({ ok: false, error: err.message }));
  if (!result?.ok) {
    showToast(result?.error ?? "Couldn't show this source.");
    return render();
  }
  if (action.toggle && !result.jumped) activeCitation = { key, tabId: result.tabId };
  render();
}

// force: "Ask anyway" on an answer the relevance gate gave (the model wasn't asked).
function askQuestion(question, { force = false } = {}) {
  const tab = activeTab(state);
  if (!question || pending || !tab?.threadId) return;
  failed = null;
  clearCitation(); // a new question clears the last answer's highlight (decision 2)
  pending = { chatId: crypto.randomUUID(), tabId: state.activeTabId, threadId: tab.threadId, question, force, text: "", mode: null, status: "Finding sources…", error: null };
  chatChannel().postMessage({ type: "ask", chatId: pending.chatId, tabId: pending.tabId, threadId: pending.threadId, question, force });
  if (force) return render();
  dom.chatInput.value = "";
  autoGrow();
  render();
}

function stopAnswer() {
  if (pending) chatPort?.postMessage({ type: "stop", chatId: pending.chatId });
}

// The input grows with its text, up to about five lines.
// border-box: the height includes the 1px borders that scrollHeight leaves out. A scrollbar only
// past ~5 lines; below that the box grows with the text.
function autoGrow() {
  const input = dom.chatInput;
  input.style.height = "auto";
  const full = input.scrollHeight + 2;
  input.style.height = `${Math.min(full, 120)}px`;
  input.style.overflowY = full > 120 ? "auto" : "hidden";
}

// ⚙: chrome.storage.local keys read by background/llm.js. geminiApiKey is the same key Phase B's
// setGeminiKey writes, and its value is never displayed back.
function toggleSettings(open = dom.settings.hidden) {
  dom.settings.hidden = !open;
  dom.settingsToggle.setAttribute("aria-expanded", String(open));
  if (open) loadSettings();
}

async function loadSettings() {
  const { geminiApiKey, llmProvider, ollamaModel, webSearchEngine } = await chrome.storage.local.get(["geminiApiKey", "llmProvider", "ollamaModel", "webSearchEngine"]);
  dom.webEngine.value = webSearchEngine ?? "duckduckgo";
  dom.settingsStatus.textContent = geminiApiKey ? "A key is saved." : "No key saved.";
  dom.llmProvider.value = llmProvider === "ollama" ? "ollama" : "gemini";
  dom.ollamaModel.value = ollamaModel ?? "";
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
// The background picks the matrix row (new thread / append / cache hit) from the tab's thread.
function startScan({ force = false, rescan = false } = {}) {
  const tabId = state.activeTabId;
  if (tabId === null) return;
  if (!hasAllSites && !activeTab(state).url) {
    requestAllSites().then(() => launchScan(tabId, { force, rescan }));
    return;
  }
  launchScan(tabId, { force, rescan });
}

function launchScan(tabId, { force, rescan }) {
  const scanId = nextScanId++;
  const threadId = state.tabs[tabId]?.threadId ?? null;
  dispatch({ type: "scan-started", tabId, scanId });
  scanPort().postMessage({ type: "start", tabId, scanId, force, rescan, threadId });
  return scanId;
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

// Lets the background notice this panel closing, so it can clear the highlights it made. If the
// service worker restarts the port drops while the panel is still open, so it reconnects.
function holdPanelPort() {
  try {
    chrome.runtime.connect({ name: `panel:${windowId}` }).onDisconnect.addListener(() => setTimeout(holdPanelPort, 1000));
  } catch {
    /* extension reloaded or uninstalled: this panel is orphaned */
  }
}

// The splitter between sections and chat. Its position is a share of the space both use, so it
// survives resizing the panel, and it's kept per browser in localStorage (a convenience only).
const SPLIT_KEY = "summarizer.split";
const READING_MIN = 48;
const CHAT_MIN = 200;

function setupSplitter() {
  const splitter = document.getElementById("splitter");
  const reading = dom.readingView;
  const chat = document.getElementById("chat-area");
  const space = () => reading.getBoundingClientRect().height + chat.getBoundingClientRect().height;
  let share = null;
  try {
    share = Number(localStorage.getItem(SPLIT_KEY)) || null;
  } catch {
    /* storage blocked: default split */
  }

  const apply = () => {
    if (share == null) return (reading.style.flex = "");
    const px = Math.max(READING_MIN, Math.min(space() - CHAT_MIN, share * space()));
    reading.style.flex = `0 0 ${px}px`;
  };
  const save = () => {
    try {
      if (share == null) localStorage.removeItem(SPLIT_KEY);
      else localStorage.setItem(SPLIT_KEY, String(share));
    } catch {
      /* not kept */
    }
  };
  const setHeight = (px) => {
    share = Math.max(READING_MIN, Math.min(space() - CHAT_MIN, px)) / space();
    apply();
  };

  splitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add("dragging");
    document.body.classList.add("resizing");
    const top = reading.getBoundingClientRect().top;
    const move = (e) => setHeight(e.clientY - top);
    const up = () => {
      splitter.removeEventListener("pointermove", move);
      splitter.classList.remove("dragging");
      document.body.classList.remove("resizing");
      save();
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", up, { once: true });
    splitter.addEventListener("pointercancel", up, { once: true });
  });
  splitter.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowUp" ? -32 : event.key === "ArrowDown" ? 32 : 0;
    if (!step) return;
    event.preventDefault();
    setHeight(reading.getBoundingClientRect().height + step);
    save();
  });
  splitter.addEventListener("dblclick", () => {
    share = null;
    apply();
    save();
  });
  window.addEventListener("resize", apply);
  apply();
}

async function init() {
  setupSplitter();
  ({ id: windowId } = await chrome.windows.getCurrent());
  holdPanelPort();
  hasAllSites = await chrome.permissions.contains(ALL_SITES);
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) {
    dispatch({ type: "tab-activated", ...tabInfo(tab) });
    loadTabThread(tab.id);
  } else dispatch({ type: "noop" });

  chrome.tabs.onActivated.addListener(async (info) => {
    if (info.windowId !== windowId) return;
    const activated = await chrome.tabs.get(info.tabId).catch(() => null);
    dispatch({ type: "tab-activated", ...(activated ? tabInfo(activated) : { tabId: info.tabId }) });
    loadTabThread(info.tabId);
  });

  // changeInfo.url/title are only reported with access to the tab, so a new load ("loading") is
  // what marks a navigation. Reloads count too: they drop the content script and its ranges.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, updated) => {
    if (changeInfo.status === "loading") dispatch({ type: "tab-navigated", ...tabInfo(updated) });
    // Once loaded the URL is known: a page some thread already holds links to it.
    if (changeInfo.status === "complete") loadTabThread(tabId);
    else if (changeInfo.title !== undefined || changeInfo.status === "complete") dispatch({ type: "tab-info", ...tabInfo(updated) });
  });

  chrome.tabs.onRemoved.addListener((tabId) => dispatch({ type: "tab-closed", tabId }));

  // Clicking the toolbar icon grants activeTab, which makes the tab's title readable.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "action-clicked") refreshTabInfo(message.tabId);
    else if (message?.type === "crawl-progress") {
      if (picklist?.threadId === message.threadId) picklist.view.setProgress(message);
      if (message.stage === "added" && message.thread) dispatch({ type: "thread-updated", thread: message.thread });
    } else if (message?.type === "citation-cleared") {
      // Esc on the page cleared it.
      if (activeCitation) ((activeCitation = null), render());
    } else if (message?.type === "relabel-progress") dispatch({ type: "relabel-progress", tabId: message.tabId, corpusId: message.corpusId, sections: message.sections });
  });

  // Granted here or revoked in Chrome's settings: titles of every known tab may have changed.
  const onPermissionsChanged = async () => {
    hasAllSites = await chrome.permissions.contains(ALL_SITES);
    for (const tabId of Object.keys(state.tabs)) refreshTabInfo(Number(tabId));
  };
  chrome.permissions.onAdded.addListener(onPermissionsChanged);
  chrome.permissions.onRemoved.addListener(onPermissionsChanged);

  dom.startScan.addEventListener("click", () => startScan());
  dom.rescan.addEventListener("click", () => startScan({ rescan: true }));
  dom.reattachThread.addEventListener("click", () => changeTabThread("panel-reattach-thread"));
  setIcon(dom.rescan, "rescan");
  setIcon(dom.settingsToggle, "settings");
  dom.chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    askQuestion(dom.chatInput.value.trim());
  });
  // Enter sends; Shift+Enter is a new line.
  dom.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      askQuestion(dom.chatInput.value.trim());
    }
  });
  dom.chatInput.addEventListener("input", autoGrow);
  dom.chatStop.addEventListener("click", stopAnswer);
  dom.chatClear.addEventListener("click", onClearChat);
  setIcon(dom.chatSend, "send", "Send (Enter)");
  setIcon(dom.chatStop, "stop", "Stop answering");
  dom.settingsToggle.addEventListener("click", () => toggleSettings());
  dom.llmProvider.addEventListener("change", () => chrome.storage.local.set({ llmProvider: dom.llmProvider.value }));
  dom.webEngine.addEventListener("change", () => chrome.storage.local.set({ webSearchEngine: dom.webEngine.value }));
  dom.ollamaModel.addEventListener("change", () => chrome.storage.local.set({ ollamaModel: dom.ollamaModel.value.trim() }));
  dom.settings.addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = dom.geminiKey.value.trim();
    if (!key) return;
    await chrome.storage.local.set({ geminiApiKey: key });
    dom.geminiKey.value = "";
    loadSettings();
  });
  dom.geminiKeyClear.addEventListener("click", async () => {
    await chrome.storage.local.remove("geminiApiKey");
    loadSettings();
  });
}

init();

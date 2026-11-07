// Which thread each tab is in or continues (phase 5, revised 2026-11-06: no picker, threads follow
// the user's own navigation). Kept per tab in chrome.storage.session, so it works while the panel is
// closed and survives a service-worker restart; a browser restart forgets it.
//   threadId          the thread a Start scan on this tab goes into (null: a new thread)
//   detachedThreadId  the thread the user closed with ×, so the panel can offer to reattach it
// A tab keeps its link when it navigates (a link clicked on a thread page continues the thread), and
// a tab opened from a linked tab inherits it. Loaded into the service worker with importScripts().

const TAB_THREADS_KEY = "tabThreads"; // { [tabId]: { threadId, detachedThreadId } }

async function readTabThreads() {
  return (await chrome.storage.session.get(TAB_THREADS_KEY))[TAB_THREADS_KEY] ?? {};
}

// Read-modify-write on one storage key: changes run one at a time so concurrent events (a tab
// opening while another closes) can't overwrite each other.
let linkQueue = Promise.resolve();
function updateTabThreads(change) {
  const run = linkQueue.then(async () => {
    const links = await readTabThreads();
    change(links);
    await chrome.storage.session.set({ [TAB_THREADS_KEY]: links });
  });
  linkQueue = run.catch(() => {});
  return run;
}

function setTabThread(tabId, link) {
  return updateTabThreads((links) => {
    if (link) links[tabId] = { threadId: link.threadId ?? null, detachedThreadId: link.detachedThreadId ?? null };
    else delete links[tabId];
  });
}

// The tab's link, checked against storage (a deleted thread drops out). A tab with no link at all on
// a page that some thread already holds is linked to that thread.
async function tabThread(tabId) {
  const links = await readTabThreads();
  let link = links[tabId] ?? { threadId: null, detachedThreadId: null };
  const [thread, detached] = await Promise.all([link.threadId && getThread(link.threadId), link.detachedThreadId && getThread(link.detachedThreadId)]);
  const checked = { threadId: thread ? link.threadId : null, detachedThreadId: detached ? link.detachedThreadId : null };

  if (!checked.threadId && !checked.detachedThreadId) {
    const url = (await chrome.tabs.get(tabId).catch(() => null))?.url;
    const holding = url && threadForPage(await listStoredThreads(), url);
    if (holding) checked.threadId = holding;
  }
  if (checked.threadId !== link.threadId || checked.detachedThreadId !== link.detachedThreadId) await setTabThread(tabId, checked);
  const threads = [thread, detached].filter(Boolean);
  if (checked.threadId && !thread) threads.push(await getThread(checked.threadId));
  return { ...checked, threads };
}

// × : this page starts a new thread; the closed one can be reattached.
async function detachTabThread(tabId) {
  const { threadId } = await tabThread(tabId);
  if (threadId) await setTabThread(tabId, { threadId: null, detachedThreadId: threadId });
  return tabThread(tabId);
}

async function reattachTabThread(tabId) {
  const { threadId, detachedThreadId } = await tabThread(tabId);
  if (!threadId && detachedThreadId) await setTabThread(tabId, { threadId: detachedThreadId, detachedThreadId: null });
  return tabThread(tabId);
}

function forgetThreadLinks(threadId) {
  return updateTabThreads((links) => {
    for (const [tabId, link] of Object.entries(links)) {
      if (link.threadId === threadId) link.threadId = null;
      if (link.detachedThreadId === threadId) link.detachedThreadId = null;
      if (!link.threadId && !link.detachedThreadId) delete links[tabId];
    }
  });
}

// A link opened in a new tab (or, later, a search-result card) continues the opener's thread.
// Decided on the new tab's first load, not at creation: Chrome hasn't exposed the address yet when
// the tab is created. A link's tab loads a web page straight away; a blank or new-tab page (Ctrl+T,
// which Chrome can also give an opener) first loads with no web address, and starts fresh.
const WEB_URL = /^https?:\/\//;
// Noted synchronously: an async lookup here would let the tab's first load slip past unseen.
const pendingOpeners = new Map(); // new tabId → openerTabId, until the new tab's first load

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId !== undefined) pendingOpeners.set(tab.id, tab.openerTabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !pendingOpeners.has(tabId)) return;
  const openerTabId = pendingOpeners.get(tabId);
  pendingOpeners.delete(tabId);
  if (!WEB_URL.test(changeInfo.url || tab.url || tab.pendingUrl || "")) return;
  const opener = (await readTabThreads())[openerTabId];
  if (opener?.threadId) await setTabThread(tabId, { threadId: opener.threadId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingOpeners.delete(tabId);
  setTabThread(tabId, null);
});

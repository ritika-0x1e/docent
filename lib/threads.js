// G1/G3: thread helpers, pure. A thread chains pages the user scanned on purpose (master-spec §3.10);
// this decides whether a scan creates a thread, appends a page or is a cache hit (§3.11 matrix).
// Used by the background (attachment, tab links) and the side panel (status line, thread heading).
// Plan: docs/phased-implementation-plan/phase-5-threads.md.

// Click/campaign tracking: never changes what the page shows.
const TRACKING_PARAM = /^(utm_.+|fbclid|gclid)$/i;
// Same shape as lib/gdocs.js parseDocsUrl, including a signed-in account prefix ("/u/1/").
const GOOGLE_DOC_PATH = /^\/document\/(?:u\/\d+\/)?d\/([\w-]+)/;

/**
 * The comparison key for "the same page" (decision 4). Lower-case scheme and host (URL already
 * does), no #fragment, no trailing slash, no tracking parameters; other query parameters are kept
 * because they often pick the content. A Google Doc is its document id, whatever view it's open in.
 * Unparseable input (or none) comes back unchanged.
 */
function normalizeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return url ?? null;
  }
  if (u.hostname === "docs.google.com") {
    const doc = GOOGLE_DOC_PATH.exec(u.pathname);
    if (doc) return `https://docs.google.com/document/d/${doc[1]}`;
  }
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.href.replace(/\?$/, "");
}

function findPage(thread, url) {
  if (!thread || !url) return null;
  const key = normalizeUrl(url);
  return thread.pages.find((p) => normalizeUrl(p.url) === key) ?? null;
}

/** H2 matrix row for Start scan: no thread → "new-thread"; page already in it → "cache-hit"; else "append". */
function scanAction(thread, url) {
  if (!thread) return "new-thread";
  return findPage(thread, url) ? "cache-hit" : "append";
}

function newThread({ id, page, now }) {
  return { id, title: page.title || hostOf(page.url) || "Untitled thread", createdAt: now, updatedAt: now, pages: [{ ...page, addedAt: now }], messages: [] };
}

function withPage(thread, page, now) {
  return { ...thread, updatedAt: now, pages: [...thread.pages, { ...page, addedAt: now }] };
}

// Rescan (decision 2): the page keeps its place in the thread; only its corpus (and title) change.
function replacePage(thread, url, page, now) {
  const key = normalizeUrl(url);
  return {
    ...thread,
    updatedAt: now,
    pages: thread.pages.map((p) => (normalizeUrl(p.url) === key ? { ...p, ...page, addedAt: p.addedAt } : p)),
  };
}

function corpusRefs(thread) {
  return thread ? thread.pages.map((p) => p.corpusRef) : [];
}

// A tab with no thread link yet, on a page some thread already holds: that thread (the most
// recently used, if several), else none.
function threadForPage(threads, url) {
  const holding = threads.filter((t) => findPage(t, url));
  holding.sort((a, b) => b.updatedAt - a.updatedAt);
  return holding[0]?.id ?? null;
}

function sortThreads(threads) {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

if (typeof module === "object") {
  module.exports = { normalizeUrl, findPage, scanAction, newThread, withPage, replacePage, corpusRefs, threadForPage, sortThreads };
}

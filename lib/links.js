// D1–D5 (phase 9) and G4 (phase 10): the linked-pages picklist. The content script harvests raw link
// occurrences during a scan; this cleans, merges, scores and allocates them. Pure. Never a crawl
// trigger: the output is only ever a list for the user to tick (spec §3.3).
// Plan: docs/phased-implementation-plan/phase-9-10-linked-pages.md; skill link-harvesting-and-scoring.

const BASE_WEIGHT = { inline: 10, nav: 3 };
const REPEAT_CAP = 3;
const PICKLIST = { cap: 20, inline: 15, nav: 5 };
const SOFT_CAP = 8; // phase 10 (decision 4): warn past 8 pages, never block
const MAX_STORED = 400; // harvested links kept per page, best first (the filter searches them all)

// Files, not pages: by extension of the path.
const FILE_EXT = /\.(pdf|png|jpe?g|gif|svg|webp|bmp|ico|mp3|wav|ogg|mp4|webm|mov|avi|zip|gz|tgz|rar|7z|exe|dmg|msi|csv|xlsx?|docx?|pptx?)$/i;
// A footnote marker as the whole link text: "[12]", "12", "[a]", "^".
const FOOTNOTE_TEXT = /^(?:\[?\s*(?:\d+|[a-z]{1,2}|note\s*\d+)\s*\]?|\^|↑)$/i;

if (typeof normalizeUrl === "undefined" && typeof require === "function") {
  globalThis.normalizeUrl = require("./threads.js").normalizeUrl;
}

/**
 * D2 + defaults: drop cross-origin links, links back to this page, files, links with no text,
 * footnote markers and pages already in the thread. Nothing is fetched.
 * @param {{url, anchorText, sourceType, position, surroundingText}[]} raw  occurrences in page order
 * @param {{pageUrl: string, threadUrls?: string[]}} context
 */
function cleanLinks(raw, { pageUrl, threadUrls = [] }) {
  let origin;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }
  const self = normalizeUrl(pageUrl);
  const known = new Set(threadUrls.map(normalizeUrl));
  return raw.filter((link) => {
    let url;
    try {
      url = new URL(link.url);
    } catch {
      return false;
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== origin) return false;
    const key = normalizeUrl(url.href);
    if (key === self || known.has(key)) return false;
    if (FILE_EXT.test(url.pathname)) return false;
    const text = (link.anchorText ?? "").replace(/\s+/g, " ").trim();
    return text.length > 0 && !FOOTNOTE_TEXT.test(text);
  });
}

function positionBonus(position) {
  if (position == null) return 0;
  return position < 1 / 3 ? 2 : position < 2 / 3 ? 1 : 0;
}

/**
 * D1 dedupe + D3 score. One entry per normalized URL: inline wins over nav; the first inline
 * occurrence gives the position and text; each further inline occurrence adds 1, capped at 3.
 * @returns {{url, anchorText, sourceType, surroundingText, score, occurrences}[]}  best first, ties in page order
 */
function scoreLinks(cleaned) {
  const byUrl = new Map();
  cleaned.forEach((link, order) => {
    const key = normalizeUrl(link.url);
    const entry = byUrl.get(key);
    if (!entry) {
      byUrl.set(key, { ...link, order, occurrences: 1, inlineCount: link.sourceType === "inline" ? 1 : 0 });
    } else if (link.sourceType === "inline") {
      if (entry.sourceType === "nav") Object.assign(entry, { ...link, order, occurrences: entry.occurrences + 1, inlineCount: 1 }); // inline wins
      else Object.assign(entry, { occurrences: entry.occurrences + 1, inlineCount: entry.inlineCount + 1 });
    } else entry.occurrences++;
  });
  return [...byUrl.values()]
    .map((e) => ({
      url: e.url,
      anchorText: e.anchorText.replace(/\s+/g, " ").trim(),
      sourceType: e.sourceType,
      surroundingText: e.surroundingText ?? "",
      occurrences: e.occurrences,
      order: e.order,
      score: BASE_WEIGHT[e.sourceType] + (e.sourceType === "inline" ? positionBonus(e.position) + Math.min(REPEAT_CAP, e.inlineCount - 1) : 0),
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, MAX_STORED);
}

/** D4: at most 20, 15 inline + 5 nav, unused slots backfilled (inline first). One list, best first. */
function allocatePicklist(scored, { cap = PICKLIST.cap, inline = PICKLIST.inline, nav = PICKLIST.nav } = {}) {
  const inl = scored.filter((l) => l.sourceType === "inline");
  const nv = scored.filter((l) => l.sourceType === "nav");
  let takeInline = Math.min(inl.length, inline);
  let takeNav = Math.min(nv.length, nav);
  let leftover = cap - takeInline - takeNav;
  const extraInline = Math.max(0, Math.min(leftover, inl.length - takeInline));
  takeInline += extraInline;
  leftover -= extraInline;
  takeNav += Math.max(0, Math.min(leftover, nv.length - takeNav));
  return [...inl.slice(0, takeInline), ...nv.slice(0, takeNav)].sort((a, b) => b.score - a.score || a.order - b.order);
}

/** D5's filter: over every harvested link, by link text, sentence or address. */
function filterLinks(links, text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return links;
  return links.filter((l) => {
    const hay = `${l.anchorText} ${l.surroundingText} ${decodeURIComponent(l.url)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** G4: the soft-cap note for adding `adding` pages to a thread of `current`, or null. */
function softCapNote(current, adding, cap = SOFT_CAP) {
  const total = current + adding;
  if (total <= cap) return null;
  return `This thread has ${current} page${current === 1 ? "" : "s"}; adding ${adding} makes ${total}. Past ${cap}, answers draw on more pages and citations get harder to follow.`;
}

if (typeof module === "object") {
  module.exports = { cleanLinks, scoreLinks, allocatePicklist, filterLinks, softCapNote, SOFT_CAP, PICKLIST };
}

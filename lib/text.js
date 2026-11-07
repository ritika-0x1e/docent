// Pure text matching for B1 anchoring: locating a Readability block's text inside the live
// page's text. No DOM access here — content/anchor.js builds the page text and maps offsets
// back to nodes. See docs/phased-implementation-plan/phase-B-sectioning.md ("Anchoring").

var EDGE_CHARS = 40; // length of the head/tail probes used when the exact text isn't found
var MAX_SPAN_RATIO = 1.5; // a head..tail match may be at most this much longer than the block
var ANCHOR_CONTEXT_CHARS = 32; // prefix/suffix length stored with each anchor

// Must collapse whitespace exactly the way content/anchor.js builds its page index,
// or block text and page text won't line up.
function normalizeText(s) {
  return s.replace(/\s+/g, " ").trim();
}

// Permalink marks docs generators put inside headings (Sphinx/MkDocs "¶", Docusaurus "#", "§", 🔗).
// Part of the page's text, so the anchor keeps them; the heading shown and embedded doesn't.
var PERMALINK_MARKS = /^(?:[¶§#🔗⚓\uFE0F][\s\u200B]+)+|(?:[\s\u200B]*[¶§🔗⚓\uFE0F]|[\s\u200B]+#)+$/gu; // a trailing "#" needs a space before it: "C#"

/** A heading's text without permalink marks at either end; unchanged if nothing else is left. */
function headingText(s) {
  return s.replace(PERMALINK_MARKS, "").trim() || s;
}

/**
 * Finds `quote` in `haystack` at or after `from`.
 * Tries an exact match first; if that fails (Readability sometimes drops inline bits inside a
 * paragraph), matches the first and last EDGE_CHARS separately and accepts the span between
 * them if it isn't implausibly long.
 * @returns {{start: number, end: number, exact: boolean} | null}
 */
function findQuote(haystack, quote, from = 0) {
  if (!quote) return null;

  const start = haystack.indexOf(quote, from);
  if (start !== -1) return { start, end: start + quote.length, exact: true };

  // Too short to split into a distinct head and tail.
  if (quote.length < EDGE_CHARS * 2) return null;

  const head = quote.slice(0, EDGE_CHARS);
  const tail = quote.slice(-EDGE_CHARS);
  const headStart = haystack.indexOf(head, from);
  if (headStart === -1) return null;
  const tailStart = haystack.indexOf(tail, headStart + head.length);
  if (tailStart === -1) return null;

  const end = tailStart + tail.length;
  if (end - headStart > quote.length * MAX_SPAN_RATIO) return null;
  return { start: headStart, end, exact: false };
}

// Serializable form of a match, for re-anchoring after reload (F3) or when a live Range goes stale.
function makeQuoteAnchor(haystack, start, end) {
  return {
    exact: haystack.slice(start, end),
    prefix: haystack.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start),
    suffix: haystack.slice(end, end + ANCHOR_CONTEXT_CHARS),
  };
}

function countWords(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

if (typeof module === "object") {
  module.exports = { normalizeText, headingText, findQuote, makeQuoteAnchor, countWords, EDGE_CHARS, MAX_SPAN_RATIO };
}

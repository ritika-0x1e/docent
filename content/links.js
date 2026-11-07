// D1 (phase 9): harvest link occurrences during a scan, for the linked-pages picklist. Inline links
// come from the extracted article (Readability's content element), in page order, each with where it
// sits in the article (0–1, for the position bonus) and its surrounding sentence. Nav links come from
// <nav> / [role=navigation] on the live page only (spec §3.3a: no class-name guessing). Cleaning,
// dedupe and scoring happen in the background (lib/links.js). Nothing is fetched here.

var LINK_BLOCKS = "p, li, dd, dt, td, th, blockquote, figcaption, h2, h3, h4";
var SURROUNDING_CHARS = 220;
var MAX_HARVEST = 2000;

function absoluteHref(a) {
  try {
    return new URL(a.getAttribute("href"), document.baseURI).href;
  } catch {
    return null;
  }
}

// The sentence around the link inside its block, trimmed to about SURROUNDING_CHARS.
function surroundingSentence(blockText, anchorText) {
  const text = blockText.replace(/\s+/g, " ").trim();
  const at = anchorText ? text.indexOf(anchorText) : -1;
  if (text.length <= SURROUNDING_CHARS) return text;
  if (at < 0) return `${text.slice(0, SURROUNDING_CHARS)}…`;
  const start = Math.max(0, text.lastIndexOf(". ", at) + 2);
  const end = text.indexOf(". ", at + anchorText.length);
  const sentence = text.slice(start, end < 0 ? undefined : end + 1);
  if (sentence.length <= SURROUNDING_CHARS) return sentence;
  const from = Math.max(0, at - 80);
  return `${from ? "…" : ""}${text.slice(from, from + SURROUNDING_CHARS)}…`;
}

/** @param {Element|null} contentEl  Readability's article content (before parseBlocks) */
function harvestLinks(contentEl) {
  const out = [];
  if (contentEl) {
    const anchors = [...contentEl.querySelectorAll("a[href]")];
    anchors.forEach((a, i) => {
      const url = absoluteHref(a);
      if (!url) return;
      const anchorText = a.textContent.replace(/\s+/g, " ").trim();
      const block = a.closest(LINK_BLOCKS) ?? a.parentElement;
      // readableText (blocks.js) puts spaces between cells and lines, so table rows don't glue together.
      const blockText = block ? readableText(block) : "";
      out.push({ url, anchorText, sourceType: "inline", position: anchors.length > 1 ? i / (anchors.length - 1) : 0, surroundingText: surroundingSentence(blockText, anchorText) });
    });
  }
  for (const a of document.querySelectorAll("nav a[href], [role=navigation] a[href]")) {
    const url = absoluteHref(a);
    if (!url) continue;
    const nav = a.closest("nav, [role=navigation]");
    const label = nav?.getAttribute("aria-label") || nav?.querySelector("h2, h3, .vector-menu-heading")?.textContent || "";
    out.push({ url, anchorText: a.textContent.replace(/\s+/g, " ").trim(), sourceType: "nav", position: null, surroundingText: label.trim() ? `In: ${label.replace(/\s+/g, " ").trim()}` : "In the page's navigation" });
  }
  return out.slice(0, MAX_HARVEST);
}

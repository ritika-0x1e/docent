// B1 anchoring: map each block (whose text came from the detached Readability clone) back to the
// live page. Live Ranges stay in this content script; only serializable anchors leave it.
// See docs/phased-implementation-plan/phase-B-sectioning.md ("Anchoring").

const SKIP_SELECTOR = "script, style, noscript, template, textarea";

// Block id → live Range, for the most recent scan of this page.
globalThis.__summarizerRanges = globalThis.__summarizerRanges || new Map();

// Concatenates the page's text nodes with whitespace collapsed exactly like lib/text.js's
// normalizeText(), recording for every output character which text node and offset it came from.
function buildTextIndex(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });

  const chars = [];
  const nodeAt = [];
  const offsetAt = [];
  let lastWasSpace = true; // drops leading whitespace, matching normalizeText's trim()

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = node.data;
    for (let i = 0; i < data.length; i++) {
      const isSpace = /\s/.test(data[i]);
      if (isSpace && lastWasSpace) continue;
      chars.push(isSpace ? " " : data[i]);
      nodeAt.push(node);
      offsetAt.push(i);
      lastWasSpace = isSpace;
    }
  }
  return { text: chars.join(""), nodeAt, offsetAt };
}

function rangeFromIndex(index, start, end) {
  const range = document.createRange();
  range.setStart(index.nodeAt[start], index.offsetAt[start]);
  range.setEnd(index.nodeAt[end - 1], index.offsetAt[end - 1] + 1);
  return range;
}

/**
 * Anchors blocks in document order (a moving cursor disambiguates repeated text). If a block
 * isn't found after the cursor, one exact retry from the top of the page is allowed without
 * moving the cursor, so a single bad match can't strand every block after it.
 * @returns blocks with {anchor, anchored, match} added; match is "exact" | "edges" | null
 */
function anchorBlocks(blocks) {
  const index = buildTextIndex(document.body);
  const ranges = globalThis.__summarizerRanges;
  ranges.clear();

  let cursor = 0;
  return blocks.map((block) => {
    // Markdown blocks match on their raw source (the live <pre> shows raw markdown).
    const quote = block.anchorText ?? block.text;
    let m = findQuote(index.text, quote, cursor);
    let advance = true;
    if (!m) {
      const retry = findQuote(index.text, quote, 0);
      if (retry?.exact) {
        m = retry;
        advance = false;
      }
    }

    if (!m) return unanchoredBlock(block);
    ranges.set(block.id, rangeFromIndex(index, m.start, m.end));
    if (advance) cursor = m.end;
    return {
      ...block,
      anchor: makeQuoteAnchor(index.text, m.start, m.end),
      anchored: true,
      match: m.exact ? "exact" : "edges",
    };
  });
}

function unanchoredBlock(block) {
  return { ...block, anchor: { exact: block.text, prefix: "", suffix: "" }, anchored: false, match: null };
}

// Google Docs (canvas-rendered): nothing on the live page to anchor to. Blocks keep the same shape
// so the corpus looks like any other page's; citations fall back to snippet + jump (A5a).
function skipAnchoring(blocks) {
  globalThis.__summarizerRanges.clear();
  return blocks.map(unanchoredBlock);
}

// Test-only (Phase B harness): show blocks' live ranges in the "summarizer-debug" highlight.
// The ::highlight style is added by the background via chrome.scripting.insertCSS, so the
// page DOM is never touched. F1 builds the real citation highlighting.
function debugHighlight(blockIds) {
  if (!globalThis.CSS?.highlights) return { ok: false, error: "CSS Custom Highlight API unavailable" };
  const ranges = blockIds
    .map((id) => globalThis.__summarizerRanges.get(id))
    .filter((r) => r && r.startContainer.isConnected);
  CSS.highlights.set("summarizer-debug", new Highlight(...ranges));
  ranges[0]?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  return { ok: true, highlighted: ranges.length, requested: blockIds.length };
}

function clearDebugHighlight() {
  globalThis.CSS?.highlights?.delete("summarizer-debug");
}

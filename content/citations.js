// F1/F3 (phase 7): citation highlights on the live page, with the CSS Custom Highlight API only: the
// page's DOM is never changed. A citation shows its passage (the sentences that support the claim)
// as a translucent tint, and the rest of its section as an underline in the same colour (user,
// 2026-11-07). Each citation picks a random colour from a palette. One citation at a time; it clears
// on Esc, on "clear-citation", or when the panel closes ("clear-highlight").
// The ::highlight styles are inserted by the background (chrome.scripting.insertCSS), one named
// highlight per palette colour: background/citation-styles.js.
// Plan: docs/phased-implementation-plan/phase-7-citations.md.

const CITE_COLORS = 6; // must match the palette in background/citation-styles.js
const FLASH_MS = 2000;
let lastColor = -1;
let flashTimer = null;

function citationHighlightNames() {
  const names = [];
  for (let i = 0; i < CITE_COLORS; i++) names.push(`summarizer-cite-${i}`, `summarizer-cite-ctx-${i}`);
  return names;
}

function clearCitation() {
  if (!globalThis.CSS?.highlights) return false;
  let had = false;
  for (const name of citationHighlightNames()) had = CSS.highlights.delete(name) || had;
  return had;
}

function clearFlash() {
  clearTimeout(flashTimer);
  globalThis.CSS?.highlights?.delete("summarizer-flash");
}

// Where a live range starts in the text index (the index is the page's text, in order).
function indexPosition(index, range) {
  for (let i = 0; i < index.nodeAt.length; i++) {
    const node = index.nodeAt[i];
    if (node === range.startContainer && index.offsetAt[i] >= range.startOffset) return i;
    if (node !== range.startContainer && range.comparePoint(node, 0) === 0) return i; // first text inside
  }
  return -1;
}

/**
 * Live ranges for a section's blocks: the scan's own when still on the page, otherwise rebuilt from
 * the stored anchor (a page opened from another tab's citation, or one re-rendered since).
 * @returns {{block, range, pos}[]}  pos: where the block starts in the index
 */
function sectionRanges(blocks, index) {
  const live = globalThis.__summarizerRanges;
  const found = [];
  let cursor = 0;
  for (const block of blocks) {
    const exact = block.anchor?.exact;
    if (!exact) continue;
    let range = live.get(block.id);
    let pos = range?.startContainer.isConnected ? indexPosition(index, range) : -1;
    if (pos < 0) {
      const m = findQuote(index.text, exact, cursor) ?? findQuote(index.text, exact, 0);
      if (!m) continue;
      range = rangeFromIndex(index, m.start, m.end);
      live.set(block.id, range);
      pos = m.start;
    }
    cursor = pos;
    found.push({ block, range, pos });
  }
  return found;
}

/**
 * @param {{id, anchor: {exact}}[]} blocks  the cited section's anchored blocks, in page order
 * @param {{blockId, exact}[]} passages  substrings of those blocks (lib/passages.js); may be empty
 * @returns {{ok, highlighted, passages}}  highlighted: section blocks found on the page
 */
function highlightCitation(blocks, passages = []) {
  if (!globalThis.CSS?.highlights) return { ok: false, error: "CSS Custom Highlight API unavailable" };
  clearCitation();
  clearFlash();
  const index = buildTextIndex(document.body);
  const found = sectionRanges(blocks, index);
  if (!found.length) return { ok: true, highlighted: 0, passages: 0 };

  const passageRanges = [];
  for (const p of passages) {
    const at = found.find((f) => f.block.id === p.blockId);
    if (!at) continue;
    const offset = at.block.anchor.exact.indexOf(p.exact);
    const start = offset >= 0 ? at.pos + offset : findQuote(index.text, p.exact, at.pos)?.start;
    if (start == null || index.text.slice(start, start + p.exact.length) !== p.exact) continue;
    passageRanges.push(rangeFromIndex(index, start, start + p.exact.length));
  }

  let color;
  do color = Math.floor(Math.random() * CITE_COLORS);
  while (CITE_COLORS > 1 && color === lastColor);
  lastColor = color;
  // No clear passage (or an answer saved before phase 7): the whole section is the passage.
  const strong = passageRanges.length ? passageRanges : found.map((f) => f.range);
  const passage = new Highlight(...strong);
  passage.priority = 1;
  CSS.highlights.set(`summarizer-cite-${color}`, passage);
  if (passageRanges.length) CSS.highlights.set(`summarizer-cite-ctx-${color}`, new Highlight(...found.map((f) => f.range)));
  scrollRangeIntoView(strong[0]);
  return { ok: true, highlighted: found.length, passages: passageRanges.length };
}

// Reading-view cards (decision 3): scroll to the section and flash it, then it fades away.
function flashSection(blocks) {
  if (!globalThis.CSS?.highlights) return { ok: false, error: "CSS Custom Highlight API unavailable" };
  clearFlash();
  const found = sectionRanges(blocks, buildTextIndex(document.body));
  if (!found.length) return { ok: true, highlighted: 0 };
  CSS.highlights.set("summarizer-flash", new Highlight(...found.map((f) => f.range)));
  scrollRangeIntoView(found[0].range);
  flashTimer = setTimeout(clearFlash, FLASH_MS);
  return { ok: true, highlighted: found.length };
}

// Esc on the page clears the citation, and tells the panel so its button reads "Show on page" again.
// Listens only; the key still reaches the page.
if (!globalThis.__summarizerEscListener) {
  globalThis.__summarizerEscListener = true;
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && clearCitation()) chrome.runtime.sendMessage({ type: "citation-cleared" }).catch(() => {});
    },
    true
  );
}

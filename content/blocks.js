// B1/B2 shared input: walk a content element (Readability's, from the detached clone, or a Google
// Docs export) into an ordered list of blocks.
// See docs/phased-implementation-plan/phase-B-sectioning.md ("Blocks").

// h1 is absent by default: Readability renames article h1s to h2 (the title comes as article.title).
// The Google Docs export passes its own set, since there h1 is a real "Heading 1".
// h5/h6 are treated as text — too fine-grained to be worth a section boundary.
const DEFAULT_HEADING_TAGS = ["H2", "H3", "H4"];
const BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, pre, blockquote, table, figcaption, ul, ol, dl";

function parseBlocks(contentEl, { headingTags = DEFAULT_HEADING_TAGS } = {}) {
  if (!contentEl) return [];

  const headings = new Set(headingTags);
  const blocks = [];
  for (const el of contentEl.querySelectorAll(BLOCK_SELECTOR)) {
    // Outermost block wins: a <p> inside a <li> or <blockquote> is part of that block,
    // and a whole list is one block (single short items embed poorly).
    if (el.parentElement?.closest(BLOCK_SELECTOR)) continue;

    const text = normalizeText(el.textContent || "");
    if (!text) continue;

    const isHeading = headings.has(el.tagName);
    blocks.push({
      id: `b${blocks.length}`,
      type: isHeading ? "heading" : "text",
      ...(isHeading && { level: Number(el.tagName[1]) }),
      text,
      wordCount: countWords(text),
    });
  }
  return blocks;
}

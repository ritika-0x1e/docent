// B1: heading-based split. Pure — takes the plain block list from content/blocks.js.
// See docs/phased-implementation-plan/phase-B-sectioning.md ("B1 — Heading-based split").

const MIN_HEADINGS = 2; // with 0-1 headings the structure says nothing; caller falls back to B2

// Back matter dropped from the reading view and retrieval (decided 2026-11-05, combined run test 7):
// citation lists are long (≈4k words on Wikipedia's "White House") and match many queries badly.
// Whole-heading matches only, so "Sources of funding" or "Notes on setup" are kept. "See also" is kept.
const REFERENCE_HEADINGS = new Set([
  "references",
  "reference",
  "notes",
  "footnotes",
  "notes and references",
  "references and notes",
  "citations",
  "sources",
  "works cited",
  "bibliography",
  "further reading",
  "external links",
]);

function isReferenceHeading(text) {
  return REFERENCE_HEADINGS.has(text.trim().toLowerCase().replace(/[\s:.]+$/, ""));
}

// Pages without real headings mark back matter with a plain line instead: paulgraham.com ends each
// essay with a bold "Notes" (combined run test 8). A text block that is exactly a back-matter
// heading cuts it and everything after, but only in the page's second half, so a stray "Notes" line
// near the top never empties the page. Real headings are handled by splitByHeadings below.
function dropTrailingBackMatter(blocks) {
  const cut = blocks.findIndex((b, i) => b.type === "text" && i >= blocks.length / 2 && isReferenceHeading(b.text));
  return cut === -1 ? blocks : blocks.slice(0, cut);
}

/**
 * @param {Array<{id: string, type: "heading"|"text", level?: number, text: string, wordCount: number}>} blocks
 * @returns {Array<object> | null} sections, or null if there aren't enough headings to use B1
 */
function splitByHeadings(blocks) {
  if (blocks.filter((b) => b.type === "heading").length < MIN_HEADINGS) return null;

  const sections = [];
  const ancestors = []; // open headings, outermost first: [{level, text}]
  let current = { heading: null, headingPath: [], headingBlock: null, body: [] }; // intro

  const close = () => {
    // A heading with no body produces no section; if the next heading is a sub-heading,
    // its text still reaches that section through `ancestors` → headingPath.
    if (current.body.length === 0) return;
    // Back matter, including its sub-sections (e.g. "References" > "Sources").
    if (current.heading !== null && [...current.headingPath, current.heading].some(isReferenceHeading)) return;
    const blocksInSection = current.headingBlock ? [current.headingBlock, ...current.body] : current.body;
    sections.push({
      heading: current.heading,
      headingSource: current.heading === null ? null : "html", // null: intro, B3 generates it
      headingPath: current.headingPath,
      summary: null,
      text: current.body.map((b) => b.text).join("\n\n"),
      wordCount: current.body.reduce((n, b) => n + b.wordCount, 0),
      method: "headings",
      blockIds: blocksInSection.map((b) => b.id),
    });
  };

  for (const block of blocks) {
    if (block.type !== "heading") {
      current.body.push(block);
      continue;
    }
    close();
    while (ancestors.length && ancestors[ancestors.length - 1].level >= block.level) ancestors.pop();
    current = {
      heading: block.text,
      headingPath: ancestors.map((a) => a.text),
      headingBlock: block,
      body: [],
    };
    ancestors.push({ level: block.level, text: block.text });
  }
  close();

  return sections.map((s, i) => ({ id: `s${i}`, ...s }));
}

if (typeof module === "object") {
  module.exports = { splitByHeadings, isReferenceHeading, dropTrailingBackMatter, MIN_HEADINGS };
}

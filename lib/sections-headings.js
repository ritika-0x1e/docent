// B1: heading-based split. Pure — takes the plain block list from content/blocks.js.
// See docs/phased-implementation-plan/phase-B-sectioning.md ("B1 — Heading-based split").

const MIN_HEADINGS = 2; // with 0-1 headings the structure says nothing; caller falls back to B2

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
  module.exports = { splitByHeadings, MIN_HEADINGS };
}

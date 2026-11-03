// B2: running-centroid breakpoint detection for pages without usable headings. Pure — the caller
// embeds the units. See docs/phased-implementation-plan/phase-B-sectioning.md ("B2").

// Defaults, to tune against real pages (combined run). Exported and overridable via opts.
const MIN_BLOCK_WORDS = 12; // shorter blocks merge into the next one: one-liners embed noisily
const SIMILARITY_THRESHOLD = 0.45; // below this, a unit starts a new section
const MIN_SECTION_BLOCKS = 2; // a similarity drop can't end a section shorter than this
const MAX_SECTION_WORDS = 600; // force a break before a section grows past this

/**
 * Groups blocks into embedding units, merging short blocks into the following one
 * (or into the previous one, at the very end).
 * @returns {Array<{blockIds: string[], text: string, wordCount: number}>}
 */
function groupUnits(blocks, { minBlockWords = MIN_BLOCK_WORDS } = {}) {
  const units = [];
  let pending = null;
  for (const block of blocks) {
    pending = pending
      ? { blockIds: [...pending.blockIds, block.id], text: `${pending.text}\n\n${block.text}`, wordCount: pending.wordCount + block.wordCount }
      : { blockIds: [block.id], text: block.text, wordCount: block.wordCount };
    if (pending.wordCount >= minBlockWords) {
      units.push(pending);
      pending = null;
    }
  }
  if (pending) {
    const last = units[units.length - 1];
    if (last) {
      last.blockIds.push(...pending.blockIds);
      last.text += `\n\n${pending.text}`;
      last.wordCount += pending.wordCount;
    } else {
      units.push(pending); // the whole page is shorter than one unit
    }
  }
  return units;
}

/**
 * Walks units in order, keeping the running centroid of the current section. A new section starts
 * when a unit's cosine similarity to the centroid drops below the threshold (once the section has
 * MIN_SECTION_BLOCKS units), or when adding it would push the section past MAX_SECTION_WORDS.
 * @returns {number[]} indices of units that start a section; always begins with 0 if there are units
 */
function detectBreakpoints(vectors, wordCounts, opts = {}) {
  const {
    similarityThreshold = SIMILARITY_THRESHOLD,
    minSectionBlocks = MIN_SECTION_BLOCKS,
    maxSectionWords = MAX_SECTION_WORDS,
  } = opts;
  if (vectors.length === 0) return [];

  const starts = [0];
  let centroidSum = [...vectors[0]]; // cosine is scale-invariant, so the sum stands in for the mean
  let count = 1;
  let words = wordCounts[0];

  for (let i = 1; i < vectors.length; i++) {
    const tooLong = words + wordCounts[i] > maxSectionWords;
    const topicShift = count >= minSectionBlocks && cosine(vectors[i], centroidSum) < similarityThreshold;

    if (tooLong || topicShift) {
      starts.push(i);
      centroidSum = [...vectors[i]];
      count = 1;
      words = wordCounts[i];
    } else {
      for (let d = 0; d < centroidSum.length; d++) centroidSum[d] += vectors[i][d];
      count++;
      words += wordCounts[i];
    }
  }
  return starts;
}

// Turns units + start indices into raw sections (same shape lib/sections-headings.js produces).
function sectionsFromUnits(units, starts) {
  return starts.map((start, i) => {
    const group = units.slice(start, starts[i + 1] ?? units.length);
    return {
      id: `s${i}`,
      heading: null,
      headingSource: null,
      headingPath: [],
      summary: null,
      text: group.map((u) => u.text).join("\n\n"),
      wordCount: group.reduce((n, u) => n + u.wordCount, 0),
      method: "semantic",
      blockIds: group.flatMap((u) => u.blockIds),
    };
  });
}

if (typeof cosine === "undefined" && typeof require === "function") {
  // Node tests: lib/vector.js is a global in the browser (importScripts), a module here.
  globalThis.cosine = require("./vector.js").cosine;
}

if (typeof module === "object") {
  module.exports = {
    groupUnits,
    detectBreakpoints,
    sectionsFromUnits,
    MIN_BLOCK_WORDS,
    SIMILARITY_THRESHOLD,
    MIN_SECTION_BLOCKS,
    MAX_SECTION_WORDS,
  };
}

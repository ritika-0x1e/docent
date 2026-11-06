// B2: running-centroid breakpoint detection for pages without usable headings. Pure — the caller
// embeds the units. See docs/phased-implementation-plan/phase-B-sectioning.md ("B2").

// Defaults. Exported and overridable via opts.
// The similarity threshold is set per page, not fixed: how similar neighbouring paragraphs look to
// all-MiniLM-L6-v2 varies a lot with the writing (combined run, 2026-11-06, 12 headingless pages:
// news, essays, blogs, fiction, speeches, German prose; mean neighbour similarity 0.39–0.59). A
// fixed 0.45 cut news into ~70-word scraps; a fixed 0.30 almost never fired on the German text.
// Mean − 0.5 × spread of the page's own profile, with a 150-word minimum, gave 220–520-word
// sections on every page and hit 8 of 10 real (bold) subheadings on one essay that has them.
const THRESHOLD_SPREAD = 0.5; // threshold = mean − THRESHOLD_SPREAD × sd of the page's profile
const PROFILE_WINDOW = 3; // profile: each unit vs the mean of the previous PROFILE_WINDOW units
const FALLBACK_THRESHOLD = 0.45; // pages too short for a profile
const MIN_BLOCK_WORDS = 12; // shorter blocks merge into the next one: one-liners embed noisily
const MIN_SECTION_WORDS = 150; // a similarity drop can't end a section shorter than this
const MIN_SECTION_BLOCKS = 1; // …nor one with fewer units than this
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
 * The page's own break threshold: compares each unit with the mean of the PROFILE_WINDOW units
 * before it, then takes mean − spread × sd of those similarities. Below this a unit is unusually
 * different from what came just before, for this page.
 */
function pageThreshold(vectors, { spread = THRESHOLD_SPREAD, window = PROFILE_WINDOW } = {}) {
  const sims = [];
  for (let i = 1; i < vectors.length; i++) {
    const context = new Array(vectors[i].length).fill(0);
    for (let j = Math.max(0, i - window); j < i; j++) for (let d = 0; d < context.length; d++) context[d] += vectors[j][d];
    sims.push(cosine(vectors[i], context));
  }
  if (sims.length < 2) return FALLBACK_THRESHOLD;
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length);
  return mean - spread * sd;
}

/**
 * Walks units in order, keeping the running centroid of the current section. A new section starts
 * when a unit's cosine similarity to the centroid drops below the threshold (the page's own, unless
 * opts.similarityThreshold is given; once the section has MIN_SECTION_WORDS words and
 * MIN_SECTION_BLOCKS units), or when adding it would push the section past MAX_SECTION_WORDS.
 * @returns {number[]} indices of units that start a section; always begins with 0 if there are units
 */
function detectBreakpoints(vectors, wordCounts, opts = {}) {
  const { minSectionBlocks = MIN_SECTION_BLOCKS, minSectionWords = MIN_SECTION_WORDS, maxSectionWords = MAX_SECTION_WORDS } = opts;
  if (vectors.length === 0) return [];
  const similarityThreshold = opts.similarityThreshold ?? pageThreshold(vectors, opts);

  const starts = [0];
  let centroidSum = [...vectors[0]]; // cosine is scale-invariant, so the sum stands in for the mean
  let count = 1;
  let words = wordCounts[0];

  for (let i = 1; i < vectors.length; i++) {
    const tooLong = words + wordCounts[i] > maxSectionWords;
    const topicShift = count >= minSectionBlocks && words >= minSectionWords && cosine(vectors[i], centroidSum) < similarityThreshold;

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
    pageThreshold,
    MIN_BLOCK_WORDS,
    THRESHOLD_SPREAD,
    FALLBACK_THRESHOLD,
    MIN_SECTION_WORDS,
    MIN_SECTION_BLOCKS,
    MAX_SECTION_WORDS,
  };
}

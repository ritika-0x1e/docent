const test = require("node:test");
const assert = require("node:assert/strict");
const { groupUnits, detectBreakpoints, sectionsFromUnits } = require("./breakpoints.js");

const words = (n, w = "word") => Array(n).fill(w).join(" ");
const block = (id, n) => ({ id, type: "text", text: words(n), wordCount: n });

// Three well-separated topic directions with a little jitter.
const topic = (axis, jitter) => {
  const v = [0.05, 0.05, 0.05];
  v[axis] = 1;
  v[(axis + 1) % 3] += jitter;
  return v;
};

test("groupUnits merges short blocks into the following block", () => {
  const units = groupUnits([block("b0", 3), block("b1", 20), block("b2", 15)]);
  assert.deepEqual(units.map((u) => u.blockIds), [["b0", "b1"], ["b2"]]);
  assert.equal(units[0].wordCount, 23);
});

test("groupUnits folds a short trailing block into the previous unit", () => {
  const units = groupUnits([block("b0", 20), block("b1", 2)]);
  assert.deepEqual(units.map((u) => u.blockIds), [["b0", "b1"]]);
});

test("groupUnits keeps a page shorter than one unit as a single unit", () => {
  assert.deepEqual(groupUnits([block("b0", 2), block("b1", 3)]).map((u) => u.blockIds), [["b0", "b1"]]);
  assert.deepEqual(groupUnits([]), []);
});

test("three clusters produce exactly two breaks, at the cluster boundaries", () => {
  const vectors = [topic(0, 0), topic(0, 0.1), topic(0, 0.05), topic(1, 0), topic(1, 0.1), topic(2, 0), topic(2, 0.1)];
  const starts = detectBreakpoints(vectors, vectors.map(() => 50));
  assert.deepEqual(starts, [0, 3, 5]);
});

test("a similarity drop can't end a section before MIN_SECTION_BLOCKS units", () => {
  const vectors = [topic(0, 0), topic(1, 0), topic(1, 0.1), topic(1, 0.05)];
  assert.deepEqual(detectBreakpoints(vectors, [50, 50, 50, 50], { minSectionBlocks: 1 }), [0, 1]);
  assert.ok(!detectBreakpoints(vectors, [50, 50, 50, 50], { minSectionBlocks: 2 }).includes(1));
});

test("MAX_SECTION_WORDS forces a break even within one topic", () => {
  const vectors = [topic(0, 0), topic(0, 0), topic(0, 0), topic(0, 0)];
  assert.deepEqual(detectBreakpoints(vectors, [250, 250, 250, 250], { maxSectionWords: 600 }), [0, 2]);
});

test("a single unit gives one section; no units gives none", () => {
  assert.deepEqual(detectBreakpoints([topic(0, 0)], [10]), [0]);
  assert.deepEqual(detectBreakpoints([], []), []);
});

test("sectionsFromUnits groups units into semantic sections", () => {
  const units = groupUnits([block("b0", 20), block("b1", 20), block("b2", 20)]);
  const sections = sectionsFromUnits(units, [0, 2]);
  assert.deepEqual(sections.map((s) => s.blockIds), [["b0", "b1"], ["b2"]]);
  assert.deepEqual(sections.map((s) => [s.id, s.method, s.heading, s.wordCount]), [
    ["s0", "semantic", null, 40],
    ["s1", "semantic", null, 20],
  ]);
});

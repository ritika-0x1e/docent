const test = require("node:test");
const assert = require("node:assert/strict");
const { topKSections, blendedTopK } = require("./retrieval.js");

const chunk = (sectionId, chunkIndex, vector, corpusId = "c1") => ({ corpusId, sectionId, chunkIndex, vector });

test("a section scores by its best chunk, so a strong second chunk outranks a weak single chunk", () => {
  const chunks = [
    chunk("s0", 0, [0.1, 0.99]), // s0 is weak overall
    chunk("s1", 0, [0.2, 0.98]),
    chunk("s1", 1, [0.95, 0.31]), // ...but s1's second chunk matches the query
  ];
  const hits = topKSections([1, 0], chunks);
  assert.deepEqual(hits.map((h) => [h.sectionId, h.bestChunkIndex]), [["s1", 1], ["s0", 0]]);
});

test("k larger than the number of sections returns all of them", () => {
  assert.equal(topKSections([1, 0], [chunk("s0", 0, [1, 0]), chunk("s1", 0, [0, 1])], 5).length, 2);
});

test("ties go to the section earlier in the page (numeric order, not string order)", () => {
  const same = [1, 0];
  const hits = topKSections([1, 0], [chunk("s10", 0, same), chunk("s2", 0, same)]);
  assert.deepEqual(hits.map((h) => h.sectionId), ["s2", "s10"]);
});

test("pools chunks from several corpora into one ranking", () => {
  const hits = topKSections([1, 0], [chunk("s0", 0, [0.5, 0.86], "a"), chunk("s0", 0, [0.9, 0.43], "b")], 2);
  assert.deepEqual(hits.map((h) => h.corpusId), ["b", "a"]);
  assert.ok(hits[0].score > hits[1].score);
});

test("no chunks gives no hits", () => {
  assert.deepEqual(topKSections([1, 0], []), []);
});

test("blendedTopK adds the section that stands out once the shared topic is taken away", () => {
  // Every chunk shares a strong "topic" direction (x); the query has the topic plus a little of z,
  // which only s9 has. Plainly, s9 ranks last-ish; centred, it's first.
  const chunks = [];
  for (let i = 0; i < 9; i++) chunks.push(chunk(`s${i}`, 0, [0.95, Math.sin(i) * 0.3, 0.0]));
  chunks.push(chunk("s9", 0, [0.8, 0, 0.6]));
  const query = [0.97, 0.05, 0.24];
  const plain = topKSections(query, chunks, 3).map((h) => h.sectionId);
  assert.ok(!plain.includes("s9"));
  const blended = blendedTopK(query, chunks, { rawK: 3, centredK: 1 });
  assert.ok(blended.some((h) => h.sectionId === "s9"));
  assert.ok(blended.length <= 4);
  assert.deepEqual(blended.map((h) => h.score), [...blended.map((h) => h.score)].sort((a, b) => b - a)); // plain scores, best first
});

test("blendedTopK on few chunks is just the plain ranking", () => {
  const chunks = [chunk("s0", 0, [1, 0]), chunk("s1", 0, [0, 1])];
  assert.deepEqual(blendedTopK([1, 0], chunks, { rawK: 1, centredK: 4 }).map((h) => h.sectionId), ["s0"]);
});

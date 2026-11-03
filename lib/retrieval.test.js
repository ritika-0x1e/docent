const test = require("node:test");
const assert = require("node:assert/strict");
const { topKSections } = require("./retrieval.js");

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

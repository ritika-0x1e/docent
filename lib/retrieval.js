// C3: top-k section retrieval over chunk vectors. Pure — brute force, which at page scale (tens to
// low hundreds of chunks, ≤ ~8 pages per thread) is well under a millisecond (master-spec §3.7).

// Vectors are unit length (the worker normalizes), so cosine similarity is a plain dot product.
// A section scores as its best chunk (max-sim): a match deep in a long section still counts.
function topKSections(queryVec, chunkRecords, k = 5) {
  const best = new Map(); // "corpusId|sectionId" → best hit so far
  for (const c of chunkRecords) {
    const score = dot(queryVec, c.vector);
    const key = `${c.corpusId}|${c.sectionId}`;
    const current = best.get(key);
    if (!current || score > current.score) {
      best.set(key, { corpusId: c.corpusId, sectionId: c.sectionId, score, bestChunkIndex: c.chunkIndex });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.corpusId.localeCompare(b.corpusId) || sectionOrder(a.sectionId) - sectionOrder(b.sectionId))
    .slice(0, k);
}

// Section ids are "s<index>" in page order; ties go to the section earlier in the page.
function sectionOrder(sectionId) {
  return Number(sectionId.slice(1));
}

if (typeof dot === "undefined" && typeof require === "function") {
  // Node tests: lib/vector.js is a global in the service worker (importScripts), a module here.
  globalThis.dot = require("./vector.js").dot;
}

if (typeof module === "object") {
  module.exports = { topKSections };
}

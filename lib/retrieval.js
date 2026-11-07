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
  ({ dot: globalThis.dot, meanVector: globalThis.meanVector } = require("./vector.js"));
}

// Blended ranking (phase 7 follow-up, 2026-11-07). On a page that's all about one thing, every chunk
// is close to the question's topic words ("white house"), so the word that matters ("built") barely
// moves the ranking: "when was white house built" put Construction 8th. Centring, i.e. taking away
// what all the thread's chunks have in common (their mean vector) from the question and the chunks,
// ranks by what's distinctive: Construction 1st. On ordinary pages it was about even (top 5: 22/25 →
// 23/25 on MDN, Python docs, React docs, Wikipedia), a little worse in places, so it adds to the plain
// ranking instead of replacing it: the plain top `rawK` plus the centred top `centredK`. Scores stay
// plain cosine, which the relevance gate's threshold was measured on.
const MIN_CHUNKS_TO_CENTRE = 8; // with fewer, the mean is mostly the chunks themselves

function unit(v) {
  const n = Math.sqrt(dot(v, v));
  return n ? v.map((x) => x / n) : v;
}

/**
 * @returns hits like topKSections (plain scores, best first), at most rawK + centredK, usually fewer
 */
function blendedTopK(queryVec, chunkRecords, { rawK = 4, centredK = 4 } = {}) {
  const all = topKSections(queryVec, chunkRecords, Infinity);
  const chosen = new Set(all.slice(0, rawK).map((h) => `${h.corpusId}|${h.sectionId}`));
  if (chunkRecords.length >= MIN_CHUNKS_TO_CENTRE) {
    const mean = meanVector(chunkRecords.map((c) => c.vector));
    const centredQuery = unit(queryVec.map((x, i) => x - mean[i]));
    const centred = chunkRecords.map((c) => ({ ...c, vector: unit(c.vector.map((x, i) => x - mean[i])) }));
    for (const h of topKSections(centredQuery, centred, centredK)) chosen.add(`${h.corpusId}|${h.sectionId}`);
  }
  return all.filter((h) => chosen.has(`${h.corpusId}|${h.sectionId}`));
}

if (typeof module === "object") {
  module.exports = { topKSections, blendedTopK };
}

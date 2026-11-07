// F2 (phase 7, decision 1): which text inside a cited section supports the claim. When an answer is
// saved, the sentences citing [n] are matched (local embeddings, no LLM call) against the single
// sentences of section n's blocks; the best one or two become the citation's passages. Each passage is
// a substring of one block's anchored text, so the content script finds it inside that block's live
// range. Pure; background/chat.js does the embedding, content/citations.js the highlighting.
// Plan: docs/phased-implementation-plan/phase-7-citations.md.

const MIN_WINDOW_WORDS = 6; // shorter sentences join the next one
const MAX_PASSAGES = 2;
// A weaker best match isn't shown as "the" passage: the whole section is, instead. Measured on
// White House / Pennsylvania Avenue (phase 7): the right passage 0.71–0.80; the best text of a
// section the claim was miscited to ≤ 0.56. To recheck on other pages (phase 7 checks).
const PASSAGE_MIN = 0.6;

if (typeof answerSentences === "undefined" && typeof require === "function") {
  // Node tests: these are globals in the service worker (importScripts), modules here.
  ({ answerSentences: globalThis.answerSentences, splitSentences: globalThis.splitSentences } = require("./grounding.js"));
  globalThis.dot = require("./vector.js").dot;
}

/** Answer sentences grouped by the source numbers they cite: Map n → [plain sentence]. */
function claimsByCitation(answerText) {
  const claims = new Map();
  for (const s of answerSentences(answerText)) {
    for (const group of s.raw.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
      for (const n of group[1].split(",").map((x) => Number(x.trim()))) {
        if (!claims.has(n)) claims.set(n, []);
        if (!claims.get(n).includes(s.plain)) claims.get(n).push(s.plain);
      }
    }
  }
  return claims;
}

/**
 * One window per sentence inside each anchored block, so a citation highlights the sentence that
 * says it, not its neighbours (user, phase 7). Fragments under MIN_WINDOW_WORDS ("Why?") join the
 * next sentence. Windows are exact substrings of the block's anchor text (whitespace-normalized,
 * so sentences are joined back with single spaces).
 * @param {{id: string, anchored?: boolean, anchor?: {exact: string}}[]} blocks
 * @returns {{blockId: string, exact: string}[]}
 */
function blockWindows(blocks, minWords = MIN_WINDOW_WORDS) {
  const windows = [];
  for (const block of blocks) {
    const text = block.anchored === false ? "" : (block.anchor?.exact ?? "");
    let parts = [];
    let words = 0;
    const sentences = splitSentences(text);
    sentences.forEach((sentence, i) => {
      parts.push(sentence);
      words += sentence.split(/\s+/).length;
      if (words < minWords && i < sentences.length - 1) return;
      const exact = parts.join(" ");
      if (text.includes(exact)) windows.push({ blockId: block.id, exact });
      parts = [];
      words = 0;
    });
  }
  return windows;
}

/**
 * Each claim's best window, best first, without repeats, at most `max`, none below `min`.
 * @returns {{blockId, exact, score}[]}  empty: no clear passage (the whole section is shown)
 */
function pickPassages(claimVecs, windows, windowVecs, { max = MAX_PASSAGES, min = PASSAGE_MIN } = {}) {
  const best = new Map(); // window index → best score from any claim
  for (const claim of claimVecs) {
    let top = -1;
    let topScore = -Infinity;
    windowVecs.forEach((w, i) => {
      const score = dot(claim, w);
      if (score > topScore) [top, topScore] = [i, score];
    });
    if (top >= 0 && topScore >= min && topScore > (best.get(top) ?? -Infinity)) best.set(top, topScore);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([i, score]) => ({ ...windows[i], score: +score.toFixed(3) }));
}

if (typeof module === "object") {
  module.exports = { claimsByCitation, blockWindows, pickPassages, MIN_WINDOW_WORDS, MAX_PASSAGES, PASSAGE_MIN };
}

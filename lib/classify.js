// Pure decision logic for A2 (text vs. media classification).
// No DOM access here on purpose — this must be unit-testable without a browser.
// See docs/phased-implementation-plan/phase-A-extraction-classification.md

const MIN_WORD_COUNT = 175; // spec (master-spec.md §3.1) says ~150-200 words; tune later against real pages
const MEDIA_AREA_RATIO_THRESHOLD = 0.6; // media-dominated if media covers >60% of the article's bounding area

/**
 * @param {{wordCount: number, mediaArea: number, contentArea: number}} measurements
 * @returns {{classification: "text"|"media-dominated"|"sparse", wordCount: number, mediaRatio: number}}
 */
function classifyPage({ wordCount, mediaArea, contentArea }) {
  const mediaRatio = contentArea > 0 ? mediaArea / contentArea : 0;

  if (wordCount >= MIN_WORD_COUNT) {
    return { classification: "text", wordCount, mediaRatio };
  }
  if (mediaRatio > MEDIA_AREA_RATIO_THRESHOLD) {
    return { classification: "media-dominated", wordCount, mediaRatio };
  }
  return { classification: "sparse", wordCount, mediaRatio };
}

if (typeof module === "object") {
  /* eslint-disable-next-line no-redeclare */
  /* global module */
  module.exports = { classifyPage, MIN_WORD_COUNT, MEDIA_AREA_RATIO_THRESHOLD };
}

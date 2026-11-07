// Pure decision logic for A2 (text vs. media classification).
// No DOM access here on purpose — this must be unit-testable without a browser.
// See docs/phased-implementation-plan/phase-A-extraction-classification.md

var MIN_WORD_COUNT = 175; // spec (master-spec.md §3.1) says ~150-200 words; tune later against real pages
var MEDIA_AREA_RATIO_THRESHOLD = 0.6; // media-dominated if media covers >60% of the article's bounding area
// Listing pages (YouTube home, search results, front pages) clear the word floor with link text alone.
// Articles sit far below this even when link-heavy (Wikipedia ~0.15-0.3); decided 2026-11-03, spec §3.1.
var LINK_DENSITY_THRESHOLD = 0.5;

/**
 * @param {{wordCount: number, linkWordCount?: number, mediaArea: number, contentArea: number}} measurements
 * @returns {{classification: "text"|"link-list"|"media-dominated"|"sparse", wordCount: number, linkDensity: number, mediaRatio: number}}
 */
function classifyPage({ wordCount, linkWordCount = 0, mediaArea, contentArea }) {
  const mediaRatio = contentArea > 0 ? mediaArea / contentArea : 0;
  const linkDensity = wordCount > 0 ? linkWordCount / wordCount : 0;
  const result = (classification) => ({ classification, wordCount, linkDensity, mediaRatio });

  if (wordCount >= MIN_WORD_COUNT) {
    return result(linkDensity > LINK_DENSITY_THRESHOLD ? "link-list" : "text");
  }
  if (mediaRatio > MEDIA_AREA_RATIO_THRESHOLD) {
    return result("media-dominated");
  }
  return result("sparse");
}

if (typeof module === "object") {
  /* eslint-disable-next-line no-redeclare */
  /* global module */
  module.exports = { classifyPage, MIN_WORD_COUNT, MEDIA_AREA_RATIO_THRESHOLD, LINK_DENSITY_THRESHOLD };
}

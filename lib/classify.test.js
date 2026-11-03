const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyPage, MIN_WORD_COUNT, MEDIA_AREA_RATIO_THRESHOLD, LINK_DENSITY_THRESHOLD } = require("./classify.js");

test("classifies as text when word count meets the floor", () => {
  const result = classifyPage({ wordCount: MIN_WORD_COUNT, mediaArea: 0, contentArea: 1000 });
  assert.equal(result.classification, "text");
});

test("classifies as text even with heavy media, once word count is enough", () => {
  const result = classifyPage({ wordCount: MIN_WORD_COUNT + 500, mediaArea: 900, contentArea: 1000 });
  assert.equal(result.classification, "text");
});

test("classifies as media-dominated when sparse text and media covers most of the area", () => {
  const result = classifyPage({ wordCount: 10, mediaArea: 900, contentArea: 1000 });
  assert.equal(result.classification, "media-dominated");
  assert.equal(result.mediaRatio, 0.9);
});

test("classifies as sparse when text is thin but media isn't dominant either", () => {
  const result = classifyPage({ wordCount: 10, mediaArea: 100, contentArea: 1000 });
  assert.equal(result.classification, "sparse");
});

test("treats zero content area as zero media ratio instead of dividing by zero", () => {
  const result = classifyPage({ wordCount: 0, mediaArea: 0, contentArea: 0 });
  assert.equal(result.mediaRatio, 0);
  assert.equal(result.classification, "sparse");
});

test("media ratio exactly at threshold does not count as media-dominated (boundary is exclusive)", () => {
  const result = classifyPage({ wordCount: 10, mediaArea: 600, contentArea: 1000 });
  assert.equal(result.mediaRatio, MEDIA_AREA_RATIO_THRESHOLD);
  assert.equal(result.classification, "sparse");
});

test("a page whose text is mostly link text is a link list, even above the word floor", () => {
  const result = classifyPage({ wordCount: 800, linkWordCount: 600, mediaArea: 0, contentArea: 1000 });
  assert.equal(result.classification, "link-list");
  assert.equal(result.linkDensity, 0.75);
});

test("a link-heavy article (Wikipedia-like) is still text", () => {
  const result = classifyPage({ wordCount: 3000, linkWordCount: 750, mediaArea: 0, contentArea: 1000 });
  assert.equal(result.classification, "text");
});

test("link density exactly at threshold is still text (boundary is exclusive)", () => {
  const result = classifyPage({ wordCount: 1000, linkWordCount: 1000 * LINK_DENSITY_THRESHOLD, mediaArea: 0, contentArea: 1000 });
  assert.equal(result.classification, "text");
});

test("missing linkWordCount (Docs/Markdown sources) means zero link density", () => {
  const result = classifyPage({ wordCount: 500, mediaArea: 0, contentArea: 1 });
  assert.equal(result.linkDensity, 0);
  assert.equal(result.classification, "text");
});

test("below the word floor, sparse/media rules apply before link density", () => {
  const result = classifyPage({ wordCount: 50, linkWordCount: 50, mediaArea: 900, contentArea: 1000 });
  assert.equal(result.classification, "media-dominated");
});

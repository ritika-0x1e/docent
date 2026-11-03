const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeText, findQuote, makeQuoteAnchor, countWords, EDGE_CHARS } = require("./text.js");

test("normalizeText collapses all whitespace runs, including newlines and nbsp, and trims", () => {
  assert.equal(normalizeText("  a\n\n b\t c  "), "a b c");
});

test("findQuote returns an exact match", () => {
  assert.deepEqual(findQuote("one two three", "two"), { start: 4, end: 7, exact: true });
});

test("findQuote starts searching at the cursor, skipping an earlier duplicate", () => {
  const hay = "Summary first. Body. Summary second.";
  const second = hay.lastIndexOf("Summary");
  assert.equal(findQuote(hay, "Summary", 1).start, second);
});

test("findQuote falls back to head/tail matching when the middle differs", () => {
  const head = "a".repeat(EDGE_CHARS);
  const tail = "z".repeat(EDGE_CHARS);
  const quote = `${head} middle text ${tail}`;
  const hay = `xx ${head} middle SHARE BUTTON text ${tail} yy`;
  const m = findQuote(hay, quote);
  assert.equal(m.exact, false);
  assert.equal(hay.slice(m.start, m.end), `${head} middle SHARE BUTTON text ${tail}`);
});

test("findQuote rejects a head/tail span far longer than the quote", () => {
  const head = "a".repeat(EDGE_CHARS);
  const tail = "z".repeat(EDGE_CHARS);
  const quote = `${head} ${tail}`;
  const hay = `${head} ${"filler ".repeat(100)}${tail}`;
  assert.equal(findQuote(hay, quote), null);
});

test("findQuote gives up on short quotes that don't match exactly", () => {
  assert.equal(findQuote("hello world", "hello there"), null);
});

test("findQuote returns null for an empty quote", () => {
  assert.equal(findQuote("abc", ""), null);
});

test("makeQuoteAnchor captures exact text plus bounded context", () => {
  const hay = "0123456789".repeat(10);
  const a = makeQuoteAnchor(hay, 40, 50);
  assert.equal(a.exact, "0123456789");
  assert.equal(a.prefix.length, 32);
  assert.equal(a.suffix.length, 32);
  assert.deepEqual(makeQuoteAnchor("abc", 0, 3), { exact: "abc", prefix: "", suffix: "" });
});

test("countWords ignores extra whitespace", () => {
  assert.equal(countWords("  one  two\nthree "), 3);
  assert.equal(countWords(""), 0);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSearchQuery, searchUrl } = require("./web-search.js");

test("a vague or referring question gets the thread's title", () => {
  assert.deepEqual(buildSearchQuery("when was it built?", "White House"), { query: "when was it built? White House", addedTitle: true });
  assert.deepEqual(buildSearchQuery("who designed this", "White House"), { query: "who designed this White House", addedTitle: true });
  assert.equal(buildSearchQuery("bowling alley?", "White House").addedTitle, true); // too few content words
  assert.equal(buildSearchQuery("What is the boiling point of mercury?", "White House").addedTitle, false); // stands alone
});

test("a self-contained question is searched as typed", () => {
  assert.deepEqual(buildSearchQuery("How many people visit Buckingham Palace each year?", "White House"), { query: "How many people visit Buckingham Palace each year?", addedTitle: false });
  assert.equal(buildSearchQuery("when was the White House built", "White House").addedTitle, false); // title already there
  assert.deepEqual(buildSearchQuery("  when   was it built ", ""), { query: "when was it built", addedTitle: false });
});

test("searchUrl encodes the query for the chosen engine, DuckDuckGo by default", () => {
  assert.equal(searchUrl("when was it built? White House"), "https://duckduckgo.com/?q=when%20was%20it%20built%3F%20White%20House");
  assert.equal(searchUrl("a&b", "google"), "https://www.google.com/search?q=a%26b");
  assert.equal(searchUrl("x", "nonsense"), "https://duckduckgo.com/?q=x");
});

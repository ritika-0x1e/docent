const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeUrl, findPage, scanAction, newThread, withPage, replacePage, corpusRefs, threadForPage, sortThreads } = require("./threads.js");

const page = (url, corpusRef = "c1", title = "Page") => ({ url, title, corpusRef });

test("normalizeUrl drops the fragment, a trailing slash and host case", () => {
  assert.equal(normalizeUrl("https://Example.COM/a/b/#intro"), "https://example.com/a/b");
  assert.equal(normalizeUrl("https://example.com/"), "https://example.com/");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com/");
});

test("normalizeUrl removes tracking parameters but keeps ones that pick the content", () => {
  assert.equal(normalizeUrl("https://ex.com/post?utm_source=x&utm_medium=y&fbclid=1&gclid=2"), "https://ex.com/post");
  assert.equal(normalizeUrl("https://ex.com/item?id=7&utm_campaign=z&page=2"), "https://ex.com/item?id=7&page=2");
  assert.notEqual(normalizeUrl("https://ex.com/item?id=7"), normalizeUrl("https://ex.com/item?id=8"));
});

test("normalizeUrl reduces a Google Doc to its id, whatever view it's open in", () => {
  const id = "1BKNoW3IBGnCWZFW08P_ivMRZjtuwublGDUd1toemRn0";
  const key = `https://docs.google.com/document/d/${id}`;
  for (const view of ["/edit", "/edit?tab=t.0#heading=h.1", "/mobilebasic", "/", ""]) {
    assert.equal(normalizeUrl(`https://docs.google.com/document/d/${id}${view}`), key);
  }
  assert.equal(normalizeUrl(`https://docs.google.com/document/u/1/d/${id}/edit`), key, "signed-in account prefix");
});

test("normalizeUrl keeps a raw .md file and its rendered page apart", () => {
  assert.notEqual(
    normalizeUrl("https://raw.githubusercontent.com/o/r/main/README.md"),
    normalizeUrl("https://github.com/o/r/blob/main/README.md")
  );
});

test("normalizeUrl leaves unparseable input alone", () => {
  assert.equal(normalizeUrl("not a url"), "not a url");
  assert.equal(normalizeUrl(undefined), null);
});

test("scanAction covers the three Start scan rows", () => {
  const thread = newThread({ id: "t1", page: page("https://ex.com/a"), now: 1 });
  assert.equal(scanAction(null, "https://ex.com/a"), "new-thread");
  assert.equal(scanAction(thread, "https://ex.com/a#x"), "cache-hit");
  assert.equal(scanAction(thread, "https://ex.com/b"), "append");
  assert.equal(scanAction(thread, undefined), "append"); // URL hidden (no access yet): the background decides
});

test("newThread takes its title from the page, else its host", () => {
  assert.equal(newThread({ id: "t", page: page("https://ex.com/a", "c", "Essay"), now: 5 }).title, "Essay");
  const untitled = newThread({ id: "t", page: page("https://ex.com/a", "c", ""), now: 5 });
  assert.equal(untitled.title, "ex.com");
  assert.deepEqual(untitled.pages, [{ url: "https://ex.com/a", title: "", corpusRef: "c", addedAt: 5 }]);
  assert.deepEqual(untitled.messages, []);
});

test("withPage appends; replacePage swaps the corpus in place and keeps addedAt", () => {
  let thread = newThread({ id: "t", page: page("https://ex.com/a", "c1"), now: 1 });
  thread = withPage(thread, page("https://ex.com/b", "c2"), 2);
  assert.deepEqual(corpusRefs(thread), ["c1", "c2"]);
  assert.equal(findPage(thread, "https://ex.com/b/").corpusRef, "c2");

  thread = replacePage(thread, "https://ex.com/a#top", page("https://ex.com/a", "c3", "New title"), 3);
  assert.deepEqual(corpusRefs(thread), ["c3", "c2"]);
  assert.equal(thread.pages[0].addedAt, 1);
  assert.equal(thread.pages[0].title, "New title");
  assert.equal(thread.updatedAt, 3);
});

test("threadForPage picks the most recently used thread holding the page, else none", () => {
  const a = { ...newThread({ id: "a", page: page("https://ex.com/p"), now: 1 }), updatedAt: 1 };
  const b = { ...newThread({ id: "b", page: page("https://ex.com/p"), now: 2 }), updatedAt: 9 };
  const c = { ...newThread({ id: "c", page: page("https://ex.com/q"), now: 3 }), updatedAt: 20 };
  assert.equal(threadForPage([a, b, c], "https://ex.com/p?utm_source=feed"), "b");
  assert.equal(threadForPage([a, b, c], "https://ex.com/other"), null);
  assert.deepEqual(sortThreads([a, b, c]).map((t) => t.id), ["c", "b", "a"]);
});

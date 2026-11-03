const test = require("node:test");
const assert = require("node:assert/strict");
const { splitByHeadings } = require("./sections-headings.js");

let n = 0;
const h = (level, text) => ({ id: `b${n++}`, type: "heading", level, text, wordCount: text.split(" ").length });
const p = (text) => ({ id: `b${n++}`, type: "text", text, wordCount: text.split(" ").length });

test("returns null with fewer than two headings so the caller falls back to B2", () => {
  assert.equal(splitByHeadings([p("a"), h(2, "Only"), p("b")]), null);
  assert.equal(splitByHeadings([p("a"), p("b")]), null);
});

test("splits at each heading and keeps blocks before the first heading as an intro", () => {
  const blocks = [p("intro text"), h(2, "One"), p("one body"), h(2, "Two"), p("two a"), p("two b")];
  const s = splitByHeadings(blocks);
  assert.equal(s.length, 3);
  assert.deepEqual(s.map((x) => x.heading), [null, "One", "Two"]);
  assert.deepEqual(s.map((x) => x.headingSource), [null, "html", "html"]);
  assert.equal(s[2].text, "two a\n\ntwo b");
  assert.equal(s[2].wordCount, 4);
  assert.deepEqual(s.map((x) => x.id), ["s0", "s1", "s2"]);
});

test("includes the heading block in blockIds so highlights cover the heading too", () => {
  const blocks = [h(2, "One"), p("x"), h(2, "Two"), p("y")];
  const s = splitByHeadings(blocks);
  assert.deepEqual(s[0].blockIds, [blocks[0].id, blocks[1].id]);
});

test("builds headingPath from enclosing heading levels", () => {
  const blocks = [h(2, "Install"), p("general"), h(3, "Linux"), p("apt"), h(4, "Debian"), p("deb"), h(2, "Usage"), p("run")];
  const s = splitByHeadings(blocks);
  assert.deepEqual(
    s.map((x) => [x.heading, x.headingPath]),
    [
      ["Install", []],
      ["Linux", ["Install"]],
      ["Debian", ["Install", "Linux"]],
      ["Usage", []],
    ]
  );
});

test("an empty-bodied heading yields no section but survives in its sub-sections' headingPath", () => {
  const blocks = [h(2, "Chapter"), h(3, "Part A"), p("a"), h(3, "Part B"), p("b")];
  const s = splitByHeadings(blocks);
  assert.deepEqual(s.map((x) => x.heading), ["Part A", "Part B"]);
  assert.deepEqual(s[1].headingPath, ["Chapter"]);
});

test("no intro section when the article starts with a heading", () => {
  const s = splitByHeadings([h(2, "A"), p("a"), h(2, "B"), p("b")]);
  assert.equal(s[0].heading, "A");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanLinks, scoreLinks, allocatePicklist, filterLinks, softCapNote } = require("./links.js");

const PAGE = "https://en.wikipedia.org/wiki/White_House";
const link = (url, anchorText, sourceType = "inline", position = 0.1, surroundingText = "") => ({ url, anchorText, sourceType, position, surroundingText });

test("cleanLinks drops cross-origin, self, files, empty text, footnotes and pages already in the thread", () => {
  const raw = [
    link("https://en.wikipedia.org/wiki/James_Hoban", "James Hoban"),
    link("https://example.com/x", "Elsewhere"),
    link("https://en.wikipedia.org/wiki/White_House#History", "History"),
    link("https://en.wikipedia.org/wiki/File:WH.jpg.png", "photo"),
    link("https://en.wikipedia.org/wiki/Oval_Office", "  "),
    link("https://en.wikipedia.org/wiki/White_House#cite_note-12", "[12]"),
    link("https://en.wikipedia.org/wiki/Pennsylvania_Avenue", "Pennsylvania Avenue"),
    link("mailto:a@b.c", "mail"),
  ];
  const kept = cleanLinks(raw, { pageUrl: PAGE, threadUrls: ["https://en.wikipedia.org/wiki/Pennsylvania_Avenue"] });
  assert.deepEqual(kept.map((l) => l.anchorText), ["James Hoban"]);
});

test("scoreLinks: base weight, position bonus, capped repeats, inline wins over nav", () => {
  const scored = scoreLinks([
    link("https://w.org/a", "A", "inline", 0.1), // 10 + 2
    link("https://w.org/b", "B", "inline", 0.5), // 10 + 1
    link("https://w.org/c", "C", "inline", 0.9), // 10 + 0, repeated 5 more times: +3 cap
    ...Array.from({ length: 5 }, () => link("https://w.org/c", "C again", "inline", 0.95)),
    link("https://w.org/d", "D", "nav", null), // 3
    link("https://w.org/a/", "A in nav", "nav", null), // same page as a: merged, stays inline
    link("https://w.org/e", "E nav", "nav", null),
    link("https://w.org/e", "E inline", "inline", 0.8), // inline wins: 10 + 0
  ]);
  assert.deepEqual(scored.map((l) => [l.anchorText, l.sourceType, l.score]), [
    ["C", "inline", 13],
    ["A", "inline", 12],
    ["B", "inline", 11],
    ["E inline", "inline", 10],
    ["D", "nav", 3],
  ]);
});

const many = (type, n) => Array.from({ length: n }, (_, i) => ({ url: `https://w.org/${type}${i}`, anchorText: `${type}${i}`, sourceType: type, score: type === "inline" ? 10 : 3, order: i }));
for (const [inl, nav, wantInl, wantNav] of [
  [20, 3, 17, 3],
  [5, 20, 5, 15],
  [18, 18, 15, 5],
  [4, 3, 4, 3],
]) {
  test(`allocatePicklist: ${inl} inline / ${nav} nav → ${wantInl} + ${wantNav}`, () => {
    const out = allocatePicklist([...many("inline", inl), ...many("nav", nav)]);
    assert.equal(out.filter((l) => l.sourceType === "inline").length, wantInl);
    assert.equal(out.filter((l) => l.sourceType === "nav").length, wantNav);
    assert.ok(out.length <= 20);
  });
}

test("filterLinks matches every word against text, sentence or address", () => {
  const links = [
    { url: "https://w.org/wiki/James_Hoban", anchorText: "James Hoban", surroundingText: "designed by the Irish-born architect" },
    { url: "https://w.org/wiki/Oval_Office", anchorText: "Oval Office", surroundingText: "the president's office" },
  ];
  assert.deepEqual(filterLinks(links, "irish architect").map((l) => l.anchorText), ["James Hoban"]);
  assert.deepEqual(filterLinks(links, "oval_office").map((l) => l.anchorText), ["Oval Office"]);
  assert.equal(filterLinks(links, "  ").length, 2);
});

test("softCapNote only once the total passes 8", () => {
  assert.equal(softCapNote(5, 3), null);
  assert.match(softCapNote(6, 3), /has 6 pages; adding 3 makes 9/);
  assert.match(softCapNote(1, 8), /has 1 page; adding 8 makes 9/);
});

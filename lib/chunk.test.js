const test = require("node:test");
const assert = require("node:assert/strict");
const { chunkSection } = require("./chunk.js");

const numbered = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const section = (text, extra = {}) => ({ heading: null, headingSource: "generated", headingPath: [], text, ...extra });

test("a short section is one chunk", () => {
  const chunks = chunkSection(section(numbered(50)));
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text.split(" ").length, 50);
});

test("a long section gives overlapping chunks with exact boundaries", () => {
  const chunks = chunkSection(section(numbered(400)), { chunkWords: 180, overlapWords: 30 });
  const bounds = chunks.map((c) => {
    const w = c.text.split(" ");
    return [w[0], w[w.length - 1], w.length];
  });
  assert.deepEqual(bounds, [
    ["w0", "w179", 180],
    ["w150", "w329", 180],
    ["w300", "w399", 100],
  ]);
  assert.deepEqual(chunks.map((c) => c.chunkIndex), [0, 1, 2]);
});

test("exactly one window's worth of words doesn't produce an extra chunk", () => {
  assert.equal(chunkSection(section(numbered(180))).length, 1);
});

test("HTML heading path prefixes every chunk; generated headings don't", () => {
  const html = section(numbered(200), { heading: "Linux", headingSource: "html", headingPath: ["Install"] });
  assert.ok(chunkSection(html).every((c) => c.text.startsWith("Install > Linux\n")));
  const gen = section(numbered(10), { heading: "Made up", headingSource: "generated" });
  assert.ok(!chunkSection(gen)[0].text.includes("Made up"));
});

test("empty text gives no chunks, unless an HTML heading can stand in", () => {
  assert.deepEqual(chunkSection(section("")), []);
  assert.deepEqual(chunkSection(section("  ", { heading: "Only", headingSource: "html" })), [{ chunkIndex: 0, text: "Only" }]);
});

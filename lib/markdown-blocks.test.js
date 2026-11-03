const test = require("node:test");
const assert = require("node:assert/strict");
const { markdownToBlocks, stripInline } = require("./markdown-blocks.js");

const shape = (blocks) => blocks.map((b) => [b.type, b.level ?? null, b.text]);

test("ATX headings at levels 1-4 are headings; deeper levels become text", () => {
  const md = "# One\n## Two ##\n#### Four\n##### Five";
  assert.deepEqual(shape(markdownToBlocks(md)), [
    ["heading", 1, "One"],
    ["heading", 2, "Two"],
    ["heading", 4, "Four"],
    ["text", null, "Five"],
  ]);
});

test("setext headings", () => {
  const md = "Title\n=====\n\nSub\n---\n\nbody";
  assert.deepEqual(shape(markdownToBlocks(md)), [
    ["heading", 1, "Title"],
    ["heading", 2, "Sub"],
    ["text", null, "body"],
  ]);
});

test("paragraphs split on blank lines and keep raw source as anchorText", () => {
  const blocks = markdownToBlocks("Some **bold** and a [link](http://x.y).\nSecond line.\n\nNext para.");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "Some bold and a link. Second line.");
  assert.equal(blocks[0].anchorText, "Some **bold** and a [link](http://x.y). Second line.");
  assert.equal(blocks[0].wordCount, 7);
});

test("a # line inside a code fence is not a heading, and the fence is one block", () => {
  const blocks = markdownToBlocks("```bash\n# install\nnpm i\n```\n\n## Real");
  assert.deepEqual(shape(blocks), [
    ["text", null, "# install npm i"],
    ["heading", 2, "Real"],
  ]);
  assert.equal(blocks[0].anchorText, "```bash # install npm i ```");
});

test("YAML front matter is skipped", () => {
  assert.deepEqual(shape(markdownToBlocks("---\ntitle: x\n---\n# Hi")), [["heading", 1, "Hi"]]);
});

test("a run of list items, including loose lists, is one block", () => {
  const blocks = markdownToBlocks("Intro:\n- one\n- two\n\n- three\n  continued\n\nAfter.");
  assert.deepEqual(shape(blocks), [
    ["text", null, "Intro:"],
    ["text", null, "one two three continued"],
    ["text", null, "After."],
  ]);
});

test("horizontal rules are dropped and empty input gives no blocks", () => {
  assert.deepEqual(shape(markdownToBlocks("a\n\n***\n\nb")), [["text", null, "a"], ["text", null, "b"]]);
  assert.deepEqual(markdownToBlocks(""), []);
});

test("stripInline handles images, code, emphasis, and leaves snake_case alone", () => {
  assert.equal(stripInline("![alt](a.png) `code` *em* _em_ snake_case_name ~~old~~"), "alt code em em snake_case_name old");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDocsUrl, exportUrl } = require("./gdocs.js");

test("parses common Google Docs URLs", () => {
  assert.deepEqual(parseDocsUrl("https://docs.google.com/document/d/abc_DEF-123/edit"), { docId: "abc_DEF-123", accountPrefix: "", tab: null });
  assert.deepEqual(parseDocsUrl("https://docs.google.com/document/d/abc/view?usp=sharing"), { docId: "abc", accountPrefix: "", tab: null });
  assert.deepEqual(parseDocsUrl("https://docs.google.com/document/u/1/d/abc/edit#heading=h.x"), { docId: "abc", accountPrefix: "u/1/", tab: null });
  assert.deepEqual(parseDocsUrl("https://docs.google.com/document/d/abc/edit?tab=t.0"), { docId: "abc", accountPrefix: "", tab: "t.0" });
});

test("rejects non-Docs URLs", () => {
  assert.equal(parseDocsUrl("https://docs.google.com/spreadsheets/d/abc/edit"), null);
  assert.equal(parseDocsUrl("https://example.com/document/d/abc/edit"), null);
  assert.equal(parseDocsUrl("not a url"), null);
});

test("builds the export URL, keeping the account prefix", () => {
  assert.equal(exportUrl({ docId: "abc", accountPrefix: "u/1/", tab: "t.2" }), "https://docs.google.com/document/u/1/d/abc/export?format=html");
  assert.equal(exportUrl({ docId: "abc", accountPrefix: "", tab: null }), "https://docs.google.com/document/d/abc/export?format=html");
});

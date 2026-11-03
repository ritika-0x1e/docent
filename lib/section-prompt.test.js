const test = require("node:test");
const assert = require("node:assert/strict");
const { batchSections, truncateWords, buildRequestBody, parseResponse, fallbackHeading, applyResults } = require("./section-prompt.js");

const section = (id, heading = null, text = "some section text here") => ({ id, heading, headingSource: heading ? "html" : null, headingPath: [], summary: null, text });
const apiReply = (items) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }] });

test("batchSections splits at the batch size", () => {
  const sections = Array.from({ length: 19 }, (_, i) => section(`s${i}`));
  assert.deepEqual(batchSections(sections).map((b) => b.length), [8, 8, 3]);
  assert.deepEqual(batchSections([]), []);
});

test("truncateWords caps long text and leaves short text alone", () => {
  assert.equal(truncateWords("a b c", 5), "a b c");
  assert.equal(truncateWords("a b c d e f", 3), "a b c …");
});

test("buildRequestBody marks which sections need a heading and asks for JSON", () => {
  const body = buildRequestBody([section("s0"), section("s1", "Install")], "Page");
  const prompt = body.contents[0].parts[0].text;
  const items = JSON.parse(prompt.slice(prompt.indexOf("[")));
  assert.deepEqual(items.map((i) => [i.id, i.needsHeading, i.existingHeading]), [["s0", true, undefined], ["s1", false, "Install"]]);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
});

test("parseResponse accepts valid items and ignores unknown ids", () => {
  const batch = [section("s0"), section("s1")];
  const { results, error } = parseResponse(batch, apiReply([
    { id: "s0", heading: "Intro", summary: "Covers the intro." },
    { id: "s1", heading: "Next", summary: "Covers more." },
    { id: "s9", heading: "Bogus", summary: "Not ours." },
  ]));
  assert.equal(error, null);
  assert.deepEqual([...results.keys()], ["s0", "s1"]);
});

test("parseResponse reports missing fields, bad JSON and empty replies", () => {
  const batch = [section("s0"), section("s1")];
  assert.match(parseResponse(batch, apiReply([{ id: "s0", heading: "H", summary: "" }])).error, /2 of 2/);
  assert.match(parseResponse(batch, { candidates: [{ content: { parts: [{ text: "not json" }] } }] }).error, /not valid JSON/);
  assert.match(parseResponse(batch, { candidates: [{ finishReason: "SAFETY" }] }).error, /SAFETY/);
});

test("parseResponse tolerates a fenced JSON reply", () => {
  const reply = { candidates: [{ content: { parts: [{ text: '```json\n[{"id":"s0","heading":"H","summary":"S"}]\n```' }] } }] };
  assert.equal(parseResponse([section("s0")], reply).results.size, 1);
});

test("fallbackHeading uses the first words", () => {
  assert.equal(fallbackHeading(section("s0", null, "one two three")), "one two three");
  assert.equal(fallbackHeading(section("s0", null, "1 2 3 4 5 6 7 8 9 10")), "1 2 3 4 5 6 7 8…");
  assert.equal(fallbackHeading(section("s0", null, "")), "Untitled section");
});

test("applyResults keeps HTML headings, fills generated ones, falls back when missing", () => {
  const results = new Map([
    ["s0", { heading: "Generated", summary: "Sum 0." }],
    ["s1", { heading: "Ignored", summary: "Sum 1." }],
  ]);
  const out = applyResults([section("s0"), section("s1", "Install"), section("s2", null, "first words here")], results);
  assert.deepEqual(out.map((s) => [s.heading, s.headingSource, s.summary]), [
    ["Generated", "generated", "Sum 0."],
    ["Install", "html", "Sum 1."],
    ["first words here", "fallback", null],
  ]);
});

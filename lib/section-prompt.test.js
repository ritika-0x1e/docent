const test = require("node:test");
const assert = require("node:assert/strict");
const { LLM_BATCH_SIZE, batchSections, truncateWords, buildRequestBody, parseResponse, fallbackHeading, applyResults, sectionsToRelabel, mergeRelabelled, buildOllamaBody, joinOllamaStream, ollamaToGeminiShape, OLLAMA_SECTION_WORDS } = require("./section-prompt.js");

const section = (id, heading = null, text = "some section text here") => ({ id, heading, headingSource: heading ? "html" : null, headingPath: [], summary: null, text });
const apiReply = (items) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(items) }] } }] });

test("batchSections splits at the batch size", () => {
  const sections = Array.from({ length: 2 * LLM_BATCH_SIZE + 3 }, (_, i) => section(`s${i}`));
  assert.deepEqual(batchSections(sections).map((b) => b.length), [LLM_BATCH_SIZE, LLM_BATCH_SIZE, 3]);
  assert.deepEqual(batchSections(sections, 8).map((b) => b.length).slice(0, 2), [8, 8]);
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

test("parseResponse needs a generated heading only where the page had none", () => {
  const batch = [section("s0"), section("s1", "Install")];
  const { results, error } = parseResponse(batch, apiReply([
    { id: "s0", heading: "", summary: "Intro without a heading." },
    { id: "s1", heading: "", summary: "How to install." },
  ]));
  assert.match(error, /1 of 2/);
  assert.deepEqual([...results], [["s1", { heading: "Install", summary: "How to install." }]]);
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

test("sectionsToRelabel picks only unsummarised sections and reopens fallback headings", () => {
  const sections = [
    { id: "s0", heading: "Generated", headingSource: "generated", headingPath: [], text: "a", summary: "done" },
    { id: "s1", heading: "Start of the text…", headingSource: "fallback", headingPath: [], text: "b", summary: null },
    { id: "s2", heading: "Install", headingSource: "html", headingPath: [], text: "c", summary: null },
    { id: "s3", heading: "Usage", headingSource: "html", headingPath: [], text: "d", summary: "done" },
  ];
  const pending = sectionsToRelabel(sections);
  assert.deepEqual(pending.map((s) => s.id), ["s1", "s2"]);
  assert.equal(pending[0].heading, null, "fallback heading is regenerated");
  assert.equal(pending[0].headingSource, null);
  assert.equal(pending[1].heading, "Install", "HTML heading is kept");

  // Round trip through B3's applyResults: generated where Gemini answered, fallback where it didn't.
  const labelled = applyResults(pending, new Map([["s1", { heading: "New heading", summary: "One line." }]]));
  const merged = mergeRelabelled(sections, labelled);
  assert.deepEqual(merged.map((s) => s.id), ["s0", "s1", "s2", "s3"]);
  assert.equal(merged[0], sections[0]);
  assert.equal(merged[1].heading, "New heading");
  assert.equal(merged[1].headingSource, "generated");
  assert.equal(merged[2].heading, "Install");
  assert.equal(merged[2].summary, null);
});

test("the Ollama body carries the same prompt as Gemini's, streamed, with a JSON-schema format", () => {
  const batch = [section("s0", null, "some text here")];
  const gemini = buildRequestBody(batch, "Page");
  const ollama = buildOllamaBody(batch, "Page", "some-model");
  assert.equal(ollama.model, "some-model");
  assert.equal(ollama.stream, true);
  assert.equal(ollama.messages[0].content, gemini.contents[0].parts[0].text, "short text: identical prompts");
  assert.equal(ollama.format.type, "array");
  assert.deepEqual(ollama.format.items.required, ["id", "heading", "summary"]);
});

test("an Ollama reply parses through the same validator", () => {
  const batch = [section("s0", null, "text")];
  const reply = { message: { content: JSON.stringify([{ id: "s0", heading: "H", summary: "S." }]) }, done_reason: "stop" };
  const { results, error } = parseResponse(batch, ollamaToGeminiShape(reply));
  assert.equal(error, null);
  assert.deepEqual(results.get("s0"), { heading: "H", summary: "S." });

  const empty = parseResponse(batch, ollamaToGeminiShape({ message: { content: "" }, done_reason: "length" }));
  assert.match(empty.error, /empty response \(length\)/);
});

test("Ollama gets shorter section text than Gemini", () => {
  const long = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
  const prompt = buildOllamaBody([section("s0", null, long)], "Page", "m").messages[0].content;
  assert.match(prompt, new RegExp(`w${OLLAMA_SECTION_WORDS - 1} …`));
  assert.doesNotMatch(prompt, new RegExp(`w${OLLAMA_SECTION_WORDS} `));
});

test("joinOllamaStream concatenates streamed chunks and keeps the done reason", () => {
  const stream = ['{"message":{"content":"[{\\"id\\":"},"done":false}', '{"message":{"content":"\\"s0\\"}]"},"done":false}', '{"done":true,"done_reason":"stop"}', ""].join("\n");
  assert.deepEqual(joinOllamaStream(stream), { message: { content: '[{"id":"s0"}]' }, done_reason: "stop" });
  assert.throws(() => joinOllamaStream('{"error":"model not found"}'), /model not found/);
});

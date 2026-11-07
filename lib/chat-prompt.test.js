const test = require("node:test");
const assert = require("node:assert/strict");
const { buildGeminiChatBody, buildOllamaChatBody, formatSources, stripFootnotes, trimHistory, citedNumbers, isNotCovered, NOT_COVERED } = require("./chat-prompt.js");

const sources = [
  { pageTitle: "White House", headingPath: ["History"], heading: "1789–1800", text: "Washington occupied two houses in New York." },
  { pageTitle: "Pennsylvania Avenue", heading: "Route", text: Array(500).fill("word").join(" ") },
];

test("sources are numbered with their page and heading path, and long text is cut", () => {
  const text = formatSources(sources);
  assert.match(text, /^\[1\] White House › History › 1789–1800\nWashington occupied/);
  assert.match(text, /\[2\] Pennsylvania Avenue › Route\n/);
  assert.ok(text.endsWith("…"));
  assert.ok(text.split(/\s+/).length < 400);
});

test("the Gemini body carries the system prompt, recent turns and the sourced question", () => {
  const history = [
    { role: "user", content: "q1" }, { role: "assistant", content: "a1 [1]" },
    { role: "user", content: "q2" }, { role: "assistant", content: "" }, // stopped before any text
  ];
  const body = buildGeminiChatBody({ question: "Who lived there?", history, sources, mode: "retrieval" });
  assert.match(body.systemInstruction.parts[0].text, /only the numbered sources/);
  assert.deepEqual(body.contents.map((c) => c.role), ["user", "model", "user", "user"]);
  assert.match(body.contents.at(-1).parts[0].text, /^Sources:\n\n\[1\][\s\S]*Question: Who lived there\?\n\n\(Answer only from the sources above[^)]*The sources don't cover this\. Cite each claim like \[1\]\.\)$/);
});

test("the Ollama body uses chat roles and streams", () => {
  const body = buildOllamaChatBody({ question: "q", history: [{ role: "assistant", content: "a" }], sources, mode: "selection" }, "qwen2.5:1.5b");
  assert.equal(body.model, "qwen2.5:1.5b");
  assert.equal(body.stream, true);
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "assistant", "user"]);
  assert.match(body.messages.at(-1).content, /^Source \(the text the user selected/);
});

test("trimHistory keeps the last six finished turns", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` }));
  assert.deepEqual(trimHistory(msgs).map((m) => m.content), ["m4", "m5", "m6", "m7", "m8", "m9"]);
});

test("citedNumbers finds [n], [n, m] and [n][m], in order, within range", () => {
  assert.deepEqual(citedNumbers("A [2]. B [1, 3]. C [3][2]. D [9]. E [0].", 5), [2, 1, 3]);
  assert.deepEqual(citedNumbers("no citations", 5), []);
});

test("isNotCovered matches the fixed reply, loosely on trailing punctuation", () => {
  assert.ok(isNotCovered(NOT_COVERED));
  assert.ok(isNotCovered(" The sources don't cover this \n"));
  assert.ok(!isNotCovered("The sources don't cover this fully, but [1] says…"));
});

test("footnote markers are dropped from sources so they can't pass for citations", () => {
  assert.equal(stripFootnotes("Built by enslaved African-Americans.[28] Hoban won,[a][note 3] then left.[citation needed]"), "Built by enslaved African-Americans. Hoban won, then left.");
  assert.equal(stripFootnotes("Arrays like a[0] and x[i] stay; so does [Section 2]."), "Arrays like a[0] and x[i] stay; so does [Section 2].");
  assert.doesNotMatch(formatSources([{ heading: "h", text: "A fact.[12] Another.[13]" }]), /\[1[23]\]/);
});

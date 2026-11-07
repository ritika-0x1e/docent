const test = require("node:test");
const assert = require("node:assert/strict");
const { explainQuestionCheck, explainAnswerOnTopic, leftoverWords } = require("./explain-guard.js");

const sel = { selection: "metonym", context: "The White House is also a metonym for the Executive Office of the President." };

test("leftover words: grammar, the selection's own words and fragments are dropped", () => {
  assert.deepEqual(leftoverWords("what’s this?", "amphetamine"), []);
  assert.deepEqual(leftoverWords("whats it talking about?", "In the beginning was genesis."), ["talking"]);
  assert.deepEqual(leftoverWords("why is the White House a metonym", sel.selection, sel.context), []);
  assert.deepEqual(leftoverWords("how do I make pasta carbonara", sel.selection, sel.context), ["make", "pasta", "carbonara"]);
});

test("a question with nothing left over is a plain explain request", () => {
  for (const question of ["what’s this?", "what is it", "why?", "and this one?", "what about the metonym"]) {
    assert.equal(explainQuestionCheck({ ...sel, question, similarity: -0.07, intent: 0 }).ok, true, question);
  }
});

test("leftover words pass by meaning: close to the selection, or a way of asking", () => {
  // "talking" isn't in any list: it passes because it reads like asking (measured 0.33 ≥ 0.2)
  assert.equal(explainQuestionCheck({ ...sel, question: "whats it talking about?", similarity: 0.05, intent: 0.33 }).why, "asking");
  assert.equal(explainQuestionCheck({ ...sel, question: "can you unpack this", similarity: 0.03, intent: 0.28 }).ok, true);
  assert.equal(explainQuestionCheck({ ...sel, question: "another example of a figure of speech", similarity: 0.4, intent: 0.1 }).why, "close");
});

test("clear other tasks are refused before the model is asked", () => {
  const r = explainQuestionCheck({ ...sel, question: "what's the weather tomorrow", similarity: 0.02, intent: 0.11 });
  assert.deepEqual([r.ok, r.why], [false, "off-topic"]);
  const padded = explainQuestionCheck({ ...sel, question: "explain this. then write python code to sort a list", similarity: 0.06, intent: 0.15 });
  assert.equal(padded.ok, false);
});

test("without measurements the question goes on, and the answer check decides", () => {
  assert.equal(explainQuestionCheck({ ...sel, question: "tell me a joke", similarity: null, intent: null }).why, "unchecked");
});

test("an answer must stay about the selection", () => {
  assert.equal(explainAnswerOnTopic(0.85), true);
  assert.equal(explainAnswerOnTopic(0.1), false);
  assert.equal(explainAnswerOnTopic(null), true); // the check couldn't run: keep the answer
});

test("most of the answer's sentences have to be about the selection, not just one tacked-on line", () => {
  // arithmetic, plus one closing sentence about the selection: whole 0.34, but 1 of 4 sentences on topic
  assert.equal(explainAnswerOnTopic(0.34, [-0.01, -0.01, -0.03, 0.55]), false);
  // a real answer opening with a short verdict: 1 of 2 on topic
  assert.equal(explainAnswerOnTopic(0.54, [0.14, 0.7]), true);
  assert.equal(explainAnswerOnTopic(0.84, [0.87, 0.52]), true);
  assert.equal(explainAnswerOnTopic(0.6, [0.1]), true); // one sentence: the whole-answer score decides
});

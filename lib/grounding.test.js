const test = require("node:test");
const assert = require("node:assert/strict");
const { numbersIn, sourceNumbers, missingNumbers, answerSentences, sourceWindows, judgeAnswer, isRelevant, RELEVANCE_MIN, SUPPORT_MIN } = require("./grounding.js");

test("numbersIn normalizes thousands separators and drops trailing punctuation", () => {
  assert.deepEqual(numbersIn("It cost 1,792 dollars in 1792. Then 3.5 m, the 13th."), ["1792", "1792", "3.5", "13"]);
});

test("sourceNumbers counts spelled-out small numbers", () => {
  const known = sourceNumbers("The house has six floors and 132 rooms.");
  assert.ok(known.has("6") && known.has("132"));
});

test("missingNumbers lists numbers no source states", () => {
  const known = sourceNumbers("Construction began on 13 October 1792.");
  assert.deepEqual(missingNumbers("It began in 1792 and took 8 years.", known), ["8"]);
  assert.deepEqual(missingNumbers("It began on 13 October 1792.", known), []);
});

test("answerSentences strips citations, bullets and bold, and flags short lines", () => {
  const s = answerSentences("**Yes.** Construction began in 1792 [1]. It was designed by James Hoban [2][3].\n- The Oval Office is in the West Wing [4].");
  assert.deepEqual(
    s.map((x) => [x.plain, x.check]),
    [
      ["Yes.", false],
      ["Construction began in 1792.", true],
      ["It was designed by James Hoban.", true],
      ["The Oval Office is in the West Wing.", true],
    ]
  );
  assert.equal(s[1].raw, "Construction began in 1792 [1].");
});

test("answerSentences doesn't split decimals or abbreviations followed by lowercase", () => {
  assert.equal(answerSentences("Pi is about 3.14 and e.g. used in circles.").length, 1);
});

test("sourceWindows groups whole sentences up to the word budget and covers every sentence", () => {
  const text = "One two three four five. Six seven eight nine ten. Eleven twelve thirteen fourteen fifteen.";
  const w = sourceWindows([text], 10);
  assert.deepEqual(w, ["One two three four five. Six seven eight nine ten.", "Six seven eight nine ten. Eleven twelve thirteen fourteen fifteen."]);
  assert.deepEqual(sourceWindows(["Short."], 10), ["Short."]);
  assert.deepEqual(sourceWindows([""], 10), []);
});

test("judgeAnswer: verdicts from support and numbers", () => {
  const sentences = answerSentences("Construction began in 1792 at the site. The tower is 330 metres tall today. Ok.");
  const known = sourceNumbers("Construction began on 13 October 1792.");
  const all = judgeAnswer(sentences, [0.8, 0.9, null], known);
  assert.equal(all.verdict, "partly"); // 330 isn't in the sources
  assert.deepEqual(all.sentences[1].missing, ["330"]);
  assert.equal(all.sentences[2].supported, null);
  assert.equal(judgeAnswer(sentences, [0.8, 0.1, null], sourceNumbers("1792 330")).verdict, "partly");
  assert.equal(judgeAnswer(sentences, [0.8, 0.8, null], sourceNumbers("1792 330")).verdict, "grounded");
  assert.equal(judgeAnswer(sentences, [0.1, 0.1, null], known).verdict, "ungrounded");
  assert.equal(judgeAnswer(answerSentences("Ok."), [null], known).verdict, "unchecked");
});

test("judgeAnswer: support exactly at the threshold counts as supported", () => {
  const s = answerSentences("This sentence has enough words.");
  assert.equal(judgeAnswer(s, [SUPPORT_MIN], new Set()).verdict, "grounded");
});

test("isRelevant gates on the best section score", () => {
  assert.equal(isRelevant(RELEVANCE_MIN), true);
  assert.equal(isRelevant(RELEVANCE_MIN - 0.01), false);
  assert.equal(isRelevant(undefined), false);
});

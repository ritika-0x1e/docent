const test = require("node:test");
const assert = require("node:assert/strict");
const { splitSentences, sourceWordSet, wordCoverage, numbersIn, sourceNumbers, missingNumbers, answerSentences, sourceWindows, judgeAnswer, needsSimilarity, isRelevant, RELEVANCE_MIN, SUPPORT_MIN } = require("./grounding.js");

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

test("answerSentences doesn't check a lead-in ending in a colon, unless it has a number", () => {
  const s = answerSentences("You can use the CSS Custom Highlight API [1]. The steps to do this are:\n- Create Range objects [1].\nConstruction took 8 years in total:");
  assert.deepEqual(
    s.map((x) => [x.plain, x.check]),
    [
      ["You can use the CSS Custom Highlight API.", true],
      ["The steps to do this are:", false],
      ["Create Range objects.", false],
      ["Construction took 8 years in total:", true],
    ]
  );
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

test("splitSentences keeps initials and abbreviations inside a sentence", () => {
  assert.deepEqual(splitSentences("Taft hired architect Nathan C. Wyeth to add space. It was built in Washington, D.C. in 1909. Dr. Smith agreed."), [
    "Taft hired architect Nathan C. Wyeth to add space.",
    "It was built in Washington, D.C. in 1909.",
    "Dr. Smith agreed.",
  ]);
  assert.deepEqual(splitSentences("It ended (in 1800). \"Then\" it burned! Why? 1814 was the year."), ["It ended (in 1800).", '"Then" it burned!', "Why?", "1814 was the year."]);
  assert.deepEqual(splitSentences("It began in 1792.[25][26] The house rose.[a] Then it burned."), ["It began in 1792.[25][26]", "The house rose.[a]", "Then it burned."]);
  assert.deepEqual(splitSentences("pi is 3.14 and e.g. small.\nNext line"), ["pi is 3.14 and e.g. small.", "Next line"]);
});

test("word check: a short item copied from the sources is found, a new claim isn't", () => {
  const source = "The children who married in the White House are Tricia Nixon Cox (1971). Luci Johnson (1967) and Jenna Bush Hager (2008) held their receptions at the White House.";
  const words = sourceWordSet(source);
  const known = sourceNumbers(source);
  const s = answerSentences("- **1971**: Tricia Nixon Cox [1]\n- **2008**: Jenna Bush Hager (reception) [1]\n- The Rose Garden was used for the 1971 ceremony [1].\n- Lincoln held a wedding in 1863 [1].");
  const judged = judgeAnswer(s, [0.22, 0.41, 0.2, 0.56], known, { words }).sentences;
  assert.deepEqual(judged.map((x) => x.supported), [true, true, false, false]);
  assert.deepEqual(judged[3].missing, ["1863"]);
  assert.equal(wordCoverage("Absolutely.", words), null); // one word: too few to judge
});

test("answerSentences keeps initials inside a sentence, so its citation stays with all of it", () => {
  const s = answerSentences("- Renovations were ordered in 1881 under Chester A. Arthur, with work done in the fall of 1882 [3].\n**Yes.** It was rebuilt in Washington, D.C. after 1814 [4].");
  assert.deepEqual(s.map((x) => x.raw), [
    "Renovations were ordered in 1881 under Chester A. Arthur, with work done in the fall of 1882 [3].",
    "Yes.",
    "It was rebuilt in Washington, D.C. after 1814 [4].",
  ]);
});

test("needsSimilarity: only sentences the word and number checks don't settle are embedded", () => {
  const src = "Construction of the White House began in 1792. James Hoban designed the building.";
  const known = sourceNumbers(src);
  const words = sourceWordSet(src);
  const [copied, invented, paraphrase, short] = answerSentences("James Hoban designed the White House building. It was rebuilt in 1817 after a fire. An Irish architect drew up the plans. Ok.");
  assert.equal(needsSimilarity(copied, known, words), false); // word check finds it
  assert.equal(needsSimilarity(invented, known, words), false); // 1817 isn't in the sources: unsupported anyway
  assert.equal(needsSimilarity(paraphrase, known, words), true);
  assert.equal(needsSimilarity(short, known, words), false); // not checked at all
  // Verdicts match a run that embedded everything: the skipped ones don't depend on similarity.
  const all = answerSentences("James Hoban designed the White House building. It was rebuilt in 1817 after a fire.");
  for (const sim of [0, 0.99]) {
    assert.deepEqual(judgeAnswer(all, [sim, sim], known, { words }).sentences.map((x) => x.supported), [true, false]);
  }
});

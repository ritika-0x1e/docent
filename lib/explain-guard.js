// Explain mode's guards (user, 2026-11-07: "we can't fully open it, they could use it to bypass the
// restrictions"). With text selected the model may use general knowledge, so selecting a word must
// not turn the panel into a general chatbot. Decided by meaning (local embeddings), not by lists of
// phrasings, so a new way of asking still works (user: "hardcoded will fail on unseen words"):
//
//   1. Before the call, only the obvious misses are refused. A question's leftover words (what's left
//      after grammar words and words from the selection) are refused only if they are far from the
//      selection AND far from a few example "help me understand" requests.
//   2. The model is told to explain only this text and decline anything else.
//   3. After the call, the answer (as a whole, and most of its sentences) must be about the selection,
//      or it's hidden: the real backstop.
//
// Measured 2026-11-07 (MiniLM, the model that embeds pages):
//   leftover words that are ways of asking ("unpack", "talking", "gist", "eli5"…, 33 phrasings)
//   0.28–0.73 against the example requests; other tasks ("weather", "python code", "poem sea"…)
//   0.11–0.36. They overlap, so the question check alone can't separate them: its cutoff (0.2) only
//   stops clear tasks, and borderline ones ("joke" 0.36, "song lyrics" 0.36) go on to step 3.
//   Answers: on-topic 0.47–0.85, off-topic −0.05–0.10 against the selection: a clean split.
//   Specific on-topic questions vs the selection: 0.19–0.67; off-topic ≤ 0.09.
// Pure; background/chat.js does the embedding.

const QUESTION_MIN = 0.15; // question vs selection + paragraph: specific on-topic ≥ 0.19
const INTENT_MIN = 0.2; // leftover words vs example requests: all 33 ways of asking ≥ 0.28
const ANSWER_MIN = 0.25; // answer vs selection: on-topic ≥ 0.47, off-topic ≤ 0.10

// Examples of asking to understand something, compared by meaning with a question's leftover words.
const INTENT_EXAMPLES = [
  "explain this",
  "what does this mean",
  "what is this about",
  "help me understand this",
  "I don't understand this",
  "summarize this",
  "simplify this",
  "clarify this",
  "give me the gist",
  "rephrase this in plain words",
];

// Grammar words only (articles, pronouns, question words, auxiliaries…): ordinary English, not a
// list of phrasings. What's left after removing them is what the question is really asking about.
const GRAMMAR = new Set(
  ("a an the this that these those it its it's here there what whats what's which who whos whose whom why how when where " +
    "is are was were be been being am do does did done have has had can could would should will shall may might must " +
    "i im i'm me my you your we us our they them their he him his she her of in on at to for from by with about into " +
    "and or but so if as than then too very just also please pls plz thanks thank thx kindly okay ok hey hi " +
    "one ones something anything everything someone")
    .split(" ")
);

// Curly apostrophes count as straight ones ("what’s" from autocorrect once read as "what" + "s").
function words(text) {
  return (text.toLowerCase().replace(/[’‘`´]/g, "'").match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [])
    .map((w) => w.replace(/'s$/, ""))
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
}

/** The question's own words: not grammar, not from the selection or its paragraph, not fragments. */
function leftoverWords(question, selection, context = "") {
  const fromText = new Set(words(`${selection} ${context}`));
  return words(question).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !GRAMMAR.has(w) && !fromText.has(w));
}

/**
 * Before the model is asked.
 * @param {number|null} similarity  the whole question vs selection + paragraph
 * @param {number|null} intent  the leftover words vs the closest INTENT_EXAMPLES
 * @returns {{ok: boolean, why: "explain-request" | "close" | "asking" | "unchecked" | "off-topic", novel: string[]}}
 */
function explainQuestionCheck({ question, selection, context = "", similarity, intent }) {
  const novel = leftoverWords(question, selection, context);
  if (!novel.length) return { ok: true, why: "explain-request", novel };
  if (typeof similarity === "number" && similarity >= QUESTION_MIN) return { ok: true, why: "close", novel };
  if (typeof intent === "number" && intent >= INTENT_MIN) return { ok: true, why: "asking", novel };
  // Without the measurements (embedding failed), let it through: step 3 still checks the answer.
  if (typeof similarity !== "number" || typeof intent !== "number") return { ok: true, why: "unchecked", novel };
  return { ok: false, why: "off-topic", novel };
}

// Per sentence (measured on qwen answers, 2026-11-07): sentences of real explanations 0.52–0.87, plus a
// short verdict opener at 0.14 ("No, it's not a metaphor."); sentences of off-topic answers ≤ 0.16.
// The whole-answer score alone leaked once: arithmetic for "17 times 23" plus one closing line about
// the selection scored 0.34. So most of the sentences have to be about the selection too.
const SENTENCE_MIN = 0.2;
const ON_TOPIC_SHARE = 0.5;

/**
 * After the answer: false when it drifted away from the selection.
 * @param {number|null} similarity  the whole answer vs selection + paragraph
 * @param {number[]} perSentence  each sentence of the answer vs the same
 */
function explainAnswerOnTopic(similarity, perSentence = []) {
  if (typeof similarity === "number" && similarity < ANSWER_MIN) return false;
  if (perSentence.length < 2) return true;
  return perSentence.filter((x) => x >= SENTENCE_MIN).length / perSentence.length >= ON_TOPIC_SHARE;
}

if (typeof module === "object") {
  module.exports = { explainQuestionCheck, explainAnswerOnTopic, leftoverWords, INTENT_EXAMPLES, QUESTION_MIN, INTENT_MIN, ANSWER_MIN, SENTENCE_MIN };
}

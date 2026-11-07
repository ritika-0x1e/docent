// Phase 6 hallucination control, local and free (no extra LLM call). Two checks around the one
// answer call:
//  1. Relevance gate, before the call: if no section is even loosely related to the question, the
//     model isn't asked. Small models ignore "say it's not covered" and answer from memory (qwen2.5
//     1.5B in the phase 6 run), so the plainest off-topic questions never reach them.
//  2. Grounding check, after the call: every answer sentence must be close (embedding similarity) to
//     some window of the sources it was given, and every number in it must appear in those sources.
// Pure; background/chat.js does the embedding. Thresholds were measured on varied pages, see
// docs/phased-implementation-plan/phase-6-chat.md ("Hallucination control").

const RELEVANCE_MIN = 0.2; // best section score below this: off-topic, the model isn't asked
const SUPPORT_MIN = 0.5; // a sentence's best match in the sources below this: not found in them
const WINDOW_WORDS = 45; // source windows are a few sentences, so a one-sentence claim isn't diluted
const MIN_CLAIM_WORDS = 4; // shorter sentences ("Yes.", "In short:") aren't claims worth checking

// "1,792" and "1792", "13th" and "13", "3.5" kept as is. A trailing "." or "," is punctuation.
function numbersIn(text) {
  return [...text.matchAll(/\d(?:[\d,.]*\d)?/g)].map((m) => m[0].replace(/,(?=\d{3}\b)/g, ""));
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/** Every number a source states, as digits ("six floors" counts as 6). */
function sourceNumbers(text) {
  const set = new Set(numbersIn(text));
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const n = NUMBER_WORDS.indexOf(word);
    if (n >= 0) set.add(String(n));
  }
  return set;
}

/** Numbers in a claim that no source (or the question) states. */
function missingNumbers(sentence, known) {
  return [...new Set(numbersIn(sentence))].filter((n) => !known.has(n));
}

// The answer as sentences: bullets and bold dropped; `plain` also without citation markers (what's
// checked), `raw` with them (what the panel matches to mark a sentence), and a "check" flag (long enough to be a claim).
function answerSentences(text) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, ""))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/))
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const plain = raw.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "").replace(/\s+/g, " ").trim();
      return { raw, plain, check: plain.split(" ").filter((w) => /\w/.test(w)).length >= MIN_CLAIM_WORDS };
    });
}

/** Sources cut into overlapping windows of whole sentences, about WINDOW_WORDS each. */
function sourceWindows(texts, maxWords = WINDOW_WORDS) {
  const windows = [];
  for (const text of texts) {
    const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < sentences.length; i++) {
      let words = 0;
      const parts = [];
      for (let j = i; j < sentences.length && (words === 0 || words < maxWords); j++) {
        parts.push(sentences[j]);
        words += sentences[j].split(/\s+/).length;
      }
      windows.push(parts.join(" "));
      if (i + parts.length >= sentences.length) break; // the rest is already inside this window
    }
  }
  return windows;
}

/**
 * @param {{plain, check}[]} sentences  from answerSentences
 * @param {(number|null)[]} supports  each sentence's best similarity to a source window (null: not checked)
 * @param {Set<string>} known  numbers stated in the sources and the question
 * @returns {{verdict: "grounded"|"partly"|"ungrounded"|"unchecked", sentences: {text, support, missing, supported}[]}}
 */
function judgeAnswer(sentences, supports, known, { supportMin = SUPPORT_MIN } = {}) {
  const judged = sentences.map((s, i) => {
    if (!s.check) return { text: s.raw, support: null, missing: [], supported: null };
    const missing = missingNumbers(s.plain, known);
    const support = supports[i];
    return { text: s.raw, support: support == null ? null : +support.toFixed(3), missing, supported: support >= supportMin && missing.length === 0 };
  });
  const checked = judged.filter((s) => s.supported !== null);
  const ok = checked.filter((s) => s.supported).length;
  const verdict = !checked.length ? "unchecked" : ok === checked.length ? "grounded" : ok === 0 ? "ungrounded" : "partly";
  return { verdict, sentences: judged };
}

function isRelevant(topScore, min = RELEVANCE_MIN) {
  return typeof topScore === "number" && topScore >= min;
}

if (typeof module === "object") {
  module.exports = { numbersIn, sourceNumbers, missingNumbers, answerSentences, sourceWindows, judgeAnswer, isRelevant, RELEVANCE_MIN, SUPPORT_MIN };
}

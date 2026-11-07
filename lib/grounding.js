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
// Measured 2026-11-07 on 5 pages (51 true claims: source sentences reworded or cut to short notes by
// qwen; 58 made-up ones: qwen answering near-topic questions the pages don't cover, from memory), with
// the word check: 0.5 keeps 90% of true claims and catches 60% of made-up sentences (14 of 20 made-up
// answers get an underline, 8 are hidden). 0.55 would catch 72% but flag 18% of true claims; the user
// minds false underlines, so 0.5. Data: phase-6-chat.md ("Hallucination control").
const SUPPORT_MIN = 0.5;
const WINDOW_WORDS = 45; // source windows are a few sentences, so a one-sentence claim isn't diluted
const MIN_CLAIM_WORDS = 4; // shorter sentences ("Yes.", "In short:") aren't claims worth checking

// A lead-in that ends with a colon ("The steps to do this are:") introduces what follows and states
// nothing itself; checked, it was underlined on most list answers. One with a digit still is, so
// "Construction took 8 years:" can't slip a made-up number past the check.
function isClaim(plain) {
  if (plain.split(" ").filter((w) => /\w/.test(w)).length < MIN_CLAIM_WORDS) return false;
  return !(plain.endsWith(":") && !/\d/.test(plain));
}

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

// Word check (2026-11-07): short list items like "1971: Tricia Nixon Cox", copied from the page,
// scored 0.22 on similarity against whole paragraphs and were flagged. A claim whose content words are
// nearly all in its sources is found there, whatever its similarity. Plural/singular count as the same.
const WORD_COVERAGE_MIN = 0.8;
const MIN_CONTENT_WORDS = 2; // one word alone ("Yes", a name) isn't enough to judge by
const STOPWORDS = new Set("the and for are was were has have had not but with from that this these those its his her their they them who whom which what when where why how all any can could would should will into onto over under than then there here also been being about after before while during such only very more most some other each both into upon our your you she him it is be by of on in at to as an or a".split(" "));

function stem(word) {
  return word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
}

/** The sources' words, lower-case, singular-ish, for the word check. */
function sourceWordSet(text) {
  return new Set((text.toLowerCase().match(/\p{L}+/gu) ?? []).map(stem));
}

/** Share of a claim's content words found in the sources, or null if it has too few to judge. */
function wordCoverage(sentence, words) {
  const content = (sentence.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w)).map(stem);
  if (content.length < MIN_CONTENT_WORDS) return null;
  return content.filter((w) => words.has(w)).length / content.length;
}

/** Numbers in a claim that no source (or the question) states. */
function missingNumbers(sentence, known) {
  return [...new Set(numbersIn(sentence))].filter((n) => !known.has(n));
}

// The answer as sentences: bullets and bold dropped; `plain` also without citation markers (what's
// checked), `raw` with them (what the panel matches to mark a sentence), and a "check" flag (long enough to be a claim).
// Split with splitSentences, like the sources: "Chester A. Arthur" isn't two sentences (it was, and
// the half carrying [3] matched nothing, so the citation fell back to its whole section). The panel
// splits answer lines the same way to underline sentences (render.js lineNodes).
function answerSentences(text) {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))
    .flatMap((line) => splitSentences(line))
    .map((raw) => raw.replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .map((raw) => {
      const plain = raw.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "").replace(/\s+/g, " ").trim();
      return { raw, plain, check: isClaim(plain) };
    });
}

// A period after an initial or a common abbreviation doesn't end a sentence: "Nathan C. Wyeth",
// "Washington, D.C.", "e.g.", "Dr." (phase 7: a passage was cut at "Nathan C."). Missing a real end
// only makes a window longer; a false end cuts a quote in half.
const NOT_AN_END = /(?:^|[\s(])(?:[A-Za-z]|(?:[A-Za-z]\.)+[A-Za-z]|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|No|Nos|Fig|Vol|Gen|Col|Lt|Capt|Rev|Mt|Ft|Ave|Inc|Ltd|Co|ca|approx)\.$/;

/** Source text split into sentences (and lines). Pieces are trimmed substrings of the text. */
function splitSentences(text) {
  const sentences = [];
  for (const line of text.split(/\n+/)) {
    let start = 0;
    // The end may be followed by closing quotes/brackets, footnote markers ("stone.[25][26] The") and
    // bold marks in answers ("**Yes.** It").
    for (const m of line.matchAll(/[.!?](?:["”’')\]]|\[[^\]\s]{1,12}\]|\*\*)*(\s+)(?=(?:\*\*)?["“(\[]?[A-Z0-9])/g)) {
      const end = m.index + m[0].length - m[1].length;
      const piece = line.slice(start, end);
      if (NOT_AN_END.test(piece)) continue;
      sentences.push(piece.trim());
      start = m.index + m[0].length;
    }
    sentences.push(line.slice(start).trim());
  }
  return sentences.filter(Boolean);
}

/** Sources cut into overlapping windows of whole sentences, about WINDOW_WORDS each. */
function sourceWindows(texts, maxWords = WINDOW_WORDS) {
  const windows = [];
  for (const text of texts) {
    const sentences = splitSentences(text);
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
 * @param {{words?: Set<string>}} options  words: the sources' words (sourceWordSet), for the word check
 * @returns {{verdict: "grounded"|"partly"|"ungrounded"|"unchecked", sentences: {text, support, missing, supported}[]}}
 */
function judgeAnswer(sentences, supports, known, { supportMin = SUPPORT_MIN, words = null } = {}) {
  const judged = sentences.map((s, i) => {
    if (!s.check) return { text: s.raw, support: null, missing: [], supported: null };
    const missing = missingNumbers(s.plain, known);
    const support = supports[i];
    const coverage = words ? wordCoverage(s.plain, words) : null;
    const found = support >= supportMin || (coverage != null && coverage >= WORD_COVERAGE_MIN);
    return { text: s.raw, support: support == null ? null : +support.toFixed(3), coverage: coverage == null ? null : +coverage.toFixed(2), missing, supported: found && missing.length === 0 };
  });
  const checked = judged.filter((s) => s.supported !== null);
  const ok = checked.filter((s) => s.supported).length;
  const verdict = !checked.length ? "unchecked" : ok === checked.length ? "grounded" : ok === 0 ? "ungrounded" : "partly";
  return { verdict, sentences: judged };
}

/**
 * Whether a checked sentence's verdict depends on its embedding similarity. Not when the word check
 * already finds it, or when it states a number the sources don't (unsupported either way), so
 * those skip the embedding (2026-11-07: the check took 7–20 s on long docs pages). Same verdicts.
 */
function needsSimilarity(sentence, known, words) {
  if (!sentence.check || missingNumbers(sentence.plain, known).length) return false;
  const coverage = words ? wordCoverage(sentence.plain, words) : null;
  return !(coverage != null && coverage >= WORD_COVERAGE_MIN);
}

function isRelevant(topScore, min = RELEVANCE_MIN) {
  return typeof topScore === "number" && topScore >= min;
}

if (typeof module === "object") {
  module.exports = { splitSentences, sourceWordSet, wordCoverage, numbersIn, sourceNumbers, missingNumbers, answerSentences, sourceWindows, judgeAnswer, needsSimilarity, isRelevant, RELEVANCE_MIN, SUPPORT_MIN };
}

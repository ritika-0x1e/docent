// E2 (phase 8): web search as a plain redirect. DuckDuckGo's HTML endpoint refuses the extension's
// requests (a bot challenge or 403, checked 2026-11-07), so nothing is fetched or parsed: "Search the
// web" opens the question as an ordinary results page in a new tab (decision 1). Pure; the panel and
// background call it. Plan: docs/phased-implementation-plan/phase-8-web-search.md.

const SEARCH_ENGINES = {
  duckduckgo: { name: "DuckDuckGo", url: "https://duckduckgo.com/?q=" },
  google: { name: "Google", url: "https://www.google.com/search?q=" },
  bing: { name: "Bing", url: "https://www.bing.com/search?q=" },
  brave: { name: "Brave Search", url: "https://search.brave.com/search?q=" },
};
const DEFAULT_ENGINE = "duckduckgo";

// Decision 3: the thread's title is added when the question alone is too vague to search: few content
// words, or it leans on the conversation ("it", "this", "they"…).
const VAGUE_MIN_WORDS = 3; // "boiling point mercury" (3) stands alone; "bowling alley" (2) doesn't
const REFERS_BACK = /\b(it|its|this|that|these|those|they|them|their|he|she|his|her|here|there)\b/i;
const FILLER = new Set("what when where which who whom whose why how is are was were be been do does did the a an of to in on at for and or but with about from by tell me explain describe".split(" "));

function contentWords(text) {
  return (text.toLowerCase().match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? []).filter((w) => !FILLER.has(w));
}

/**
 * @returns {{query: string, addedTitle: boolean}}
 */
function buildSearchQuery(question, threadTitle) {
  const q = question.replace(/\s+/g, " ").trim();
  const title = (threadTitle ?? "").replace(/\s+/g, " ").trim();
  if (!title) return { query: q, addedTitle: false };
  const vague = contentWords(q).length < VAGUE_MIN_WORDS || REFERS_BACK.test(q);
  const alreadyThere = q.toLowerCase().includes(title.toLowerCase());
  return vague && !alreadyThere ? { query: `${q} ${title}`, addedTitle: true } : { query: q, addedTitle: false };
}

// With text selected (explain mode), "Search the web" searches the selection, not the thread's title
// (user, 2026-11-07: "whats it talking about? <thread title>" found nothing useful). A short selection
// goes in as an exact phrase; a passage is cut to its key terms (names and longer words, up to
// KEY_TERMS, in their order), since search boxes don't take paragraphs. The question's own words are
// kept; a plain "what's this?" becomes "meaning" (a word) or "explained" (a passage).
const PHRASE_WORDS = 6;
const KEY_TERMS = 8;
const QUESTION_FILLER = new Set(
  ("what whats what's which who whos why how is are was were be do does did the a an of in on to for and or but with about from by " +
    "this that these those it its it's here there me my i im i'm you your please pls can could would will tell explain explained mean meaning " +
    "means define simplify simple words word say saying says talk talking gist main idea point break down tldr tl dr get dont don't understand " +
    "help just really actually basically trying author refer refers")
    .split(" ")
);
const PASSAGE_STOP = new Set(
  ("the and for are was were has have had not but with from that this these those its their they them who whom which what when where " +
    "why how all any can could would should will into onto over under than then there here also been being about after before while " +
    "during such only very more most some other each both upon your you she him her his our may might must just even like said says say")
    .split(" ")
);

function keyTerms(passage, max = KEY_TERMS) {
  const seen = new Set();
  const terms = [];
  const text = passage.replace(/\[(?:\d+|[a-z]{1,2})\]/gi, "");
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu)) {
    const word = m[0].replace(/'s$/i, "");
    const key = word.toLowerCase();
    if (seen.has(key) || PASSAGE_STOP.has(key)) continue;
    // A capital counts as a name only mid-sentence ("In the beginning" isn't one).
    const sentenceStart = /(^|[.!?]["”')\]]*\s+|["“(]\s*)$/.test(text.slice(0, m.index));
    const isName = /^\p{Lu}/u.test(word) && key.length > 1 && !sentenceStart;
    if (sentenceStart && key.length < 5) continue;
    if (!isName && key.length < 5) continue; // short common words carry little for a search
    seen.add(key);
    terms.push({ word, weight: (isName ? 2 : 0) + Math.min(key.length, 12) / 6 });
  }
  // the strongest terms, kept in the passage's order
  const keep = new Set([...terms].sort((a, b) => b.weight - a.weight).slice(0, max).map((t) => t.word));
  return terms.filter((t) => keep.has(t.word)).map((t) => t.word);
}

/** "Search the web" for a question about selected text. */
function buildQuoteSearchQuery(question, selection) {
  const quote = selection.replace(/\[(?:\d+|[a-z]{1,2})\]/gi, "").replace(/\s+/g, " ").trim();
  const own = (question.toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []).filter((w) => !QUESTION_FILLER.has(w));
  const words = quote.split(" ").length;
  const subject = words <= PHRASE_WORDS ? `"${quote.replace(/[".,;:!?]+$/g, "")}"` : keyTerms(quote).join(" ");
  const ask = own.length ? own.join(" ") : words <= PHRASE_WORDS ? "meaning" : "explained";
  return `${subject} ${ask}`.trim();
}

function searchUrl(query, engine = DEFAULT_ENGINE) {
  return `${(SEARCH_ENGINES[engine] ?? SEARCH_ENGINES[DEFAULT_ENGINE]).url}${encodeURIComponent(query)}`;
}

if (typeof module === "object") {
  module.exports = { buildSearchQuery, buildQuoteSearchQuery, keyTerms, searchUrl, SEARCH_ENGINES, DEFAULT_ENGINE };
}

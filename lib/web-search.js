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

function searchUrl(query, engine = DEFAULT_ENGINE) {
  return `${(SEARCH_ENGINES[engine] ?? SEARCH_ENGINES[DEFAULT_ENGINE]).url}${encodeURIComponent(query)}`;
}

if (typeof module === "object") {
  module.exports = { buildSearchQuery, searchUrl, SEARCH_ENGINES, DEFAULT_ENGINE };
}

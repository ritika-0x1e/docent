// E1/E3/E4 (phase 6, decision 2): retrieve, then answer in one LLM call. The background finds the
// sources (the best 4–8 sections, or the page selection), and this builds the request: numbered sources,
// the last few turns, the question. The model cites sources as [n]. Pure; background/chat.js calls it.
// Plan: docs/phased-implementation-plan/phase-6-chat.md.

const CHAT_HISTORY_MESSAGES = 6; // last 3 question/answer pairs
const SOURCE_WORDS = 350; // per retrieved section; usually 5–6 sections ≈ 2,000 words
const SELECTION_WORDS = 1500;
const NOT_COVERED = "The sources don't cover this.";

const SYSTEM_PROMPT = [
  "You answer questions about web pages the user is reading, using only the numbered sources given with each question.",
  "Cite every claim with its source number in square brackets, like [1] or [2][3]. Never cite a number that isn't listed.",
  `If the sources don't contain the answer, reply with exactly "${NOT_COVERED}" and nothing else. Never use outside knowledge or guess.`,
  "Be concise: a few sentences or a short list. Plain text; **bold** and '- ' bullets are fine, no headings or tables.",
].join("\n");

// Footnote markers in page text ("…Americans.[28]", ",[a]", "[citation needed]") look exactly like
// our [n] citations, and a model copies them into its answer (seen with qwen2.5 on Wikipedia, phase 6).
// They're dropped from the sources it's given. Only markers right after punctuation (where footnotes
// sit) or spelled-out ones: "a[0]" or "x[i]" in code-like text stays. A marker left mid-word is
// harmless in the panel too: only numbers with a source card become citation chips.
const FOOTNOTE_AFTER_PUNCT = /([.,;:!?)"'’”])\[(?:\d+|[a-z]{1,2}|(?:note|nb|n)\s*\d+)\]/gi;
const FOOTNOTE_WORDS = /\[(?:citation needed|clarification needed|when\?|who\?|which\?|edit)\]/gi;

function stripFootnotes(text) {
  let out = text.replace(FOOTNOTE_WORDS, "");
  for (let prev = null; prev !== out; ) [prev, out] = [out, out.replace(FOOTNOTE_AFTER_PUNCT, "$1")]; // "won.[a][3]"
  return out.replace(/[ \t]{2,}/g, " ");
}

function truncateWordsTo(text, maxWords) {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? words.join(" ") : `${words.slice(0, maxWords).join(" ")} …`;
}

/**
 * @param {{pageTitle?: string, heading?: string, headingPath?: string[], text: string}[]} sources  in rank order
 * @param {"retrieval" | "selection"} mode
 */
function formatSources(sources, mode = "retrieval") {
  const maxWords = mode === "selection" ? SELECTION_WORDS : SOURCE_WORDS;
  return sources
    .map((s, i) => {
      const where = [s.pageTitle, ...(s.headingPath ?? []), s.heading].filter(Boolean).join(" › ");
      return `[${i + 1}] ${where}\n${truncateWordsTo(stripFootnotes(s.text), maxWords)}`;
    })
    .join("\n\n");
}

// Only finished user/assistant turns, newest last; an answer's sources aren't resent with it.
function trimHistory(messages, max = CHAT_HISTORY_MESSAGES) {
  return (messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && m.content).slice(-max);
}

// The rule is repeated after the question: small local models follow the end of the message far more
// than the system prompt (qwen2.5 1.5B answered off-topic questions from memory, phase 6 run).
const REMINDER = "Answer only from the sources above, not from memory. If they don't answer the question, reply exactly: " + NOT_COVERED;

function finalUserText(question, sources, mode) {
  const intro = mode === "selection" ? "Source (the text the user selected on the page):" : "Sources:";
  const cite = mode === "selection" ? "" : " Cite each claim like [1].";
  return `${intro}\n\n${formatSources(sources, mode)}\n\nQuestion: ${question}\n\n(${REMINDER}${cite})`;
}

function buildGeminiChatBody({ question, history, sources, mode }) {
  return {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [
      ...trimHistory(history).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      { role: "user", parts: [{ text: finalUserText(question, sources, mode) }] },
    ],
    generationConfig: { temperature: 0.3, maxOutputTokens: 4096 }, // the cap includes thinking tokens,
  };
}

function buildOllamaChatBody({ question, history, sources, mode }, model) {
  return {
    model,
    stream: true,
    options: { temperature: 0.3, num_ctx: 8192 },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...trimHistory(history).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: finalUserText(question, sources, mode) },
    ],
  };
}

/** Source numbers the answer cites, in first-cited order, limited to 1..count ("[2]", "[1, 3]", "[2][4]"). */
function citedNumbers(text, count) {
  const seen = [];
  for (const group of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const n of group[1].split(",").map((x) => Number(x.trim()))) {
      if (n >= 1 && n <= count && !seen.includes(n)) seen.push(n);
    }
  }
  return seen;
}

function isNotCovered(text) {
  return text.trim().replace(/[.\s]+$/, "") === NOT_COVERED.replace(/\.$/, "");
}

if (typeof module === "object") {
  module.exports = { buildGeminiChatBody, buildOllamaChatBody, formatSources, stripFootnotes, trimHistory, citedNumbers, isNotCovered, NOT_COVERED, CHAT_HISTORY_MESSAGES };
}

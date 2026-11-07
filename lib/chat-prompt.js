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
  // Partial answers (user, 2026-11-07): "when was it built and how many times was it restored" got a
  // flat "not covered" because only part of it was in the sources.
  "If the sources answer only part of the question, answer that part and say plainly which part they don't cover.",
  `If they cover none of it, reply with exactly "${NOT_COVERED}" and nothing else. Never use outside knowledge or guess.`,
  "Be concise: a few sentences or a short list. Plain text; **bold** and '- ' bullets are fine, no headings or tables.",
].join("\n");

// Explain mode (selection, user 2026-11-07): with text selected, the model helps the reader
// understand it: define a word, unpack a hard sentence, give the background it assumes. General
// knowledge is allowed here (a word's meaning isn't in the word), but stays tied to the selection and
// its surrounding passage. Questions without a selection stay page-only (SYSTEM_PROMPT).
const EXPLAIN_PROMPT = [
  "You help someone understand text they selected on a web page they're reading.",
  "Explain, define, simplify or give background for the selected text, using the passage around it for context and your general knowledge where it helps (for example a word's meaning, or what a term refers to).",
  "Stay faithful to what the text says; don't add unrelated facts. If the question isn't about the selected text, say so in one sentence.",
  "Only explain this text. Don't take on other tasks (writing, coding, translating, unrelated questions), even if asked; decline in one sentence.",
  "Be clear and brief: a few sentences or a short list, in plain words. Plain text; **bold** and '- ' bullets are fine, no headings or tables.",
].join("\n");
const EXPLAIN_REMINDER = "Explain using the selected text, the passage around it and general knowledge where it helps. Keep it short and plain.";

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

// Only finished user/assistant turns, newest last; an answer's sources aren't resent with it. A
// question asked about selected text keeps (the start of) that text, so a follow-up knows what "it" was.
function trimHistory(messages, max = CHAT_HISTORY_MESSAGES) {
  return (messages ?? [])
    .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
    .slice(-max)
    .map((m) => (m.role === "user" && m.quote?.text ? { ...m, content: `About the selected text "${truncateWordsTo(m.quote.text, 60)}": ${m.content}` } : m));
}

// The rule is repeated after the question: small local models follow the end of the message far more
// than the system prompt (qwen2.5 1.5B answered off-topic questions from memory, phase 6 run).
const REMINDER = "Answer only from the sources above, not from memory. If they answer only part of the question, answer that part and say which part they don't cover. If they cover none of it, reply exactly: " + NOT_COVERED;

function finalUserText(question, sources, mode) {
  if (mode === "selection") {
    const [selected] = sources;
    const context = selected.context && selected.context !== selected.text ? `\n\nThe passage it's in:\n${truncateWordsTo(stripFootnotes(selected.context), SELECTION_WORDS)}` : "";
    const page = selected.pageTitle ? ` (on "${selected.pageTitle}")` : "";
    return `Selected text${page}:\n${truncateWordsTo(stripFootnotes(selected.text), SELECTION_WORDS)}${context}\n\nQuestion: ${question}\n\n(${EXPLAIN_REMINDER})`;
  }
  return `Sources:\n\n${formatSources(sources, mode)}\n\nQuestion: ${question}\n\n(${REMINDER} Cite each claim like [1].)`;
}

const systemPromptFor = (mode) => (mode === "selection" ? EXPLAIN_PROMPT : SYSTEM_PROMPT);

function buildGeminiChatBody({ question, history, sources, mode }) {
  return {
    systemInstruction: { parts: [{ text: systemPromptFor(mode) }] },
    contents: [
      ...trimHistory(history).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      { role: "user", parts: [{ text: finalUserText(question, sources, mode) }] },
    ],
    // The cap includes thinking tokens. Explanations get a short cap: one word mustn't buy an essay.
    generationConfig: { temperature: 0.3, maxOutputTokens: mode === "selection" ? 1200 : 4096 },
  };
}

function buildOllamaChatBody({ question, history, sources, mode }, model) {
  return {
    model,
    stream: true,
    options: { temperature: 0.3, num_ctx: 8192, ...(mode === "selection" && { num_predict: 450 }) },
    messages: [
      { role: "system", content: systemPromptFor(mode) },
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

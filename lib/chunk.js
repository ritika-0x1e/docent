// C1: split a section into overlapping word windows for embedding. Pure.
// MiniLM reads only ~256 tokens (~200 words), so one vector per section would represent only its
// opening (master-spec §3.7). See docs/phased-implementation-plan/phase-C-embeddings-retrieval.md.

const CHUNK_WORDS = 180;
const OVERLAP_WORDS = 30;

/**
 * @returns {Array<{chunkIndex: number, text: string}>}
 *   HTML heading paths prefix each chunk's text (strong retrieval signal); generated or fallback
 *   headings don't, so embedding never depends on the LLM step.
 */
function chunkSection(section, { chunkWords = CHUNK_WORDS, overlapWords = OVERLAP_WORDS } = {}) {
  const words = section.text.split(/\s+/).filter(Boolean);
  const prefix = section.headingSource === "html" ? [...section.headingPath, section.heading].join(" > ") : "";
  if (words.length === 0) return prefix ? [{ chunkIndex: 0, text: prefix }] : [];

  const step = chunkWords - overlapWords;
  const chunks = [];
  for (let start = 0; ; start += step) {
    const end = Math.min(start + chunkWords, words.length);
    const body = words.slice(start, end).join(" ");
    chunks.push({ chunkIndex: chunks.length, text: prefix ? `${prefix}\n${body}` : body });
    if (end === words.length) break;
  }
  return chunks;
}

if (typeof module === "object") {
  module.exports = { chunkSection, CHUNK_WORDS, OVERLAP_WORDS };
}

// E1 typo tolerance (2026-11-07): a misspelt question word that happens to be another real word
// ("weedings" for "weddings") sends the embedding to a different meaning, and the right section fell
// from 1st to 18th. The fix is checked against the pages themselves: a question word (4+ letters) that
// never occurs in the thread's pages, with a page word one edit away (two for 8+ letters), is corrected, and retrieval runs
// with both questions. A word the pages use is never changed. Pure; background/chat.js calls it.

const MIN_WORD = 4; // shorter words have too many neighbours one edit away
const TWO_EDITS_FROM = 8; // long words may have two mistakes ("photosyntesis", "constuctoin")
// Everyday question words are never "corrected" to a page word that looks like them.
const NEVER_FIX = new Set("what when where which while who whom whose why how does did done have has had about above after again also among another because been before being below between both could each every explain describe define tell give show list summarize summarise compare mean means meaning there their they them then than that this these those with without within would should shall will your yours from into onto over under some such only other more most much many very just like make made know think used using does doesn".split(" "));

/** Word counts of the texts, lower-case, letters only. */
function buildVocabulary(texts) {
  const vocab = new Map();
  for (const text of texts) {
    for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) vocab.set(word, (vocab.get(word) ?? 0) + 1);
  }
  return vocab;
}

/** True if a becomes b with one insertion, deletion, substitution or swap of neighbours. */
function oneEditApart(a, b) {
  return a !== b && editDistance(a, b, 1) === 1;
}

/** Edit distance with neighbour swaps (optimal string alignment), or max + 1 once it's over max. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      row.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    [prev2, prev] = [prev, row];
  }
  return Math.min(prev[b.length], max + 1);
}

/**
 * @returns {{text: string, fixes: {from, to}[]} | null}  the corrected question, or null if nothing changed
 */
function correctQuery(question, vocab) {
  const fixes = [];
  const text = question.replace(/\p{L}+/gu, (word) => {
    const lower = word.toLowerCase();
    if (lower.length < MIN_WORD || vocab.has(lower) || NEVER_FIX.has(lower)) return word;
    const max = lower.length >= TWO_EDITS_FROM ? 2 : 1;
    let best = null;
    for (const [candidate, count] of vocab) {
      if (candidate.length < MIN_WORD - 1) continue;
      if (max === 2 && candidate[0] !== lower[0]) continue; // two edits: keep the first letter, fewer wild guesses
      const d = editDistance(lower, candidate, max);
      if (d > max) continue;
      // Fewer edits first, then the word the pages use most.
      if (!best || d < best.d || (d === best.d && count > best.count)) best = { candidate, count, d };
    }
    if (!best) return word;
    fixes.push({ from: word, to: best.candidate });
    return best.candidate;
  });
  return fixes.length ? { text, fixes } : null;
}

if (typeof module === "object") {
  module.exports = { buildVocabulary, oneEditApart, editDistance, correctQuery };
}

// C3 glue: embed a question, rank the stored chunks of the given corpora, join the section records.
// Loaded into the service worker with importScripts().

// k: a number for the plain top k (console helpers), or "blended" for chat (lib/retrieval.js).
async function retrieve(corpusIds, queryText, k = 5) {
  const [{ vector, model }, chunks, corpora] = await Promise.all([
    embedQuery(queryText),
    getChunkVectors(corpusIds),
    Promise.all(corpusIds.map((id) => getCorpus(id).then((c) => c?.corpus))),
  ]);

  // Never compare vectors from different models: such corpora need a re-scan.
  const stale = corpora.filter((c) => c && c.embeddingModel !== model).map((c) => c.corpusId);
  const usable = stale.length ? chunks.filter((c) => !stale.includes(c.corpusId)) : chunks;

  const hits = k === "blended" ? blendedTopK(vector, usable) : topKSections(vector, usable, k);
  const sections = await Promise.all(hits.map((h) => getSections(h.corpusId, [h.sectionId]).then(([s]) => s)));
  return { hits: hits.map((h, i) => ({ ...h, section: sections[i] })), staleCorpora: stale };
}

// C1: section-chunk and query embeddings, on top of the Phase B offscreen worker.
// Loaded into the service worker with importScripts().

async function embedSectionChunks(sections) {
  const chunks = sections.flatMap((s) => chunkSection(s).map((c) => ({ sectionId: s.id, ...c })));
  const { vectors, stats } = await embedTexts(chunks.map((c) => c.text));
  return {
    // Chunk text isn't kept: it's recomputable from the section text with lib/chunk.js.
    chunks: chunks.map((c, i) => ({ sectionId: c.sectionId, chunkIndex: c.chunkIndex, vector: vectors[i] })),
    stats,
  };
}

async function embedQuery(text) {
  const { vectors, stats } = await embedTexts([text]);
  return { vector: vectors[0], model: stats.model };
}

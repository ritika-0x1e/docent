// A1: Readability integration.
// Runs on a cloned document — Readability prunes the tree it's given, and we must not
// mutate the live page the user is looking at.
//
// Design note (see docs/phased-implementation-plan/phase-A-extraction-classification.md):
// article.content below is a detached HTML string/tree from the clone, not live DOM.
// Re-anchoring it to real Ranges on the live page for highlighting is B1's job, not this one.

function extractArticle() {
  const clone = document.cloneNode(true);
  const reader = new Readability(clone);
  const article = reader.parse(); // null if Readability can't find enough to work with
  return article;
}

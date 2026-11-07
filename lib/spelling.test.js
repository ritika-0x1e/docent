const test = require("node:test");
const assert = require("node:assert/strict");
const { buildVocabulary, oneEditApart, correctQuery } = require("./spelling.js");

test("oneEditApart: substitution, insertion, deletion, neighbour swap", () => {
  assert.equal(oneEditApart("weedings", "weddings"), true);
  assert.equal(oneEditApart("wedings", "weddings"), true);
  assert.equal(oneEditApart("weddingss", "weddings"), true);
  assert.equal(oneEditApart("wedidngs", "weddings"), true);
  assert.equal(oneEditApart("weddings", "weddings"), false);
  assert.equal(oneEditApart("wedlings", "weddings"), true);
  assert.equal(oneEditApart("wdeidngs", "weddings"), false);
  assert.equal(oneEditApart("house", "horses"), false);
});

test("correctQuery fixes words the pages don't use, from words they do", () => {
  const vocab = buildVocabulary(["Numerous weddings and receptions have taken place at the White House.", "Weddings were held in the East Room."]);
  assert.deepEqual(correctQuery("when was white house used for weedings", vocab), {
    text: "when was white house used for weddings",
    fixes: [{ from: "weedings", to: "weddings" }],
  });
  assert.equal(correctQuery("when were weddings held", vocab), null); // nothing to fix
  assert.equal(correctQuery("what about the treaty", vocab), null); // unknown word, nothing close
  assert.equal(correctQuery("whn was it", vocab), null); // short words are left alone
});

test("correctQuery never changes a word the pages use, and prefers the commoner candidate", () => {
  const vocab = buildVocabulary(["weeding the garden", "weddings weddings weddings wedding"]);
  assert.equal(correctQuery("weeding", vocab), null);
  assert.equal(correctQuery("weddingz", vocab).text, "weddings");
});

test("correctQuery: several typos, two edits in long words, 4-letter words, question words untouched", () => {
  const vocab = buildVocabulary(["Photosynthesis is a process used by plants. The house was constructed in 1792 for the president."]);
  assert.equal(correctQuery("how does photosyntesis work in plnts", vocab).text, "how does photosynthesis work in plants");
  assert.equal(correctQuery("when was the hous constuctde", vocab).text, "when was the house constructed");
  assert.equal(correctQuery("explain about it", vocab), null);
  assert.equal(correctQuery("presidnet", vocab).text, "president");
});

test("editDistance counts a neighbour swap as one edit and stops past max", () => {
  const { editDistance } = require("./spelling.js");
  assert.equal(editDistance("constuctde", "constructed", 2), 2);
  assert.equal(editDistance("teh", "the", 1), 1);
  assert.equal(editDistance("abcdef", "uvwxyz", 2), 3);
});

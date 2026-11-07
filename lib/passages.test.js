const test = require("node:test");
const assert = require("node:assert/strict");
const { claimsByCitation, blockWindows, pickPassages } = require("./passages.js");

test("claimsByCitation groups sentences by the numbers they cite", () => {
  const claims = claimsByCitation("Construction began in 1792 [1]. Hoban designed it [2][1]. **Short.** It burned in 1814 [1, 3].");
  assert.deepEqual(claims.get(1), ["Construction began in 1792.", "Hoban designed it.", "It burned in 1814."]);
  assert.deepEqual(claims.get(2), ["Hoban designed it."]);
  assert.deepEqual(claims.get(3), ["It burned in 1814."]);
  assert.equal(claims.has(4), false);
});

test("blockWindows yields one sentence per window, exact substrings, short fragments joined", () => {
  const blocks = [
    { id: "b1", anchored: true, anchor: { exact: "Construction began at noon on 13 October 1792.[25][26] The main residence was built by employed Europeans. Why? Because the stone was local and cheap." } },
    { id: "b2", anchored: false, anchor: { exact: "Not on the page." } },
    { id: "b3", anchor: { exact: "Single sentence here" } },
  ];
  const w = blockWindows(blocks);
  assert.deepEqual(w, [
    { blockId: "b1", exact: "Construction began at noon on 13 October 1792.[25][26]" },
    { blockId: "b1", exact: "The main residence was built by employed Europeans." },
    { blockId: "b1", exact: "Why? Because the stone was local and cheap." },
    { blockId: "b3", exact: "Single sentence here" },
  ]);
  for (const x of w) assert.ok(blocks.find((b) => b.id === x.blockId).anchor.exact.includes(x.exact));
});

test("pickPassages keeps each claim's best window, best first, deduped, above the floor", () => {
  const windows = [{ blockId: "a", exact: "w0" }, { blockId: "a", exact: "w1" }, { blockId: "b", exact: "w2" }];
  const windowVecs = [[1, 0], [0, 1], [0.6, 0.8]];
  const claims = [[1, 0], [0.95, 0.31], [0, 1]];
  assert.deepEqual(pickPassages(claims, windows, windowVecs).map((p) => p.exact), ["w0", "w1"]);
  assert.deepEqual(pickPassages([[0.8, 0.6]], windows, windowVecs).map((p) => p.exact), ["w2"]); // 0.96
  assert.deepEqual(pickPassages([[0.5, 0.5]], windows, windowVecs, { min: 0.75 }), []);
  assert.deepEqual(pickPassages(claims, windows, windowVecs, { max: 1 }).map((p) => p.exact), ["w0"]);
  assert.deepEqual(pickPassages([[-1, 0]], windows, windowVecs), []); // nothing close: whole section
});

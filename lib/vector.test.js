const test = require("node:test");
const assert = require("node:assert/strict");
const { dot, cosine, meanVector } = require("./vector.js");

test("cosine of identical, orthogonal and opposite vectors", () => {
  assert.equal(cosine([1, 2, 3], [1, 2, 3]).toFixed(6), "1.000000");
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([1, 1], [-1, -1]).toFixed(6), "-1.000000");
});

test("cosine is scale-invariant and safe on zero vectors", () => {
  assert.equal(cosine([1, 2], [10, 20]).toFixed(6), "1.000000");
  assert.equal(cosine([0, 0], [1, 1]), 0);
});

test("dot and meanVector", () => {
  assert.equal(dot([1, 2], [3, 4]), 11);
  assert.deepEqual(meanVector([[1, 2], [3, 6]]), [2, 4]);
});

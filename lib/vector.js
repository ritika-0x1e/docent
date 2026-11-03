// Pure vector math for B2 breakpoints (and C3 retrieval later).

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function cosine(a, b) {
  const denom = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b));
  return denom === 0 ? 0 : dot(a, b) / denom;
}

function meanVector(vectors) {
  const mean = new Array(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) mean[i] += v[i];
  return mean.map((x) => x / vectors.length);
}

if (typeof module === "object") {
  module.exports = { dot, cosine, meanVector };
}

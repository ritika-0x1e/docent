const test = require("node:test");
const assert = require("node:assert/strict");
const { rankFlashModels, quotaWindow, msUntilPacificMidnight, parkedUntil, usableModels } = require("./gemini-ladder.js");

const model = (id, methods = ["generateContent", "countTokens"]) => ({ name: `models/${id}`, supportedGenerationMethods: methods });
const list = [
  model("gemini-3.5-flash-lite"),
  model("gemini-3.6-flash"),
  model("gemini-3-flash"),
  model("gemini-3.8-flash"),
  model("gemini-3.1-flash-lite"),
  model("gemini-3.9-flash-preview"),
  model("gemini-flash-latest"),
  model("gemini-3.6-flash-image"),
  model("gemini-3.6-pro"),
  model("gemini-3.7-flash", ["embedContent"]),
  model("text-embedding-004", ["embedContent"]),
];

test("chat ladder: stable Flash newest first, then Flash-Lite; previews, aliases, variants skipped", () => {
  assert.deepEqual(rankFlashModels(list), ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
});

test("Lite-only ladder for B3", () => {
  assert.deepEqual(rankFlashModels(list, { lite: "only" }), ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
});

test("quotaWindow reads the QuotaFailure id", () => {
  const body = (quotaId) => ({ error: { code: 429, details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] }] } });
  assert.equal(quotaWindow(body("GenerateRequestsPerDayPerProjectPerModel-FreeTier")), "day");
  assert.equal(quotaWindow(body("GenerateRequestsPerMinutePerProjectPerModel-FreeTier")), "minute");
  assert.equal(quotaWindow(null), "minute");
});

test("daily quota parks a model until midnight Pacific", () => {
  // 2026-11-07 10:00 PST = 18:00 UTC: 14 hours left.
  const now = Date.UTC(2026, 10, 7, 18, 0, 0);
  assert.equal(msUntilPacificMidnight(now), 14 * 3600 * 1000);
  assert.equal(parkedUntil("day", now), now + 14 * 3600 * 1000);
  assert.equal(parkedUntil("minute", now), now + 60000);
  assert.equal(parkedUntil("gone", now), now + 30 * 24 * 3600 * 1000);
});

test("usableModels drops parked models until their time is up", () => {
  const ladder = ["a", "b", "c"];
  assert.deepEqual(usableModels(ladder, { a: 2000, b: 500 }, 1000), ["b", "c"]);
});

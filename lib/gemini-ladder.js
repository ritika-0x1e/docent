// E4/E5 (phase 6, decision 1): which Gemini model to try next. Free-tier limits are per model
// (the 429's quota id reads "…PerDayPerProjectPerModel…"), so chat walks a ladder: every stable
// Flash model, newest first, then the Flash-Lite ones, then Ollama. A model whose quota ran out is
// parked until it resets. Pure; background/chat.js does the fetching and storage.

// Stable names only: "gemini-3.6-flash", "gemini-3.5-flash-lite". Previews, "-latest" aliases and
// variants (-8b, -image, -tts, -live, dated -001) are skipped: they change or behave differently.
const STABLE_FLASH = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/;

/**
 * @param {{name: string, supportedGenerationMethods?: string[]}[]} models  the API's model list
 * @param {{lite?: "only" | "after"}} opts  "after" (chat): full Flash first, then Lite; "only" (B3)
 * @returns {string[]} model ids, best first
 */
function rankFlashModels(models, { lite = "after" } = {}) {
  const ranked = [];
  for (const m of models) {
    const id = m.name.replace(/^models\//, "");
    const match = STABLE_FLASH.exec(id);
    if (!match || !(m.supportedGenerationMethods ?? ["generateContent"]).includes("generateContent")) continue;
    const isLite = Boolean(match[2]);
    if (lite === "only" && !isLite) continue;
    ranked.push({ id, version: Number(match[1]), isLite });
  }
  ranked.sort((a, b) => a.isLite - b.isLite || b.version - a.version);
  return [...new Set(ranked.map((m) => m.id))];
}

// "day" | "minute" from a 429 body's QuotaFailure details; unknown counts as a short ("minute") wait.
function quotaWindow(body) {
  const ids = (body?.error?.details ?? []).flatMap((d) => (d.violations ?? []).map((v) => `${v.quotaId ?? ""} ${v.quotaMetric ?? ""}`));
  return ids.some((id) => /PerDay/i.test(id)) ? "day" : "minute";
}

// Daily quotas reset at midnight Pacific time.
function msUntilPacificMidnight(now = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(now))
      .map((p) => [p.type, Number(p.value)])
  );
  const elapsed = (((parts.hour % 24) * 60 + parts.minute) * 60 + parts.second) * 1000 + (now % 1000);
  return 24 * 3600 * 1000 - elapsed;
}

// A model the list still names but that answers 404 ("no longer available to new users") is gone
// for this key: parked this long instead of being asked again on every question (2026-11-07).
const GONE_MS = 30 * 24 * 3600 * 1000;

// When a model that just returned 429 ("day" | "minute") or 404 ("gone") may be tried again.
function parkedUntil(window, now = Date.now()) {
  if (window === "gone") return now + GONE_MS;
  return now + (window === "day" ? msUntilPacificMidnight(now) : 60 * 1000);
}

// The ladder minus parked models, in order.
function usableModels(ladder, parked = {}, now = Date.now()) {
  return ladder.filter((id) => !(parked[id] > now));
}

if (typeof module === "object") {
  module.exports = { rankFlashModels, quotaWindow, msUntilPacificMidnight, parkedUntil, usableModels };
}

# Phase A — Extraction & Classification

Implementation plan for sub-feature **A** (`docs/master-spec.md` §5.A, §3.1), first step of the build sequence in §6 ("gates everything downstream"). Covers A1–A4. Nothing in B/C/D/E/F/G/H/I is touched here — this phase must be independently testable via a minimal harness, per CLAUDE.md's "test each sub-feature in isolation" rule.

## Scope recap (from spec)
- A1. Readability.js integration — extract main content node
- A2. Text vs. media classification heuristic
- A3. "Not enough text" banner + force-scan override
- A4. CSP/injection-failure detection + "site restricts access" message

## Runtime flow this phase implements

```
user triggers scan (test harness for now; H2 wires this properly later)
  → background attempts chrome.scripting.executeScript on active tab
      ├─ throws / restricted URL  ──────────────────► A4: "site restricts access"
      └─ succeeds, content script boots
            → content script sends "ready" handshake, background starts a timeout
                ├─ no handshake within timeout ──────► A4: "site restricts access"
                └─ handshake received
                      → A1: run Readability on a cloned document
                      → A2: measure text length + media area, classify
                            ├─ text-heavy or user forced ─► proceed (this phase ends here; B picks up)
                            └─ sparse + media-dominated ──► A3: banner + force-scan override
```

## Correction to §7.1 (manifest permissions)

§7.1 listed `activeTab` + `sidePanel` + `storage` as the base permission set. Programmatic injection (`chrome.scripting.executeScript`, needed since we're deliberately avoiding static `content_scripts` matches to keep the standing grant at zero) also requires the **`scripting`** permission. Adding it to the base set — it's a functional requirement of the phased/optional strategy already agreed, not a new scope decision, so noted here rather than re-litigated.

## File layout

```
/manifest.json                    base manifest: activeTab, scripting, sidePanel, storage
/background/service-worker.js     injection orchestration, handshake timeout, A4 error classification
/content/vendor/readability.js    vendored Mozilla Readability (UMD build, no bundler)
/content/bootstrap.js             entry point: ready-handshake, wraps everything in try/catch
/content/extract.js               A1: Readability integration
/content/classify.js              A2: DOM measurement (word count, media bounding-box area)
/lib/classify.js                  A2: pure threshold function (no DOM) — unit testable
```

`lib/classify.js` is the only piece that needs to survive past this phase unchanged — it's the pure logic CLAUDE.md wants written DOM-independent so it can be unit tested without a browser.

## A1 — Readability.js integration

**Approach**: vendor Readability.js directly (no bundler — per CLAUDE.md, only Transformers.js justifies one). Content script clones the document before parsing, since Readability prunes the tree it's given and we must not mutate the live page the user is looking at.

```js
// content/extract.js
function extractArticle() {
  const clone = document.cloneNode(true);
  const reader = new Readability(clone);
  const article = reader.parse(); // { title, content, textContent, excerpt, length, siteName } or null
  return article;
}
```

- `article === null` (Readability gives up) is a valid outcome, not an error — treat it as "0 words extracted" and let A2's classifier route it into the sparse/force-scan path (A3), same as a thin page. Don't special-case it.

**Design note for B1 (not solved in this phase)**: because Readability runs on a *clone*, `article.content` is a detached HTML string/tree — it has no live `Range` back into the actual page DOM. §3.2 requires DOM `Range` capture per section for highlighting. Re-anchoring extracted content to the live DOM (e.g. text-fingerprint matching, similar to the browser's native Scroll-to-Text-Fragment approach) is B1's problem to solve when it walks headings for sectioning, not A1's. A1's contract is: return Readability's parsed output plus the plain fact that it came from a clone. Flagging this now so it isn't a surprise when B1 starts.

**Test plan**: run the harness against a handful of manually chosen pages — a heading-structured docs page, a heading-less blog post, and a JS-heavy SPA article — and confirm `article.textContent.length` and `article.title` look sane. No automated test yet (needs real DOM); this is exploratory verification, not unit testing.

## A2 — Text vs. media classification

**Split**: DOM measurement (content script, impure) feeds a pure decision function (`lib/classify.js`, unit-testable).

> **Implementation deviation (measurement scope):** the sketch below measures media inside the article root, but A1 runs Readability on a *clone*, so there is no live-DOM article element to measure. As implemented, `content/classify.js` takes `wordCount` from Readability's `textContent`, and measures `mediaArea` across the whole live document, with `contentArea` = `documentElement.scrollWidth × scrollHeight`. Consequence: on long pages the ratio is diluted, so `"media-dominated"` will fire less often than the article-scoped design intended (the page still routes to A3 as `"sparse"` if the word count is low, so the user-facing outcome is unchanged). Revisit once B1 solves live-DOM re-anchoring and an article boundary exists on the live page.

```js
// content/classify.js — measurement only, no thresholds here (original article-scoped sketch; see deviation note above)
function measurePage(articleRootEl) {
  const wordCount = (articleRootEl?.textContent || "").trim().split(/\s+/).filter(Boolean).length;
  const mediaEls = articleRootEl.querySelectorAll("img, video, canvas, svg");
  const mediaArea = [...mediaEls].reduce((sum, el) => {
    const r = el.getBoundingClientRect();
    return sum + Math.max(0, r.width) * Math.max(0, r.height);
  }, 0);
  const contentArea = articleRootEl.getBoundingClientRect().width * articleRootEl.getBoundingClientRect().height;
  return { wordCount, mediaArea, contentArea };
}
```

```js
// lib/classify.js — pure, unit-testable without a browser
const MIN_WORD_COUNT = 175;          // spec says ~150-200; picking a midpoint, tune later
const MEDIA_AREA_RATIO_THRESHOLD = 0.6; // media-dominated if media covers >60% of article bounding area

function classifyPage({ wordCount, mediaArea, contentArea }) {
  const mediaRatio = contentArea > 0 ? mediaArea / contentArea : 0;
  if (wordCount >= MIN_WORD_COUNT) return { classification: "text", mediaRatio, wordCount };
  if (mediaRatio > MEDIA_AREA_RATIO_THRESHOLD) return { classification: "media-dominated", mediaRatio, wordCount };
  return { classification: "sparse", mediaRatio, wordCount }; // thin but not clearly media — still routes to A3
}

module.exports = { classifyPage, MIN_WORD_COUNT, MEDIA_AREA_RATIO_THRESHOLD };
```

- `MIN_WORD_COUNT = 175` and `MEDIA_AREA_RATIO_THRESHOLD = 0.6` are defaults, not final — same treatment as the DDG selectors and nav heuristic in §7: tune against real pages once more of the pipeline exists, don't over-fit to guesses now.
- Both `"media-dominated"` and `"sparse"` route to A3 — the banner doesn't need to distinguish *why* it's short for the user-facing message, only the classifier needs the distinction for future tuning/telemetry.

**Test plan**: this is the one piece of Phase A that gets a real unit test now (`lib/classify.test.js` or equivalent) — feed `classifyPage()` synthetic `{wordCount, mediaArea, contentArea}` triples and assert the three branches. No browser required.

## A3 — "Not enough text" banner + force-scan override

**Decision**: render this in the **side panel**, not injected into the host page.

Rationale: the spec's citation design (§3.8) deliberately avoids DOM mutation on host pages (Custom Highlight API instead of span-wrapping) specifically to not fight the page's own scripts/CSP. Injecting a visible banner element into an arbitrary page's DOM works against that same goal and is more likely to collide with exactly the CSP/Trusted-Types restrictions A4 is built to detect. The side panel is always-available UI regardless of the host page's restrictions, so it's the safer and more consistent place for this message. (I1/side panel doesn't exist yet as of this phase — see harness note below.)

- Content script's job in this phase is just to report `{classification: "sparse"|"media-dominated", wordCount, mediaRatio}` back to the background/harness via `chrome.runtime.sendMessage`.
- The actual banner UI (message + "Force scan anyway" button) belongs to I2/H-era side panel code — out of scope to build here since I1 hasn't been scaffolded yet. What *is* in scope for A3: the content script must support being told "force scan" (i.e. skip the A2 gate and proceed as if classification were `"text"`) via a message, so the override path exists and is testable even before real UI calls it.

**Test plan**: via harness, manually send the mock "force scan" message after a sparse-page classification and confirm extraction proceeds regardless of the classifier's verdict.

## A4 — CSP/injection-failure detection

Two independent failure modes, both must be caught and both produce the same user-facing outcome ("this site restricts extension access"), distinguished only in logs:

1. **Injection itself rejected** — `chrome.scripting.executeScript` throws or its returned promise rejects (e.g. restricted URLs like `chrome://`, the Chrome Web Store, or a page where injection is blocked). Caught with a plain `try/catch` around the call in `background/service-worker.js`.
2. **Injection succeeds but the content script never reports back** — e.g. a Trusted Types policy or other page-level restriction breaks something inside `content/bootstrap.js` before it can send its "ready" handshake. Detected via a timeout (propose 2000ms) started right after `executeScript` resolves; if no handshake message arrives in time, treat as blocked.

**Ordering requirement:** the handshake listener must be registered *before* `executeScript` is called. `bootstrap.js` sends "ready" as soon as it runs, which can arrive before `executeScript`'s promise resolves; a listener added afterwards misses it and every normal page times out. Only the *timeout* starts after `executeScript` resolves.

**Re-injection guard:** content scripts persist in the tab's isolated world until navigation. Before injecting, the background runs a one-line `executeScript({func})` probe for `globalThis.__summarizerContentLoaded` (set by `bootstrap.js`); if present, it skips injection and the handshake and goes straight to the scan message. This avoids `const` redeclaration errors and duplicate message listeners on repeat scans. The probe is itself an `executeScript` call, so restricted URLs still reject there (`injection-rejected`).

```js
// background/service-worker.js (original sketch; see ordering requirement and re-injection guard above)
async function attemptScan(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [
      "content/vendor/readability.js", "content/extract.js", "content/classify.js", "content/bootstrap.js"
    ]});
  } catch (e) {
    return { blocked: true, reason: "injection-rejected", detail: e.message };
  }
  return waitForHandshake(tabId, 2000); // resolves {blocked:false} or {blocked:true, reason:"handshake-timeout"}
}
```

`content/bootstrap.js` wraps its own startup in `try/catch` too and, if it catches something, tries to send a `{ready:false, error}` message before giving up — best-effort, since a Trusted Types violation may prevent even that.

**Test plan**: run the harness against (a) a `chrome://extensions` tab — expect `injection-rejected`; (b) a site known to enforce a strict Trusted Types CSP — expect either `injection-rejected` or `handshake-timeout` depending on where it breaks; (c) a normal page — expect success within the timeout, to confirm the timeout isn't a false-positive trap on slow-loading pages. Adjust the 2000ms figure if (c) shows false positives on heavy pages.

## Test harness (temporary, this phase only)

I1 (side panel shell) isn't built until phase 4. To test A1–A4 in isolation now:
- `chrome.action.onClicked` triggers `attemptScan(tab.id)` directly (don't call `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})` yet — that would hijack the toolbar click before I1 exists).
- Results get logged via `console.log` in the background service worker, inspectable from `chrome://extensions` → service worker devtools.
- Delete/replace this harness when H2 wires the real "Start scan" button in phase 4 — it's scaffolding, not product code.

## Exit criteria for Phase A

- [x] `lib/classify.js` unit tests pass for all three classification branches
- [x] Harness confirms A1 extracts sane title/text on 3 manually chosen real pages (headed docs page, headingless blog, JS-heavy SPA) — passes, see test log
- [x] Harness confirms A2 correctly routes a real sparse page and a real text-heavy page
- [x] Harness confirms force-scan override bypasses the A2 gate
- [x] Harness confirms A4 catches both a restricted-URL rejection and a Trusted-Types-style handshake timeout, without misfiring on a normal page
- [x] `manifest.json` requests only `activeTab`, `scripting`, `sidePanel`, `storage` — no host_permissions

### Test log (2026-11-01, manual harness runs)

- **Unit tests**: `npm test` — 6/6 pass.
- ~~**A1 headed docs page**: "PSBA Terms of Reference" → `text`, 228 words (only just above the 175 floor).~~ **Not a valid result** (corrected 2026-11-03): this was a Google Doc, whose body is canvas-rendered, so Readability extracted only the sidebar outline. Google Docs now has its own extraction path (A5a, `phase-A5-special-sources.md`), which gets 10,384 words from the same doc.
- **A1 headed docs page (re-test)**: several ordinary HTML articles with headings extracted correctly, and their headings were later confirmed by Phase B's heading split (CP-B1). This is the real pass for this criterion.
- **A1 blog**: "How to Structure Your Blog Posts with Subheadings" → `text`, 850 words (this post likely has headings, so headingless was re-tested below).
- **A1 headingless essays** (paulgraham.com, legacy table/`<font>`/`<br>` markup): "Making Startups Powerful" → `text`, 2907 words; "How to Do Great Work" → `text`, 11619 words. Readability handles the legacy layout fine — B1's no-heading breakpoint path has valid input. (paulgraham.com homepage → `sparse`, 19 words — correct, it's an image-link index.)
- **A1 JS-heavy SPA**: Reddit's "Reddit Rules" page → `text`, 244 words. Correct page extracted.
- **Untested risk (not a confirmed bug)**: `document.cloneNode(true)` does not copy shadow roots, so pages whose main text lives inside web components' shadow DOM could extract the wrong text. Not observed on any page yet. If a real page shows it, the fix belongs in A1 (flatten the rendered tree into the copy before Readability), and B1/F would also need to cross shadow boundaries when walking the live DOM.
- **A1 JS-heavy SPA (non-shadow-DOM)**: "Scenario-Based Git Interview Questions" → `text`, 1394 words, mediaRatio ≈ 0.07. Correct article extracted.
- **A2 sparse**: YouTube video page → `sparse`, 13–18 words, mediaRatio ≈ 0.49.
- **A3 force-scan**: `forceScan(tabId)` on the YouTube sparse page → `status: "ok"` with classification still `sparse` (override bypasses the gate without altering the verdict).
- **A4 restricted URL**: `chrome://extensions` → `injection-rejected` ("Cannot access a chrome:// URL").
- **A4 Trusted Types, no false positive**: YouTube (enforces Trusted Types) scanned normally — no `handshake-timeout` misfire.
- **A4 handshake timeout**: simulated by temporarily commenting out the `ready` send in `content/bootstrap.js` → `handshake-timeout` after 2s. Change reverted; normal scans confirmed after.

Once all boxes are checked, move to Phase B (sectioning) per §6 — B1 will need to solve the live-DOM re-anchoring problem flagged above before it can capture `Range`s.

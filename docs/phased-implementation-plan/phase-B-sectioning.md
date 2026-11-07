# Phase B — Sectioning

Implementation plan for sub-feature **B** (`docs/master-spec.md` §5.B, §3.2), second step of the build sequence in §6. Covers B1–B3. Builds on Phase A's extraction output (`docs/phased-implementation-plan/phase-A-extraction-classification.md`); follows the `semantic-sectioning` skill. Verified via the Phase A harness, extended — no side panel yet.

**Testing strategy (approved 2026-11-02):** phases B, C and 4 are built back to back, with full testing in one combined run at the end of phase 4 (see `phase-4-side-panel-shell.md`). Only the **checkpoints** listed below get tested before moving on. They cover failures that would break everything built on top and that unit tests can't catch. See master-spec §6a.

## Scope recap (from spec)
- B1. Heading-based split (h1–h4) with DOM `Range` capture per section
- B2. Paragraph embedding + running-centroid cosine breakpoint detection (unstructured fallback)
- B3. LLM call: generate heading + 1-line summary per section, after boundaries are fixed

## Decisions (all five approved 2026-11-02; recorded in master-spec and CLAUDE.md)

These change something the spec or CLAUDE.md states, so they were flagged before coding.

1. **Pull a minimal C1 forward into B2.** B2 needs paragraph embeddings, but embeddings are C1 (phase 3). B2 can't be built or tested without them. Proposal: build only the embedding worker now (text in → vectors out). Storage (C2) and retrieval (C3) stay in phase 3.
2. **Embeddings run in an offscreen document, not the service worker.** MV3 service workers can't spawn Web Workers, and the side panel (the other candidate host) doesn't exist until phase 4. The background creates a `chrome.offscreen` document (reason `WORKERS`), which spawns `workers/embed-worker.js`. This adds the **`offscreen`** permission, and adds `'wasm-unsafe-eval'` to the extension-pages CSP because ONNX Runtime runs as WebAssembly. Neither grants access to any site.
3. **A section is anchored by a list of per-block anchors, not one `domRange`.** The spec and skill say "keep each section's DOM `Range`". Two problems with a single range:
   - (a) A range from one heading to the next sweeps in everything Readability stripped between them (ads, share bars, embeds), so the highlight would cover junk.
   - (b) A `Range` is a live object. It can't be messaged out of the content script, and it can't be stored in IndexedDB. F3 ("open page and highlight") has to re-highlight a page after reload, and that needs a serializable anchor.

   Proposal: each block (paragraph, list, heading…) gets a **text-quote anchor** `{exact, prefix, suffix}` (same idea as the W3C Web Annotation TextQuoteSelector). That anchor is persisted. Live `Range`s are a runtime cache inside the content script, rebuilt from the anchors when missing or stale. The CSS Custom Highlight API takes multiple ranges per `Highlight`, so F1 is unaffected. The `semantic-sectioning` skill's output shape gets updated to match.
4. **Model weights are downloaded at first use, not vendored.** The Transformers.js library and the ONNX Runtime `.wasm` files are vendored, because MV3 forbids remote *code*. The `all-MiniLM-L6-v2` quantized weights (~23 MB, data, not code) are fetched once from the Hugging Face hub and cached by Transformers.js in the Cache API. That keeps 23 MB of binaries out of git. Trade-off: the first scan needs network access and a few seconds; later scans are offline. HF serves permissive CORS, so no host permission is needed.
5. **The "static reading view" in §6 step 2 is deferred to I2 (phase 4).** Rendering it needs the side panel. For this phase, sections are verified through the harness: a console table, plus a test-only "highlight section N" helper. That helper is a debugging aid only. F1 builds the real highlighting.

## Runtime flow this phase implements

```
Phase A scan succeeds (classification "text", or force-scan)
  → content: parse article.content → ordered block list
  → content: anchor every block to the live DOM (text-quote → Range, kept in memory)
  → content: ≥ 2 headings in blocks?
        ├─ yes ─► B1: split at headings (pure, lib/)            ─┐
        └─ no  ─► return blocks to background                     │
                    → offscreen → worker: embed paragraphs        │
                    → B2: centroid breakpoints (pure, lib/)      ─┤
                                                                  ▼
  → background: B3 heading/summary generation via Gemini (batched; failure falls back, never blocks)
  → harness: console.table of sections; highlightSection(tabId, i) for visual checks
```

## File layout

```
/manifest.json                     + "offscreen" permission, + extension_pages CSP with 'wasm-unsafe-eval'
/content/blocks.js                 parse article.content (DOMParser) → [{id, type, level?, text}]
/content/anchor.js                 live-DOM text index; block text → Range; Map<blockId, Range>; test highlight helper
/content/bootstrap.js              extended: after A, run blocks → anchor → (B1 | hand off for B2)
/lib/text.js                       normalizeText(), findQuote(haystack, quote, from) — pure
/lib/sections-headings.js          B1: splitByHeadings(blocks) — pure
/lib/vector.js                     cosine(), meanVector() — pure; reused by C3 later
/lib/breakpoints.js                B2: detectBreakpoints(embeddings, wordCounts, opts) — pure
/lib/section-prompt.js             B3: build batched prompt + validate/parse response, fallback heading — pure
/background/offscreen-client.js    create/reuse offscreen doc, embed(texts) → vectors
/background/llm.js                 B3: Gemini call (fetch), batching, 429 backoff, API key from storage
/background/service-worker.js      harness extended to run A → B and log results
/offscreen/offscreen.html + .js    hosts and relays to the embedding worker
/workers/embed-worker.js           Transformers.js feature-extraction, mean pooling, normalized
/workers/vendor/transformers/      vendored Transformers.js ESM build + ONNX Runtime wasm (version pinned)
/lib/*.test.js                     unit tests for every lib/ file above
```

Loading: content scripts and the service worker stay **classic scripts**. The service worker pulls in `lib/` files with `importScripts()`, and the content scripts get them through the `executeScript` file list, as Phase A does. The `typeof module` guard keeps the same files `require`-able from Node tests. Only the embedding worker is an ES module (`new Worker(url, {type: "module"})`), because Transformers.js ships as ESM. Messages between the service worker and the offscreen document are JSON-serialized, so vectors cross as plain arrays.

## Blocks (shared input for B1 and B2)

`content/blocks.js` walks Readability's content element into an ordered list of blocks.

> **As implemented:** `extract.js` passes Readability `serializer: el => el`, so `article.content` is the content element from the detached clone, not an HTML string. That removes the need for `DOMParser` and any HTML re-parsing, which would be a Trusted Types sink on strict pages. Until B2 exists (build step 4), pages with fewer than 2 headings come back as one section per block (`method: "unsplit"`), so CP-B1 can still check anchoring on headingless pages.

The block rules:

- **Heading**: `h2`–`h4`, stored with its `level`. Readability renames `h1` to `h2` in its output, and the page title comes separately as `article.title`. In practice that means the spec's "h1–h4" maps to `h2`–`h4` here.
- **Paragraph-like**: `p`, `pre`, `blockquote`, `table`, `figcaption`. Each one becomes a single block.
- **Lists**: a `ul`/`ol` becomes **one** block (all items' text), since single short `li`s embed poorly and make noisy breakpoints.
- Blocks whose normalized text is empty are dropped. Images and media contribute nothing, since this is text RAG.

Each block: `{ id: "b<index>", type: "heading"|"text", level?, text, wordCount }`.

## Anchoring (part of B1, used by both paths)

This solves the re-anchoring problem Phase A flagged. It lives in `content/anchor.js`, and the pure matching lives in `lib/text.js`:

1. Build a text index of the live page. A `TreeWalker` collects the text nodes under `document.body`, skipping `script`/`style`/`noscript`/`template`. Their text is concatenated with whitespace collapsed (`normalizeText`), and an offset map records `normalizedOffset → (textNode, offset)`.
2. For each block **in document order**, search for its normalized text with `findQuote`, starting from a moving cursor. Order disambiguates repeated text, such as a "Summary" heading that appears twice.
3. **Exact match**: build a `Range` from the mapped start and end, and advance the cursor.
4. **No exact match** (Readability sometimes drops inline bits inside a paragraph): match the block's first ~40 and last ~40 normalized characters separately, after the cursor. If both are found, in order, and span no more than ~1.5× the block length, use that span.
5. **Still nothing**: the block is unanchored (`anchored: false`). It stays in its section and remains usable for retrieval; it just can't be highlighted live, and F falls back to snippet mode for it.
6. Each block gets a serializable anchor `{exact, prefix, suffix}`, with ~32 chars of context either side, for later re-anchoring after reload (F3) or when a stored `Range` has gone stale (`!range.startContainer.isConnected`, e.g. after an SPA re-render).

Ranges stay in `globalThis.__summarizerRanges: Map<blockId, Range>` in the content script. Only anchors and the `anchored` flag leave it.

Known limits, consistent with Phase A's log: text inside shadow roots and iframes isn't indexed, and text the page renders differently from its DOM (CSS `text-transform`, `::before` content) won't match. Both degrade to unanchored blocks, never to errors.

## B1 — Heading-based split

`lib/sections-headings.js`, `splitByHeadings(blocks)`, pure:

- **Use B1 when the article has ≥ 2 heading blocks.** With 0–1 headings, the heading structure says nothing useful, so fall to B2.
- Flat split: every heading at any level starts a new section. Each section records `headingPath` (e.g. `["Installation", "Linux"]`) from the levels above it, which gives B3 and citations context without nesting the data.
- Blocks before the first heading become an intro section with `heading: null`. B3 generates its heading.
- A heading followed directly by another heading (empty body) doesn't produce a section of its own. Its text survives in the next section's `headingPath`.
- Heading text comes straight from HTML (`headingSource: "html"`). B3 only generates the summary for these.

Not handled (noted for tuning, not built): a single huge headed section isn't sub-split by B2. Revisit if real pages show it.

## B2 — Centroid breakpoint detection

**Embedding (minimal C1).** `workers/embed-worker.js` loads `Xenova/all-MiniLM-L6-v2` (quantized) through Transformers.js `pipeline("feature-extraction")` with `{pooling: "mean", normalize: true}`, which gives 384-dim unit vectors. The pipeline is loaded once and reused for the life of the offscreen document. `background/offscreen-client.js` creates the offscreen document on demand and messages `{texts}` → `{vectors}`. Exact library and model versions are pinned when vendored.

> **As implemented (build step 3):** Transformers.js **4.3.1** (`dist/transformers.min.js`, ONNX Runtime bundled), plus `onnxruntime-web` **1.31.0-dev.20260914-8d85527a0** wasm files. It uses the plain CPU `ort-wasm-simd-threaded` build (14 MB) instead of v4's default `.asyncify` build (27 MB, only needed for WebGPU), single-threaded, because extension pages aren't cross-origin isolated. Details: `workers/vendor/VENDORED.md`. Text over the model's token limit is truncated by the tokenizer, which is acceptable for boundary detection.

**Breakpoints.** `lib/breakpoints.js`, `detectBreakpoints(embeddings, wordCounts, opts)`, pure. It returns the block indices where a new section starts.

- Before embedding, very short text blocks (< `MIN_BLOCK_WORDS` = 12) are merged into the following block, because one-line paragraphs make noisy vectors.
- The function walks blocks in order and keeps the running centroid of the current section (the mean of its vectors). It starts a new section when `cosine(block, centroid)` drops below the threshold (per page since 2026-11-06, see below). It also never ends a section before `MIN_SECTION_BLOCKS` blocks, and it forces a break once a section exceeds `MAX_SECTION_WORDS`.
- Defaults, to tune against real pages like the Phase A thresholds: `SIMILARITY_THRESHOLD = 0.45`, `MIN_SECTION_BLOCKS = 2`, `MAX_SECTION_WORDS = 600`. They're exported constants passed in through `opts`, per the skill, not buried in the function.
  > **Changed 2026-11-06 (combined run test 8): the threshold is now per page.** A fixed threshold didn't carry across kinds of writing. On 12 headingless pages (news from NPR, essays from Paul Graham, Sam Altman, Joel Spolsky and danluu, a blog post, a short story, two speeches, a German novella), the mean neighbour similarity ranged 0.39–0.59. A fixed 0.45 cut news into ~70-word scraps; 0.30 (briefly tried 2026-11-05, tuned on two Paul Graham essays) almost never fired on the German text. Now `pageThreshold` compares each unit with the mean of the 3 before it and takes mean − 0.5 × sd of those similarities (`THRESHOLD_SPREAD`), falling back to 0.45 for pages too short to profile. The section minimum is now `MIN_SECTION_WORDS = 150` instead of a unit count, so it doesn't depend on how a site splits paragraphs (`MIN_SECTION_BLOCKS` stays as an option, default 1). Result: 220–520-word sections on average on every page, mostly topic-driven breaks rather than the 600-word cap. One check against ground truth: "Do Things That Don't Scale" has 10 bold subheadings, and 8 of them get a break within one unit, with 1 break elsewhere (0.45 fixed: 8 hits and 3 elsewhere; 0.30: 6 hits).
  >
  > **Input fixes found in the same test, all general rather than site-specific:** (1) Readability turns wrapper elements (a `<div>`, or an old `<font>` around a whole essay) into a `<p>`, which can then hold every paragraph. `parseBlocks` now unwraps any `<p>` that holds block elements, keeping loose text as its own `<p>`. This generalizes the Wikipedia heading fix. (2) Layout wrappers: a `<blockquote>`, `<table>` or list whose text is ≥ 80% in nested blocks (`WRAPPER_SHARE`) is skipped and its nested blocks used instead. Lincoln's second inaugural (an old table layout) was one 1,058-word block; danluu's largest block went from 1,332 to 418 words. Real quotes, data tables and plain lists stay one block; block coverage stays ≥ 96% on all 17 test pages. (3) The debug highlight scrolls to the highlighted range itself, not its parent element (which can be the whole article). (4) `dropTrailingBackMatter` (`lib/sections-headings.js`) cuts the block list at a plain-text back-matter line ("Notes", "References", …) in the page's second half, for pages whose back matter isn't under a real heading. English names only, like `REFERENCE_HEADINGS`.

  > **Input fix, 2026-11-07 (user report during phase 5): glued text.** Block text came from `textContent`, which runs neighbouring cells, captions and list items together with no space. Wikipedia infoboxes gave fallback headings like "White HouseTop: the Executive Residence's…" and "Washington, D.C.Capital city…", and the same glued words went into embeddings. `parseBlocks` now builds `text` with a space at each block or cell boundary (`readableText` in `content/blocks.js`, which also skips `<style>`/`<script>`). The page's own text has no space there either, so a block whose spaced text differs keeps the plain one as `anchorText` for anchoring, as Markdown blocks already do. Checked on Washington, D.C., White House and MDN `<table>`: anchoring 99.3% / 100% / 100% as before, and every section's highlight is exact (47 + 27 + 33). `blockCoverage` can now go slightly above 100%, because of the added spaces.
- Produced sections have `heading: null`, `headingSource: "generated"` (filled by B3) and `method: "semantic"`.

Embeddings computed here are **not** stored. C2 owns storage, and the section-level embeddings retrieval needs are a different input (whole section text). Re-embedding in C is the cost of keeping B independent. It runs locally and costs only CPU.

## B3 — Heading + summary generation

`background/llm.js` with pure helpers in `lib/section-prompt.js`:

- **Batched**, not one call per section. The Gemini free tier is rate-limited per minute, and an 11k-word essay can produce 20+ sections. Up to 8 sections go in one request, each truncated to ~400 words. *(Raised to **30** on 2026-11-05 during the phase 4 combined run, approved by the user: repeated test scans hit the free-tier 429 quota. With 8, a 66-section doc needed 9 requests; with 30 it needs 3.)* Batches run sequentially. Each section is still summarized on its own text only, never the whole page, as the skill requires.
- Requests use JSON structured output (`responseMimeType: "application/json"` plus a response schema): an array of `{id, heading, summary}`. For sections whose heading came from the HTML, only `summary` is requested and used.
- Model: Gemini Flash (free tier), kept as one constant in `llm.js`. The current model ID is verified against Google's docs when this is implemented, not guessed now.
  > **As implemented:** `gemini-3.6-flash`, marked stable on Google's model list (checked 2026-11-03). The `gemini-flash-latest` alias was rejected because it's swapped to each new release. The list doesn't say which models are on the free tier; confirm when setting up the key. A 429 is retried once only if the suggested wait is ≤ 20 s, because an idle service worker can be stopped after ~30 s.
- **Never blocks the pipeline.** On a missing key, a network error, malformed output, or a 429 that is still failing after one retry (which honours the retry delay), the affected sections get a fallback heading (first ~8 words + "…") and `summary: null`, and the harness logs why.
- **API key**: kept in `chrome.storage.local` under `geminiApiKey`. For this phase it's set from the service-worker console via `setGeminiKey("…")`; a settings UI comes with the side panel. It is never committed or logged.
- **Host access**: the call is first tried with no host permission, since the Gemini REST API returns CORS headers. If the service worker is blocked anyway, the fallback is one narrow static host permission for `generativelanguage.googleapis.com`, the same pattern §7.1 uses for DuckDuckGo. That fallback gets noted in §7.1 if it's needed.
- Privacy note for the README: scanned page text goes to Google for this step. On the free tier, Google may use it to improve its products.

## Output shape

The `semantic-sectioning` skill's `Section` is updated to:

```
Section {
  id,               // "s<index>", unique within the page; page scoping comes with C2/G
  heading,          // HTML text or generated; fallback text if B3 failed
  headingSource,    // "html" | "generated" | "fallback"
  headingPath,      // ancestor headings (B1); [] for B2
  summary,          // generated one-liner, or null
  text,             // joined block text
  method,           // "headings" | "semantic"
  blocks: [ { id, anchor: {exact, prefix, suffix}, anchored } ]  // replaces domRange; live Ranges stay in the content script
}
```

> **As implemented (build steps 4–5):** the content script does extraction, blocks, anchoring and B1, and returns `sections: null` when there are fewer than 2 headings. The background then runs B2 (`background/sectioning.js`) and B3 (`background/llm.js`) and assembles the final shape (`lib/sections.js`). The finished sections are stored in `chrome.storage.session` under `scan:<tabId>`, so the console helpers keep working after the service worker restarts. The interim `"unsplit"` mode from step 2 is gone.

## Test harness (extends Phase A's)

- The toolbar click runs A, then B, and logs `console.table` rows `{i, heading, headingSource, method, words, anchored: "7/8", summary}` plus totals: section count, anchoring rate, and the time spent on blocks, anchoring, embedding and LLM.
- `highlightSection(tabId, i)` messages the content script to put that section's Ranges into a test `Highlight` (`::highlight(summarizer-debug)`), so you can see whether anchoring landed on the right text. `clearHighlight(tabId)` removes it.
- `scan(tabId, { llm: false })` skips B3, to save quota while tuning B1/B2.
- `setGeminiKey(key)` stores the key.

This is still scaffolding and gets replaced by H2/I2 in phase 4.

## Test plan

**Unit (`npm test`, no browser):**
- `lib/text.js`: whitespace normalization; `findQuote` exact match, the cursor skipping an earlier duplicate, the prefix/suffix fallback, and rejection of spans far longer than the quote.
- `lib/sections-headings.js`: intro section, empty-body headings folding into `headingPath`, nested levels, and the < 2 headings case (returns null so the caller falls to B2).
- `lib/vector.js`: cosine of identical, orthogonal and opposite vectors; the mean.
- `lib/breakpoints.js`: three synthetic clusters of vectors give exactly two breaks; the `MIN_SECTION_BLOCKS` and `MAX_SECTION_WORDS` constraints hold; one block gives one section.
- `lib/section-prompt.js`: batching splits at the batch size (8, now 30); truncation; the response parser accepts valid JSON, rejects unknown ids and missing fields, and fills fallbacks.

**Manual (harness), reusing Phase A's pages:**
- Headed docs page and the "Subheadings" blog → `method: "headings"`, and sections match the page's visible headings.
- Paul Graham essays → `method: "semantic"`, with a plausible count (roughly 10–30 sections for "How to Do Great Work"). Spot-check that the breaks fall at real topic shifts.
- `highlightSection` on 3+ sections per page highlights exactly the right paragraphs, with no nav or ads.
- Embedding: the first scan downloads the model (time logged), and a second scan after reloading the extension loads it from cache.
- B3 produces sensible headings and summaries; a deliberately wrong key produces fallback headings with no crash.

## Checkpoints: test these before starting Phase C

You run these right after the build step named; the rest of the manual test plan above waits for the combined run.

- [x] **CP-B1, after build step 2 (anchoring + B1).** Reload the extension, scan the headed docs page and one Paul Graham essay, and run `highlightSection(tabId, i)` on 2–3 sections each. Pass: the right paragraphs are highlighted, and the logged anchoring rate is ≥ 90%. *Why now:* every citation highlight later depends on this, and a miss here would be hard to separate from C or side-panel bugs in a combined run.
- [x] **CP-B2, after build step 3 (offscreen + worker).** Run `await embed(["hello world", "goodbye"])` in the service-worker console. Pass: two arrays of length 384, and on a second call after an extension reload, no model download in the Network tab. *Why now:* the offscreen document, wasm CSP and model download are browser-environment concerns no unit test covers, and B2, all of C, and phase 4 retrieval sit on top of them.

Everything else (B2 threshold tuning, B3 output quality, LLM fallback) is checked in the combined run.

## Exit criteria for Phase B (ticked during the combined run, except unit tests and checkpoints)

- [x] All `lib/` unit tests pass
- [x] B1 splits a real headed page into sections matching its visible headings *(combined run item 7)*
- [x] B2 splits a real headingless page into plausible topic sections *(combined run item 8)*
- [x] Anchoring rate ≥ 90% of blocks on the test pages, and `highlightSection` lands on the correct text *(2026-11-06, combined run test 9, automated with Playwright on 10 varied pages: 99.0–100% anchored, 204/204 sections highlighted exactly; details in the phase 4 plan.)*
- [x] Embedding worker runs in the offscreen document; the model is cached after first load *(CP-B2)*
- [x] B3 generates headings/summaries in batches, and falls back cleanly when the LLM is unavailable *(combined run items 2 and 10)*
- [x] `manifest.json` adds only `offscreen` + the wasm CSP (plus the Gemini host permission only if CORS forces it), still no broad host permissions
- [x] `semantic-sectioning` skill updated to the new output shape; spec §3.2 / §5.B1 note the per-block anchor change

## Build order inside the phase

Each step is testable before the next starts:
1. `lib/text.js` + `content/blocks.js` + `content/anchor.js` + highlight helper. Verify anchoring alone on real pages.
2. B1 (`lib/sections-headings.js`). Verify on headed pages.
3. Offscreen document + embedding worker. Verify `embed(["a","b"])` returns 384-dim vectors.
4. B2 (`lib/vector.js`, `lib/breakpoints.js`). Verify on headingless pages, tuning the threshold.
5. B3 (`lib/section-prompt.js`, `background/llm.js`). Verify with and without a valid key.

Once unit tests pass and CP-B1/CP-B2 pass, build A5 (`phase-A5-special-sources.md`: Google Docs + raw Markdown), then Phase C (`phase-C-embeddings-retrieval.md`). C1's worker already exists by then, so C covers section-level embeddings, C2 storage and C3 retrieval.

> **Changed 2026-11-05 (phase 4 combined run, approved by the user):** B3 runs **on demand**, from the panel's "Generate headings & summaries", not inside every scan. It uses `gemini-3.5-flash-lite` (15 RPM / 500 RPD on the free tier, vs 5 / 20 for `gemini-3.6-flash`), and can use local Ollama (E5) instead or as a fallback when Gemini's quota runs out. Ollama batches are 8 sections with `num_ctx` 8192. See master-spec §3.2 and §3.6. The `{llm: false}` scan option is gone, since scans never call the LLM now.

> **Fixed 2026-11-05 (phase 4 combined run, test 7):** Wikipedia headings were being lost or polluted.
> 1. On pages whose headings have no "[edit]" link (semi-protected ones, e.g. "White House"), Readability turned `<div class="mw-heading"><h2>…</h2></div>` into `<p><h2>…</h2></p>`, because it doesn't count headings as block children. The outer `<p>` won in `parseBlocks`, so the page had no headings and fell back to B2. `content/blocks.js` now unwraps paragraphs that contain a heading.
> 2. On other Wikipedia pages, each "[edit]" link became a one-word block opening every section, and a parent heading with nothing else under it became a "1 words" section. `content/extract.js` now removes `.mw-editsection` from the clone before Readability runs.
>
> Checked with jsdom on saved copies of both pages: White House went from 0 headings to 33 (30 sections), and "History of cricket to 1725" now matches its Contents box, with no near-empty sections.

> **Changed 2026-11-05 (combined run test 7, approved by the user):** B1 drops back-matter sections (References, Notes, Bibliography, Further reading, External links, etc. — `REFERENCE_HEADINGS` / `isReferenceHeading` in `lib/sections-headings.js`), including their sub-sections. Whole-heading matches only. See master-spec §3.2. The user chose not to remove Wikipedia infoboxes.


# Phase A5 — Special sources: Google Docs & raw Markdown

Implementation plan for sub-feature **A5** (`docs/master-spec.md` §3.1a, §5.A5), added 2026-11-03. It extends extraction (A) so two important source types produce the same block list that Phase B consumes. Built **after Phase B is complete and before Phase C**, and covered by the combined B + C + 4 run (master-spec §6a). The only checkpoint is CP-A5-1, for Google Docs.

## Why these need their own path

- **Google Docs** draws the document body on a `<canvas>`. The only real text in the page's HTML is the sidebar outline, so Readability "extracts" the outline. This was observed in testing: the Phase A "PSBA Terms of Reference" result was outline-only.
- **Raw Markdown files** (e.g. `raw.githubusercontent.com/.../README.md`) are shown by Chrome as plain text in a single `<pre>`. Readability finds no structure, so the page lands in the A3 "sparse" banner or comes out as one undivided block.
- **Rendered Markdown** (GitHub/GitLab file views, MkDocs/Docusaurus sites) is ordinary HTML and already works through the normal path. It needs no new code, just a combined-run test.

## Approved behaviour (2026-11-03)

| Source | Extraction | Sectioning | Citations |
|---|---|---|---|
| Google Docs | Fetch Docs' own HTML export using the user's session | B1 on the export's real headings (B2 if the doc has none) | **No live highlight** (canvas). **Snippet** (quoted text + heading) plus a **Jump to section** action that clicks the heading in the doc's outline sidebar, which scrolls the doc there (see "Jump to section") |
| Raw Markdown | Parse the page's plain text into blocks (`#` headings, paragraphs, lists, code fences) | B1 on `#` headings (B2 if none) | **Live highlight works**: the text is real DOM text, anchored like any page |

## Runtime flow

```
scan → content: detectSource()
  ├─ "gdocs"    → fetch export HTML (same-origin, user's cookies) → DOMParser (inert) → blocks
  │               + per-heading outline target {headingText, occurrence} → section.jump
  │               anchoring skipped: every block anchored:false (canvas has no DOM text)
  ├─ "markdown" → read document.body text → lib/markdown-blocks.js → blocks
  │               → normal anchoring against the live <pre> text
  └─ "dom"      → Phase A + B as today (Readability → blocks → anchoring)
        ↓ (same from here on)
  A2 classification on the block word count (media area treated as 0 for both special sources)
  → B1 / B2 / B3 → C → side panel, unchanged
```

## File layout

```
/content/sources.js            detectSource(); gdocs fetch + parse; markdown read; returns {source, title, blocks, textContent}
/lib/gdocs.js                  parseDocsUrl(url) → {docId, accountPrefix, tab}; exportUrl() — pure
/lib/markdown-blocks.js        markdownToBlocks(text) — pure
/content/blocks.js             parseBlocks(el, {headingTags}): gains an option so the gdocs path can count h1 as a heading
/content/anchor.js             anchors on block.anchorText ?? block.text (markdown keeps raw source text for matching)
/content/bootstrap.js          handleScan branches on detectSource(); becomes async (gdocs fetch)
/lib/gdocs.test.js, /lib/markdown-blocks.test.js
```

## A5a — Google Docs

**Detection.** The hostname is `docs.google.com` and the path matches `/document/(u/<n>/)?d/<docId>/…`. The `u/<n>/` account prefix is kept, so the export uses the same Google account the tab is signed into.

**Export fetch.** `fetch(\`/document/${accountPrefix}d/${docId}/export?format=html\`, {credentials: "include"})` runs from the content script. It's same-origin, so it uses the user's existing login and needs **no new permissions and no Google API/OAuth setup**.
- A non-OK response, a non-HTML response, or a redirect to a sign-in page → new user-facing message: *"Couldn't read this Google Doc. The owner may have disabled downloading, or you may need to sign in."* It's logged with its own `reason` and never confused with A4's "site restricts access".

**Parsing.**
- The export is parsed with `DOMParser` into an inert document and walked with `parseBlocks`. **Readability is skipped**: the export is already just the document, and Readability's pruning would only drop real content.
- In the export, `h1` is a real "Heading 1" (the doc title is a styled `<p class="title">`), so this path treats `h1`–`h4` as headings.
- Noise removed before walking:
  - table-of-contents paragraphs, whose entire text is an internal `#h.…` link
  - exported comment and footnote blocks (elements with `cmnt…` / `ftnt…` ids at the end of the body)
- Title: the export's `<title>`, falling back to the tab title.

**Jump to section.**
> **Changed during CP-A5-1 (2026-11-03):** the original design (heading ids from the export → `#heading=h.xxxx` URLs) doesn't work. On a real doc the export had **no `id` attributes at all**, and its table-of-contents links were a bare `href="#"`. Clicking a heading in the live doc's outline sidebar doesn't change the URL hash either, so no heading URL is available anywhere. The approved behaviour ("Jump to section") is unchanged; only the mechanism is.

- **Mechanism (as built):** a jump clicks the heading's entry in the **live doc's outline sidebar**, which is real DOM text. B1 sections with a heading get `jump: {kind: "gdocs-outline", headingText, occurrence}`. `occurrence` is the nth heading with that exact text, counted in document order over all headings, so repeated headings like two "Overview"s go to the right one.
- **In CP-A5-1:** the content script finds `.navigation-item` entries whose `.navigation-item-content` text equals `headingText`, picks the `occurrence`-th one, and dispatches `mouseover` → `mousedown` → `mouseup` → `click`. Docs' outline items are Closure components: a bare `click()` and synthetic Enter key events both did nothing, while the mouse sequence scrolled the doc.
- **Fragility:** `.navigation-item` / `.navigation-item-content` are Docs-internal class names, so this is the most fragile selector in the project. If no outline is found, the jump fails with "open the document outline (left sidebar) and try again". Whether it still works with the outline panel closed is unverified.
- **F3 (doc not open):** open or focus the doc tab, inject, then send the same jump. No URL is involved.
- Intro sections and B2 sections (no heading) get `jump: null`. Their citation is snippet-only.
- In F, "Jump to section" sends the content script `{type: "jump-to-outline-heading", jump}`.

**Anchoring.** Skipped. Every block is `anchored: false`, with `anchor.exact` still filled so the corpus shape matches other pages. F's live-highlight path sees no anchored blocks and falls to snippet + jump.

## A5b — Raw Markdown

**Detection.** `document.contentType` is `text/markdown` or `text/x-markdown`, **or** it's `text/plain` and the URL path ends in `.md` / `.markdown`. Other plain-text files are out of scope and take the normal path.

**Parsing.** `lib/markdown-blocks.js`, pure, with no library. CommonMark-lite, covering only what sectioning needs:
- ATX headings (`#`–`####` become headings, `#####`+ become text) and setext headings (`===` / `---` underlines)
- paragraphs separated by blank lines
- a run of list lines (`-`, `*`, `+`, `1.`) becomes one block, like HTML lists in B
- a fenced code block (```` ``` ```` / `~~~`) becomes one block, and `#` lines inside fences are never headings
- YAML front matter (`---` … `---` at the top) is skipped
- Each block keeps **two texts**:
  - `text`: markdown syntax stripped (`#`, emphasis markers, link URLs reduced to their link text), used for display, embeddings and the LLM
  - `anchorText`: the raw source lines, normalized, used to match against the live `<pre>`, which shows the raw source

**Anchoring.** Normal Phase B anchoring against the page text, using `anchorText`, so live highlighting works.

## Output-shape additions

- `Section.jump`: `{kind: "gdocs-outline", headingText, occurrence} | null` is a navigation target for sources that can't be highlighted live. It's `null` for normal web pages.
- The corpus records `source: "dom" | "gdocs" | "markdown"` so F and the reading view know which citation mode to use.
- Blocks may carry `anchorText` (markdown only).

## Test plan

**Unit (`npm test`):**
- `lib/gdocs.js`:
  - URL parsing with and without `u/<n>/`, `/edit`, `/view`, query strings, a tab parameter
  - non-Docs URLs return null
  - export URL building
- `lib/markdown-blocks.js`:
  - ATX and setext headings at each level
  - `#` inside a code fence isn't a heading
  - front matter skipped
  - list runs merged into one block
  - `text` vs `anchorText` stripping
  - empty input

**Manual:** in the combined run (phase 4 doc, items 13–16).

> **As implemented (2026-11-03, both A5a and A5b built):** `content/sources.js` picks the path. If `DOMParser` throws under Trusted Types, it retries once through a `trustedTypes` policy (`summarizer-export`); if that's refused too, the scan reports `source-error` / `gdocs-trusted-types`, which is the signal to move parsing to the offscreen document. Export failures report `source-error` / `gdocs-export-failed`. Harness helper: `jumpTo(tabId, i)`.

## Checkpoint: test this before building on the Google Docs path

- [x] **CP-A5-1: Google Docs export, right after A5a is built.** On one of your real Google Docs:
  1. Scan it. Pass: section headings match the doc's headings, and the word count is in the doc's real range, not ~200 like the outline.
  2. Run `jumpTo(tabId, i)` (harness helper) for 2 sections. Pass: the doc scrolls to that heading.
  3. If the doc uses document tabs, try a heading in a second tab.
  4. If you have access to a doc with downloading disabled, scan it. Pass: the "couldn't read this Google Doc" message, no crash.

  *Why now:* three assumptions here are unverified: the export fetch works from the content script, `DOMParser` isn't blocked by Docs' Trusted Types policy, and the export's heading ids match what `#heading=` expects. If `DOMParser` is blocked, parsing moves to the offscreen document (which exists from Phase B step 3), before anything else depends on it.

## Exit criteria for A5 (ticked during the combined run, except unit tests and the checkpoint)

- [ ] `lib/gdocs.js` and `lib/markdown-blocks.js` unit tests pass
- [ ] CP-A5-1 passes
- [ ] A raw `.md` file splits on its `#` headings, and `highlightSection` highlights the right lines
- [ ] A rendered GitHub README still works through the normal path
- [ ] No new permissions

## Build order inside A5

1. `lib/gdocs.js` + tests, `content/sources.js` gdocs branch, `parseBlocks` heading option, `jumpTo` harness helper. **Run CP-A5-1.**
2. `lib/markdown-blocks.js` + tests, the markdown branch, `anchorText` support in `anchor.js`.

Then Phase C.

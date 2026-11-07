---
name: citation-highlighting
description: Use when implementing or modifying how chat answers cite and highlight source sections for the Summarizer (sub-features F1–F3) — mapping a retrieved section back to a live DOM highlight when its source page is open, or a snippet-plus-link when it isn't.
---

# Citation highlighting

Implements master-spec §3.8 (sub-features F1–F3). The mechanism itself (CSS Custom Highlight API) is a generic browser API — see `docs/reusable-skills.md` for general usage patterns. This skill covers the project-specific decision logic for *when* to highlight live vs. show a snippet.

## Live highlighting (F1)

For any cited section whose source page is the currently open/active tab:

1. Create or reuse a named `Highlight` object.
2. Get the section's live `Range`s from the content script's map, one per anchored block. If a range is missing or stale (`!range.startContainer.isConnected`), rebuild it from the block's stored text-quote anchor (see the `semantic-sectioning` skill and master-spec §3.2). Add all of them to the highlight via `CSS.highlights.set(name, highlight)`. Blocks that can't be re-anchored are skipped; if none anchor, fall back to snippet mode as in F3.
3. Style via a `::highlight(name)` CSS rule — do not wrap the range in a `<span>` or otherwise mutate the DOM.
4. Clear/replace the highlight when a new answer is given, rather than accumulating highlights indefinitely.

## As built in phase 7 (2026-11-07)

- **Passage, not section.** Each citation stores `passages: [{blockId, exact}]`: the sentence(s) of the section that best match the answer sentences citing it (`lib/passages.js`, local embeddings, floor `PASSAGE_MIN`). The passage gets a translucent tint; the rest of the section an underline in the same colour. No passage → the whole section is tinted.
- **Colours.** A random palette colour per citation, one named highlight per colour (`summarizer-cite-<i>`, `summarizer-cite-ctx-<i>`), styles in `background/citation-styles.js`; `CITE_COLORS` in `content/citations.js` must match the palette length.
- **Triggers.** The [n] chip or card toggles the highlight (opening/focusing the source page if needed); Esc, the next question and closing the panel clear it. Reading-view cards only flash (`summarizer-flash`, 2 s).
- **Selection answers.** [1] is the selected text (`selection: true, quote`), highlighted as one quote.

## Citation-to-response mapping (F2)

Every chat response that draws on retrieved sections must carry, per citation, at minimum: `{pageUrl, sectionId}`. Render this as a small badge in the chat UI (e.g. page title + section heading) — not just a bare highlight with no visible reference, since citations may point to pages other than the current one.

## Cross-page citations (F3)

If a cited section's `pageUrl` does not match the currently open tab:
1. Do not attempt to highlight anything (there is no live DOM to target).
2. Render the citation as a snippet (the section's stored text or summary) plus the page title, with an action button: "open page and highlight."
3. That action should: open the target URL in a new tab (or focus it if already open), then once loaded, re-run the F1 live-highlight logic for the cited section. On a freshly loaded page there are no live ranges yet, so they're rebuilt from the section's stored text-quote anchors.

## Google Docs citations (A5, master-spec §3.1a / §3.8)

Google Docs pages are canvas-rendered: their sections have no anchored blocks and are never highlighted live, even when the doc is the open tab. Render them as a snippet + page badge. If `section.jump` is set (`{kind: "gdocs-outline", headingText, occurrence}`), add a **Jump to section** action. Focus or open the doc tab, make sure the content script is injected, then send it `{type: "jump-to-outline-heading", jump}`; it clicks the heading in the doc's outline sidebar. There is no heading URL to navigate to (master-spec §3.1a). If the outline isn't on the page, show the returned error ("open the document outline…"). Sections with `jump: null` (intro, or B2-split) are snippet-only. Decide the mode from the corpus `source` (`"gdocs"`), not from the URL.

## Non-goals

- No attempt to highlight a page that isn't rendered in any tab — always fall back to snippet mode in that case.
- No persistent/multi-highlight overlays across turns — one active highlight set at a time per page, tied to the most recent answer that cited it.

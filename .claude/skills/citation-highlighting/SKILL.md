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

## Citation-to-response mapping (F2)

Every chat response that draws on retrieved sections must carry, per citation, at minimum: `{pageUrl, sectionId}`. Render this as a small badge in the chat UI (e.g. page title + section heading) — not just a bare highlight with no visible reference, since citations may point to pages other than the current one.

## Cross-page citations (F3)

If a cited section's `pageUrl` does not match the currently open tab:
1. Do not attempt to highlight anything (there is no live DOM to target).
2. Render the citation as a snippet (the section's stored text or summary) plus the page title, with an action button: "open page and highlight."
3. That action should: open the target URL in a new tab (or focus it if already open), then once loaded, re-run the F1 live-highlight logic for the cited section. On a freshly loaded page there are no live ranges yet, so they're rebuilt from the section's stored text-quote anchors.

## Non-goals

- No attempt to highlight a page that isn't rendered in any tab — always fall back to snippet mode in that case.
- No persistent/multi-highlight overlays across turns — one active highlight set at a time per page, tied to the most recent answer that cited it.

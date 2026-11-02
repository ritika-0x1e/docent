---
name: semantic-sectioning
description: Use when implementing or modifying page sectioning for the Summarizer (sub-features B1–B3) — splitting Readability-extracted content into sections by existing headings, or by embedding-based centroid breakpoint detection when no headings exist, and generating headings/summaries after boundaries are fixed.
---

# Semantic sectioning

Implements master-spec §3.2 (sub-features B1–B3). The core rule: LLM calls happen only *after* section boundaries are fixed, never to determine the boundaries themselves — boundary detection must be free (embeddings + heuristics only).

## Structured case (B1)

If the extracted article contains `h1`–`h4` elements:
1. Split content at each heading.
2. For each block (paragraph, list, heading…) in the section, compute a text-quote anchor `{exact, prefix, suffix}` by matching the block's text against the live page, and keep the resulting live `Range` in the content script's in-memory map (`globalThis.__summarizerRanges`). Only the anchors leave the content script. `Range`s can't be messaged or persisted, and a heading-to-heading `Range` would also cover the boilerplate between paragraphs (master-spec §3.2). Unmatched blocks are marked `anchored: false`, never treated as errors.
3. Use the heading's own text as the section heading; no generation needed for this case.

## Unstructured case (B2)

If no usable headings exist:
1. Split the content into paragraphs.
2. Embed each paragraph (via the local MiniLM embeddings — see `docs/reusable-skills.md` for the Transformers.js worker pattern).
3. Walk paragraphs sequentially, maintaining a running centroid (mean vector) of the current section's paragraph embeddings.
4. For each new paragraph, compute cosine similarity between its embedding and the running centroid.
5. If similarity drops below a threshold, close the current section and start a new one with this paragraph as the first member of the new running centroid.
6. Threshold is a tunable constant — start with a reasonable default and expose it as a config value rather than hardcoding it deep in the function, since it will likely need adjustment once tested against real pages.
7. Anchor each block the same way as the structured case. Anchoring runs on blocks before either path, so both share it.
8. Embeddings come from the worker hosted in the offscreen document (master-spec §7.1). They're used only to find boundaries and are not stored; Phase C embeds section chunks separately for retrieval.

## Heading + summary generation (B3)

Only runs after B1 or B2 has produced fixed section boundaries.

- One LLM call per section (or batched, if the API supports multiple outputs per call efficiently) that takes the section's text and returns `{heading, summary}` — summary should be one line.
- Do not feed the whole page to the LLM at once for this step; keep it scoped per-section to keep calls cheap, per the "defer and minimize LLM calls" principle in the master spec.
- If a section already has a heading (structured case), skip heading generation and only generate the summary.

## Output shape (both cases converge here)

```
Section {
  id,               // "s<index>", unique within the page
  heading,          // from HTML, generated, or fallback text if the LLM step failed
  headingSource,    // "html" | "generated" | "fallback"
  headingPath,      // ancestor headings (structured case); [] otherwise
  summary,          // generated one-liner, or null
  text,
  method,           // "headings" | "semantic"
  blocks: [ { id, anchor: {exact, prefix, suffix}, anchored } ]  // replaces domRange; live Ranges stay in the content script
}
```

Full details, thresholds and batching rules: `docs/phased-implementation-plan/phase-B-sectioning.md`.

## Non-goals

- No LLM-based boundary detection — boundaries must come from heading structure or the centroid-similarity method only.
- No re-sectioning on every query — sectioning runs once per scan (see `scan-button-state-machine` skill for when re-scans are cache-hits vs. fresh runs).

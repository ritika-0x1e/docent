---
name: crawl-approved-links
description: Use when implementing or modifying the crawl step that runs after the user approves links from the picklist (sub-feature D6) — fetching approved URLs, running them through extraction/sectioning/embedding, and merging results into the thread corpus with sourcePage/linkedFrom tags. This skill only covers orchestration and the tagging contract — it does not duplicate extraction, sectioning, or thread-schema logic, which live in their own skills.
---

# Crawl approved links (D6)

Implements master-spec §3.5. This is the bridge between the picklist (`link-harvesting-and-scoring`) and the thread corpus (`thread-data-model`) — it has no scoring or ranking logic of its own, and it must never run on anything the user didn't explicitly check in the picklist.

## Trigger

Runs only after the user has approved one or more links in the picklist UI (see `link-harvesting-and-scoring` skill for how that list was built and ranked) and confirmed the crawl. Never triggered by score, position, or `sourceType` alone — approval is the only gate.

## Orchestration order, per approved URL

1. `fetch()` the URL in the background service worker.
2. Run the fetched HTML through the same extraction step as the current-page pipeline (see `docs/reusable-skills.md` for Readability.js usage — no separate extraction logic here).
3. Run the extracted content through the same sectioning logic as the current page (see `semantic-sectioning` skill — heading split or centroid breakpoint, whichever applies).
4. Embed the resulting sections the same way as any other page (see `docs/reusable-skills.md` for the Transformers.js worker pattern).
5. Do **not** create a new standalone page corpus that lives outside the thread — merge directly into the active thread's corpus (see `thread-data-model` skill for the `Thread.pages[]` shape).

## Tagging contract (the one piece unique to this skill)

Every section produced by this flow must carry, in addition to the normal section fields:

```
{
  sourcePage: string,   // title of the crawled page
  linkedFrom: string,   // title of the page the link was found on
  viaAnchorText: string // the anchor text of the link that was approved
}
```

These three fields are what let later citations say "from *Lorentz transformation* (linked from this article)" instead of just showing a bare page title — don't drop them at the merge step even though they're not needed by the embedding/retrieval math itself.

## Thread update

After a successful crawl, append `{url, title, corpusRef, addedAt}` to `thread.pages` exactly as the manual scan-button flow does (see `thread-data-model` skill, sub-feature G3) — a crawled page and a manually-scanned page should be indistinguishable in the thread schema once they're in it. The only difference is how they got there.

## Non-goals

- No independent extraction/sectioning/embedding implementation — this skill orchestrates calls into the logic already defined elsewhere; if that logic needs to change, change it in `semantic-sectioning` or the reusable Readability/Transformers.js patterns, not here.
- No crawling based on score, quota rank, or `sourceType` — only explicit user approval triggers this flow.
- No new corpus type — crawled pages merge into the same `Thread.pages[]` structure as manually scanned ones.

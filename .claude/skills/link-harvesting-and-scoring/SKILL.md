---
name: link-harvesting-and-scoring
description: Use when implementing or modifying the link-harvesting picklist for the Docent (sub-features D1–D5) — harvesting inline vs nav links from a page, scoring them, allocating the top-20 picklist slots between categories with backfill, and the picklist UI itself. This is project-specific logic, not a general web-scraping pattern.
---

# Link harvesting and scoring

Implements master-spec §3.3–3.4 (sub-features D1–D4). Do not auto-crawl anything this skill touches — output is always a ranked candidate list for manual user approval, never a crawl trigger.

## Harvesting (D1–D2)

1. From the Readability-extracted article body, collect every `<a>` inside it → `sourceType: 'inline'`.
2. From `<nav>` / `[role="navigation"]` / sidebar-like containers **outside** the article body → `sourceType: 'nav'`.
3. Drop any link whose origin differs from the current page's origin.
4. Normalize URLs (strip fragments; keep distinct query strings only if they plausibly point to different content) and dedupe. If a URL appears in both `inline` and `nav` sets, keep only the `inline` entry.
5. Record for each surviving link: `{url, anchorText, sourceType, surroundingText}`, where `surroundingText` is the sentence or paragraph the link is embedded in (used for picklist relevance judgment, not for scoring).

## Scoring (D3)

```
score = baseWeight[sourceType] + positionBonus + repeatBonus

baseWeight.inline = 10
baseWeight.nav = 3

positionBonus: +2 if link's paragraph is in the first third of the article,
               +1 if middle third, +0 if last third

repeatBonus: +1 per additional inline occurrence of the same URL, capped at +3
             (nav links do not accrue repeat bonus)
```

## Quota allocation with backfill (D4)

Cap total picklist size at 20, with a 15 (inline) / 5 (nav) base quota.

```
sortedInline = inlineCandidates sorted by score desc
sortedNav    = navCandidates sorted by score desc

takenInline = min(len(sortedInline), 15)
takenNav    = min(len(sortedNav), 5)
leftover    = 20 - takenInline - takenNav

if leftover > 0:
    extraFromInline = min(leftover, len(sortedInline) - takenInline)
    takenInline += extraFromInline
    leftover -= extraFromInline
    if leftover > 0:
        extraFromNav = min(leftover, len(sortedNav) - takenNav)
        takenNav += extraFromNav

result = sortedInline[:takenInline] + sortedNav[:takenNav]
```

Inline backfills before nav — it's the higher-priority category. Verify against these cases when testing:

| Inline available | Nav available | Expected result |
|---|---|---|
| 20 | 3 | 17 inline, 3 nav |
| 5 | 20 | 5 inline, 15 nav |
| 18 | 18 | 15 inline, 5 nav (no backfill) |
| 4 | 3 | 4 inline, 3 nav (total 7, no capping) |

## UI notes (D5)

- Render as one merged, score-sorted list — do not visually split into two separate inline/nav sections; the scoring already interleaves them correctly.
- Include a text filter box above the list regardless of candidate count.
- Show `surroundingText` as a snippet next to each entry.

## Non-goals

- No automatic crawling based on score alone — score only determines picklist visibility/ranking, never approval.
- No re-scoring after the user starts checking boxes — scoring runs once per page scan.
- No crawl execution logic here at all — once links are approved, the actual fetch/extract/section/embed/merge flow is a separate concern; see the `crawl-approved-links` skill (D6).

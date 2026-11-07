# Phases 9 and 10 — Linked pages (picklist + crawl) and the thread soft cap

Implementation plan for build-sequence steps 9 (**D1–D6**, spec §3.3–3.5, skills `link-harvesting-and-scoring` and `crawl-approved-links`) and 10 (**G4**, spec §3.10). From a scanned page, the user picks linked pages to add to the thread without visiting them. Nothing is ever crawled without being ticked.

**Testing:** one combined run with phase 8 at the end of phase 10 (spec §6a, exception 2).

## Already fixed by the spec and skills (no sign-off needed)
- **Harvest (D1–D2):**
  - Inline links come from the extracted article.
  - Nav links come from `<nav>`/`[role=navigation]` only (§3.3a).
  - Cross-origin links are dropped.
  - URLs are deduped by normalized URL; inline wins.
  - Each link keeps `{url, anchorText, sourceType, surroundingText}`.
- **Score (D3):** inline 10, nav 3; position +2/+1/+0 by third of the article; inline repeats +1 each, capped at +3.
- **Quota (D4):** at most 20 links, 15 inline / 5 nav, with inline backfilling first. The skill's four test cases become unit tests.
- **Picklist (D5):** one list sorted by score, with checkboxes, each link's surrounding sentence, and a filter box.
- **Crawl (D6):** approval is the only trigger. Each crawled page is tagged `{sourcePage, linkedFrom, viaAnchorText}` and appended to `thread.pages` like a scanned page.

## Defaults that need no sign-off (say if you disagree)
- **Links that aren't pages are dropped:**
  - links back to this page (`#fragment`-only, or the same normalized URL)
  - links with no visible text (image links)
  - footnote markers like "[12]"
  - files by extension (pdf, images, audio, video, archives)
  - pages already in the thread
- **The filter box searches every harvested link,** not just the top 20, since the spec's reason for it is a link the ranking missed.
- **Harvesting happens during the scan** (it's cheap) and is saved with the page's corpus. Old scans without links say "Rescan to list linked pages".
- **Crawling runs one page at a time,** with progress ("Adding 2 of 5…"), a Stop button and per-page failures listed. Pages that finish are kept if you stop.

## Decisions needing sign-off

**Status 2026-11-07: decisions 1–4 approved as proposed.**


1. **How an approved page is read.**
   - **Proposed: fetch, then extract in the offscreen document** (spec §3.5 "fetch() in background"). The background fetches the HTML, and the offscreen document parses it with `DOMParser` and runs the same Readability → blocks → sections → embedding steps. No tabs open.
     - Pages that build their text with JavaScript come back empty and are listed as "couldn't read" (open them and use Start scan instead).
     - Their sections can't be anchored until the page is opened. Citations to them show **Open page and highlight**, which re-anchors from the stored text (phase 7 already does this).
     - Needs the offscreen `DOM_PARSER` reason (no new permission). Site access is covered by the all-sites grant. If that was declined, the click asks for that site.
   - **Alternative: open each page in a background tab** and run the normal scan there, then close it. Works on JavaScript-built pages and anchors live, but tabs appear and close while it runs, and it's slower.
2. **Where the picklist lives.**
   - **Proposed: an "Add linked pages" button** under the status line after a scan (with the count, e.g. "Add linked pages (20)"). It replaces the reading view with the picklist until you add or cancel. It's never shown automatically.
   - Alternative: shown automatically after every scan, as spec §4 step 3 sketches.
3. **What a crawled page is in the thread.**
   - **Proposed: a full page of the thread.** It's in the page count and in retrieval, and its citations show the page badge. The hover path card lists only the pages you actually visited, so the path doesn't fill up with crawled pages. In the panel, a crawled page's badge reads "*Title* (linked from *Page*)", per the skill's tagging contract.
   - Opening a crawled page later is a cache hit (phase 5), so it loads instantly without re-reading.
4. **Soft cap (phase 10, G4).**
   - **Proposed: warn at 8 pages, never block.** The picklist shows "This thread has 6 pages; adding 3 makes 9 (more than 8 makes citations harder to follow)" once the total would pass 8, and the thread row's page count turns amber past 8. Nothing is refused.
   - Alternative: a different number (spec says ~6–8).

## Checks (combined run with phase 8)
1. **Picklist:** on a scanned Wikipedia article, Add linked pages shows ≤ 20 links:
   - inline first, nav at most 5 unless backfilled
   - each with its sentence
   - the filter finds a link outside the top 20
   - no footnote/image/self links
2. **Crawl:** tick 3, Add. Progress shows, the thread grows by 3, and a question about one of them is answered and cited with "(linked from …)". Open page and highlight opens it and highlights the passage.
3. **Stop and failures:** Stop mid-crawl keeps finished pages. A page that can't be read is listed, not silently skipped.
4. **Same-origin:** no cross-origin links in the list.
5. **Soft cap:** a thread going past 8 pages shows the warning, and adding still works.
6. **Web search:** phase 8's checks 1–5.
7. **No regressions:** earlier behaviour still works (scan, cache hit, chat, citations). The manifest changes only as recorded.

## As built (2026-11-07)
- `lib/links.js` (+ tests): clean, dedupe and score, 20-slot allocation with backfill, filter, soft-cap note.
- `content/links.js`: harvest during the scan (inline from Readability's content, nav from `<nav>`/`[role=navigation]`), with spacing-aware context text. Scored links are saved on the corpus.
- `offscreen/extract.js`: fetched HTML → Readability → blocks → B1. Each block's own text is its anchor; the offscreen document now also declares `DOM_PARSER`.
- `background/crawl.js`: one page at a time, Stop, per-page failures. Pages are tagged `{crawled, linkedFrom, viaAnchorText}`.
- Service worker: `panel-links`, `panel-crawl`, `panel-stop-crawl`.
- Panel: `sidepanel/picklist.js`, the "Add linked pages" button, the amber count past 8, "(linked from …)" badges.
- **Hover card (user, 2026-11-07):** it now lists every page in the thread, so it always matches the count. The path up to this page, pages added after it muted under "Later in this thread", and pages added from links under "Added from links". This replaces "past pages only", which hid pages on a thread's first page while the count included them.

**Combined run 2026-11-07, automated (Playwright, `t8.mjs`, a fresh profile):**
- Phase 8 ✅
  - A "not covered" answer offers Search the web, and nothing is opened or sent before the click.
  - The tab opens next to the page with the right query and continues the thread.
  - Fixed during the run:
    - The thread link was set explicitly, since the opener rule missed a panel-created tab.
    - "Vague" became < 3 content words, so "boiling point of mercury" isn't padded.
  - A vague question gets the title.
- Phase 9 ✅
  - 20 links, 5 nav, no footnote or self links, all same-origin (400 harvested), and each inline link shows its sentence.
  - The filter found "Lincoln Bedroom" outside the top 20.
  - 2 pages crawled and tagged.
  - A non-page (`action=raw`, text/x-wiki) is listed as failed.
  - Open page and highlight on a crawled page highlighted 5 blocks, re-found from the stored text.
  - Stop kept the 1 page already added.
- Phase 10 ✅
  - "has 4 pages; adding 5 makes 9" is shown, and adding still works.
  - The count turns amber at 9.
- **Found and fixed:** typo correction could lift an off-topic question over the relevance gate ("boiling point" → "bowling paint", 0.207). The gate now scores the question as typed; corrections only add sections.

## Exit criteria
- [x] Decisions 1–4 signed off *(2026-11-07)*
- [x] `npm test` passes, with tests for harvest filtering, scoring and quota allocation (the skill's four cases) and the cap message *(154/154)*
- [x] Combined checks pass *(automated, 2026-11-07; the user's own run is to follow)*

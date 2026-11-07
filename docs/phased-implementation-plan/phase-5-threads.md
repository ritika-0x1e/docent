# Phase 5 — Threads and the full scan-button matrix

Implementation plan for build-sequence step 5 in `docs/master-spec.md` §6: **G1, G2, G3, H3, H4**. It covers thread persistence and the full Start scan matrix from §3.11, still with single-page corpora (linked pages are phase 9). It follows the `thread-data-model` and `scan-button-state-machine` skills.

**Testing:** back to per-phase (spec §6a). This phase is tested on its own at the end (bottom of this doc), and phase 6 doesn't start until that's ticked.

## Scope recap
- **G1.** A `threads` store in the extension's IndexedDB: `{id, title, createdAt, updatedAt, pages: [{url, title, corpusRef, addedAt}], messages: []}`. `messages` stays empty until chat (phase 6).
- **G2.** A thread picker in the panel header: recent threads (title and page count) plus "New thread".
- **G3.** Attachment: Start scan with a thread selected appends this page's corpus, or is a cache hit if the page is already in the thread.
- **H3.** A cache-hit toast, styled differently from a normal scan finishing: "Already scanned. Using saved data."
- **H4.** Selecting a thread lets you search it (the temporary find-sections box, until chat) without scanning the current tab.
- **Not here:** G4 (the soft cap, phase 10), chat and `messages[]` (phase 6), "open page and highlight" for other pages' sections (F2, phase 7).

## Decisions needing sign-off

**Status 2026-11-06: all four approved by the user as proposed. Later the same day the user replaced decision 1: no picker at all.** Threads follow navigation per tab, and the header shows "Continuing <name> · N pages" with ×, a reattach icon only after ×, the name as a heading once the page is in the thread, and nothing for a new thread. Icons have hover labels, and hovering the name lists the thread's pages. Recorded in master-spec §3.11. Decisions 2–4 are unchanged, and Rescan and Delete are icons now.

1. **Which thread is selected.**
   - **Proposed:** the selection belongs to the panel, not the tab. It stays put when you switch tabs, which is how you chain pages: select thread A on page 1, switch to page 2, Start scan, and page 2 joins A. When the panel opens, it preselects the most recent thread that already holds the active page, or "New thread" if none does. The choice is remembered per window in `chrome.storage.session`.
   - **Alternative:** always open on "New thread". That's simpler, but scanning the same page again then makes a second thread and embeds the page again, which is the double work §3.11 is meant to avoid.
2. **Rescan.** Under the matrix, Start scan on a page that's already in the selected thread is a cache hit. Phase 4's "Start scan on a ready tab runs again" goes away. The skill says to flag rescan before adding it.
   - **Proposed:** keep an explicit, smaller **Rescan** button on a cache-hit or ready tab. It reruns the pipeline and replaces that page's corpus in the thread: the new `corpusRef` takes the old one's place and the old corpus is deleted. That's useful when a page has changed.
   - **Alternative:** no rescan. A changed page can only be picked up by starting a new thread.
3. **Deleting threads.** It isn't in G1–G4, but without it, threads and corpora pile up with no way to clear them except the console.
   - **Proposed:** a small "Delete thread" action in the picker, with a confirm. It removes the thread and its corpora.
   - **Alternative:** leave it out until later. The console's `clearCorpora()` / `clearThreads()` stay the only way.
4. **What counts as "the same page"** (`normalizeUrl` in `lib/threads.js`, the one comparison both skills share).
   - **Proposed:** lower-case the scheme and host, drop the `#fragment`, drop a trailing `/` on the path, and remove common tracking parameters (`utm_*`, `fbclid`, `gclid`). Other query parameters are kept, because they often pick the content (`?id=`, `?page=2`). Google Docs URLs reduce to the document id, so `/edit`, `/edit?tab=…` and `/mobilebasic` match. A raw `.md` file and its rendered GitHub page stay different pages, because their sources differ.
   - **Alternative:** compare exact URLs minus the fragment. That's safer, but the same page reached with and without tracking parameters would be scanned twice.

Not a decision: corpora saved in phase 4 belong to no thread. The IndexedDB upgrade (v1 → v2) leaves them in place. `listCorpora()` still shows them and `clearCorpora()` removes them.

## Runtime flow

```
panel opens → load threads (sorted by updatedAt) → preselect (decision 1) → nothing scans
  status line: "Not scanned yet" | "In <thread>: Start scan loads the saved data" | scan stages
  [Start scan]
     no thread selected ("New thread")  → full pipeline → create thread {pages:[this page]}, select it
     thread selected, page not in it    → full pipeline → append page to thread
     thread selected, page already in it → cache hit:
          load the corpus from IndexedDB, re-anchor its blocks in the tab (below), show sections,
          toast "Already scanned. Using saved data." (H3)
  [Rescan] (decision 2)                 → full pipeline → replace this page's corpusRef in the thread
  find box (H4): enabled whenever a thread is selected; searches every page in the thread
```

**Cache-hit re-anchoring.** Live `Range`s exist only in the content script and are lost when the page reloads, so a cache hit asks the tab to rebuild them from the stored text-quote anchors (`reanchor-blocks`, using `lib/text.js` `findQuote` with each anchor's exact text, prefix and suffix). There's no extraction or embedding. Blocks whose text has changed on the page stay unanchored, and their sections fall back to snippet-only. A Google Docs cache hit skips this step, since jump works without ranges.

**Find results from other pages** in the thread show the page title as a badge and are snippet-only. "Open page and highlight" is F2 (phase 7).

## File layout

```
/lib/threads.js              pure: normalizeUrl, findPage, scanAction(thread, url) → "new-thread"|"append"|"cache-hit",
                              withPage / replacePage / thread title helpers
/lib/threads.test.js
/background/store.js         DB v2: + "threads" store; saveThread, getThread, listThreads, deleteThread (+ its corpora)
/background/pipeline.js      runScan unchanged; a thin scanIntoThread(tabId, threadId, opts) wraps it with G3
/background/service-worker.js  panel-threads, panel-cache-hit, panel-delete-thread, panel-find over a thread's corpora
/content/anchor.js           reanchorBlocks(stored blocks) → rebuilds __docentRanges
/content/bootstrap.js        + "reanchor-blocks" handler
/lib/panel-state.js          + selectedThreadId, threads list, cache-hit status/toast, rescan
/sidepanel/*                 thread picker, toast, Rescan, page badges on find results
```

> **As implemented (2026-11-06):**
> - The store functions are `saveThread`, `getThread`, `listStoredThreads` and `deleteThread`, in `background/store.js`. The console has `listThreads()` and `clearThreads()`, and `clearCorpora()` now clears threads too.
> - `scanIntoThread` and `loadSavedScan` are in `background/pipeline.js`. `runScan` is unchanged; only its injection step was split out as `ensureInjected`, which the cache hit reuses. A Google Docs cache hit still injects the content script, because Jump needs it.
> - If a thread's corpus is missing (e.g. after `clearCorpora()`), the cache hit falls through to a full scan into the same place in the thread.
> - In the reducer, each tab remembers the selection its scan started with (`scanFrom`). A New thread scan then selects the thread it made, but only if the user hasn't picked another thread in the meantime.
> - The picker's options are rebuilt only when the list or the selection changes: replacing them closes an open dropdown, and the panel re-renders on every B3 batch.
> - Fixed during the run: Docs URLs with a signed-in account prefix (`/document/u/1/d/…`) now normalize too.

## Checks for phase 5 (run at the end)

Unit (`npm test`): `normalizeUrl` cases (fragment, trailing slash, tracking parameters, Docs ids, kept query parameters), `scanAction` for all three matrix rows, and the reducer's new events.

Manual or Playwright, on varied pages (not only Wikipedia and paulgraham.com):

**Run 2026-11-06, automated** (Playwright, with the panel page opened as a background tab against the scratchpad test copy, which grants all sites). Pages: MDN "CSS Custom Highlight API", paulgraham.com "Do Things that Don't Scale", example.com, a public Google Doc, MDN "Range" and `chrome://extensions`. The profile still had phase-4 corpora in a v1 database, so the v1 → v2 upgrade ran too. **All 10 pass:**
- 1 ✅ New thread: 14 sections, thread named after the page, picker shows "(1 page)".
- 2 ✅ The selection stayed after switching tabs, and the second page made the thread "(2 pages)".
- 3 ✅ After a reload: "Saved in …", then the toast, the log line "re-anchored 40/40 blocks, nothing embedded", no new corpus, and Show on page highlighted the right text on 4 of 4 cards tried.
- 4 ✅ After a browser restart, the thread is still there and preselected for its page.
- 5 ✅ On example.com, unscanned, the find box searched both pages. A startup question returned the essay's sections with its page badge; a DOM question returned MDN's. The tab stayed unscanned.
- 6 ✅ Rescan gave page 1 a new corpus in the same position, and the old one was deleted.
- 7 ✅ Delete asked for a confirm, then removed the thread and its corpora and kept the other thread.
- 8 ✅ `?utm_source=…#examples` was a cache hit. The Doc at `/mobilebasic` showed "Saved in …" for its `/edit` scan.
- 9 ✅ Phase 4 behaviour: example.com showed the A3 banner, and Force scan made a thread; `chrome://extensions` showed the A4 message; Generate with nothing set showed the settings banner; a Docs cache hit followed by Jump returned ok; highlights cleared when the panel closed (9 ranges, then 0).
- 10 ✅ `manifest.json` is unchanged.

Not covered by the run: the real side panel UI (it ran as a tab), and the no-access prompt (the test copy grants all sites).

**Rerun after the no-picker redesign (2026-11-06/07, automated, `t5c.mjs`).** This run checks what's drawn on screen, not just the `hidden` flag. All pass:
- New thread: nothing shown. After the scan, the name heading with "1 page", Rescan and delete.
- A tab opened by `window.open` from the thread tab shows "Continuing", with × and the page count, and the find box searches the thread before scanning. Scanning makes "2 pages".
- Following a link to another site in the same tab continues the thread. × leaves only reattach, and reattach continues again. × then Start scan makes a new thread.
- A blank new tab shows nothing. (Before the fix, an opener set by Chrome made it continue the thread; inheritance is now decided on the first load.)
- A cache hit after a reload, and after a browser restart a revisited page (with `utm_`/`#`) links back to its thread, then a cache hit. The Rescan icon replaces the corpus, and delete asks for a second click to confirm.
- Hovering the name lists "1. White House, 2. Pennsylvania Avenue, → Washington, D.C. (this page, not scanned yet)", with "2 pages" while continuing and 3 after the scan.

Bug found by the user in the real panel: the icon buttons' `display: inline-flex` overrode the `hidden` attribute, so reattach and Rescan showed when they shouldn't. Fixed with a global `[hidden] { display: none !important }`.

UI follow-ups from the user's review (2026-11-07):
- **Thread trail card.** Hovering the thread name (or focusing it with the keyboard) opens a card instead of the browser tooltip. It shows **the path to this page**: the thread's pages in the order they joined, up to and including the current page, as dots joined by arrows. Pages that joined after it aren't shown (user, 2026-11-07). The current page is highlighted. While continuing, the unscanned current page hangs off the end on a dashed arrow, marked "not scanned yet". Only scanned pages are listed (user's choice); pages passed through without scanning aren't recorded.
- **Thin scrollbars** across the panel (`scrollbar-width: thin`, in the panel's border colour).
1. With "New thread" selected, Start scan creates a thread named after the page, and the picker shows it with 1 page.
2. With that thread selected, switch to a second page and Start scan. The thread now has 2 pages.
3. Back on page 1, Start scan is a cache hit: the toast shows, nothing is embedded (check the service-worker log), and Show on page still highlights the right text after a page reload.
4. Close and reopen the panel, and restart the browser: threads and their pages are still there, and page 1 preselects its thread.
5. H4: on an unrelated tab, select the thread and search. Results come from both pages, with page badges, and nothing scans.
6. Rescan (if approved) replaces the page's corpus. `listCorpora()` shows the old one gone.
7. Delete thread (if approved) removes it and its corpora.
8. The same page reached with `#section` or `?utm_source=` is a cache hit. A Google Doc opened at `/edit` and at `/mobilebasic` is too.
9. Phase 4 behaviour still works: A3, A4, no-access, Generate headings & summaries, and highlights clearing on panel close.
10. Manifest: no new permissions.

## Exit criteria for phase 5
- [x] Decisions 1–4 signed off *(2026-11-06, all as proposed)*
- [x] `npm test` passes, including `lib/threads.test.js`
- [x] Checks 1–10 pass *(2026-11-06, automated; see above)*
- [x] `thread-data-model` / `scan-button-state-machine` skills updated (`updatedAt`, `normalizeUrl`, Rescan)

## Build order inside the phase
1. `lib/threads.js` + tests
2. Store v2 (threads), then `scanIntoThread` and the cache hit with re-anchoring
3. Panel: picker, toast, Rescan, H4 find over the thread
4. Run the checks, then record the results here

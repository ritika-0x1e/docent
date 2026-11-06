# Phase 4 — Side panel shell (single page, no threads)

Implementation plan for build-sequence step 4 in `docs/master-spec.md` §6: **H1, H2 (partial), I1, I2**, a side panel with a scan button wired to A + B + C for a single page, no threads yet. Follows the `scan-button-state-machine` skill for the parts that exist without threads. Replaces the Phase A–C toolbar harness.

**Testing strategy (approved 2026-11-02):** this phase ends with the **combined test run for B + C + 4** (bottom of this doc). Only checkpoint CP-4-1 gets tested before that. See master-spec §6a.

## Scope recap
- **I1.** `chrome.sidePanel` setup: the toolbar icon opens the panel; the panel holds a reading view and a chat area.
- **I2.** Reading view: sections with headings (HTML or generated) and summaries.
- **H1 (partial).** Initial state: the current tab's title + "not scanned yet" + **Start scan**, with nothing running on open. The thread picker is G2 (phase 5), so it isn't here.
- **H2 (partial).** Only the "no thread selected" row of the matrix: Start scan always runs the full pipeline. The cache-hit and append-to-thread rows come in phase 5.
- Also lands here because it was deferred to the side panel:
  - the A3 banner with **Force scan anyway**
  - the A4 "site restricts access" message
  - the Gemini API key setting (Phase B, B3)

## Decisions

Status as of 2026-11-03: decision 1 is **deferred** until CP-4-1 runs; if it fails, stop and ask the user to pick (a) or (b). Decision 2 is **approved** and recorded in master-spec §6.

1. **What happens when you scan a tab you switched to (only decided if CP-4-1 fails).** `activeTab` grants access to a tab when you click the toolbar icon on it. It's unclear whether a click *inside the side panel* grants access to a tab you switched to after opening the panel. If it doesn't, Start scan on that tab fails. Two options, to choose if the checkpoint fails:
   - **(a) Ask per site (recommended).** On Start scan, if the extension lacks access, call `chrome.permissions.request` for that one origin, with Chrome's own prompt. This is the same per-origin optional-permission pattern §7.1 already approves for D6. It adds `optional_host_permissions` to the manifest, but never a standing grant.
   - **(b) No new permissions.** The panel shows "Click the Summarizer icon on this tab to allow scanning". That works because clicking the icon grants `activeTab`, but you have to remember an extra click on every new tab.

   Either way, A4's "site restricts access" message must stop covering this case. "No permission yet" (fixable) and "site blocks extensions" (not fixable) become separate messages.
2. **A temporary "find sections" box in the chat area, until I3 (phase 6).** Chat itself is phase 6, but the chat area exists now and C's retrieval otherwise has no UI. Proposal: a search box that shows the top-5 retrieved sections with scores, where clicking one highlights it on the page through Phase B's debug highlight. That turns the combined run into a real check of A → B → C → panel. It's deleted when I3 lands. Without it, retrieval stays testable only from the console.

## Runtime flow

```
toolbar click → side panel opens (setPanelBehavior openPanelOnActionClick), nothing runs
  panel: shows active tab title + "not scanned yet" + [Start scan]   (H1)
  [Start scan] → panel opens a port to background: {start, tabId, force:false}
     background pipeline (moved out of the harness into background/pipeline.js):
       A: inject + handshake + extract + classify
           ├─ blocked   → port: {stage:"blocked", reason}            → panel: restricts-access message
           ├─ sparse    → port: {stage:"needs-force", classifyResult} → panel: A3 banner + [Force scan anyway]
           └─ ok
       B: blocks + anchoring → B1 | B2       → port: {stage:"sectioned", sections}  (fallback headings)
       B3 ∥ C1 chunk embedding               → port: {stage:"summaries", batch} as each batch lands
       C2: save corpus                       → port: {stage:"done", corpusId}
       any throw                             → port: {stage:"error", message}
  panel renders progressively: sections show at "sectioned", summaries fill in as batches arrive
```

The background keeps running the pipeline if the panel closes mid-scan, and the corpus still gets saved. The panel just stops receiving progress.

## File layout

```
/manifest.json                   + "side_panel": {"default_path": "sidepanel/index.html"}; action title updated
/background/pipeline.js          runScan(tabId, {force, llm}, onProgress): A→B→C, extracted from the harness
/background/service-worker.js    setPanelBehavior; port routing; message handlers (getCorpus, retrieve*); harness onClicked removed
/sidepanel/index.html            layout: header (tab title, status, Start scan, ⚙) / reading view / chat area
/sidepanel/panel.js              tab tracking, port handling, state → DOM
/sidepanel/render.js             reading-view + banner rendering (textContent only, never innerHTML)
/sidepanel/panel.css             light + dark (prefers-color-scheme)
/lib/panel-state.js              pure reducer: (state, event) → state; phase-5 rows extend it later
/lib/panel-state.test.js
```

`* retrieve` is only needed if decision 2 is approved.

## H1/H2 — Panel state

`lib/panel-state.js` is a pure reducer, unit-tested and DOM-free per CLAUDE.md's "pure logic before UI". States:

```
idle (not scanned) ─Start scan─► scanning(stage) ─┬─► ready(sections, summaries, corpusId)
        ▲                                         ├─► needs-force(classifyResult) ─Force scan─► scanning
        │                                         ├─► blocked(reason)
        └──── tab switch / navigation ────────────┴─► error(message)
```

- **Which tab:** the panel follows the active tab of its own window, using `chrome.tabs.query({active, currentWindow})` plus `tabs.onActivated` and `tabs.onUpdated` (on a URL change).
- **Per-tab memory, while the panel is open:** an in-memory map `tabId → {url, state}`, so switching away and back shows that tab's sections again. If the tab navigated to a new URL, its entry resets to `idle`. Closing the panel forgets everything. Surviving a panel close is a cache hit backed by stored corpora, which is phase 5 (H2/G3), so it isn't built here.
> **As implemented (2026-11-03, build steps 1–2):**
> - The icon opens the panel from `chrome.action.onClicked` → `chrome.sidePanel.open()`, not `setPanelBehavior({openPanelOnActionClick})`. CP-4-1's first run showed that the latter doesn't grant `activeTab`, so even the tab where the icon was clicked failed to scan.
> - Each Start scan gets a `scanId`. Progress from a scan that was replaced or cut off by a navigation is ignored.
> - Without the `tabs` permission, Chrome hides `tab.title`/`tab.url`, and `changeInfo.url`, for tabs the extension has no access to. So the header falls back to "This tab", and a navigation is detected from `changeInfo.status === "loading"` (reloads count too). Whether that's acceptable is part of what CP-4-1 shows.

> **As implemented (2026-11-03, build steps 3–5):**
> - B3 reports each batch (`labelSections(…, {onBatch})` sends a `"summaries"` progress message), and the reducer merges it into the cards by section id.
> - Each reading-view card also gets a **Show on page** button (or **Jump to section** on Google Docs; none when snippet-only). It's the same action as clicking a find-sections result, so combined-run item 9 can be checked from the cards. This is the only addition beyond the plan. The buttons appear only once the scan is `ready`, because they read the saved scan.
> - Find-sections snippets are the hit's best-matching chunk, not the start of the section.
> - **Added 2026-11-05 (combined run, approved by the user): "Retry headings".** Gemini returned 429 (free-tier quota) on a 29-section page. The B3 banners (no key / some failed) now have a **Retry headings** button. It reruns B3 only on the saved scan's sections that have no summary yet (`sectionsToRelabel` / `mergeRelabelled` in `lib/section-prompt.js`), then updates IndexedDB (`updateSections`) and session storage in place. There's no re-extraction and no re-embedding, since chunk vectors never depend on generated headings. In the same change, the B3 batch size went from 8 to 30 (see the Phase B plan).
> - **Changed 2026-11-05 (combined run, approved by the user): B3 on demand, Flash-Lite, Ollama.** The free tier allows only 20 requests a day on Flash. "Retry headings" became the row's **Generate headings & summaries** button, shown on a ready tab while any section lacks a summary. Batches stream in through `relabel-progress` messages, and the row then names the model used. ⚙ gained a provider choice and an Ollama model field. Scan stages lose "labelling", and gain "embedding". See master-spec §3.2 / §3.6.
> - **Added 2026-11-05 (combined run, user request): a Stop button while generating**, for Gemini and Ollama alike. The background keeps one `AbortController` per tab (`panel-stop-relabel`). Aborting cancels the fetch, which makes Ollama drop the job, and also cancels a pending Gemini retry wait. Batches that already finished are saved, and Generate then offers "Generate the remaining N".
> - **Added 2026-11-05 (combined run, user request): highlights clear when the panel closes.** Each panel holds a `panel:<windowId>` port. When it disconnects, the background sends `clear-highlight` to every tab it highlighted in that window. Those tabs are recorded in `chrome.storage.session.highlightedTabs`, which survives a service-worker restart.
> - The panel talks to the background with `panel-show-section` / `panel-find` runtime messages. These are temporary and go away with I3.

- **Pressing Start scan on a tab that's already `ready` runs the pipeline again.** That's the matrix's "no thread → run full pipeline" row, not a new rescan feature. Phase 5 turns it into a cache hit when a thread is selected.

## I1/I2 — Layout & reading view

- **Header:** tab title, status line (stage text while scanning, e.g. "Embedding 42 chunks…"), **Start scan**, and ⚙ settings.
- **Reading view** (scrollable, top): one card per section.
  - It shows the heading, headed by its `headingPath` breadcrumb when there is one. Generated headings are marked subtly (e.g. a small "auto" tag) so they aren't mistaken for the page's own, and fallback headings are shown in muted text.
  - Below the heading are the one-line summary (or "no summary" if B3 was skipped or failed) and a collapsible full text (`<details>`).
- **Chat area** (bottom): either decision 2's "find sections" box or a placeholder reading "Chat arrives in phase 6".
- **Banners:**
  - A3: "Not enough text detected on this page" + **Force scan anyway**, which re-sends `{start, force:true}`.
  - A4: "This site restricts extension access".
  - B3: "No Gemini key set — headings/summaries skipped" with a link to ⚙.
- **Settings ⚙:** a Gemini API key field (password input), saved to `chrome.storage.local.geminiApiKey`. That's the same key Phase B's `setGeminiKey` writes.
- **Safety:** all page-derived text is rendered with `textContent`. Page content is untrusted, and the panel runs with extension privileges.

## Harness changes

- The `chrome.action.onClicked` harness is removed, as planned in Phase A: `openPanelOnActionClick` would take over the click anyway.
- The console helpers are **kept** for debugging until their real replacements exist: `scan`, `forceScan`, `highlightSection`, `clearHighlight`, `query`, `listCorpora`, `clearCorpora`, `setGeminiKey`, `embed`.

## Checkpoints: test these before building the rest of phase 4

- [x] **CP-4-1: scanning a tab you switched to, right after the I1 shell + Start scan wiring exist.**
  1. Open the panel from the toolbar on tab 1 and Start scan. Expected: it works.
  2. Switch to tab 2, a normal article, without clicking the icon, and Start scan.
  3. Pass: tab 2 scans. Fail: tab 2 reports an access error. Then pick option (a) or (b) from decision 1 before going on.

  *Result 2026-11-03: **failed at step 2.** Step 1 passed once the icon opened the panel through `onClicked` (Wikipedia: real title, 15 sections). Tab 2 (paulgraham.com, no icon click) got `injection-rejected: Cannot access contents of the page`. The user also asked whether access could be on by default. That adds options "all sites from the start" (`host_permissions: <all_urls>`) and "ask once for all sites" (optional `<all_urls>`, requested once), both of which mean relaxing the CLAUDE.md / §7.1 rule against broad host access before phase 9. **Decided: ask once for all sites** (recorded in master-spec §7.1).*

  *Retest 2026-11-03: **passed.** The icon-click tab scans with no prompt. On a switched-to tab, Start scan shows Chrome's all-sites prompt once, then scans. Embedding took about 10 s, and speed is logged as a follow-up in master-spec §8.*

  *Why now:* if this fails, the scan flow, error messages and possibly the manifest change, and building the rest of the panel first would mean redoing it.

## Combined test run: phases B + A5 + C + 4

Run after phase 4 is built. Tick the matching exit criteria in each phase doc as you go. Use the same pages as before: the headed docs page, the "Subheadings" blog, two Paul Graham essays, the Git-questions SPA article, YouTube (sparse) and `chrome://extensions`.

**Panel & flow (phase 4)**
1. ✅ The toolbar click opens the panel, and nothing scans until Start scan. *(Passed 2026-11-03.)*
2. ✅ Headed docs page: progress stages show, sections appear, then summaries fill in. *(Passed 2026-11-03 on Wikipedia "History of cricket to 1725". Stages and progressive cards worked. Gemini returned 503 "high demand" for both batches; the scan still finished and the B3 warning banner showed. B3 now retries once on 503 as well as 429. Summary quality is checked in item 10.)*
3. ✅ YouTube: A3 banner, then **Force scan anyway** runs. *(Passed 2026-11-03 on a video page: banner shown, and the forced scan gave 2–3 sections. The YouTube **home page** got no banner: its list of video titles clears the 175-word minimum. The user wants listing pages like that treated as "not enough content". **Fixed the same day** with the A2 link-density rule (master-spec §3.1). On recheck, the home page shows the "list of links" banner and force scan works, while Wikipedia still scans with no banner.)*
4. ✅ `chrome://extensions`: the restricts-access message. *(Passed 2026-11-03.)*
5. ✅ Switching tabs shows the other tab's state; switching back shows the earlier sections; navigating resets to "not scanned". *(Passed 2026-11-05. Also confirms the fix for "Full text" sections closing during a scan: each B3 batch re-rendered the cards, and open sections and scroll position are now kept.)*
6. ✅ Closing the panel mid-scan, then calling `listCorpora()`, shows the corpus was still saved. *(Passed 2026-11-05.)*

**Sectioning (Phase B)**

7. ✅ Headed pages: sections match the visible headings, including the breadcrumbs. *(Passed 2026-11-05 on "White House" and "History of cricket to 1725", after two Wikipedia fixes: headings inside `<p>` were unwrapped, and "[edit]" links removed (Phase B plan). The user then decided to drop back-matter sections (Notes, References, External links, …; Phase B plan, B1) and to keep the infobox as text, so the intro card's fallback heading can still come from the infobox caption.)*
8. ✅ Paul Graham essays: semantic sections with a plausible count (~10–30 for "How to Do Great Work") and breaks at real topic shifts. Tune `SIMILARITY_THRESHOLD` here if needed. *(2026-11-06: tuning on these two essays alone overfit, so the threshold is now set per page and was checked on 12 varied headingless pages; see the Phase B plan. Passed 2026-11-06, checked by the user after the change.)*
9. ✅ Anchoring: on 3+ sections per page, clicking a find-sections result (or calling `highlightSection`) highlights exactly the right text. The anchoring rate is ≥ 90%. *(Passed 2026-11-06, automated with Playwright: Playwright's Chromium loading a scratch copy of the extension whose manifest grants all sites, since a test browser can't click the permission prompt. It scanned each page, called `highlightSection` on **every** section, and compared each highlight range's drawn text with its block. 10 pages: en Wikipedia White House and Git, de Wikipedia Kaffee, MDN, a GitHub README, NPR text news, danluu, Sam Altman, Paul Graham, and Lincoln's second inaugural (old table layout). Anchoring 99.0–100% on every page; 204/204 sections highlighted exactly; the first highlighted line was on screen after the scroll every time. The only misses at first were MediaWiki's inline `<style>` tags inside a range, which `Range.toString()` includes but the browser never draws, so the check now ignores `<style>`/`<script>` text.)*
10. ✅ B3 (on demand since 2026-11-05): after a scan, **Generate headings & summaries** fills cards in batch by batch with sensible headings and summaries, and the row names the model used. With neither a key nor an Ollama model set, the settings banner appears and fallback headings stay, with no crash. With an Ollama model set and Gemini's quota exhausted (or "Ollama only"), it generates through Ollama. *(Passed 2026-11-06, automated with Playwright: Playwright's Chromium loading a scratch copy of the extension whose manifest grants all sites, with the real side-panel page opened in a tab beside the article (in that copy only, the background's "ignore messages from tabs" gate also accepts extension pages), on Lincoln's second inaugural: (a) no key or model: the "No Gemini key or local model set" banner, fallback headings kept, no crash; (b) Stop pressed mid-run: back in about 1 s with "Stopped; finished sections were kept."; (c) Ollama only (`qwen2.5:1.5b`): 3/3 sections in 42 s with "auto" headings, and the row says "Generated with local Ollama"; (d) Gemini selected with a deliberately invalid key: fell back, "Generated with local Ollama (Gemini failed)", 3/3. Gemini itself was seen working earlier in the run ("Generated with Gemini Flash-Lite"). Fixed on the way: after a Stop before the first batch, the row no longer names a model. Quality note: qwen 1.5b writes sentence-long headings, ignoring the 8-word limit; Gemini doesn't.)*

**Retrieval (Phase C)**

11. ✅ Repeat CP-C1's three question types on a headingless essay, via the find-sections box or `query()`. *(Run 2026-11-06, automated, on "How to Do Great Work", with questions paraphrased rather than quoted. Early question (motives): rank 1. Deep inside the longest section (few great colleagues vs many decent ones): rank 1, and the find box showed it and highlighted the right section. **Late question (exercise/sleep and morale, section 33): missed the top 3 in 2 of 3 phrasings** (ranks 4, 2, and outside the top 5). Cause: 180-word chunks mix several ideas, and MiniLM's averaged vector matches a short, specific question weakly. Not tuned to pass: that would be chunk-size tuning on one question. 2026-11-06: the user accepted this as a known limitation for MVP; phase 6 chat passes the top 5 to the LLM, which covers 2 of the 3 phrasings, and a stronger embedding model is on the §8 follow-up list.)*
12. ✅ Reload the extension, then reopen the panel: corpora persist, as `listCorpora()` shows. *(Passed 2026-11-06, automated. Playwright can't re-enable an extension after `chrome.runtime.reload()`, so the browser was closed and relaunched on the same profile instead, a stricter case: "How to Do Great Work: 37 sections, 79 chunks" before and after, and retrieval on the stored corpus still returned the right section first.)*

**Special sources (A5)**

13. ✅ Google Doc: sections match the doc's headings, the word count is realistic (not just the outline), and there's no highlight. In the find-sections box, clicking a result shows the snippet and runs **Jump to section**, which scrolls the doc to that heading. *(Passed 2026-11-06, automated, on two public docs. "Some readings & notes on how to do high-quality, efficient research": 6 sections = intro + its 5 headings, 1,584 words (the export's 1,997 also counts comments). A school "Docs & Drive 8.1" guide: 35 sections = 42 headings − 8 parent headings with no text of their own (in breadcrumbs instead) + intro; 8,036 of the export's 8,130 words. No highlight anchors. The find box's top hit offered **Jump to section**, and the jump scrolled the Docs editor (scrollTop 0 → 117 and 0 → 1,333). One first attempt hung at "scanning" on a reused profile; it didn't reproduce in three reruns, so most likely Docs loaded slowly in the automated browser.)*
14. ✅ Google Doc with no headings, or the intro section: snippet only, no jump button. *(Passed 2026-11-06, automated: the intro card has no action, its find-box result reads "Snippet only" with no buttons, and `jumpTo` on it refuses.)*
15. ✅ Raw `.md` file (e.g. a `raw.githubusercontent.com` README): splits on `#` headings, and clicking a find-sections result highlights the right lines. *(Passed 2026-11-06, automated: the raw READMEs of mozilla/readability (10 sections) and nodejs/node (22) were detected as Markdown, split on `#` headings, 100% anchored, and every section's highlight matched its source lines.)*
16. ✅ Rendered GitHub README: works through the normal path, with highlights. *(Passed 2026-11-06, automated: the same two repos on github.com went through the normal path with the same section counts as their raw files (10, 22), 100% anchored, all highlights exact.)*

**Housekeeping**

17. ✅ `manifest.json` contains only the approved permissions: `activeTab`, `scripting`, `sidePanel`, `storage`, `offscreen`, the wasm CSP, `optional_host_permissions` for `http(s)://*/*` (CP-4-1), and, for E5, `declarativeNetRequestWithHostAccess` + `host_permissions: ["http://localhost:11434/*"]`. No other static host permissions. *(Passed 2026-11-06: `permissions` are exactly `activeTab, scripting, sidePanel, storage, offscreen, declarativeNetRequestWithHostAccess`; `host_permissions` only `http://localhost:11434/*`; `optional_host_permissions` `http://*/*, https://*/*`; CSP `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.)*
18. ✅ `npm test` passes for everything. *(Passed 2026-11-06: 93/93.)*

## Exit criteria for phase 4

- [x] `lib/panel-state.js` unit tests pass
- [x] CP-4-1 passes (or its chosen fallback works)
- [x] Combined test run items 1–6 pass
- [x] Phase B, A5 and Phase C exit criteria all ticked via the combined run *(C's headingless retrieval accepted with a known limitation, item 11)*

## Build order inside the phase

1. `lib/panel-state.js` + tests.
2. `background/pipeline.js` (move the harness logic over unchanged), manifest `side_panel`, `setPanelBehavior`, and a bare panel with Start scan → port → status text. **Run CP-4-1.**
3. Reading view + progressive rendering.
4. Banners (A3 / A4 / B3) + settings ⚙.
5. Chat area: the find-sections box (if decision 2 is approved) or the placeholder.
6. **Combined test run.**

After the combined run passes, go back to per-phase testing (master-spec §6a). Next is phase 5: threads, G1–G3, H3, H4 and the rest of H2.

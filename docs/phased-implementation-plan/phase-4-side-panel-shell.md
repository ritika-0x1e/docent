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

- [ ] **CP-4-1: scanning a tab you switched to, right after the I1 shell + Start scan wiring exist.**
  1. Open the panel from the toolbar on tab 1 and Start scan. Expected: it works.
  2. Switch to tab 2, a normal article, without clicking the icon, and Start scan.
  3. Pass: tab 2 scans. Fail: tab 2 reports an access error. Then pick option (a) or (b) from decision 1 before going on.

  *Why now:* if this fails, the scan flow, error messages and possibly the manifest change, and building the rest of the panel first would mean redoing it.

## Combined test run: phases B + A5 + C + 4

Run after phase 4 is built. Tick the matching exit criteria in each phase doc as you go. Use the same pages as before: the headed docs page, the "Subheadings" blog, two Paul Graham essays, the Git-questions SPA article, YouTube (sparse) and `chrome://extensions`.

**Panel & flow (phase 4)**
1. The toolbar click opens the panel, and nothing scans until Start scan.
2. Headed docs page: progress stages show, sections appear, then summaries fill in.
3. YouTube: A3 banner, then **Force scan anyway** runs.
4. `chrome://extensions`: the restricts-access message.
5. Switching tabs shows the other tab's state; switching back shows the earlier sections; navigating resets to "not scanned".
6. Closing the panel mid-scan, then calling `listCorpora()`, shows the corpus was still saved.

**Sectioning (Phase B)**

7. Headed pages: sections match the visible headings, including the breadcrumbs.
8. Paul Graham essays: semantic sections with a plausible count (~10–30 for "How to Do Great Work") and breaks at real topic shifts. Tune `SIMILARITY_THRESHOLD` here if needed.
9. Anchoring: on 3+ sections per page, clicking a find-sections result (or calling `highlightSection`) highlights exactly the right text. The anchoring rate is ≥ 90%.
10. B3: headings and summaries are sensible. With the key cleared, the B3 banner and fallback headings appear, with no crash.

**Retrieval (Phase C)**

11. Repeat CP-C1's three question types on a headingless essay, via the find-sections box or `query()`.
12. Reload the extension, then reopen the panel: corpora persist, as `listCorpora()` shows.

**Special sources (A5)**

13. Google Doc: sections match the doc's headings, the word count is realistic (not just the outline), and there's no highlight. In the find-sections box, clicking a result shows the snippet and runs **Jump to section**, which scrolls the doc to that heading.
14. Google Doc with no headings, or the intro section: snippet only, no jump button.
15. Raw `.md` file (e.g. a `raw.githubusercontent.com` README): splits on `#` headings, and clicking a find-sections result highlights the right lines.
16. Rendered GitHub README: works through the normal path, with highlights.

**Housekeeping**

17. `manifest.json` contains only the approved permissions: `activeTab`, `scripting`, `sidePanel`, `storage`, `offscreen`, the wasm CSP, plus anything decision 1(a) or the Gemini CORS fallback added. No broad host permissions.
18. `npm test` passes for everything.

## Exit criteria for phase 4

- [ ] `lib/panel-state.js` unit tests pass
- [ ] CP-4-1 passes (or its chosen fallback works)
- [ ] Combined test run items 1–6 pass
- [ ] Phase B, A5 and Phase C exit criteria all ticked via the combined run

## Build order inside the phase

1. `lib/panel-state.js` + tests.
2. `background/pipeline.js` (move the harness logic over unchanged), manifest `side_panel`, `setPanelBehavior`, and a bare panel with Start scan → port → status text. **Run CP-4-1.**
3. Reading view + progressive rendering.
4. Banners (A3 / A4 / B3) + settings ⚙.
5. Chat area: the find-sections box (if decision 2 is approved) or the placeholder.
6. **Combined test run.**

After the combined run passes, go back to per-phase testing (master-spec §6a). Next is phase 5: threads, G1–G3, H3, H4 and the rest of H2.

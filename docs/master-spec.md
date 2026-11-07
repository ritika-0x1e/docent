# Summarizer — Master Spec

Source of truth for ideation, architecture, decisions, and implementation order. Each sub-feature below is meant to be built and tested independently before wiring into the next.

---

## 1. Core idea

A Chrome extension that sits alongside any tab (via `chrome.sidePanel`, half-screen split) and:

- Detects whether the current tab is mostly text (vs. media-heavy) and skips gracefully if not, with a manual override
- Parses the page into sections — using existing HTML headings when present, or semantic (embedding-based) chunking when not
- Auto-generates a heading + short summary for sections that lack one
- Runs a scoped RAG chatbot that answers only from the current page's content (plus optionally linked pages you approve, plus optional web search)
- Cites answers by highlighting the exact source text on the live page (CSS Custom Highlight API — non-destructive, no DOM mutation)
- Lets you select text on the page to get a detailed answer scoped to just that selection
- Falls back to web search (redirect-only, no scraping) when the page doesn't have the answer
- Persists conversations as threads, so research done on page 1 can be reattached when you land on page 2 (e.g. via a search result or an inline/nav link you approved), without needing the agent to autonomously crawl the web

**Objective**: when reading an article or docs page, you shouldn't have to comb through all the content to find your answer — the chatbot points you to (or answers from) the relevant section directly.

**Constraint**: free-first stack, lightweight enough to run in-browser without a heavy backend.

---

## 2. High-level architecture

```
Content script (per tab)
  → extract + classify (text vs media)
  → sectioning (headings or semantic chunking)
  → link harvesting (inline vs nav)
        ↓
Background service worker
  → embeddings (Transformers.js, local, in a Web Worker hosted by an offscreen document — see §7.1)
  → vector store (IndexedDB, cosine similarity)
  → chat: retrieve top-k, then one LLM call (§3.7); web_search from phase 8
  → LLM calls (Gemini free tier: Flash-Lite for headings/summaries, the Flash model ladder for chat; local Ollama as fallback or alternative, §3.6)
        ↓
Side panel UI (chrome.sidePanel)
  → thread/chat management
  → picklist for approving crawl candidates
  → citation rendering (page badge + live highlight via CSS Custom Highlight API)
```

No dedicated backend server is required for v1. A Cloudflare Workers free-tier proxy is an optional later addition only if API keys need to be hidden from a distributed build.

---

## 3. Key design decisions (with rationale, in discussion order)

### 3.1 Extraction & classification
- Use **Readability.js** to strip boilerplate and get the main content node — solves most of the "what is actually the article" problem for free.
- Classify text-heavy vs. media-heavy by comparing extracted text length against media pixel area.
- If text is too sparse (~<150–200 words) and the page is media-dominated: **don't silently proceed** — show a banner ("not enough text detected") with a **force-scan** override button. However small the text, the user can still force it through.
- **Listing pages count as "not enough content" too** (decided 2026-11-03, combined run). Some pages clear the word floor only with link text: the YouTube home page, search results, front pages. If more than 50% of the extracted words are inside links, the page is classed `link-list` and gets the same banner + force-scan override ("This looks like a list of links rather than an article"). Raising the word floor instead was rejected: it would block real short articles.
- If the content script can't attach at all (strict CSP, Trusted Types, permission-blocked sites) — detect this and clearly say "this site restricts extension access," never fail silently.

### 3.1a Special sources: Google Docs & raw Markdown (decided 2026-11-03, sub-feature A5)
- **Google Docs** draws its body on a canvas, so the page's HTML only holds the sidebar outline. Instead of Readability, the content script fetches Docs' own HTML export (`/document/d/<id>/export?format=html`). It's same-origin, so it uses the user's login, needs no new permissions, and needs no Google API/OAuth. The export's real headings feed B1 directly. If the export fails (e.g. the owner disabled downloading), show a dedicated "couldn't read this Google Doc" message, distinct from A4.
- **Citations for Google Docs:** no live highlight is possible. Show a **snippet** (quoted text + heading) and a **Jump to section** action that clicks that heading's entry in the live doc's **outline sidebar**, which scrolls the doc there. (Changed 2026-11-03 during CP-A5-1: the export has no heading ids and outline clicks don't expose one, so `#heading=` URLs aren't possible. The approved behaviour is unchanged.)
- **Raw Markdown files** (shown by Chrome as plain text): parse `#`/setext headings, paragraphs, lists and code fences into blocks with a small built-in parser. The text is real DOM text, so anchoring and **live highlighting work as on normal pages**.
- **Rendered Markdown** (GitHub/GitLab views, docs sites) is ordinary HTML and uses the normal path.
- Plan: `docs/phased-implementation-plan/phase-A5-special-sources.md`.

### 3.2 Sectioning
- **Structured case**: split on existing `h1–h4`, and keep each section's location for later highlighting. (Readability renames `h1` to `h2` in its output, so in practice this is `h2`–`h4`.)
- **Section location = per-block text-quote anchors, not one `Range`** (decided in Phase B planning, 2026-11-02). Each paragraph-level block in a section stores `{exact, prefix, suffix}`. Live `Range`s are rebuilt from these anchors inside the content script and never stored. A single heading-to-heading `Range` would also highlight the boilerplate Readability stripped between paragraphs. A `Range` also can't be messaged out of the content script or persisted, and F3 has to re-highlight a page after reload. The CSS Custom Highlight API accepts multiple ranges per highlight, so §3.8 is unaffected.
- **Unstructured case**: no LLM needed to find boundaries. Embed paragraphs, walk sequentially, and break into a new section when cosine similarity to the running section centroid drops below a threshold (classic semantic-breakpoint chunking). The threshold is set per page from that page's own similarity profile (mean − 0.5 × sd; decided 2026-11-06), because a fixed value didn't carry across kinds of writing.
- Only call the LLM **after** boundaries are fixed, to generate a heading + 1-line summary per section — keeps LLM usage cheap and deferred.
- **Back-matter sections are dropped** (decided 2026-11-05, combined run test 7). Sections whose own heading, or any parent heading, is exactly References / Notes / Footnotes / Citations / Sources / Works cited / Bibliography / Further reading / External links (case-insensitive) don't become sections. They stay on the page, but aren't in the reading view or retrieval. Citation lists are long (about 4k words on Wikipedia's "White House") and only add noise. "See also" is kept. Not decided: Wikipedia infoboxes stay in the intro section for now (the user chose not to drop them).
- **On demand since 2026-11-05:** a scan never calls the LLM. Sections show fallback headings until the user presses **Generate headings & summaries** in the panel. That reruns only B3 on the saved scan (no re-extraction, no re-embedding; chunk vectors never depend on generated headings) and retries just the sections still missing a summary. Reason: the free-tier quota (§3.6) is too small to spend on every scan.

### 3.3 Link harvesting for multi-page context (Wikipedia-style)
Rejected an early version of this design that treated "nav vs inline" as "auto-crawl vs skip." That's the wrong axis — **location in the DOM doesn't determine relevance; user approval does.**

Revised approach:
- Harvest **all** same-origin links from two zones: `inlineLinks` (inside the extracted article body) and `navLinks` (inside `<nav>`/sidebar-like containers outside the article body). Drop cross-origin entirely.
- Tag each link with `{url, anchorText, sourceType, surroundingText, sameOrigin}`.
- Dedupe by normalized URL; if a link appears in both zones, keep it as `inline` only.
- **Never auto-crawl.** Present a searchable, checkbox picklist so the user manually approves exactly which links get crawled — regardless of whether they're inline or nav in origin.
- Each picklist row shows the surrounding sentence/context so relevance can be judged without leaving the page.

### 3.4 Picklist ranking & capping (top 20, weighted quota with backfill)
- Score = `baseWeight[sourceType] + positionBonus (earlier paragraphs score higher) + repeatBonus (same URL linked multiple times inline, capped)`.
- Base weights: inline = 10, nav = 3 (inline links are more deliberately relevant — the article author chose to reference them mid-sentence).
- **Quota**: 15 slots reserved for inline, 5 for nav, total cap 20.
- **Backfill rule**: if one category has fewer candidates than its quota, the unused slots go to the other category (inline backfills first, since it's higher priority) — so link-noise in one category never starves the other of visible slots.
  - Example: 20 inline / 3 nav → 17 inline + 3 nav (2 leftover nav slots go to inline)
  - Example: 5 inline / 20 nav → 5 inline + 15 nav
  - Example: both ≥ quota → exactly 15 inline + 5 nav, no backfill needed
  - Example: both < quota (total ≤ 20) → take everything, no capping logic engages
- Add a text filter box above the picklist — even a well-ranked top-20 might miss a link you're specifically looking for in a long article.

### 3.5 Crawling approved links
- For each approved URL only: `fetch()` in background → Readability → sectioning → embed → merge into the **thread's** corpus (not just this page's).
- Tag every crawled section with `{sourcePage, linkedFrom, viaAnchorText}` — needed for citation badges later.

### 3.6 LLM backend
- **Gemini free tier.** Supports tool-calling.
- **Quota is a real constraint (2026-11-05, AI Studio):** on the free tier, every full Flash model (3, 3.6, 3.8) is capped at **5 RPM / 20 requests per day**. The user hit it after 5–6 test scans. Flash-Lite models get **15 RPM / 500 RPD** (`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`).
- **B3 (headings/summaries) uses `gemini-3.5-flash-lite`**, 30 sections per request, on demand (§3.2).
- **Local Ollama (E5) is built for B3**, moved forward from phase 11 because quota became a real constraint. ⚙ settings choose either "Gemini Flash-Lite, with Ollama when its quota runs out" (falls back on any Gemini failure, i.e. 429, a 503 that persists after one retry, other HTTP errors or a network error, or when no key is set) or "Ollama only". It's fully free and private, but you have to run a local server. That's acceptable for a personal tool, a bigger ask if distributing to others. It needs no `OLLAMA_ORIGINS` change: the extension removes the `Origin` header from its own requests to `localhost:11434` (§7.1).
- **Chat (phase 6, decided 2026-11-07 by the user): a model ladder.**
  - Free-tier limits are per model, so chat uses every stable Flash model, newest first, until each one's daily quota is used up, then the Flash-Lite models, then local Ollama.
  - The ladder is read from the API's model list (cached for a day).
  - A per-day 429 skips that model until midnight Pacific time; a per-minute 429 skips it for a minute.
  - Once an answer has started streaming, an error isn't retried on another model.
  - The ⚙ provider setting covers chat too. "Ollama only" skips Gemini.
  - Details: `docs/phased-implementation-plan/phase-6-chat.md`.

### 3.7 Retrieval + agent loop
- Tool-use pattern: `retrieve_sections(query, k=5)` (cosine similarity over local embeddings) and `web_search(query)` (only invoked when the page's own corpus doesn't cover the question).
- **Phase 6 decision (2026-11-07, user): retrieve, then answer, in one call, with no tool-calling for now.**
  - The top 5 sections are always retrieved locally, and one LLM call answers with [n] citations. That's one request per question, and it works with small Ollama models.
  - When the sources don't cover the question, the model is told to reply "The sources don't cover this."
  - Phase 8 hooks `web_search` onto that reply, or moves to real tool-calling if that proves necessary.
  - Footnote markers after punctuation ("…[28]") are stripped from the sources, because models copy them as citations.
  - **Hallucination control (2026-11-07, user):** a local relevance gate before the call (best section score < 0.2: "not covered", the model isn't asked, with Ask anyway), and a local grounding check after it (sentences and numbers not found in the sources are marked; an answer with none of it in the sources is shown as not covered). Details: `phase-6-chat.md`.
- Selection-scoped mode: if the user has text selected on the page, skip retrieval entirely and answer from just that selection — cheaper and more precise for "explain this specific part" questions.
- Context budget is naturally bounded by `k`, not by how many pages are linked in a thread — so threads can grow without needing an explicit pruning scheme.
- **Retrieval for chat (2026-11-07, from the user's testing):**
  - **Blended ranking.** The plain top 4 plus the top 4 after centring (the thread's mean chunk vector taken away from the question and the chunks), so on a page that's all about one topic the distinctive words still count. Usually 4–6 sections. The relevance gate keeps plain cosine scores.
  - **Typos.** A question word (4+ letters) that the thread's pages never use, with a page word one edit away (two for 8+ letters), is corrected, and retrieval runs with both questions. Words the pages use, and everyday question words, are never changed.
  - Measured on White House, MDN, Python docs, React docs and Photosynthesis, 35 questions (6 with typos): the right section reached the model in 29 → 33. No question got worse.
- **Section embeddings are chunked (decided 2026-11-03).** MiniLM reads only ~256 tokens (~200 words), so one vector per section would represent only its opening. Each section is split into ~180-word chunks with a 30-word overlap, each chunk is embedded, and a section's retrieval score is its best chunk's similarity (max-sim). Retrieval still returns whole sections, so E1 and F2 are unaffected.

### 3.8 Citation highlighting
- Use the **CSS Custom Highlight API** (`Highlight`, `CSS.highlights.set()`) to highlight the cited `Range` on the *live* page — non-destructive, no span-wrapping, doesn't fight the host page's own scripts/DOM state.
- If the cited section's source page is the currently open tab → highlight live.
- If the cited section came from a different page in the thread (crawled but not open) → show as a snippet + page badge with an "open page and highlight" action, rather than trying to highlight a page that isn't rendered.
- If the cited section is from a **Google Doc** (§3.1a), whether open or not → snippet + page badge + **Jump to section** (opens the doc at that heading); never a live highlight. Sections without a heading id (intro, or B2-split) are snippet-only.
- **Phase 7 decisions (2026-11-07, user):**
  - What's highlighted is the **passage**: the sentence(s) in the cited section that support the claim, matched locally when the answer is saved. It gets a translucent tint in a random palette colour; the rest of the section gets an underline in the same colour. With no clear passage, the whole section is tinted.
  - Clicking an [n] chip highlights the page directly (opening or focusing the source's page if it's another one); a second click, Esc, the next question or closing the panel clears it. One citation at a time.
  - Reading-view cards jump to their section with a short flash; nothing stays highlighted.
  - Open page and highlight focuses a tab already showing that page, or opens a new tab next to the current one.
  - Details: `docs/phased-implementation-plan/phase-7-citations.md`.

### 3.9 Web search fallback (decided: redirect-only, no crawling of results)
- No paid API needed. Background service worker does a plain `fetch()` against DuckDuckGo's HTML endpoint (`html.duckduckgo.com/html/`) — lighter than Google's SERP, no JS requirement. Flagged as unofficial/could break if DDG changes markup; Brave Search API (small free tier) is the fallback if so.
- **Filter out sponsored/ad result blocks** before extracting anything.
- Take the **top 3 organic results only** — `{title, url, snippet}` straight from the SERP, no visiting the target site.
- Render as link-preview cards in chat. Clicking a card just does `chrome.tabs.create({url})` — a plain redirect. No background crawl of that target page happens at this stage.
- Reading/crawling of that new page only happens later, if/when the user opens the extension on that tab themselves (see thread reattachment below).

### 3.10 Threads & cross-page context (decided: manual reattachment, not autonomous crawling)
- Data model (stored in extension-level IndexedDB, survives tab close):
  ```
  Thread {
    id, title, createdAt, updatedAt,
    pages: [ {url, title, corpusRef, addedAt} ],
    messages: [ {role, content, citedSections: [{pageUrl, sectionId}]} ]
  }
  ```
- When you follow a search result or an approved link to a new page, you manually attach that tab's session to an existing thread (or start fresh) — the *user* chains context across pages, not the agent autonomously crawling the open web.
- Retrieval, once attached, searches across all linked pages' sections together as one pool — no special merge logic needed beyond a bigger candidate set for the same top-k search.
- Soft cap of ~6–8 linked pages per thread — mainly to keep the picklist/citation UI usable, not because retrieval would break past that.

### 3.11 Scan button (decided: explicit trigger, avoids double work)
On side panel open, nothing runs automatically (except loading a page that's already saved in its thread, see below). UI shows:
```
[ this page: <title> — not scanned yet ]
Recent threads:
  ○ Thread A (N pages)
  ○ Thread B (N pages)
  ○ Start new thread
[ Start scan ]
```

Behavior matrix:

| Action | Pipeline runs? | Thread state |
|---|---|---|
| Open chat on existing thread, no scan pressed | No | unchanged |
| Press "Start scan", no thread selected | Yes | new thread created |
| Press "Start scan", thread selected, page already in `thread.pages` | No (cache hit, load `corpusRef` from storage) | unchanged |
| Press "Start scan", thread selected, page not yet in `thread.pages` | Yes | page appended to thread |

- Cache-hit case shows a toast ("already scanned, using saved data") so the no-op isn't ambiguous.
- Entering an existing thread's chat (to ask about page 1 while sitting on page 2) is always available independent of whether "Start scan" is pressed for the current tab.
- **Decided 2026-11-06 (phase 5, approved by the user):**
  - **No thread picker (revised the same day by the user, replacing "sticky selection + preselect").** Each tab is linked to a thread, and the panel shows only that link:
    - **Continuing.** A tab continues a thread when you followed a link from a thread page, either in the same tab or in a new tab opened from it (decided on the new tab's first load, so a blank/Ctrl+T tab starts fresh). The panel shows "Continuing *name* · N pages" and an × button. × makes this page start a new thread.
    - **Reattach.** After ×, a reattach icon appears, and only then.
    - **In the thread.** When the page is in its thread (scanned there, or saved there before), the thread's name is a heading, with the page count and a delete icon.
    - **New thread.** Nothing is shown.
    - Hovering the name lists the thread's pages in order, plus the current page if it isn't in the thread yet.
    - A page some thread already holds links to it when revisited.
    - The links live in `chrome.storage.session` (`background/tab-threads.js`), so they work with the panel closed, and a browser restart forgets them. All thread buttons are icons with hover labels.
    - **Consequence (accepted):** an old thread can't be opened from an unrelated tab. You reach it by revisiting one of its pages. This replaces the §3.11 sketch's "Recent threads" list (G2), and H4 works through a continued tab.
  - **Rescan.** On a page that's showing the selected thread's saved scan, a **Rescan** button reruns the pipeline and replaces that page's corpus in the thread. The old corpus is deleted.
  - **Delete thread.** It's in the picker, with a confirm, and it removes the thread and its corpora.
  - **Same page.** URLs are compared with no `#fragment`, no trailing slash, no tracking parameters (`utm_*`, `fbclid`, `gclid`) and a lower-case host. Other query parameters are kept. A Google Doc is matched by its document id.
  - **Cache hit.** No extraction and no embedding. The tab's live ranges are rebuilt from the stored text-quote anchors.
  - **Saved pages load by themselves (2026-11-07, user).** Since a cache hit reads and embeds nothing, a page already saved in its thread loads when the panel shows it, without Start scan and without the toast. New pages still scan only on Start scan.
  - Details: `docs/phased-implementation-plan/phase-5-threads.md`.

---

## 4. UI flow summary

1. User opens side panel on a tab → sees scan status + thread picker (no auto-run)
2. User optionally selects an existing thread, then presses **Start scan** (or doesn't scan and just chats against the selected thread)
3. If scanning: extraction → classification (force-check banner if sparse) → sectioning → heading/summary generation → embedding → link harvesting → picklist shown for approval → approved links crawled and merged into thread corpus
4. Side panel now shows: reading view (sections with generated headings/summaries) + chat, split-screen
5. User asks a question → agent retrieves top-k sections (or uses page selection if one is active) → answers with citations → citations highlight live on page or show as cross-page snippet
6. If the question needs external info → `web_search` tool returns top-3 non-sponsored DDG results as cards → user clicks one → new tab opens (plain redirect)
7. User opens the panel on that new tab → attaches to the same thread → optionally scans that page → continues the conversation with combined context

---

## 5. Sub-features (parent/child, independently testable)

Each item below should be buildable and testable in isolation before integration.

### A. Extraction & classification
- **A1.** Readability.js integration in content script — extract main content node
- **A2.** Text vs. media classification heuristic (char count vs. media pixel area)
- **A3.** "Not enough text" banner + force-scan override
- **A4.** CSP/injection-failure detection + "site restricts access" message
- **A5.** Special sources (§3.1a): **A5a** Google Docs via HTML export + jump-to-heading via the doc's outline sidebar; **A5b** raw Markdown parsing into blocks

### B. Sectioning
- **B1.** Heading-based split (h1–h4) with per-block text-quote anchors (live `Range`s rebuilt from them; see §3.2)
- **B2.** Paragraph embedding + running-centroid cosine similarity breakpoint detection (unstructured fallback)
- **B3.** LLM call: generate heading + 1-line summary per section (post-boundary-fixing)

### C. Local embeddings & storage
- **C1.** Transformers.js + MiniLM running in a Web Worker
- **C2.** IndexedDB schema for section chunk vectors + metadata (per-page corpus; see §3.7 on chunking)
- **C3.** Cosine similarity top-k retrieval function

### D. Link harvesting & picklist
- **D1.** Inline vs. nav link zone detection + tagging (`sourceType`, `surroundingText`)
- **D2.** Cross-origin filtering + URL dedupe (inline wins on conflict)
- **D3.** Scoring function (base weight + position bonus + repeat bonus)
- **D4.** Quota allocation with backfill (15/5 split, cap 20)
- **D5.** Picklist UI: checkboxes, surrounding-text snippets, search/filter box
- **D6.** Crawl-approved-only pipeline (fetch → Readability → sectioning → embed → merge into thread corpus with `sourcePage`/`linkedFrom` tags)

### E. Agent & retrieval
- **E1.** `retrieve_sections(query, k=5)` tool
- **E2.** `web_search(query)` tool — DuckDuckGo HTML fetch, sponsored-result filtering, top-3 extraction
- **E3.** Selection-scoped answering mode (bypass retrieval when text is selected)
- **E4.** The LLM call that answers: Gemini Flash model ladder, retrieve-then-answer in one call (no tool-calling for now, §3.6–3.7)
- **E5.** Local Ollama fallback path when Gemini quota is exhausted. *Built for B3 on 2026-11-05 and for chat in phase 6 (§3.6).*

### F. Citation & highlighting
- **F1.** CSS Custom Highlight API integration — highlight a `Range` on the live page
- **F2.** Citation-to-section mapping in chat responses (page badge per citation)
- **F3.** Cross-page citation handling — snippet + "open page and highlight" action for non-open source pages

### G. Threads & persistence
- **G1.** Thread data model + IndexedDB persistence (`pages[]`, `messages[]`)
- **G2.** Thread picker UI (recent threads list, start-new option)
- **G3.** Page-to-thread attachment logic (append `corpusRef`, detect already-scanned pages)
- **G4.** Soft cap warning at ~6–8 linked pages per thread

### H. Scan button & panel state
- **H1.** Side panel initial state (scan status + thread picker, no auto-run)
- **H2.** "Start scan" behavior matrix (new thread / cache-hit / append-to-thread)
- **H3.** Cache-hit toast notification
- **H4.** Independent "enter thread chat without scanning" path

### I. UI shell
- **I1.** `chrome.sidePanel` split-screen setup (reading view + chat)
- **I2.** Reading view rendering (sections, generated headings/summaries)
- **I3.** Chat UI (messages, citation cards, web-search result cards)

---

## 6. Implementation order

Recommended build sequence — each phase should be functional and testable before moving to the next:

1. **A** — Extraction, classification, force-check banner (gates everything downstream)
2. **B** — Sectioning + heading/summary generation (no chat yet). The minimal C1 embedding worker is built here, since B2 can't work without embeddings. The static reading view is deferred to I2 in step 4, because it needs the side panel; B is verified through the console harness until then.
2a. **A5** — Special sources: Google Docs export and raw Markdown (§3.1a). Built after B is complete, because it produces B's block list, and before C. Covered by the combined run (§6a).
3. **C** — Local embeddings + retrieval, tested standalone ("show top 5 sections for this query"). C1's worker already exists from step 2.
4. **H1, H2 (partial), I1, I2** — Side panel shell with scan button wired to A+B+C for a single page, no threads yet. The chat area temporarily holds a "find sections" search box (top-5 retrieval results, click to highlight) so retrieval can be tested through the UI; it's removed when I3 lands in step 6 (decided 2026-11-03).
5. **G1, G2, G3, H3, H4** — Thread persistence and the full scan-button behavior matrix, still single-page corpora
6. **E1, E3, E4, I3** — Wire retrieval + Gemini Flash into an actual chat loop with selection-scoped mode (built as retrieve-then-answer with the model ladder, §3.6–3.7)
7. **F1, F2, F3** — Citation highlighting (live + cross-page snippet mode)
8. **E2** — Web search tool: DDG fetch, sponsor filtering, top-3 cards, redirect-on-click
9. **D1–D6** — Link harvesting, scoring, quota/backfill, picklist UI, approved-link crawling (most fragile piece — nav/inline heuristics will need real-world tuning against actual sites)
10. **G4** — Soft cap warning once multi-page threads are common in testing
11. **E5** — Local Ollama fallback (only if/when Gemini quota becomes a real constraint). *B3's part was pulled forward on 2026-11-05 once it did; chat's part was built in phase 6.*

Per-phase plans live in `docs/phased-implementation-plan/`, one file per phase.

## 6a. Testing strategy (decided 2026-11-02)

- **Default:** each phase is fully tested on its own before the next starts.
- **Exception: phases 2, 2a, 3 and 4 (B, A5, C, side panel shell) are built back to back and fully tested in one combined run at the end of phase 4.**
  - Each of those phase plans lists **checkpoints**: a few quick manual tests that must pass before moving to the next phase. They cover browser-environment failures that unit tests can't catch and that everything later builds on: anchoring, the embedding worker loading, retrieval sanity, persistence, and side-panel tab access.
  - Unit tests for `lib/` still run in every phase.
  - The combined checklist is in `phase-4-side-panel-shell.md`.
- **Reminder for anyone resuming this work:** if phases 2–4 are built but the combined run hasn't been ticked off in `phase-4-side-panel-shell.md`, run it before starting phase 5. If a phase 2–4 checkpoint is unticked, run it before building the next phase.
- From phase 5 on, testing goes back to per-phase, unless a new exception is agreed and recorded here.

---

## 7. Resolved decisions (formerly open items)

### 7.1 Manifest V3 permissions & host_permissions strategy
- Base manifest requests only `activeTab`, `scripting`, `sidePanel`, `storage` — no upfront host_permissions. (`scripting` added during Phase A planning — required for programmatic `chrome.scripting.executeScript` injection, the mechanism this strategy relies on to avoid a standing `content_scripts` grant.)
- **D6 (crawl approved links)**: request `optional_host_permissions` at runtime, per-origin, at the moment a link is approved in the picklist — never a standing grant for origins the user hasn't actually approved.
- **E2 (web search)**: add a single narrow static host_permission for `html.duckduckgo.com` when E2 is built (phase 8) — fixed, low-scope, known upfront.
- **Phase B (embeddings)**: adds the `offscreen` permission and `'wasm-unsafe-eval'` in the extension-pages CSP (decided 2026-11-02). MV3 service workers can't spawn Web Workers, so the background creates an offscreen document (reason `WORKERS`), which hosts the embedding worker. ONNX Runtime runs as WebAssembly, so it needs the CSP entry. Neither grants access to any site.
- **Phase 4 (side panel scanning), decided 2026-11-03 after CP-4-1:** `activeTab` is granted only by a click on the toolbar icon, never by a click inside the side panel. So Start scan failed on any tab the user had switched to. Fix: `optional_host_permissions: ["http://*/*", "https://*/*"]`, **requested once for all sites** (Chrome's own prompt), the first time Start scan hits a tab without access. If declined, the icon-click path still works. Nothing is granted at install, and the grant can be revoked in Chrome's extension settings. Rejected alternatives: a static `<all_urls>` grant (Chrome shows an install-time warning) and per-site prompts (too frequent for everyday use). This loosens the "no `<all_urls>` until phase 9" rule below. D6 (phase 9) reuses this grant when it's present and falls back to its per-origin request when it isn't.
- **E5 (local Ollama, for B3), decided 2026-11-05:** `host_permissions: ["http://localhost:11434/*"]` plus `declarativeNetRequestWithHostAccess`. Ollama rejects any browser `Origin` not listed in `OLLAMA_ORIGINS`, and on a system-wide install, changing that needs root, which the user doesn't have. So a DNR **session rule** removes the `Origin` header, but only from this extension's own requests to `localhost:11434` (`initiatorDomains: [chrome.runtime.id]`). Websites keep Ollama's origin protection. The host permission lets the service worker read the reply. Rejected alternative: a second per-user Ollama server on another port with its own `OLLAMA_ORIGINS`, which would mean a 3.3 GB re-download and starting it manually.
- Rationale (original): "minimum permissions per phase, no `<all_urls>` until phase 9", as in CLAUDE.md; avoids a standing broad grant for a personal/free-first tool. Since 2026-11-03 the one exception is the user-approved, revocable all-sites grant above.

### 7.2 Embedding model weights (decided 2026-11-02: download on first use)
- The Transformers.js library and the ONNX Runtime `.wasm` files are **vendored**, because MV3 forbids remote code. The `all-MiniLM-L6-v2` quantized weights (~23 MB, data, not code) are **fetched from the Hugging Face hub on first use** and cached by Transformers.js in the Cache API.
- Trade-off accepted: the first scan needs network access and takes a few extra seconds; later scans work offline. This keeps 23 MB of binaries out of git. HF serves permissive CORS, so no host permission is needed.

### 3.9a DuckDuckGo HTML markup parsing (decided: defer + resilient selectors)
- Selectors for sponsored-vs-organic blocks are **not** pinned in the spec — DDG's markup is unofficial and drifts, so locking them in now would likely be stale by phase 8.
- At implementation time (phase 8 / E2), verify against a live fetch first, and prefer resilient parsing (semantic/text markers, e.g. explicit "Ad"/sponsored text markers) over brittle class-name selectors to reduce future drift risk.
- Document the selectors actually used in the `web-search-fallback` skill once verified, not here.

### 3.3a Nav-container detection heuristic (decided: start strict, tune later)
- Baseline heuristic for `navLinks` zone detection (D1): semantic `<nav>` tag + `role="navigation"` only. No class-name guessing (`.sidebar`, `.toc`, `.menu`, etc.) at first.
- At implementation time (phase 9), widen deliberately using a curated test set spanning doc sites, wikis, and blogs to measure false positive/negative rate before adding class-name heuristics.
- Rationale: fewer false positives to start; widen only once real-world misses are observed rather than guessing upfront.

### 3.5a Crawled corpus caching across threads (decided: no cache, always re-embed)
- If the same page gets crawled (via D6) into two different threads, each thread re-fetches and re-embeds independently — no shared/global corpus cache keyed by URL.
- Rationale: embeddings run locally via Transformers.js (free, just CPU time) — recompute cost is not money, so caching is a pure optimization, not a necessity. Avoids staleness and cache-invalidation complexity (TTL/content-hash tracking) that a shared cache would require, consistent with the project's lightweight, free-first philosophy.
- Revisit only if real-world usage shows the same popular pages get crawled into many threads and recompute time becomes a noticeable UX cost.

---

## 8. Follow-ups (noted, not scheduled)

- **Scan speed / embedding performance** (noted 2026-11-03 by the user during CP-4-1). Embedding a Wikipedia-length page takes about 10 s now. Linked pages (phase 9) and multi-page threads will multiply that. Look into it once the extension is functional end to end, not before. Measure first (`msModelLoad` vs `msEmbed` are already in the C stats). Candidate levers, none decided:
  - WASM threads (`numThreads > 1`, which needs cross-origin isolation in the offscreen document)
  - WebGPU backend
  - Batch size
  - Reusing B2's unit vectors for C chunks on headingless pages
  - Embedding visible/early sections first
  - A smaller model
- **Ollama CPU threads for B3** (noted 2026-11-05 by the user during the combined run; do after the MVP). On the user's i5-1235U (2 performance + 8 efficiency cores) Ollama only uses the 2 performance cores (≈200% CPU), so a 27-section page takes roughly 5–8 min with `qwen2.5:1.5b`. Try `options.num_thread` (e.g. 8) in `buildOllamaBody` (`lib/section-prompt.js`): time one batch at the default vs 8 threads and keep the faster. Related: when Ollama is missing the model (404) or unreachable, stop at the first batch instead of failing every batch. Also, the user's Ollama 0.22.0 can't pull `gemma3:1b` (412, needs a newer Ollama; no sudo to upgrade the service).

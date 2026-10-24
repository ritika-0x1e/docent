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
  → embeddings (Transformers.js, local, in a Web Worker)
  → vector store (IndexedDB, cosine similarity)
  → agent loop (tool-use: retrieve_sections, web_search)
  → LLM calls (Gemini Flash free tier now; local Ollama later if quota becomes a problem)
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
- If the content script can't attach at all (strict CSP, Trusted Types, permission-blocked sites) — detect this and clearly say "this site restricts extension access," never fail silently.

### 3.2 Sectioning
- **Structured case**: split on existing `h1–h4`, keep each section's DOM `Range` for later highlighting.
- **Unstructured case**: no LLM needed to find boundaries. Embed paragraphs, walk sequentially, and break into a new section when cosine similarity to the running section centroid drops below a threshold (classic semantic-breakpoint chunking).
- Only call the LLM **after** boundaries are fixed, to generate a heading + 1-line summary per section — keeps LLM usage cheap and deferred.

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
- **Gemini Flash free tier** for now — sufficient quota, supports tool-calling.
- If/when quota becomes a real constraint, fall back to **local Ollama** (fully free, private, but requires the user to run a local server — acceptable for a personal tool, a bigger ask if distributing to others).

### 3.7 Retrieval + agent loop
- Tool-use pattern: `retrieve_sections(query, k=5)` (cosine similarity over local embeddings) and `web_search(query)` (only invoked when the page's own corpus doesn't cover the question).
- Selection-scoped mode: if the user has text selected on the page, skip retrieval entirely and answer from just that selection — cheaper and more precise for "explain this specific part" questions.
- Context budget is naturally bounded by `k`, not by how many pages are linked in a thread — so threads can grow without needing an explicit pruning scheme.

### 3.8 Citation highlighting
- Use the **CSS Custom Highlight API** (`Highlight`, `CSS.highlights.set()`) to highlight the cited `Range` on the *live* page — non-destructive, no span-wrapping, doesn't fight the host page's own scripts/DOM state.
- If the cited section's source page is the currently open tab → highlight live.
- If the cited section came from a different page in the thread (crawled but not open) → show as a snippet + page badge with an "open page and highlight" action, rather than trying to highlight a page that isn't rendered.

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
    id, title, createdAt,
    pages: [ {url, title, corpusRef, addedAt} ],
    messages: [ {role, content, citedSections: [{pageUrl, sectionId}]} ]
  }
  ```
- When you follow a search result or an approved link to a new page, you manually attach that tab's session to an existing thread (or start fresh) — the *user* chains context across pages, not the agent autonomously crawling the open web.
- Retrieval, once attached, searches across all linked pages' sections together as one pool — no special merge logic needed beyond a bigger candidate set for the same top-k search.
- Soft cap of ~6–8 linked pages per thread — mainly to keep the picklist/citation UI usable, not because retrieval would break past that.

### 3.11 Scan button (decided: explicit trigger, avoids double work)
On side panel open, nothing runs automatically. UI shows:
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

### B. Sectioning
- **B1.** Heading-based split (h1–h4) with DOM `Range` capture per section
- **B2.** Paragraph embedding + running-centroid cosine similarity breakpoint detection (unstructured fallback)
- **B3.** LLM call: generate heading + 1-line summary per section (post-boundary-fixing)

### C. Local embeddings & storage
- **C1.** Transformers.js + MiniLM running in a Web Worker
- **C2.** IndexedDB schema for section vectors + metadata (per-page corpus)
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
- **E4.** Gemini Flash integration for the agent loop (tool-calling)
- **E5.** (Later/optional) Local Ollama fallback path when Gemini quota is exhausted

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
2. **B** — Sectioning + heading/summary generation, rendered as a static reading view (no chat yet)
3. **C** — Local embeddings + retrieval, tested standalone ("show top 5 sections for this query")
4. **H1, H2 (partial), I1, I2** — Side panel shell with scan button wired to A+B+C for a single page, no threads yet
5. **G1, G2, G3, H3, H4** — Thread persistence and the full scan-button behavior matrix, still single-page corpora
6. **E1, E3, E4, I3** — Wire retrieval + Gemini Flash into an actual chat loop with selection-scoped mode
7. **F1, F2, F3** — Citation highlighting (live + cross-page snippet mode)
8. **E2** — Web search tool: DDG fetch, sponsor filtering, top-3 cards, redirect-on-click
9. **D1–D6** — Link harvesting, scoring, quota/backfill, picklist UI, approved-link crawling (most fragile piece — nav/inline heuristics will need real-world tuning against actual sites)
10. **G4** — Soft cap warning once multi-page threads are common in testing
11. **E5** — Local Ollama fallback (only if/when Gemini quota becomes a real constraint)

---

## 7. Resolved decisions (formerly open items)

### 7.1 Manifest V3 permissions & host_permissions strategy
- Base manifest requests only `activeTab`, `scripting`, `sidePanel`, `storage` — no upfront host_permissions. (`scripting` added during Phase A planning — required for programmatic `chrome.scripting.executeScript` injection, the mechanism this strategy relies on to avoid a standing `content_scripts` grant.)
- **D6 (crawl approved links)**: request `optional_host_permissions` at runtime, per-origin, at the moment a link is approved in the picklist — never a standing grant for origins the user hasn't actually approved.
- **E2 (web search)**: add a single narrow static host_permission for `html.duckduckgo.com` when E2 is built (phase 8) — fixed, low-scope, known upfront.
- Rationale: matches the existing "minimum permissions per phase, no `<all_urls>` until phase 9" principle already in CLAUDE.md; avoids a standing broad grant for a personal/free-first tool.

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

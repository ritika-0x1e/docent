# Summarizer — CLAUDE.md

This file orients Claude Code (or any agentic coding session) working in this repo. Read this first, then `docs/master-spec.md` for full context before touching any sub-feature.

## What this project is

A Chrome extension (Manifest V3) that turns any browser tab into a scoped RAG chatbot: extracts and sections page content, lets the user chat against just that page (or a set of manually-approved linked pages), cites answers by highlighting the source text live on the page, and falls back to redirect-only web search when the page doesn't have the answer. Full rationale for every decision lives in `docs/master-spec.md` — do not re-derive or silently change a decision documented there without flagging it first.

## Source of truth

`docs/master-spec.md` is authoritative for:
- Architecture and data flow
- Every design decision and why it was made (including rejected alternatives — e.g. why nav-vs-inline was replaced with an approval-based picklist)
- The full sub-feature list (A–I) and implementation order (phases 1–11)

Do not start a sub-feature not listed there without checking in first. If a sub-feature's requirements seem to have changed during implementation, update the spec, don't just diverge silently.

## Current phase

**Phase A (extraction & classification): done and tested.** Next: phases 2–4 (B sectioning, then A5 special sources (Google Docs export + raw Markdown, spec §3.1a), then C embeddings/retrieval, then the side panel shell), built back to back under the combined-testing exception in `docs/master-spec.md` §6a. Per-phase plans are in `docs/phased-implementation-plan/`. Before starting any phase, check that plan's **checkpoints** and its "decisions needing sign-off" section. Remind the user to run any checkpoint left unticked, or the combined run if it's still pending, before building further. Work sub-feature by sub-feature in the order given in `docs/master-spec.md` §6.

## Tech stack (do not substitute without discussion)

| Layer | Choice |
|---|---|
| Extension platform | Chrome Manifest V3, `chrome.sidePanel` |
| Content extraction | Readability.js for normal pages; Google Docs via its own HTML export (same-origin fetch, no API/OAuth); raw Markdown via a small built-in parser (spec §3.1a) |
| Sectioning | Custom heuristics (heading split) + embedding-based centroid breakpoint detection for unstructured pages |
| Embeddings | Transformers.js, `all-MiniLM-L6-v2`, quantized, run in a Web Worker hosted by an offscreen document (MV3 service workers can't spawn workers). Library + wasm vendored but not committed: `npm run vendor` fetches them at pinned versions after cloning (`workers/vendor/VENDORED.md`); model weights downloaded on first use and cached (spec §7.2) |
| Vector storage | IndexedDB (raw cosine similarity, no external vector DB — page-scale doesn't need one) |
| LLM | Gemini Flash (free tier) via direct API calls from the background service worker; local Ollama as a documented fallback if quota becomes a real constraint (not built yet — see spec §3.6 and sub-feature E5) |
| Web search | Plain `fetch()` against DuckDuckGo's HTML endpoint, no API key; Brave Search API as a fallback path if DDG markup drifts |
| Citation highlighting | CSS Custom Highlight API (`Highlight`, `CSS.highlights.set()`) — never DOM-mutating span wraps |
| Language | JavaScript throughout (content scripts, background worker, side panel UI). No build-step framework required for v1 — keep it lightweight; only reach for a bundler if a library genuinely needs one. The plan for Transformers.js is to vendor its prebuilt ESM build and load it in a module worker, with no bundler; checkpoint CP-B2 confirms whether that works |

## Repo structure (target — create as needed per phase)

```
/manifest.json
/background/            service worker: agent loop, embeddings worker orchestration, storage access
/content/                content scripts: extraction, classification, sectioning, link harvesting, highlighting
/sidepanel/              side panel UI: thread picker, reading view, chat, picklist
/lib/                    shared pure functions (scoring, quota allocation, cosine similarity, thread schema helpers)
/offscreen/              offscreen document that hosts the embedding worker
/workers/                embedding Web Worker
/docs/master-spec.md     source of truth (this project's design doc)
/.claude/skills/         project-specific Claude Code skills (see below)
```

## Working conventions

- **Pure logic before UI.** Scoring, quota allocation, breakpoint detection, and thread-attachment logic should be written as plain testable functions in `/lib/`, independent of DOM/Chrome APIs, so they can be unit tested without a browser.
- **No silent scope creep.** If a sub-feature implementation reveals a gap in the spec (e.g. an edge case in quota backfill not covered), stop and note it rather than inventing new behavior.
- **Free-tier discipline.** Don't introduce a paid API or a hosted backend without flagging it — the whole point of this project is a free, mostly client-side stack (see spec §1 and §3.6).
- **Test each sub-feature in isolation** per the spec's phase breakdown (§6) before wiring it into the next phase. Don't jump ahead to chat/agent wiring before extraction+sectioning+retrieval are independently verified. **Approved exception (spec §6a):** phases 2–4 get one combined test run at the end of phase 4, gated by per-phase checkpoints. That isn't a violation, but phase 5 must not start until that combined run is ticked off.
- **Section locations are text-quote anchors, not stored `Range`s** (spec §3.2). Live `Range`s exist only inside the content script and are rebuilt from anchors.
- **Manifest V3 permissions**: request the minimum host permissions needed per phase; don't request broad host access beyond what's approved. Approved so far: `activeTab`, `scripting`, `sidePanel`, `storage`, plus `offscreen` and `'wasm-unsafe-eval'` in the extension-pages CSP, both from phase 2. From phase 4: `optional_host_permissions` for `http(s)://*/*`, requested **once for all sites** at runtime from Start scan, never as a static install-time grant (spec §7.1).

## Skills

See `.claude/skills/` for project-specific skills (full instructions, authored for this project's bespoke logic — scoring, sectioning breakpoints, approved-link crawl orchestration, thread schema, scan-button state machine, citation mapping, search filtering). See `docs/reusable-skills.md` for generic, non-project-specific skills that already exist in the wider ecosystem (Chrome extension boilerplate, Readability.js usage, Transformers.js worker setup, IndexedDB patterns, CSS Custom Highlight API usage, Gemini tool-calling setup) — these are referenced by name/description only; pull in an existing community skill or write a thin wrapper against the library docs rather than reinventing them here.

## Out of scope for now

- Local Ollama fallback (E5) — documented, not built, until Gemini quota is actually a problem
- Anything beyond the top-20 link picklist UX — no infinite crawling, no autonomous agent-driven crawling ever (this was an explicit rejected design — see spec §3.3)

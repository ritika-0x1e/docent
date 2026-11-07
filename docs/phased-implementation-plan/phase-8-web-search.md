# Phase 8 — Web search fallback

Implementation plan for build-sequence step 8 in `docs/master-spec.md` §6: **E2** (spec §3.9, §3.9a, skill `web-search-fallback`). When the pages in a thread don't cover a question, the user can go to the web for it, redirect-only: nothing from the results is fetched or read.

**Testing:** per-phase (spec §6a). This phase ends with its own checks (bottom of this doc).

## Blocking finding (2026-11-07): DuckDuckGo's HTML endpoint refuses automated requests
Spec §3.9a said to check the endpoint against a live fetch before relying on it. Checked from this machine, both with curl and with `fetch()` from the extension's service worker (as the built feature would call it):

| Request | Response |
|---|---|
| `GET html.duckduckgo.com/html/?q=…` | 202, a CAPTCHA page: "Unfortunately, bots use DuckDuckGo too. Please complete the following challenge…" |
| `POST html.duckduckgo.com/html/` (what its own form sends) | 403, DuckDuckGo's error page |
| `POST lite.duckduckgo.com/lite/` | 403, the same |

No results in any of them. A service-worker `fetch()` can't solve a challenge, and getting past it (a hidden tab, faking a browser) would be evading DuckDuckGo's bot protection, which this project won't do. So §3.9's plan as written can't work reliably. The source of results has to change, and that's the user's call (decision 1).

## Scope recap
- **E2.** When an answer is "not covered" (the gate, the model, or the grounding check), offer the web. Results are only ever shown or opened, never fetched or read by the extension.
- **Not here:** link picklist (phase 9). Reading a result page happens only if the user opens it and scans it, as with any page.

## Decisions needing sign-off

**Status 2026-11-07: decisions 1–4 approved as proposed** (a new search tab, a button, the title added when vague, the tab continues the thread). Built 2026-11-07: `lib/web-search.js` (+ tests), the query saved on "not covered" answers (`webQuery`), `panel-web-search` in the service worker, the button, and the engine choice in ⚙. Testing: the combined run for phases 8–10 (spec §6a).


1. **Where results come from.**
   - **Proposed: open a search in a new tab.** A "Search the web" button on a "not covered" answer opens the user's question as a normal search results page (DuckDuckGo by default; the engine selectable in ⚙). It's a plain redirect, like §3.9's cards, but the browser shows the results itself.
     - Nothing is fetched or parsed, so it can't be blocked or broken by markup changes, needs no API key and no new permission, and sends nothing until the user clicks.
     - Loses: the 3 result cards inside the panel. You pick a result on the search page instead.
   - **Alternative: Brave Search API** (spec §3.9's named fallback). Real in-panel cards (top 3, title + site + snippet), through an official API.
     - Needs a Brave Search API key that you sign up for (it has a free plan; check its current terms, which may ask for a card), entered in ⚙, and a static host permission for `api.search.brave.com`.
     - Can be added later on top of the proposed default: with a key, cards in the panel; without one, the search tab.
   - **Alternative: Wikipedia only** (official, keyless API). In-panel cards, but only Wikipedia articles.
2. **When it's offered.**
   - **Proposed: a button, never automatic.** "Search the web" appears on "not covered" answers. A question leaves the browser for a search engine only when you click.
   - Alternative: automatically on every "not covered" answer (only possible with an API source, decision 1).
3. **The search terms.**
   - **Proposed:** the question as you typed it, with the thread's title added when the question is short or vague (fewer than 4 content words, or it says "it", "this", "they"…), so "when was it built?" searches "when was it built? White House". The button's tooltip shows the exact query.
4. **A result page and the thread.**
   - **Proposed: it continues the thread**, like any page opened from a thread page (phase 5): the new tab shows "Continuing <thread>", and Start scan adds it. × detaches it as usual. Matches spec §4 step 7.
   - Alternative: a new tab with no thread link.

**Defaults that need no sign-off:**
- The search tab opens next to the current one and becomes active.
- The search a message offered is saved on it (query only), so the button still works after a restart.

## Checks for phase 8 (run at the end)
1. A "not covered" answer (gate, model, or grounding check) shows Search the web; a covered answer doesn't.
2. Clicking it opens one tab with the right query (the thread's title added only when the question is vague), next to the current tab.
3. Nothing is sent anywhere before the click (no network request in the log).
4. The opened tab continues the thread (decision 4), and scanning a result page adds it to the thread.
5. The manifest is unchanged (or, with Brave, has only `api.search.brave.com` added).

## Exit criteria for phase 8
- [x] Decisions 1–4 signed off *(2026-11-07)*
- [x] `npm test` passes, with tests for query building (a pure function in `lib/`)
- [ ] Checks 1–5 pass

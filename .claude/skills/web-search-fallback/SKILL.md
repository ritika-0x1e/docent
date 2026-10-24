---
name: web-search-fallback
description: Use when implementing or modifying the web_search tool for the Summarizer (sub-feature E2) — fetching DuckDuckGo's HTML endpoint, filtering sponsored results, extracting the top 3 organic results, and rendering them as redirect-only cards. Not a general scraping skill — scope is intentionally limited to metadata extraction, never visiting or crawling the result pages themselves.
---

# Web search fallback

Implements master-spec §3.9 (sub-feature E2). This tool is invoked by the agent only when the page's own retrieved sections don't cover the user's question. It must never fetch or read the content of any result page — only the search engine's own results listing.

## Request

Plain `fetch()` against `https://html.duckduckgo.com/html/?q=<query>` from the background service worker. No API key. Note in code comments that this is an unofficial endpoint dependent on DuckDuckGo's current HTML markup — if results parsing starts failing, check for markup drift before assuming a logic bug, and see the Brave Search API fallback noted in the master spec (§3.9) as the documented alternative path.

## Parsing

1. Parse the returned HTML.
2. Identify and exclude sponsored/ad result blocks (DDG marks these with a distinct class in its HTML results — verify the current class name against a live fetch before relying on it, since this is exactly the kind of detail that drifts; do not hardcode a guessed class name without checking).
3. From the remaining organic results, extract the first 3 in order: `{title, url, snippet}` taken directly from the SERP markup.

## Output

Render each result as a link-preview style card in chat — title, source, snippet. No additional processing of the target pages. Clicking a card performs `chrome.tabs.create({url})` — a plain redirect, nothing else happens automatically.

## Connection to threads

This tool does not attach the resulting tab to any thread automatically. If the user follows a result and wants to continue the same research thread there, that's the manual thread-attachment flow — see the `thread-data-model` skill. This tool's job ends at presenting 3 clean, non-sponsored links.

## Non-goals

- No fetching/reading of the linked pages' content from this tool.
- No use of a paid search API in the default path — Brave Search API is a documented fallback only, not the default implementation.
- No more than 3 results surfaced, regardless of how many organic results DDG returns.

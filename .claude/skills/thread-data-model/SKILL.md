---
name: thread-data-model
description: Use when implementing or modifying thread persistence and cross-page attachment for the Summarizer (sub-features G1–G4) — the IndexedDB schema for threads, attaching a new page's corpus to an existing thread, and detecting already-scanned pages.
---

# Thread data model

Implements master-spec §3.10 (sub-features G1–G4). Threads are how the user manually chains context across pages — the agent never autonomously adds pages to a thread.

## Schema (G1)

Store at the extension level (not per-tab), so threads survive tab close:

```
Thread {
  id: string,
  title: string,
  createdAt: timestamp,
  updatedAt: timestamp,   // last page added or replaced; the picker sorts by it
  pages: [
    { url: string, title: string, corpusRef: string, addedAt: timestamp }
  ],
  messages: [
    {
      role: 'user' | 'assistant',
      content: string,
      citedSections: [ { pageUrl: string, sectionId: string } ]
    }
  ]
}
```

`corpusRef` points to the page's section+embedding data (produced by the sectioning/embedding pipeline), stored separately from the thread record so the same corpus could in principle be referenced without duplicating it if the same page is ever attached to two threads (flagged as an open question in master-spec §7 — don't build cross-thread corpus sharing unless/until that's resolved, just keep the reference indirection so it's possible later).

## Which thread a tab is in (revised 2026-11-06)

There's no picker. `background/tab-threads.js` keeps a per-tab link `{threadId, detachedThreadId}` in `chrome.storage.session`. A tab keeps its link across navigations. A new tab inherits its opener's link, but only if its first load is a web page. A revisited page that some thread holds links to that thread. × detaches and reattach restores. "A thread is selected" below means the tab has a `threadId`.

## Attachment logic (G3)

When the user presses "Start scan" with a thread selected:

1. Normalize the current tab's URL with `normalizeUrl` in `lib/threads.js` and check it against `thread.pages[].url`. That's the only URL comparison; it drops the fragment, a trailing slash and tracking parameters, and keys a Google Doc by its id. For a cache hit, the tab's live ranges are rebuilt from the stored anchors (`reanchor-blocks`).
2. **Match found** → this is a cache hit. Do not re-run extraction/sectioning/embedding. Load the existing `corpusRef` from storage and proceed straight to chat. Surface a toast: "already scanned, using saved data."
3. **No match** → run the full pipeline (extraction → sectioning → embedding) for this page, then append `{url, title, corpusRef, addedAt: now}` to `thread.pages`.

When no thread is selected and "Start scan" is pressed: always run the full pipeline and create a new `Thread` with this page as `pages[0]`.

## Retrieval across a thread

Retrieval for a thread-scoped question searches across the sections of **every** page in `thread.pages`, not just the currently open tab — it's a single top-k cosine search over the combined pool of sections. Do not implement per-page result caps or manual merge-weighting between pages; k alone bounds context size (see master-spec §3.7 rationale).

## Soft cap (G4)

At ~6–8 pages in a thread, surface a UI prompt suggesting the user start a fresh thread. This is a UX suggestion only — do not hard-block adding a 9th page. The cap exists because the picklist/citation UI gets unwieldy with too many source pages, not because retrieval itself degrades.

## Non-goals

- No automatic thread creation/attachment without an explicit user action (scan button + thread picker).
- No agent-initiated page fetching into a thread outside of the approved-link crawl flow (see `link-harvesting-and-scoring` skill) — threads only grow via scan-button presses on tabs the user has actually navigated to, or via approved-link crawls.

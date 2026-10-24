---
name: scan-button-state-machine
description: Use when implementing or modifying the side panel's initial state and "Start scan" button behavior for the Summarizer (sub-features H1–H4) — the four-state matrix governing whether the extraction pipeline runs, based on whether a thread is selected and whether the current page is already in that thread.
---

# Scan button state machine

Implements master-spec §3.11 (sub-features H1–H4). The core rule: nothing runs automatically on side panel open. The scan button is the only trigger for the extraction/sectioning/embedding pipeline on the current tab.

## Initial panel state (H1)

On open, show, without running anything:
- Current tab's scan status ("not scanned yet" / "scanned, in thread: X")
- A thread picker: recent threads by title + a "start new thread" option
- The "Start scan" button

## State matrix (H2)

| Thread selected? | Page already in thread.pages? | On "Start scan" press |
|---|---|---|
| No | n/a | Run full pipeline, create new thread with this page as `pages[0]` |
| Yes | No | Run full pipeline, append this page's corpus to the selected thread |
| Yes | Yes | Skip pipeline entirely — load existing `corpusRef`, show cache-hit toast (H3) |

A fourth path exists independent of the scan button: entering an existing thread's chat view **without** pressing "Start scan" at all (H4) — always available, used when the user wants to continue a conversation about a different page in the thread while sitting on an unrelated tab. This path never touches the current tab's content.

## Implementation notes

- The URL-match check against `thread.pages` (for the "already in thread" branch) should reuse the normalization logic from the `thread-data-model` skill — do not implement a second URL-comparison method here.
- The cache-hit toast (H3) must be visually distinct from a normal "scan complete" confirmation, since the two represent different amounts of work done and the user should be able to tell at a glance.
- Do not gate H4 (enter thread chat without scanning) behind any scan-related check — it should be reachable directly from the thread picker.

## Non-goals

- No auto-scan on panel open, ever, regardless of whether a thread is selected.
- No re-scan-on-every-question behavior — a page's corpus, once produced, is reused for the rest of the session unless the user explicitly triggers a rescan (rescan-on-demand is not yet in the sub-feature list; flag before adding it).

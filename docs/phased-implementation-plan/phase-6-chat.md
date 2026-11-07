# Phase 6 — Chat

Implementation plan for build-sequence step 6 in `docs/master-spec.md` §6: **E1, E3, E4, I3**. Retrieval and an LLM become a chat in the side panel, with selection-scoped answers. Chat runs inside a thread, and its messages are stored on the thread (G1's `messages[]`). It replaces the temporary find-sections box (phase 4, decision 2).

**Testing:** per-phase (spec §6a). This phase ends with its own checks (bottom of this doc).

## Scope recap
- **E1.** Retrieve the top 5 sections across every page in the tab's thread, or the tab's own corpus.
- **E3.** Selection-scoped mode: if text is selected on the page, answer from just that selection and skip retrieval.
- **E4.** The LLM call that answers. Its model is decision 1, and its shape (tool-calling or not) is decision 2.
- **I3.** Chat UI: messages, streamed answers, numbered citations under each answer, and the conversation saved on the thread.
- **E5 for chat:** Ollama as the fallback or alternative, the same as for B3 (spec §3.6, "chat's part follows phase 6").
- **Not here:**
  - `web_search` (E2, phase 8)
  - live citation highlighting and the "open page and highlight" action for other pages (F1–F3, phase 7)
  - link picklist (D, phase 9)

## Decisions needing sign-off

**Status 2026-11-07:**
- **Decision 1, the user's variant: a model ladder.** Gemini's free-tier limits are counted per model (the 429's quota id reads `…PerDayPerProjectPerModel…`). So chat uses each available Flash model, newest first, until its daily quota is used up, then the Flash-Lite models, then Ollama.
  - The ladder comes from the API's model list (stable `gemini-<version>-flash` / `-flash-lite` names only, no previews or aliases), cached for a day. That way new models join automatically, without hardcoded guesses.
  - A per-day 429 parks that model until the quota resets at midnight Pacific time. A per-minute 429 parks it for a minute.
  - B3 keeps Flash-Lite only, as before.
- **Decisions 2–4 approved as proposed:** retrieve then one call, source cards now, the conversation saved on the thread.

1. **Chat model** (spec §3.6 left this open). Full Flash allows only 20 requests a day on the free tier, so it can't carry chat.
   - **Proposed: Gemini Flash-Lite (500 a day), with Ollama when Gemini fails**, the same setting and fallback as B3, so ⚙ stays one choice. `qwen2.5:1.5b` on Ollama will give weaker answers but works offline.
   - Alternatives: Flash for answers until its 20 a day are gone, then Flash-Lite. Or Ollama only.
2. **How an answer is produced.**
   - **Proposed: retrieve then answer, one LLM call per question.** The background always retrieves the top 5 sections locally (free and instant), then makes a single LLM call with the question, the recent turns and those sections. The model cites them as [1]–[5]. That's one request per question instead of two or more, and it works with small Ollama models, which handle tool-calling poorly. When the sections don't cover the question, the model says so plainly. Phase 8 hooks `web_search` onto that "not covered" answer, or switches to real tool-calling then if it proves necessary.
   - **Alternative: tool-calling now**, as §3.7 sketches. The model calls `retrieve_sections` itself, which takes at least 2 requests per question and needs a model that's good at tools.
3. **Citations in this phase.**
   - **Proposed: numbered source cards under each answer**: page badge, section heading and snippet. A card from the current page gets **Show on page**, reusing the phase 4 highlight. Cards from other pages are snippet-only until F2 (phase 7). Phase 7 then upgrades these cards rather than building them from scratch.
   - **Alternative:** plain [n] markers now, with cards and actions all in phase 7.
4. **Where the conversation lives.**
   - **Proposed: on the thread** (`thread.messages[]`, the spec schema), so any tab in the thread shows the same conversation and it survives restarts. The LLM gets the last 6 turns plus the retrieved sections. A tab with no thread yet gets its thread on the first scan, so chat needs a scanned page or a continued thread. That's the same rule as the find box today.
   - **Alternative:** per tab, not saved.

**Defaults that need no sign-off** (say if you disagree):
- Answers stream in as they're written. A **Stop** button aborts, the same as B3's.
- **Selection mode:**
  - When you send a question, the panel asks the page for its current selection. Non-empty → the answer uses only that text, and the message is marked "From your selection".
  - It needs the content script on the tab, which also works on a page that hasn't been scanned.
- **The find-sections box is removed.** Chat covers it.
- **Cited sections are saved with each message** (`citedSections: [{pageUrl, sectionId}]`, per the schema), so phase 7 can highlight them later.

## Checks for phase 6 (run at the end)
1. On a scanned page, a question answers from the page with [n] citations. The cards match the sections used, and Show on page highlights the right text.
2. On a continued thread, a question about an earlier page cites that page, with a badge and snippet.
3. Select a paragraph and ask "explain this". The answer uses only the selection, with no retrieval in the log.
4. A question the page doesn't cover gets a plain "not covered" answer, not an invented one.
5. Stop mid-answer keeps the partial text. With Gemini failing (an invalid key), the answer comes from Ollama, and the message says so.
6. The conversation shows on every tab in the thread and after a browser restart. Delete thread removes it.
7. Free-tier usage: one Gemini request per question (from the log).
8. Phase 5 behaviour still works. The manifest is unchanged.

## As built (2026-11-07)
- **Files:**
  - `lib/chat-prompt.js`: prompt, history trimming, citation parsing, footnote stripping.
  - `lib/gemini-ladder.js`: model ranking, quota window, park-until-reset.
  - `background/chat.js`: selection or retrieval, the streamed ladder answer, saving on the thread.
  - A "chat" port in `service-worker.js`.
  - `get-selection` in the content script.
  - `updateThread` in the store: an atomic read-modify-write, now also used by scans, so a scan and an answer can't overwrite each other's change to the thread.
- **Panel:**
  - The find box is gone. The view is split: sections on top, the conversation below.
  - User bubbles. Answers support **bold**, bullets and [n] chips; a chip scrolls to and flashes its card.
  - Source cards show a number, a page badge for other pages, the heading and a snippet, plus **Show on page** for this tab's sections.
  - Meta line: "From your selection", "Stopped", and the model with its fallback reason.
  - Enter sends, Shift+Enter adds a new line, and Stop is shown while answering.
- **Small-model guard:** answers that cite nothing show the sections they were given, folded as "not cited".
- **Not saved:** answers that fail or are stopped before any text.

**Run 2026-11-07, automated** (`t6.mjs`). The test browser had an invalid Gemini key on purpose and Ollama `qwen2.5:1.5b`, on White House → Pennsylvania Avenue:
- 0 ✅ Chat is disabled until the page is scanned.
- 1 ✅ The answer is correct (construction began 13 October 1792). The cards are this page's sections, and Show on page highlighted the section. ⚠️ qwen wrote no [n] citations, so the cards came from the "not cited" fallback. Its first try copied a Wikipedia footnote "[28]" as a citation, which led to footnote stripping and to chips only appearing for real source numbers.
- 2 ✅ On the second page the earlier conversation shows. A question about the first page got the White House cards with page badges and no Show on page.
- 3 ✅ Selection: "From your selection", no cards, and the log shows no retrieval.
- 4 ❌ with qwen: asked mercury's boiling point, it answered from its own knowledge, and wrongly (277 K). The instruction is in the prompt; a 1.5B model ignores it. **To check with Gemini.**
- 5 ✅ Stop kept 136 characters, marked "Stopped". Gemini failing gave "local qwen2.5:1.5b (Gemini failed)".
- 6 ✅ After a browser restart, revisiting White House shows all 10 messages.
- 7 ✅ One Gemini request per question before falling back (the log).
- 8 ⏳ Phase 5 recheck not rerun yet. Its script used the removed find box; the thread flows themselves didn't change. The manifest is unchanged.

**Still for the user, with a real key:**
- Checks 1 and 4 on Gemini: does it cite [n], and does it refuse off-topic questions?
- Once one Flash model's quota is used up, the next answers (logged as "quota used up, skipped until …").

## Hallucination control (added 2026-11-07, after check 4 failed with qwen)
The user asked for stricter guards. All three are local and add no LLM call (`lib/grounding.js`):
1. **Relevance gate, before the call.** If no section of the thread scores at least **0.2** against the question, the reply is "The sources don't cover this." and the model isn't asked. The panel says so and offers **Ask anyway**, which replaces that turn. A short follow-up is retried together with the previous question before it's gated.
   - Measured on 5 pages (Wikipedia, MDN, Python docs, React docs): clearly off-topic questions scored ≤ 0.21, real questions ≥ 0.25. The Paul Graham page timed out.
   - Near-topic questions can't be gated this way ("async functions" on the Python control-flow page: 0.47). Guard 2 is for those.
   - A greeting ("hi") is gated too, with the same message. Open idea, not decided: a friendlier reply for small talk.
2. **Grounding check, after the call.** Each answer sentence is compared with ~45-word windows of the sources it was given, and every number in it must appear in the sources (or the question).
   - Nothing found in the sources: shown as "The sources don't cover this.", with the model's text folded away ("none of it is in the sources"). History passes "not covered" on, so later answers don't build on it.
   - Some sentences not found: those get a wavy underline and a note.
   - **Word check (2026-11-07):** a sentence is also found if ≥ 80% of its content words are in the sources (short list items copied from the page scored ~0.2 on similarity and were wrongly underlined). Numbers must match either way.
   - **`SUPPORT_MIN = 0.5`, measured 2026-11-07.** 5 pages (White House, MDN, Python docs, React docs, Photosynthesis). True claims: real source sentences reworded, or cut to short list-style notes, by qwen (51). Made-up claims: qwen answering near-topic questions the pages don't cover, from memory, checked against what retrieval gave for that question (58 sentences, 20 answers). With the word check:

     | Cutoff | True kept | Made-up sentences caught | Made-up answers underlined | Made-up answers hidden |
     |---|---|---|---|---|
     | 0.45 | 92% | 47% | 14/20 | 7/20 |
     | **0.5** | **90%** | **60%** | **14/20** | **8/20** |
     | 0.55 | 82% | 72% | 17/20 | 10/20 |
     | 0.6 | 76% | 83% | 19/20 | 13/20 |

     Three of the five true claims flagged at 0.5 were paraphrases that had lost the meaning. The scores overlap (true median 0.70, made-up 0.46), so no cutoff separates them cleanly. 0.5 favours few false underlines, which the user asked for. The number check catches made-up figures regardless.
3. **The rule is repeated after the question** in the prompt, because small models follow the end of the message more than the system prompt.

Also from the user's testing:
- **Speed:** full Flash models think at "medium" by default and the thinking isn't shown. Chat now asks Flash models for `thinkingLevel: "low"` (3.8's lowest), leaves Flash-Lite at its default "minimal", and retries without the setting if a model rejects it. `maxOutputTokens` went from 1024 to 4096, because the cap includes thinking. The log line has timings (sources, first text, answer, check).
- A "not covered" reply from the model shows the sections it was given, folded (phase 7).

## Timeouts and partial answers (2026-11-07, from the user's testing)
- **Nothing can hang for good any more.** Before, the ladder only moved on an error code, so a request that never answered (with the keep-alive holding the worker up) would wait forever.
  - Gemini with no reply in **25 s**: the next model on the ladder, then Ollama ("Gemini didn't respond").
  - Ollama with no reply in **120 s**: an error.
  - A reply that goes quiet mid-answer for **45 s**: the text so far is kept, marked "Cut off: the model stopped responding".
  - The local embedding step after **90 s**: an error instead of "Finding sources…" for good.
  - Tested with a local server that never answers, and one that goes quiet after a line.
- **A panel reopened mid-answer** shows the real status, not "Finding sources…".
- **Partial answers.** The prompt used to say "not covered" whenever the answer wasn't fully there, so a two-part question ("when was it built, and how many times was it restored?") got a flat refusal. Now the model answers the part the sources cover and says which part they don't. "Not covered" is only for none of it.
- **At least 5 sections** again: blended retrieval is now the plain top 5 plus the centred top 4 (capped at 8). It gave 4 when the two rankings overlapped.
- **Answer sentences** now split like source text ("Chester A. Arthur" isn't two sentences). The split had cut a cited claim in half, so its citation fell back to the whole section.

## Exit criteria for phase 6
- [x] Decisions 1–4 signed off *(2026-11-07; decision 1 as the model ladder)*
- [x] `npm test` passes, with new tests for prompt building, citation parsing and message trimming (`lib/chat-prompt.js`) *(122/122, including `lib/gemini-ladder.test.js`)*
- [ ] Checks 1–8 pass *(automated run: all but 4, which fails with qwen 1.5b, and 8, which isn't rerun yet; 1 and 4 to be confirmed with Gemini)*

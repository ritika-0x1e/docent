# Phase 7 — Citation highlighting

Implementation plan for build-sequence step 7 in `docs/master-spec.md` §6: **F1, F2, F3** (spec §3.8, skill `citation-highlighting`). Phase 6's source cards become real citations: the exact supporting text is highlighted on the live page, and citations from other pages can open that page and highlight there.

**Testing:** per-phase (spec §6a). This phase ends with its own checks (bottom of this doc).

**Before starting (CLAUDE.md):** phase 6 still has open items:
- its checks 4 (an off-topic question that gets past the gate) and 8 (phase 5 regression rerun);
- the grounding-check threshold (`SUPPORT_MIN`, a placeholder 0.5 until measured);
- the docs for the hallucination guards.

## What exists today (phase 4/6 placeholders)
- **Show on page** on source cards and reading-view cards calls phase 4's test highlight (`summarizer-debug`): the whole section, yellow, cleared only when the panel closes.
- [n] chips in an answer only scroll to their card.
- Cards from other pages are snippet-only, with a page badge.
- Google Docs cards have Jump to section (A5a). That stays as it is.

## Scope
- **F1.** A citation highlight on the live page: its own named highlight and style, cleared properly, and never touching the page's DOM.
- **F2.** Each citation maps to its section and to the **passage** inside it that supports the claim. A chip or card click highlights that passage.
- **F3.** For a citation from another page: **Open page and highlight**. It focuses the tab if that page is already open, or opens it, then re-anchors the section and highlights it.
- **Not here:** web search (phase 8), link picklist (phase 9).

## Decisions needing sign-off

**Status 2026-11-07: decisions 1–4 approved as proposed.**


1. **What gets highlighted for [n].**
   - **Proposed: the passage, with the section as context.** When the answer is saved, the answer sentences citing [n] are matched to the most similar sentence windows of section n. This uses the same local embeddings as the grounding check, so there's no extra LLM call. The best one or two windows are saved on the message as text quotes.
   - On the page, the passage gets a strong highlight and the rest of the section a faint one. That shows exactly what supports the claim, and where it sits.
   - Answers that cite nothing (small models) match each sentence across all the sources they were given.
   - Messages saved before phase 7 have no passages, so they highlight the whole section.
   - Alternative: whole section only (what you have today, just clearable).
2. **How a highlight is shown and cleared.**
   - **Proposed:** clicking an [n] chip or a card highlights the passage on the page and scrolls to it. Only one citation is highlighted at a time.
   - It clears on:
     - a second click on the same citation,
     - **Esc** on the page (one key listener in the content script),
     - the next question,
     - closing the panel.
   - The card's button reads **Show on page** / **Clear highlight** to match.
3. **Reading-view section cards (top half).**
   - **Proposed: a jump, not a highlight.** Show on page scrolls to the section and flashes it for about 2 seconds, then the flash fades.
   - That way a lasting highlight on the page always means "what the answer cited".
   - Alternative: keep a lasting whole-section highlight there too, with the same clearing rules.
4. **Open page and highlight (F3).**
   - **Proposed:** if a tab already shows that page (same normalized URL), it's focused. Otherwise the page opens in a **new tab next to the current one**.
   - Once it has loaded, the stored anchors are re-anchored and the passage is highlighted.
   - That tab joins the thread automatically, because the thread already holds the page.
   - If the page has changed and nothing anchors, the card says so ("This text isn't on the page any more") and keeps the snippet.
   - It needs site access, which the all-sites grant from phase 4 gives. If that grant was declined, the click asks for it.

**Defaults that need no sign-off** (say if you disagree):
- ~~Strong yellow passage, faint yellow section.~~ **Changed by the user (2026-11-07):** each citation picks a random colour from a 6-colour palette (never the same twice in a row). The passage gets a translucent tint of it; the rest of the section gets only an underline in the same colour, with no background. One named highlight per colour (`summarizer-cite-<i>`, `summarizer-cite-ctx-<i>`), styles in `background/citation-styles.js`.
- They're inserted the way the debug style is today (`chrome.scripting.insertCSS`), never by changing the page's DOM.
- The phase 4 debug highlight stays only for the console helpers (`highlightSection`) and is no longer used by the panel.
- The saved citation schema grows to `{n, corpusId, sectionId, pageUrl, …, highlightable, jump, passages: [{blockId, exact}]}`. A passage is a substring of one block's stored anchor text, so it's found inside that block's range; live ranges are never stored (spec §3.2).

## Changes during the build (user, 2026-11-07)
- **The [n] chip goes straight to the page.** Clicking it highlights the source, opening or focusing its page if it's another one; a second click clears it. The card no longer flashes first. Only a snippet-only source scrolls to its card.
- **Source cards sit in a closed fold** ("Sources (n)", or "Sources it was given (n), not cited") under each answer; they open only when clicked, and stay as left across re-renders. The [n] chips are the main way in. *(Replaces phase 6 decision 3's always-visible cards.)*
- **"Here" means this tab shows the source's page**, scanned or not (normalized URL), not only after a scan.
- **Saved pages load by themselves.** When the tab's page is already saved in its thread, the panel loads it on open (a cache hit: nothing read or embedded) without Start scan, and without the "already scanned" toast. New pages still wait for Start scan. Spec §3.11 updated.
- **An answer survives closing the panel.** It finishes in the background and is saved on the thread; a panel opened meanwhile rejoins it and streams the rest. Only Stop aborts.
- **Selection-mode answers cite [1] = your selection**, which highlights the selected text on its page.
- **"Not covered" answers from the model show the sections it was given**, folded, so a retrieval miss and an over-strict model can be told apart.
- **Passages are single sentences.** Windows were up to 30 words and tinted neighbouring sentences. Sentence splitting now ignores initials and abbreviations ("Nathan C. Wyeth", "D.C.") and steps over footnote markers ("stone.[25][26] The").

## Follow-ups from the user's testing (2026-11-07)
- **Draggable split** between sections and chat (double-click resets; kept per browser).
- **Clear chat**: a header row over the chat, two clicks; the thread's pages stay.
- **The path card** shows only when there's a path (2+ steps).
- **Grounding check: word check added.** Short list items copied from the page ("1971: Tricia Nixon Cox") scored ~0.2 on similarity and were wrongly underlined. A sentence now counts as found if its numbers are in the sources and either its similarity is ≥ 0.5 or ≥ 80% of its content words are in the sources. On a test list, the two true items now pass and all four made-up ones are still flagged (three by their numbers, one by both checks).
- **Chat input:** no scrollbar until the text is past ~5 lines.
- **Retrieval** (spec §3.7): blended ranking (plain + centred) and typo correction against the pages' own words (`lib/retrieval.js` `blendedTopK`, `lib/spelling.js`). Found when "when was white house built" and "…used for weedings" got "not covered": the right sections ranked 8th and 18th. 35 questions on 5 pages: right section given to the model 29 → 33.

## As built (2026-11-07)
- `lib/passages.js` (+ tests): claims per citation, one-sentence windows per block, best window per claim. `PASSAGE_MIN = 0.6`: on White House / Pennsylvania Avenue the right passage scored 0.71–0.80 and the best text of a miscited section ≤ 0.56. Below the floor the whole section is shown. **To recheck on other pages.**
- `lib/grounding.js`: `splitSentences` shared by grounding and passages.
- `background/chat.js`: `findPassages` (one local embedding call per answer), saved on each citation.
- `content/citations.js`: `highlightCitation`, `flashSection`, `clearCitation`, the Esc listener. Missing or stale block ranges are rebuilt from the stored anchors.
- `background/citation-styles.js`; `service-worker.js`: `panel-show-citation`, `panel-clear-citation`, `focusOrOpen`; `panel-show-section` now flashes; the chat port keeps answers running and has `watch`.
- Panel: citation toggle, active chip and card, clearing on a new question and on Esc.

**Run 2026-11-07, automated** (`t7.mjs`, `t7b.mjs`, `t7c.mjs`; qwen answers, plus one answer rewritten to cite correctly, as Gemini would, with passages recomputed by the real code):
- 1 ✅ The passage ("Construction of the White House began at noon on October 13, 1792…") is tinted, and the rest of the "Construction" section underlined in the same colour. qwen itself cited [1] = "West Wing" for that fact; that section has no passage over the floor, so it showed whole, as intended.
- 2 ✅ A second click, Esc (the panel's label follows), and a new question each clear it. The colours vary.
- 3 ✅ A reading-view card flashes, and the flash is gone after 2 s.
- 4 ✅ Open page and highlight opened White House in a new tab and highlighted it. The second time it focused that tab, with no new tab.
- 5 ✅ An old message without passages tints the whole section.
- 6 — Google Docs not rerun (the jump path is unchanged).
- 7 ✅ No elements added to the page. Wikipedia's own scroll handlers toggle classes; that's not us. The manifest is unchanged.
- Also ✅: a saved page loads without a click; the chip highlights and clears directly, and opens another page; an answer kept streaming after the panel closed and was saved; a selection answer's source highlights the selection.
- 8 ⏳ Phase 6 chat behaviour was exercised by these runs, but its full check list wasn't rerun.

## Checks for phase 7 (run at the end)
1. On a scanned page, clicking an answer's [n] highlights the supporting sentence(s) strongly and the rest of the section faintly, and scrolls there. The highlighted text supports the claim it was cited for.
2. Clicking the same [n] again, pressing Esc on the page, asking another question, and closing the panel each clear it. Only one citation is highlighted at a time.
3. A reading-view card's Show on page scrolls there and flashes, then the flash fades, and nothing stays highlighted.
4. In a two-page thread, Open page and highlight on a card from the other page:
   - If that page is open in a tab, it focuses that tab and highlights the passage.
   - If it isn't, it opens the page in a new tab and highlights there.
5. A message saved before phase 7 still highlights its whole section.
6. A Google Docs citation still uses Jump to section, with no highlight.
7. The page's DOM is unchanged (no added elements or attributes), and the manifest is unchanged.
8. Phase 6 chat still works (questions, gate, grounding notes, Stop).

## Exit criteria for phase 7
- [x] Decisions 1–4 signed off *(2026-11-07, all as proposed)*
- [x] `npm test` passes, with new tests for passage matching (a pure function in `lib/`) *(135/135)*
- [ ] Checks 1–8 pass *(automated: 1–5 and 7 pass; 6 and 8 not rerun; your check with Gemini answers to do)*

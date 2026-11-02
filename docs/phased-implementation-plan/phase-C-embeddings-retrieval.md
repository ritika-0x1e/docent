# Phase C — Local embeddings, storage & retrieval

Implementation plan for sub-feature **C** (`docs/master-spec.md` §5.C, §3.7), third step of the build sequence in §6. Covers C1–C3. Builds on Phase B's sections and on the embedding worker Phase B pulled forward (`phase-B-sectioning.md`, decision 1).

**Testing strategy (approved 2026-11-02):** part of the combined B + C + 4 run at the end of phase 4. Only the checkpoints below are tested before phase 4 starts. See master-spec §6a.

## Scope recap (from spec)
- C1. Transformers.js + MiniLM running in a Web Worker. *Already built in Phase B.* Phase C adds section-level embedding and query embedding on top of it.
- C2. IndexedDB schema for section vectors + metadata (per-page corpus)
- C3. Cosine similarity top-k retrieval function

## Decisions (approved 2026-11-03; recorded in master-spec §3.7 / §5.C2)

1. **Several vectors per section, not one.** `all-MiniLM-L6-v2` reads at most 256 tokens (about 180–200 words) and silently ignores the rest. B2 sections run up to 600 words, and B1 sections have no upper limit, so one vector per section would represent only its opening paragraph. A question about the end of a section would never find it.

   Proposal: split each section's text into **chunks** of about 180 words with a 30-word overlap, embed each chunk, and score a section by its **best-matching chunk** (max similarity). Retrieval still returns *sections*, so `retrieve_sections(query, k)` (E1) and citations (F2) are unchanged. Spec §5.C2 says "section vectors"; this makes it "section chunk vectors".

There are no other deviations. Everything else below follows the spec and CLAUDE.md as written.

## Runtime flow this phase implements

```
Phase B produces sections (boundaries fixed)
  → background: chunk each section (pure, lib/chunk.js)
  → background → offscreen → worker: embed chunks         ┐ runs in parallel with B3:
  → background: B3 headings/summaries (Phase B)            ┘ chunk text doesn't depend on generated headings
  → background: one IndexedDB transaction writes corpus + sections + chunk vectors
                                    ↓
query (console now; side panel debug box in phase 4 if approved; E1 in phase 6)
  → embed query → load the corpus's chunk vectors → lib/retrieval.js top-k → sections with scores
```

Chunk text is prefixed with the section's **HTML** heading path when one exists (`"Installation > Linux\n…"`), since headings carry strong retrieval signal. Generated (B3) headings are left out on purpose: it keeps embedding independent of the LLM step, so the two run in parallel and an LLM failure can't affect retrieval.

## File layout

```
/lib/chunk.js                    chunkSection(section, {chunkWords, overlapWords}) — pure
/lib/retrieval.js                topKSections(queryVec, chunkRecords, k) — pure; uses lib/vector.js from Phase B
/background/vendor/idb.js        vendored `idb` UMD build (version pinned), loaded via importScripts
/background/store.js             IndexedDB open/upgrade, saveCorpus(), getCorpus(), getChunkVectors(), deleteCorpus()
/background/embedder.js          embedChunks(sections), embedQuery(text): wraps Phase B's offscreen-client
/background/service-worker.js    harness extended: store after scan, query()/listCorpora()/clearCorpora() helpers
/lib/chunk.test.js, /lib/retrieval.test.js
```

`idb` is the wrapper `docs/reusable-skills.md` already points to. Its UMD build works with `importScripts`, so the service worker stays a classic script (see Phase B, "Loading").

## C1 — Section and query embedding

- `embedChunks(sections)` sends every chunk of a page to the worker in one message, batched inside the worker. It gets back 384-dim normalized vectors, which become `Float32Array`s before storage.
- `embedQuery(text)` uses the same model and pooling. MiniLM is symmetric, so queries need no prefix.
- Each corpus record stores the model id. If the model ever changes, vectors from the old model are never mixed with query vectors from the new one; that corpus must be re-scanned. Nothing is migrated automatically.

## C2 — IndexedDB schema

Database `summarizer`, version 1. It's owned by the background service worker; the side panel asks the background for data and never opens the database itself. This matches CLAUDE.md ("background: … storage access"). Content scripts can't use it anyway: they run on the page's origin, not the extension's.

| Store | Key | Indexes | Record |
|---|---|---|---|
| `corpora` | `corpusId` | `url` | `{corpusId, url, title, scannedAt, method, sectionCount, embeddingModel}` |
| `sections` | `[corpusId, sectionId]` | `corpusId` | Phase B's `Section` (heading, headingSource, headingPath, summary, text, method, blocks + anchors) |
| `chunks` | `[corpusId, sectionId, chunkIndex]` | `corpusId` | `{corpusId, sectionId, chunkIndex, vector: Float32Array}` |

- `corpusId` comes from `crypto.randomUUID()`. It is the `corpusRef` that `Thread.pages[]` points to in phase 5 (`thread-data-model` skill).
- **One write, at the end.** A corpus is saved in a single transaction across all three stores, only after sectioning, embedding and B3 have all finished. A scan that fails partway leaves nothing behind.
- Chunk text isn't stored, since it's recomputable from the section text with `lib/chunk.js`. Only vectors are kept.
- No dedupe by URL and no cleanup in this phase: each scan creates a new corpus. Cache hits and attaching corpora to threads are phase 5 (G3/H2). In the meantime the harness has `clearCorpora()`.

## C3 — Top-k retrieval

`lib/retrieval.js`, `topKSections(queryVec, chunkRecords, k = 5)`, pure:

- Vectors are unit-length, so cosine similarity is a dot product.
- A section's score is the maximum over its chunks. The function returns the top `k` sections as `{corpusId, sectionId, score, bestChunkIndex}`, sorted by score, with ties going to the section earlier in the page.
- It's brute force over all chunks of the given corpora. At page scale (tens to low hundreds of chunks, at most ~8 pages per thread) that's well under a millisecond, and the spec rules out a vector DB.
- **No minimum-score cutoff here.** Scores are returned so E1 (phase 6) can decide when the page "doesn't cover" a question and `web_search` should be offered. Picking that threshold is E's job, not C's.

Background wrapper: `retrieve(corpusIds, queryText, k)` embeds the query, loads the chunk vectors for those corpora, calls `topKSections`, then joins in the section records.

## Test harness (extends Phase B's)

- A scan now ends with "stored corpus `<id>`" plus the chunk count and embedding time.
- `query(corpusId, "question", k = 5)` logs a `console.table` of `{rank, score, heading, preview}` and highlights the top hit using Phase B's `highlightSection`.
- `listCorpora()` and `clearCorpora()` are available.

## Test plan

**Unit (`npm test`):**
- `lib/chunk.js`: a short section gives one chunk; a long section gives overlapping chunks with exact boundaries; the heading-path prefix is applied only for `headingSource: "html"`; empty text is handled.
- `lib/retrieval.js`: max-over-chunks scoring (a section whose second chunk matches outranks one with a weak single chunk); `k` larger than the section count; tie ordering; vectors from several corpora pooled together.

**Manual (combined run):** see the phase 4 plan's combined test list.

## Checkpoints: test these before starting phase 4

- [ ] **CP-C1: retrieval sanity on one real page.** Scan the headed docs page, then ask 3 questions with `query(...)`: one whose answer is in an early section, one in a late section, and one whose answer sits deep inside a long section. Pass: the right section is in the top 3 for all three, and the third question specifically shows that chunking works. *Why now:* if retrieval quality is wrong, the fix (chunk size, heading prefix) belongs in C. In the combined run it would look like a side-panel problem.
- [ ] **CP-C2: data survives a service-worker restart.** After a scan, open `chrome://serviceworker-internals`, click **Stop** on the Summarizer worker, then run `listCorpora()` again (opening the console wakes the worker). Pass: the corpus is still there and `query` still works. *Why now:* MV3 kills idle service workers after ~30s, so anything that only lived in memory would vanish between scans and chat in phase 4+.

## Exit criteria for Phase C (ticked during the combined run, except unit tests and checkpoints)

- [ ] `lib/chunk.js` and `lib/retrieval.js` unit tests pass
- [ ] A scan writes one corpus with all its sections and chunk vectors in a single transaction; a scan that fails partway writes nothing
- [ ] `query()` returns sensible top-5 sections on a headed page and a headingless page
- [ ] Stored corpora survive a service-worker restart
- [ ] No new permissions (IndexedDB is available to extensions without one)

## Build order inside the phase

1. `lib/chunk.js` + tests, then `background/embedder.js`. Verify the chunk count and vector shapes in the console.
2. `background/store.js` (vendor `idb`). Verify save, get and delete from the console.
3. `lib/retrieval.js` + tests, then `retrieve()` + the `query()` helper. **Run CP-C1 and CP-C2.**

Then move to phase 4 (`phase-4-side-panel-shell.md`).

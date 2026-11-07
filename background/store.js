// C2: per-page corpus storage in the extension's IndexedDB. Owned by the background service worker;
// other contexts ask it for data rather than opening the database themselves.
// Schema: docs/phased-implementation-plan/phase-C-embeddings-retrieval.md ("C2"); threads (G1) were
// added in v2, docs/phased-implementation-plan/phase-5-threads.md.
// Loaded into the service worker with importScripts(), after vendor/idb.js (global `idb`).

const DB_NAME = "summarizer";
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  dbPromise ??= idb.openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore("corpora", { keyPath: "corpusId" }).createIndex("url", "url");
        db.createObjectStore("sections", { keyPath: ["corpusId", "id"] }).createIndex("corpusId", "corpusId");
        db.createObjectStore("chunks", { keyPath: ["corpusId", "sectionId", "chunkIndex"] }).createIndex("corpusId", "corpusId");
      }
      // v2 (phase 5): phase-4 corpora stay as they are, belonging to no thread.
      if (oldVersion < 2) db.createObjectStore("threads", { keyPath: "id" });
    },
  });
  return dbPromise;
}

/**
 * Writes a corpus, its sections and chunk vectors in one transaction: either all of it is saved or
 * none of it is, so a scan that fails partway leaves nothing behind.
 * @returns {Promise<string>} corpusId — the corpusRef Thread.pages[] will point to (phase 5)
 */
async function saveCorpus({ url, title, source, embeddingModel, sections, chunks, links = null, crawl = null }) {
  const corpusId = crypto.randomUUID();
  const db = await openDb();
  const tx = db.transaction(["corpora", "sections", "chunks"], "readwrite");

  tx.objectStore("corpora").put({
    corpusId,
    url,
    title,
    source,
    method: sections[0]?.method ?? null,
    sectionCount: sections.length,
    chunkCount: chunks.length,
    embeddingModel,
    scannedAt: Date.now(),
    links, // phase 9: scored links for the picklist (null: scanned before phase 9, or a crawled page)
    crawl, // phase 9: {linkedFrom: {url, title}, viaAnchorText} for a page added from the picklist
  });
  sections.forEach((s, order) => tx.objectStore("sections").put({ corpusId, order, ...s }));
  for (const c of chunks) {
    tx.objectStore("chunks").put({ corpusId, sectionId: c.sectionId, chunkIndex: c.chunkIndex, vector: new Float32Array(c.vector) });
  }

  await tx.done; // rejects (and nothing is committed) if any put failed
  return corpusId;
}

async function getCorpus(corpusId) {
  const db = await openDb();
  const corpus = await db.get("corpora", corpusId);
  if (!corpus) return null;
  const sections = await db.getAllFromIndex("sections", "corpusId", corpusId);
  return { corpus, sections: sections.sort((a, b) => a.order - b.order) };
}

async function getSections(corpusId, sectionIds) {
  const db = await openDb();
  return Promise.all(sectionIds.map((id) => db.get("sections", [corpusId, id])));
}

async function getChunkVectors(corpusIds) {
  const db = await openDb();
  const perCorpus = await Promise.all(corpusIds.map((id) => db.getAllFromIndex("chunks", "corpusId", id)));
  return perCorpus.flat();
}

// Rewrites section records in place (e.g. after "Retry headings"). Chunk vectors are untouched:
// they never depend on generated headings.
async function updateSections(corpusId, sections) {
  const db = await openDb();
  const tx = db.transaction("sections", "readwrite");
  for (const s of sections) tx.store.put({ ...s, corpusId });
  await tx.done;
}

async function listStoredCorpora() {
  const db = await openDb();
  return (await db.getAll("corpora")).sort((a, b) => b.scannedAt - a.scannedAt);
}

async function deleteCorpus(corpusId) {
  const db = await openDb();
  const tx = db.transaction(["corpora", "sections", "chunks"], "readwrite");
  tx.objectStore("corpora").delete(corpusId);
  for (const store of ["sections", "chunks"]) {
    let cursor = await tx.objectStore(store).index("corpusId").openCursor(corpusId);
    while (cursor) {
      cursor.delete();
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

const STORE_NAMES = ["corpora", "sections", "chunks", "threads"];

// Everything, threads included: a thread without its corpora would only point at nothing.
async function clearStoredCorpora() {
  const db = await openDb();
  const tx = db.transaction(STORE_NAMES, "readwrite");
  await Promise.all(STORE_NAMES.map((name) => tx.objectStore(name).clear()));
  await tx.done;
}

// G1: threads, kept apart from the corpora they point to (Thread.pages[].corpusRef).
async function saveThread(thread) {
  const db = await openDb();
  await db.put("threads", thread);
  return thread;
}

// Read-modify-write in one transaction, so a scan adding a page and a chat answer adding messages
// can't overwrite each other. `change` must be synchronous (an await would end the transaction).
// Returns the saved thread, or null if it no longer exists.
async function updateThread(id, change) {
  const db = await openDb();
  const tx = db.transaction("threads", "readwrite");
  const current = await tx.store.get(id);
  const next = current ? change(current) : null;
  if (next) tx.store.put(next);
  await tx.done;
  return next;
}

async function getThread(id) {
  const db = await openDb();
  return (await db.get("threads", id)) ?? null;
}

async function listStoredThreads() {
  const db = await openDb();
  return sortThreads(await db.getAll("threads"));
}

// Decision 3: a thread goes with its corpora. Each scan makes its own corpus (spec §3.5a), so no
// other thread points at them. Corpora first: if that fails, the thread is still there to retry.
async function deleteThread(id) {
  const thread = await getThread(id);
  if (!thread) return false;
  for (const ref of corpusRefs(thread)) await deleteCorpus(ref);
  const db = await openDb();
  await db.delete("threads", id);
  return true;
}

// C2: per-page corpus storage in the extension's IndexedDB. Owned by the background service worker;
// other contexts ask it for data rather than opening the database themselves.
// Schema: docs/phased-implementation-plan/phase-C-embeddings-retrieval.md ("C2").
// Loaded into the service worker with importScripts(), after vendor/idb.js (global `idb`).

const DB_NAME = "summarizer";
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  dbPromise ??= idb.openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore("corpora", { keyPath: "corpusId" }).createIndex("url", "url");
      db.createObjectStore("sections", { keyPath: ["corpusId", "id"] }).createIndex("corpusId", "corpusId");
      db.createObjectStore("chunks", { keyPath: ["corpusId", "sectionId", "chunkIndex"] }).createIndex("corpusId", "corpusId");
    },
  });
  return dbPromise;
}

/**
 * Writes a corpus, its sections and chunk vectors in one transaction: either all of it is saved or
 * none of it is, so a scan that fails partway leaves nothing behind.
 * @returns {Promise<string>} corpusId — the corpusRef Thread.pages[] will point to (phase 5)
 */
async function saveCorpus({ url, title, source, embeddingModel, sections, chunks }) {
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

const STORE_NAMES = ["corpora", "sections", "chunks"];

async function clearStoredCorpora() {
  const db = await openDb();
  const tx = db.transaction(STORE_NAMES, "readwrite");
  await Promise.all(STORE_NAMES.map((name) => tx.objectStore(name).clear()));
  await tx.done;
}

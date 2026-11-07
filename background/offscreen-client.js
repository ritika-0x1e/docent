// Background side of the embedding pipeline: creates the offscreen document on demand and
// sends it texts to embed. Loaded into the service worker with importScripts().

const OFFSCREEN_PATH = "offscreen/offscreen.html";

let creatingOffscreen = null; // shared promise so concurrent callers don't create two documents

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length > 0) return;

  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.DOM_PARSER],
      justification: "Runs the local embedding model in a Web Worker, and parses linked pages the user chose to add",
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

/**
 * @param {string[]} texts
 * @returns {Promise<{vectors: number[][], stats: {count, msModelLoad, msEmbed}}>} 384-dim unit vectors
 *   as plain arrays (runtime messages are JSON-serialized, so typed arrays don't survive the trip)
 */
const EMBED_TIMEOUT_MS = 90000; // generous: the first use downloads and loads the model

async function embedTexts(texts) {
  if (texts.length === 0) return { vectors: [], stats: { count: 0, msModelLoad: 0, msEmbed: 0 } };

  await ensureOffscreenDocument();
  // A hung model or worker would otherwise leave a question on "Finding sources…" for good.
  let timer;
  const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`The local embedding model didn't answer within ${EMBED_TIMEOUT_MS / 1000}s. Try again; if it repeats, reload the extension.`)), EMBED_TIMEOUT_MS)));
  const response = await Promise.race([chrome.runtime.sendMessage({ target: "offscreen", type: "embed", texts }), timeout]).finally(() => clearTimeout(timer));
  if (!response?.ok) throw new Error(response?.error || "no response from the offscreen document");
  return { vectors: response.vectors, stats: response.stats };
}

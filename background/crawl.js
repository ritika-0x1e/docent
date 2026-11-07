// D6 (phase 9): add the linked pages the user ticked in the picklist to the thread. Approval is the
// only trigger: this runs only from the panel's "Add" with the ticked links. Per page: fetch the
// HTML → read it in the offscreen document (DOMParser + the scan's extraction code) → B2 if it has
// no headings → embed → save its corpus → append it to the thread, tagged with where it was linked
// from. One page at a time; Stop keeps the pages already added. Nothing else on the web is fetched.
// Loaded into the service worker with importScripts(). Skill: crawl-approved-links.

const crawls = new Map(); // threadId → AbortController of the running crawl
const FETCH_TIMEOUT_MS = 20000;

async function fetchPageHtml(url, signal) {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetch(url, { signal: AbortSignal.any([signal, timeout]), credentials: "omit", redirect: "follow" });
  if (!response.ok) throw new Error(`The site answered ${response.status}.`);
  const type = response.headers.get("content-type") ?? "";
  if (!/html/i.test(type)) throw new Error(`Not a web page (${type.split(";")[0] || "unknown type"}).`);
  return { html: await response.text(), finalUrl: response.url || url };
}

async function readLinkedPage(url, signal) {
  const { html, finalUrl } = await fetchPageHtml(url, signal);
  await ensureOffscreenDocument();
  const read = await chrome.runtime.sendMessage({ target: "offscreen", type: "extract-html", html, url: finalUrl });
  if (!read?.ok) throw new Error(read?.error ?? "Couldn't read the page.");
  let raw = read.sections;
  if (!raw) raw = (await sectionSemantically(read.blocks)).sections; // B2, as for a scanned page
  const sections = applyResults(finalizeSections(raw, read.blocks), new Map());
  const embedded = await embedSectionChunks(sections);
  return { title: read.title, url: finalUrl, sections, embedded };
}

/**
 * @param {{threadId, from: {url, title}, links: {url, anchorText}[]}} request
 * @param {(progress) => void} onProgress  {stage: "page", index, total, url} | {stage: "added", url, title, thread} | {stage: "failed", url, error}
 * @returns {Promise<{added: number, failed: {url, anchorText, error}[], stopped: boolean, thread}>}
 */
async function crawlLinks({ threadId, from, links }, onProgress = () => {}) {
  if (crawls.has(threadId)) throw new Error("Pages are already being added to this thread.");
  const controller = new AbortController();
  crawls.set(threadId, controller);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000); // MV3 idle timer
  const failed = [];
  let added = 0;
  let thread = await getThread(threadId);
  try {
    for (const [index, link] of links.entries()) {
      if (controller.signal.aborted) break;
      if (!thread) throw new Error("This thread was deleted.");
      if (findPage(thread, link.url)) continue; // already in the thread
      onProgress({ stage: "page", index, total: links.length, url: link.url, anchorText: link.anchorText });
      try {
        const page = await readLinkedPage(link.url, controller.signal);
        const crawl = { linkedFrom: { url: from.url, title: from.title }, viaAnchorText: link.anchorText };
        const corpusId = await saveCorpus({ url: page.url, title: page.title, source: "crawl", embeddingModel: page.embedded.stats.model, sections: page.sections, chunks: page.embedded.chunks, crawl });
        const entry = { url: page.url, title: page.title, corpusRef: corpusId, crawled: true, ...crawl };
        const saved = await updateThread(threadId, (fresh) => (findPage(fresh, page.url) ? fresh : withPage(fresh, entry, Date.now())));
        if (!saved) {
          await deleteCorpus(corpusId).catch(() => {});
          throw new Error("This thread was deleted.");
        }
        thread = saved;
        added++;
        console.log(`[Summarizer/D6] added "${page.title}" (${page.sections.length} sections, linked from "${from.title}" via "${link.anchorText}")`);
        onProgress({ stage: "added", url: link.url, title: page.title, thread });
      } catch (err) {
        if (controller.signal.aborted) break;
        if (err.message === "This thread was deleted.") throw err;
        const error = err.name === "TimeoutError" ? "The site took too long to answer." : err.message;
        console.warn(`[Summarizer/D6] couldn't add ${link.url}: ${error}`);
        failed.push({ url: link.url, anchorText: link.anchorText, error });
        onProgress({ stage: "failed", url: link.url, error });
      }
    }
    return { added, failed, stopped: controller.signal.aborted, thread };
  } finally {
    clearInterval(keepAlive);
    crawls.delete(threadId);
  }
}

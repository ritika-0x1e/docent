// Offscreen document: hosts the embedding worker for the background service worker, which can't
// spawn workers itself. Relays {target: "offscreen", type: "embed", texts} → {ok, vectors, stats}.

let worker = null;
let nextId = 0;
const pending = new Map(); // request id → {resolve, reject}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(chrome.runtime.getURL("workers/embed-worker.js"), { type: "module" });

  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data);
  };

  // Load failures (bad import, CSP blocking wasm) and crashes land here. Fail everything in
  // flight and drop the worker so the next request starts a fresh one.
  worker.onerror = (event) => {
    const error = new Error(event.message || "embedding worker failed to load or crashed");
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker = null;
  };

  return worker;
}

function embedInWorker(texts) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, texts });
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "embed") return; // not ours

  embedInWorker(message.texts).then(
    ({ vectors, stats }) => sendResponse({ ok: true, vectors, stats }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true; // response is async
});

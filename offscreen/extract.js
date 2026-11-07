// D6 (phase 9): reads an approved linked page for the background, which fetched its HTML (a service
// worker has no DOMParser). The same steps as a scan's content script, minus everything that needs
// the live page: Readability → blocks → B1 heading split. There's no page to anchor to, so each block
// stores its own text as its anchor; when the page is opened later, its ranges are found from that
// text (phase 5 cache hit, phase 7 citations). Classification is skipped (no layout to measure);
// too little text is reported instead.
// Relays {target: "offscreen", type: "extract-html", html, url} → {ok, title, blocks, sections} | {ok: false, error}.

const MIN_WORDS = 120;

function extractFromHtml(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const base = doc.createElement("base");
  base.href = url; // relative links and images resolve against the page, not the extension
  doc.head.prepend(base);
  for (const el of doc.querySelectorAll(".mw-editsection, script, style, noscript")) el.remove();
  const article = new Readability(doc, { serializer: (el) => el }).parse();
  if (!article?.content) return { ok: false, error: "No article text found (the page may build its text with JavaScript)." };
  const blocks = dropTrailingBackMatter(parseBlocks(article.content)).map((b) => ({
    ...b,
    anchor: { exact: b.anchorText ?? b.text, prefix: "", suffix: "" },
    anchored: true, // "can be looked for on the page": found when the page is opened
    match: null,
  }));
  const words = blocks.reduce((n, b) => n + b.wordCount, 0);
  if (words < MIN_WORDS) return { ok: false, error: `Only ${words} words of text found (the page may build its text with JavaScript).` };
  return { ok: true, title: article.title || doc.title || url, blocks, sections: splitByHeadings(blocks) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "extract-html") return;
  try {
    sendResponse(extractFromHtml(message.html, message.url));
  } catch (err) {
    sendResponse({ ok: false, error: `Couldn't read the page: ${err.message}` });
  }
});

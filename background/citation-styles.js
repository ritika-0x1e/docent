// F1 (phase 7): the ::highlight styles for citations, inserted into a tab with
// chrome.scripting.insertCSS (no page DOM change, not subject to the page's CSP). One named highlight
// per palette colour, because a ::highlight rule can't take its colour from script. Passage: a
// translucent tint that reads on light and dark pages, with the page's own text colour. Context (the
// rest of the section): an underline in the same colour, no background (user, 2026-11-07).
// content/citations.js picks the colour; its CITE_COLORS must match the palette length.
// Loaded into the service worker with importScripts().

const CITE_PALETTE = [
  [255, 196, 0], // amber
  [255, 107, 129], // coral
  [46, 204, 113], // green
  [56, 152, 255], // blue
  [176, 120, 255], // violet
  [0, 200, 200], // teal
];

const CITATION_CSS = [
  ...CITE_PALETTE.flatMap(([r, g, b], i) => [
    `::highlight(summarizer-cite-${i}) { background-color: rgba(${r}, ${g}, ${b}, 0.32); }`,
    `::highlight(summarizer-cite-ctx-${i}) { text-decoration: underline 2px rgba(${r}, ${g}, ${b}, 0.85); text-underline-offset: 3px; }`,
  ]),
  "::highlight(summarizer-flash) { background-color: rgba(56, 152, 255, 0.22); }",
].join("\n");

const styledTabs = new Set(); // per service-worker lifetime; inserting twice is harmless

async function ensureCitationStyles(tabId) {
  if (styledTabs.has(tabId)) return;
  await chrome.scripting.insertCSS({ target: { tabId }, css: CITATION_CSS });
  styledTabs.add(tabId);
}

// A navigation drops inserted CSS along with the page.
chrome.tabs.onUpdated.addListener((tabId, info) => info.status === "loading" && styledTabs.delete(tabId));
chrome.tabs.onRemoved.addListener((tabId) => styledTabs.delete(tabId));

// A5: pick the extraction path for this page and produce blocks for it.
//   "gdocs"    → Google Docs HTML export (the live page body is a canvas)
//   "markdown" → raw .md shown as plain text
//   "dom"      → Readability on the live page (Phase A)
// See docs/phased-implementation-plan/phase-A5-special-sources.md.

var MARKDOWN_CONTENT_TYPES = new Set(["text/markdown", "text/x-markdown"]);
var GDOCS_HEADING_TAGS = ["H1", "H2", "H3", "H4"];

// Thrown for source-specific failures that deserve their own user-facing message (not A4's).
var SourceError = class SourceError extends Error {
  constructor(reason, detail) {
    super(detail);
    this.reason = reason;
  }
}

function detectSource() {
  const docs = parseDocsUrl(location.href);
  if (docs) return { kind: "gdocs", docs };

  const type = document.contentType;
  if (MARKDOWN_CONTENT_TYPES.has(type) || (type === "text/plain" && /\.(md|markdown)$/i.test(location.pathname))) {
    return { kind: "markdown" };
  }
  return { kind: "dom" };
}

// DOMParser.parseFromString is a Trusted Types sink. Docs enforces Trusted Types; whether that
// reaches this isolated world is what CP-A5-1 checks. If it does, retry through a TT policy.
function parseHtml(html) {
  try {
    return new DOMParser().parseFromString(html, "text/html");
  } catch (err) {
    if (!globalThis.trustedTypes) throw err;
    try {
      const policy = trustedTypes.createPolicy("summarizer-export", { createHTML: (s) => s });
      return new DOMParser().parseFromString(policy.createHTML(html), "text/html");
    } catch (policyErr) {
      throw new SourceError("gdocs-trusted-types", `DOMParser blocked by Trusted Types: ${policyErr.message}`);
    }
  }
}

// Strips export-only noise: the table of contents (paragraphs that are nothing but internal
// heading links) and comment/footnote markers and bodies.
function cleanDocsExport(body) {
  for (const p of body.querySelectorAll("p")) {
    const text = normalizeText(p.textContent || "");
    // Any in-page link: some exports link TOC entries to "#h.…", others (observed) to a bare "#".
    const linkText = [...p.querySelectorAll('a[href^="#"]')]
      .map((a) => a.textContent)
      .join("");
    if (text && normalizeText(linkText) === text) p.remove();
  }
  for (const a of body.querySelectorAll('a[id^="cmnt"], a[id^="ftnt"]')) {
    if (/^(cmnt|ftnt)_ref/.test(a.id)) {
      (a.closest("sup") || a).remove(); // inline marker like [a] or [1]
    } else {
      (a.closest("div") || a.closest("p") || a).remove(); // the comment/footnote body at the end
    }
  }
}

async function extractGoogleDoc(docs) {
  let response;
  try {
    response = await fetch(exportUrl(docs), { credentials: "include" });
  } catch (err) {
    // A redirect to the sign-in page is cross-origin, so it surfaces as a network error.
    throw new SourceError("gdocs-export-failed", `export fetch failed (sign-in needed?): ${err.message}`);
  }
  const type = response.headers.get("content-type") || "";
  if (!response.ok || !type.includes("text/html")) {
    throw new SourceError("gdocs-export-failed", `export returned HTTP ${response.status} (${type || "no content type"})`);
  }

  const exported = parseHtml(await response.text());
  cleanDocsExport(exported.body);
  return {
    title: normalizeText(exported.title || "") || document.title,
    blocks: parseBlocks(exported.body, { headingTags: GDOCS_HEADING_TAGS }),
  };
}

function extractMarkdown() {
  // Chrome shows plain-text files as a single <pre>.
  const source = (document.querySelector("pre") || document.body).textContent || "";
  const blocks = markdownToBlocks(source);
  const firstH1 = blocks.find((b) => b.type === "heading" && b.level === 1);
  return {
    title: firstH1?.text || decodeURIComponent(location.pathname.split("/").pop() || document.title),
    blocks,
  };
}

// A5a jump targets. The export carries no heading ids (observed: no id attributes, TOC links are a
// bare "#"), so a jump is "click this heading in the live doc's outline sidebar" — the outline is
// real DOM text. Repeated heading text is told apart by occurrence, counted in document order over
// all headings (including empty-bodied ones), which is the order the outline lists them in.
function addOutlineJumps(sections, blocks) {
  const occurrenceOf = new Map(); // heading block id → nth heading with that text
  const seen = new Map();
  for (const b of blocks) {
    if (b.type !== "heading") continue;
    const n = seen.get(b.text) ?? 0;
    occurrenceOf.set(b.id, n);
    seen.set(b.text, n + 1);
  }
  for (const s of sections) {
    s.jump =
      s.heading === null ? null : { kind: "gdocs-outline", headingText: s.heading, occurrence: occurrenceOf.get(s.blockIds[0]) ?? 0 };
  }
}

// Docs' outline items are Closure UI components: they react to a mousedown/mouseup sequence, not
// to a bare click() or keyboard events (both tried, CP-A5-1). The class names are Docs internals,
// so this is the most fragile selector in the project — the failure message says what to check.
var OUTLINE_ITEM_SELECTOR = ".navigation-item";
var OUTLINE_TEXT_SELECTOR = ".navigation-item-content";

function jumpToOutlineHeading({ headingText, occurrence }) {
  const items = [...document.querySelectorAll(OUTLINE_ITEM_SELECTOR)];
  if (items.length === 0) {
    return { ok: false, error: "Docs outline not found on the page — open the document outline (left sidebar) and try again" };
  }
  const matches = items.filter((item) => normalizeText(item.querySelector(OUTLINE_TEXT_SELECTOR)?.textContent || "") === headingText);
  const target = matches[occurrence] ?? matches[0];
  if (!target) return { ok: false, error: `no outline entry for "${headingText}" (${items.length} entries in the outline)` };

  for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
  }
  return { ok: true, matches: matches.length, usedOccurrence: matches[occurrence] ? occurrence : 0 };
}

// Word count straight from the blocks; media area is 0 — a Docs canvas would otherwise read as
// "media-dominated", and a plain-text page has no media.
function measureBlocks(blocks) {
  return { wordCount: blocks.reduce((n, b) => n + b.wordCount, 0), mediaArea: 0, contentArea: 1 };
}

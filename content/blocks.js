// B1/B2 shared input: walk a content element (Readability's, from the detached clone, or a Google
// Docs export) into an ordered list of blocks.
// See docs/phased-implementation-plan/phase-B-sectioning.md ("Blocks").

// h1 is absent by default: Readability renames article h1s to h2 (the title comes as article.title).
// The Google Docs export passes its own set, since there h1 is a real "Heading 1".
// h5/h6 are treated as text — too fine-grained to be worth a section boundary.
const DEFAULT_HEADING_TAGS = ["H2", "H3", "H4"];
const BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, pre, blockquote, table, figcaption, ul, ol, dl";

// Readability turns any <div> (and old <font> wrappers) without block children into a <p>, and it
// doesn't count headings as block children. So a <p> can end up holding real blocks:
// - Wikipedia's <div class="mw-heading"><h2>…</h2></div> becomes <p><h2>…</p> when the heading has
//   no [edit] link beside it (combined run, White House);
// - paulgraham.com's <font> around a whole essay becomes one <p> holding all 73 paragraphs
//   (combined run test 8, "Do Things That Don't Scale").
// The outer <p> would win and swallow everything, so unwrap it. Loose text between the inner blocks
// (e.g. the essay's date) is kept, wrapped in its own <p>.
// contentEl is Readability's detached clone or a parsed export, never the live page.
const INNER_BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, pre, blockquote, table, ul, ol, dl";

function unwrapBlockParagraphs(contentEl) {
  const doc = contentEl.ownerDocument;
  for (const p of contentEl.querySelectorAll("p")) {
    if (!p.querySelector(INNER_BLOCK_SELECTOR)) continue;
    const out = [];
    let run = [];
    const flush = () => {
      if (run.some((n) => n.textContent.trim())) {
        const wrap = doc.createElement("p");
        wrap.append(...run);
        out.push(wrap);
      } else out.push(...run);
      run = [];
    };
    for (const child of [...p.childNodes]) {
      const isBlock = child.nodeType === 1 && (child.matches(INNER_BLOCK_SELECTOR) || child.querySelector(INNER_BLOCK_SELECTOR));
      if (isBlock) {
        flush();
        out.push(child);
      } else run.push(child);
    }
    flush();
    p.replaceWith(...out);
  }
}

// A layout wrapper rather than a block: most of its text (WRAPPER_SHARE) sits in nested blocks.
// Old-style pages put a whole article in a <table> or <blockquote> (combined run, 2026-11-06:
// Lincoln's second inaugural came out as one 1,058-word block), and long lists of <p>-holding
// items do the same. A real quote, data table or plain list keeps most text as its own and stays
// one block. Text in a wrapper outside its nested blocks is dropped, at most 1 - WRAPPER_SHARE.
const WRAPPER_SHARE = 0.8;

function holdsBlocks(el) {
  const nested = [...el.querySelectorAll(BLOCK_SELECTOR)].filter((d) => d.parentElement.closest(BLOCK_SELECTOR) === el);
  if (nested.length === 0) return false;
  const own = normalizeText(el.textContent || "").length;
  const inNested = nested.reduce((n, d) => n + normalizeText(d.textContent || "").length, 0);
  return own > 0 && inNested >= WRAPPER_SHARE * own;
}

// textContent runs neighbouring cells, captions and list items together with no space between them
// ("Washington, D.C." + "Capital city…" in an infobox became "Washington, D.C.Capital city…"), and
// that glued text reached headings, summaries and embeddings. readableText() puts a space at each
// boundary of these elements instead. Anchoring still needs the page's own text, which has no space
// there either, so a block whose spaced text differs keeps the plain one as anchorText (as Markdown
// blocks already do).
const SPACED_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "CAPTION", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
  "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "OL", "P", "PRE", "SECTION", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL",
]);
const UNREAD_TAGS = new Set(["STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE"]);

function readableText(node) {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === 3) out += child.data;
    else if (child.nodeType === 1 && !UNREAD_TAGS.has(child.tagName)) {
      const spaced = SPACED_TAGS.has(child.tagName);
      out += spaced ? ` ${readableText(child)} ` : readableText(child);
    }
  }
  return out;
}

function parseBlocks(contentEl, { headingTags = DEFAULT_HEADING_TAGS } = {}) {
  if (!contentEl) return [];
  unwrapBlockParagraphs(contentEl);

  const headings = new Set(headingTags);
  const holds = new Map(); // element → holdsBlocks(element), cached
  const isWrapper = (el) => {
    if (!holds.has(el)) holds.set(el, holdsBlocks(el));
    return holds.get(el);
  };

  const blocks = [];
  for (const el of contentEl.querySelectorAll(BLOCK_SELECTOR)) {
    // Outermost block wins: a <p> inside a <li> or <blockquote> is part of that block, and a whole
    // list is one block (single short items embed poorly). Except wrappers: an element whose text
    // is mostly in nested blocks is skipped and its nested blocks are used instead.
    if (isWrapper(el)) continue;
    let inside = false;
    for (let a = el.parentElement?.closest(BLOCK_SELECTOR); a; a = a.parentElement?.closest(BLOCK_SELECTOR)) {
      if (!isWrapper(a)) {
        inside = true;
        break;
      }
    }
    if (inside) continue;

    const plain = normalizeText(el.textContent || "");
    if (!plain) continue;
    const text = normalizeText(readableText(el)) || plain;

    const isHeading = headings.has(el.tagName);
    blocks.push({
      id: `b${blocks.length}`,
      type: isHeading ? "heading" : "text",
      ...(isHeading && { level: Number(el.tagName[1]) }),
      text,
      ...(text !== plain && { anchorText: plain }),
      wordCount: countWords(text),
    });
  }
  return blocks;
}

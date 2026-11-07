// A5b: raw Markdown → blocks (same shape as content/blocks.js). Pure, CommonMark-lite: only what
// sectioning needs. Each block keeps `text` (syntax stripped, for display/embeddings/LLM) and
// `anchorText` (the raw source, normalized, for matching the live <pre>).
// See docs/phased-implementation-plan/phase-A5-special-sources.md ("A5b").

var MD_HEADING_LEVELS = 4; // #–#### are section headings; ##### and deeper become text

var ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
var FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
var LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;
var SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
var HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

function stripInline(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → link text
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // reference links
    .replace(/<(https?:[^>\s]+)>/g, "$1") // autolinks
    .replace(/<\/?[A-Za-z][^>]*>/g, "") // inline HTML tags
    .replace(/`+([^`]*)`+/g, "$1") // inline code
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2") // strong / strikethrough
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, "$1$2") // *em*
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1$2"); // _em_ (not snake_case)
}

function stripLinePrefix(line) {
  return line.replace(/^ {0,3}>[ \t]?/, "").replace(LIST_ITEM_RE, "").replace(/\|/g, " ");
}

function markdownToBlocks(source) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];

  const push = (type, rawLines, displayText, level) => {
    const text = normalizeText(displayText);
    if (!text) return;
    blocks.push({
      id: `b${blocks.length}`,
      type,
      ...(type === "heading" && { level }),
      text,
      anchorText: normalizeText(rawLines.join("\n")),
      wordCount: countWords(text),
    });
  };

  let i = 0;

  // YAML front matter
  if (lines[0] === "---") {
    const end = lines.findIndex((l, j) => j > 0 && (l === "---" || l === "..."));
    if (end > 0) i = end + 1;
  }

  let para = []; // raw lines of the paragraph or list being collected
  let paraIsList = false;
  const flushPara = () => {
    if (para.length) push("text", para, stripInline(para.map(stripLinePrefix).join("\n")));
    para = [];
    paraIsList = false;
  };

  const heading = (level, raw, text) => {
    if (level <= MD_HEADING_LEVELS) push("heading", raw, stripInline(text), level);
    else push("text", raw, stripInline(text));
  };

  for (; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1];
      const raw = [line];
      const body = [];
      for (i++; i < lines.length; i++) {
        raw.push(lines[i]);
        if (new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`).test(lines[i])) break;
        body.push(lines[i]);
      }
      push("text", raw, body.join("\n"));
      continue;
    }

    if (!line.trim()) {
      // A blank line inside a list continues it when the next content line is still list-like.
      if (paraIsList) {
        const next = lines.slice(i + 1).find((l) => l.trim());
        if (next && (LIST_ITEM_RE.test(next) || /^[ \t]+\S/.test(next))) {
          para.push(line);
          continue;
        }
      }
      flushPara();
      continue;
    }

    const atx = ATX_RE.exec(line);
    if (atx) {
      flushPara();
      heading(atx[1].length, [line], atx[2] || "");
      continue;
    }

    // Setext heading: a paragraph line underlined with === or ---.
    if (para.length && !paraIsList && SETEXT_RE.test(line)) {
      const level = line.trim()[0] === "=" ? 1 : 2;
      const raw = [...para, line];
      const text = para.join(" ");
      para = [];
      heading(level, raw, text);
      continue;
    }

    if (HR_RE.test(line)) {
      flushPara();
      continue;
    }

    const isItem = LIST_ITEM_RE.test(line);
    if (isItem && para.length && !paraIsList) flushPara(); // a list ends the paragraph before it
    if (isItem && !para.length) paraIsList = true;
    para.push(line);
  }
  flushPara();
  return blocks;
}

if (typeof module === "object") {
  // Node tests: lib/text.js is a global in the content script, a module here.
  const { normalizeText: n, countWords: c } = require("./text.js");
  globalThis.normalizeText ??= n;
  globalThis.countWords ??= c;
  module.exports = { markdownToBlocks, stripInline };
}

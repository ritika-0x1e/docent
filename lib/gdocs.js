// A5a: Google Docs URL handling — detect a doc and build its HTML-export URL. Pure.
// (Jumps don't use URLs: the export has no heading ids — see addOutlineJumps in content/sources.js.) See docs/phased-implementation-plan/phase-A5-special-sources.md ("A5a").

const DOCS_PATH_RE = /^\/document\/(u\/\d+\/)?d\/([A-Za-z0-9_-]+)/;

/**
 * @returns {{docId: string, accountPrefix: string, tab: string | null} | null}
 *   accountPrefix is "" or "u/<n>/" — kept so the export uses the account the tab is signed into
 */
function parseDocsUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== "docs.google.com") return null;
  const m = DOCS_PATH_RE.exec(url.pathname);
  if (!m) return null;
  return { docId: m[2], accountPrefix: m[1] || "", tab: url.searchParams.get("tab") };
}

function exportUrl({ docId, accountPrefix }) {
  return `https://docs.google.com/document/${accountPrefix}d/${docId}/export?format=html`;
}

if (typeof module === "object") {
  module.exports = { parseDocsUrl, exportUrl };
}

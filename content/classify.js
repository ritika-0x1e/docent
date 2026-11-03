// A2: DOM measurement for classification (impure — feeds lib/classify.js's pure decision function).
//
// Word count comes from Readability's extracted (boilerplate-stripped) textContent, per spec
// §3.1 ("comparing extracted text length against media pixel area") — not raw document text,
// which would be skewed by nav/footer noise.
//
// Media area is measured across the whole live document rather than just the article subtree:
// extract.js runs Readability on a *clone*, so there's no live-DOM article boundary to measure
// against yet (see the design note in extract.js — that's B1's problem to solve). Whole-page
// media area is a reasonable proxy for "how media-heavy is this page" in the meantime.

function measurePage(article) {
  const wordCount = countWords(article?.textContent || "");
  // Link density (A2 listing-page rule): words inside links in Readability's extracted content.
  const links = article?.content?.querySelectorAll?.("a") ?? [];
  const linkWordCount = [...links].reduce((n, a) => n + countWords(a.textContent || ""), 0);

  const mediaEls = document.querySelectorAll("img, video, canvas, svg");
  const mediaArea = [...mediaEls].reduce((sum, el) => {
    const r = el.getBoundingClientRect();
    return sum + Math.max(0, r.width) * Math.max(0, r.height);
  }, 0);

  const contentArea = document.documentElement.scrollWidth * document.documentElement.scrollHeight;

  return { wordCount, linkWordCount, mediaArea, contentArea };
}

// B2 glue: embed the page's units in the offscreen worker, then run the pure breakpoint detection.
// Loaded into the service worker with importScripts().

async function sectionSemantically(blocks, opts = {}) {
  const units = groupUnits(blocks, opts);
  if (units.length === 0) return { sections: [], stats: { units: 0, count: 0, msModelLoad: 0, msEmbed: 0 } };

  const { vectors, stats } = await embedTexts(units.map((u) => u.text));
  const starts = detectBreakpoints(vectors, units.map((u) => u.wordCount), opts);
  return { sections: sectionsFromUnits(units, starts), stats: { units: units.length, ...stats } };
}

// Converts raw sections (B1 or B2, which reference blocks by id) into the stored Section shape from
// the semantic-sectioning skill: per-block anchors instead of ids, plus the jump target. Pure.

function finalizeSections(rawSections, blocks) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return rawSections.map(({ blockIds, ...section }) => ({
    ...section,
    jump: section.jump ?? null,
    blocks: blockIds.map((id) => {
      const { anchor, anchored } = byId.get(id);
      return { id, anchor, anchored };
    }),
  }));
}

if (typeof module === "object") {
  module.exports = { finalizeSections };
}

export const RESIDUE_GLYPH_ADVANCE_PX = 6;

export const RESIDUE_BOX_SLACK_PX = 1;

export function residueLabelWidthPx(label: string): number {
  const characters = Math.max(1, label.length);
  return characters * RESIDUE_GLYPH_ADVANCE_PX + RESIDUE_BOX_SLACK_PX;
}

export function residueLabelWidthCss(label: string): string {
  return `${residueLabelWidthPx(label)}px`;
}

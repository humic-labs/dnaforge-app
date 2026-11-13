export const CYTOBAND_BAND_HEIGHT_PX = 14;
export const CYTOBAND_LABEL_TOP_GAP_PX = 2;
export const CYTOBAND_LABEL_FONT_SIZE_PX = 10;
export const CYTOBAND_LABEL_LINE_HEIGHT_PX = 14;
export const CYTOBAND_LABEL_BOTTOM_GUTTER_PX = 2;
export const CYTOBAND_REQUIRED_TRACK_HEIGHT_PX =
  CYTOBAND_BAND_HEIGHT_PX +
  CYTOBAND_LABEL_TOP_GAP_PX +
  CYTOBAND_LABEL_LINE_HEIGHT_PX +
  CYTOBAND_LABEL_BOTTOM_GUTTER_PX;

export const CYTOBAND_VERTICAL_CONTRACT_TOKEN = [
  `band:${CYTOBAND_BAND_HEIGHT_PX}`,
  `gap:${CYTOBAND_LABEL_TOP_GAP_PX}`,
  `line:${CYTOBAND_LABEL_LINE_HEIGHT_PX}`,
  `bottom:${CYTOBAND_LABEL_BOTTOM_GUTTER_PX}`,
].join('|');

export interface CytobandVerticalLayout {
  readonly allocatedHeightPx: number;
  readonly bandHeightPx: number;
  readonly labelTopPx: number;
  readonly labelBottomPx: number;
  readonly contentBottomPx: number;
  readonly requiredTrackHeightPx: number;
  readonly overflowPx: number;
  readonly labelsFit: boolean;
}

export function computeCytobandVerticalLayout(allocatedHeightPx: number): CytobandVerticalLayout {
  if (!Number.isFinite(allocatedHeightPx) || allocatedHeightPx < 0) {
    throw new Error('cytoband allocated height must be finite and nonnegative');
  }
  const allocated = Math.floor(allocatedHeightPx);
  const bandHeightPx = Math.min(CYTOBAND_BAND_HEIGHT_PX, allocated);
  const labelTopPx = bandHeightPx + CYTOBAND_LABEL_TOP_GAP_PX;
  const labelBottomPx = labelTopPx + CYTOBAND_LABEL_LINE_HEIGHT_PX;
  const contentBottomPx = labelBottomPx + CYTOBAND_LABEL_BOTTOM_GUTTER_PX;
  return Object.freeze({
    allocatedHeightPx: allocated,
    bandHeightPx,
    labelTopPx,
    labelBottomPx,
    contentBottomPx,
    requiredTrackHeightPx: CYTOBAND_REQUIRED_TRACK_HEIGHT_PX,
    overflowPx: Math.max(0, contentBottomPx - allocated),
    labelsFit: contentBottomPx <= allocated,
  });
}

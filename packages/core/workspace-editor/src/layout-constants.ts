export const ANNOTATION_ROW_HEIGHT = 16;

export const ANNOTATION_BAR_HEIGHT = 14;

export const ANNOTATION_LABEL_FONT_SIZE = 10;

export const ANNOTATION_LANE_PADDING = 2;

export const FEATURE_LOD_MAX_ANNOTATION_LANES = 3;

export const FEATURE_LOD_ANNOTATION_ROW_HEIGHT = 8;

export const FEATURE_LOD_ANNOTATION_LANE_PADDING = 1;

export const TRANSLATION_PILL_HEIGHT = 14;
export const TRANSLATION_TRANSCRIPT_HEIGHT = 10;
export const TRANSLATION_LABEL_HEIGHT = TRANSLATION_PILL_HEIGHT;

export const TRANSLATION_LABEL_FONT_SIZE = 10;

export const TRANSLATION_LETTER_SCALE = 0.92;

export const RESIDUE_NUMBER_ROW_HEIGHT = 11;

export const RULER_HEIGHT = 14;

export const RULER_FONT_SIZE = 8;

export const ROW_BOTTOM_PADDING = 16;

export const ROW_TOP_PADDING = 32;

export const PRIMER_TRACK_HEIGHT = 17;

export const PRIMER_ARROW_PADDING = 10;

export const TRANSLATION_AA_HEIGHT_RATIO = 0.9;

export function translationLaneHeight(
  rowHeight: number,
  showResidueNumbers = false,
  aaHeightOverride?: number,
  detailProgress = 1
): number {
  const aaHeight = aaHeightOverride ?? rowHeight * TRANSLATION_AA_HEIGHT_RATIO;
  const intronChipBottom = aaHeight / 2 + TRANSLATION_PILL_HEIGHT / 2;
  const fullHeight =
    TRANSLATION_LABEL_HEIGHT +
    Math.max(aaHeight, intronChipBottom) +
    (showResidueNumbers ? RESIDUE_NUMBER_ROW_HEIGHT : 0);
  if (aaHeightOverride === undefined) return fullHeight;
  const bandTop = TRANSLATION_LABEL_HEIGHT * detailProgress;
  const bottom = Math.max(TRANSLATION_LABEL_HEIGHT, bandTop + aaHeight);
  const laneGap = ANNOTATION_ROW_HEIGHT + ANNOTATION_LANE_PADDING - ANNOTATION_BAR_HEIGHT;
  return bottom + laneGap + (showResidueNumbers ? RESIDUE_NUMBER_ROW_HEIGHT * detailProgress : 0);
}

export function calculateCdsHeight(
  translationLaneCount: number,
  _overlayLaneCount: number,
  showTranslation: boolean,
  rowHeight: number,
  showResidueNumbers: boolean = false,
  detailProgress: number = 1,
  aaHeightOverride?: number
): number {
  if (!showTranslation || translationLaneCount <= 0) return 0;

  return (
    translationLaneCount *
    translationLaneHeight(rowHeight, showResidueNumbers, aaHeightOverride, detailProgress) *
    (aaHeightOverride === undefined ? detailProgress : 1)
  );
}

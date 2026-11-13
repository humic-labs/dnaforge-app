import { sequenceFontSizeForPixelsPerBp, sequenceRowHeightForFontSize } from './sequence-sizing';
export {
  MAX_SEQUENCE_FONT_SIZE,
  MAX_INDEXED_LINEAR_SEQUENCE_PIXELS_PER_BP,
  MAX_SEQUENCE_PIXELS_PER_BP,
  MIN_SEQUENCE_FONT_SIZE,
  SEQUENCE_CHAR_WIDTH,
  SEQUENCE_FONT_SIZE,
  maxZoomForSequencePixelsPerBp,
} from './sequence-sizing';

export const LANE_HEIGHT = 16;
export const LANE_GAP = 4;
export const TRANSLATION_LABEL_HEIGHT = 14;
export const TRANSLATION_AA_RATIO = 0.9;
export const RULER_HEIGHT = 14;
export const SECTION_GAP = 4;

export interface LayoutModel {
  viewportWidth: number;
  viewportHeight: number;
  bpPerPixel: number;
  pixelsPerBp: number;
  viewStartBp: number;
  viewEndBp: number;

  sequenceFontSize: number;

  rowHeight: number;

  sequenceVisible: boolean;

  sequenceOpacity: number;

  annotationLanes: number;

  translationLanes: number;

  annotationTop: number;

  annotationHeight: number;

  translationTop: number;

  translationLaneHeight: number;

  translationHeight: number;

  fwdStrandTop: number;

  fwdStrandCenter: number;

  fwdStrandBottom: number;

  revStrandTop: number;

  revStrandCenter: number;

  revStrandBottom: number;

  rulerY: number;

  totalHeight: number;

  cutLineTop: number;

  cutLineBottom: number;

  cutLineConnectorY: number;

  cutLabelY: number;
}

export function bpLeftX(model: LayoutModel, bp: number): number {
  return (bp - model.viewStartBp) * model.pixelsPerBp;
}

export function bpCenterX(model: LayoutModel, bp: number): number {
  return (bp - model.viewStartBp) * model.pixelsPerBp + model.pixelsPerBp / 2;
}

export function bpRightX(model: LayoutModel, bp: number): number {
  return (bp - model.viewStartBp + 1) * model.pixelsPerBp;
}

export function annotationLaneY(model: LayoutModel, lane: number): number {
  return model.annotationTop + lane * (LANE_HEIGHT + LANE_GAP);
}

export function annotationLaneCenterY(model: LayoutModel, lane: number): number {
  return annotationLaneY(model, lane) + LANE_HEIGHT / 2;
}

export function translationLaneCenterY(model: LayoutModel, cdsIndex: number): number {
  return (
    model.translationTop + cdsIndex * model.translationLaneHeight + model.translationLaneHeight / 2
  );
}

export interface LayoutInputs {
  viewportWidth: number;
  viewportHeight: number;
  bpPerPixel: number;
  viewStartBp: number;
  viewEndBp: number;
  annotationLanes: number;
  translationLanes: number;
  hasSequence: boolean;

  showReverseComplement?: boolean;
}

export function computeLayoutModel(inputs: LayoutInputs): LayoutModel {
  const {
    viewportWidth,
    viewportHeight,
    bpPerPixel,
    viewStartBp,
    viewEndBp,
    annotationLanes,
    translationLanes,
    hasSequence,
    showReverseComplement = true,
  } = inputs;

  const pixelsPerBp = 1 / bpPerPixel;
  const sequenceVisible = hasSequence && bpPerPixel < 5;
  const sequenceOpacity = sequenceVisible ? (bpPerPixel <= 2 ? 1 : 1 - (bpPerPixel - 2) / 3) : 0;

  const sequenceFontSize = sequenceFontSizeForPixelsPerBp(pixelsPerBp);

  const rowHeight = sequenceRowHeightForFontSize(sequenceFontSize);

  const translationLaneHeight = TRANSLATION_LABEL_HEIGHT + rowHeight * TRANSLATION_AA_RATIO;

  let y = 0;

  const annotationTop = y;
  const annotationHeight = annotationLanes * (LANE_HEIGHT + LANE_GAP);
  y += annotationHeight;

  const translationTop = y;
  let translationHeight = 0;
  if (sequenceVisible && translationLanes > 0) {
    translationHeight = translationLanes * translationLaneHeight;
    y += translationHeight + SECTION_GAP;
  }

  const fwdStrandTop = y;
  const fwdStrandCenter = y + rowHeight / 2;
  const fwdStrandBottom = y + rowHeight;
  if (sequenceVisible) {
    y += rowHeight;
  }

  const revStrandTop = y;
  const reverseRowHeight = showReverseComplement ? rowHeight : 0;
  const revStrandCenter = y + reverseRowHeight / 2;
  const revStrandBottom = y + reverseRowHeight;
  if (sequenceVisible && showReverseComplement) {
    y += rowHeight;
  }

  const rulerY = y + SECTION_GAP;
  y = rulerY + RULER_HEIGHT;

  const totalHeight = y;

  const idealOffset = (viewportHeight - totalHeight) / 2;
  const maxOffset = viewportHeight - totalHeight - 10;
  const offset = Math.max(0, Math.min(idealOffset, maxOffset));

  return {
    viewportWidth,
    viewportHeight,
    bpPerPixel,
    pixelsPerBp,
    viewStartBp,
    viewEndBp,

    sequenceFontSize,
    rowHeight,
    sequenceVisible,
    sequenceOpacity,
    annotationLanes,
    translationLanes,

    annotationTop: annotationTop + offset,
    annotationHeight,
    translationTop: translationTop + offset,
    translationLaneHeight,
    translationHeight,
    fwdStrandTop: fwdStrandTop + offset,
    fwdStrandCenter: fwdStrandCenter + offset,
    fwdStrandBottom: fwdStrandBottom + offset,
    revStrandTop: revStrandTop + offset,
    revStrandCenter: revStrandCenter + offset,
    revStrandBottom: revStrandBottom + offset,
    rulerY: rulerY + offset,
    totalHeight,

    cutLineTop: fwdStrandTop + offset,
    cutLineBottom: revStrandBottom + offset,
    cutLineConnectorY: fwdStrandBottom + offset,
    cutLabelY: revStrandBottom + offset + 4,
  };
}

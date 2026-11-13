import { cdsLayoutProgress } from './cds-presentation';
import type { Layout2DRow, LinePositions, WorkspaceEditorConfig } from './types';
import {
  ANNOTATION_ROW_HEIGHT,
  ANNOTATION_LANE_PADDING,
  RULER_HEIGHT,
  ROW_BOTTOM_PADDING,
  calculateCdsHeight,
} from './layout-constants';
import { PRIMER_CANVAS_CONSTANTS } from './canvas-constants';
import { calculateOrfHeight } from './orf-drawing';

export function computeLineTrackPositions(
  line: Layout2DRow,
  config: WorkspaceEditorConfig,
  hasMutationTrack = line.hasMutationTrack ?? false
): LinePositions {
  const densityLod = config.overviewLod === true || config.lodLevel === 'density';
  let y = line.y;
  const lineTranslationLaneCount = line.translationLaneCount ?? 0;
  const rawAnnotationHeight =
    !densityLod && config.showAnnotations && line.annotationLaneCount > 0
      ? line.annotationLaneCount * (ANNOTATION_ROW_HEIGHT + ANNOTATION_LANE_PADDING)
      : 0;
  const annotationHeight =
    rawAnnotationHeight > 0 && lineTranslationLaneCount > 0
      ? rawAnnotationHeight - ANNOTATION_LANE_PADDING
      : rawAnnotationHeight;
  const cdsHeight = densityLod
    ? 0
    : calculateCdsHeight(
        lineTranslationLaneCount,
        0,
        config.showTranslation,
        config.rowHeight,
        config.showResidueNumbers,
        cdsLayoutProgress(config),
        config.cdsZoomPresentation?.aaHeight
      );
  const forwardPrimerLaneCount =
    densityLod || !config.showPrimers ? 0 : (line.forwardPrimerLaneCount ?? 0);
  const reversePrimerLaneCount =
    densityLod || !config.showPrimers ? 0 : (line.reversePrimerLaneCount ?? 0);
  const hasForwardPrimers = forwardPrimerLaneCount > 0;
  const hasReversePrimers = reversePrimerLaneCount > 0;
  const hasPrimers = hasForwardPrimers || hasReversePrimers;
  const singleLaneHeight =
    config.rowHeight *
    (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
  const forwardPrimerHeight = forwardPrimerLaneCount * singleLaneHeight;
  const reversePrimerHeight = reversePrimerLaneCount * singleLaneHeight;

  const forwardOrfLaneCount = line.forwardOrfLaneCount ?? 0;
  const reverseOrfLaneCount = line.reverseOrfLaneCount ?? 0;
  const forwardOrfHeight = densityLod
    ? 0
    : calculateOrfHeight(forwardOrfLaneCount, config.rowHeight);
  const reverseOrfHeight = densityLod
    ? 0
    : calculateOrfHeight(reverseOrfLaneCount, config.rowHeight);

  const annotationY = y;
  y += annotationHeight;
  const translationY = y;
  y += cdsHeight;
  if (cdsHeight > 0 && forwardOrfHeight > 0) y += 4;
  const forwardOrfY = y;
  y += forwardOrfHeight;
  if (forwardOrfHeight > 0 && reverseOrfHeight > 0) y += 4;
  else if (cdsHeight > 0 && reverseOrfHeight > 0 && forwardOrfHeight === 0) y += 4;
  const reverseOrfY = y;
  y += reverseOrfHeight;
  const forwardPrimerY = y + config.rowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO;
  y += forwardPrimerHeight;
  const sequenceY = y;
  const sequenceRowHeight = densityLod
    ? Math.max(1, Math.ceil(config.rowHeight))
    : config.rowHeight;
  y += sequenceRowHeight;
  const complementY = y;
  y += config.showReverseComplement ? config.rowHeight : 0;
  const mutationTrackHeight = hasMutationTrack ? config.rowHeight : 0;
  const mutationTrackY = y;
  y += mutationTrackHeight;
  const reversePrimerY = y;
  y += reversePrimerHeight;
  const rulerY = y;
  const lineEndY = densityLod ? y : y + RULER_HEIGHT + ROW_BOTTOM_PADDING;

  return {
    line,
    annotationY,
    translationY,
    translationLaneCount: lineTranslationLaneCount,
    sequenceY,
    complementY,
    mutationTrackY,
    hasMutationTrack: hasMutationTrack,
    rulerY,
    forwardPrimerY,
    reversePrimerY,
    lineEndY,
    hasPrimers,
    hasForwardPrimers,
    hasReversePrimers,
    absoluteLineY: line.y,
    forwardOrfY,
    reverseOrfY,
    forwardOrfLaneCount,
    reverseOrfLaneCount,
  };
}

export function lineTrackBoundaries(line: Layout2DRow, config: WorkspaceEditorConfig): number[] {
  const tracks = computeLineTrackPositions(line, config);
  return [
    line.y,
    tracks.translationY,
    tracks.forwardOrfY,
    tracks.reverseOrfY,
    tracks.forwardPrimerY - config.rowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO,
    tracks.sequenceY,
    tracks.complementY,
    tracks.mutationTrackY,
    tracks.reversePrimerY,
    tracks.rulerY,
    tracks.lineEndY,
  ].map((y) => y - line.y);
}

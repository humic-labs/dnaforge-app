import { cdsLayoutProgress } from '../cds-presentation';
import type { Layout2DRow } from '../types';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import { computeLineTrackPositions } from '../line-track-layout';
import { PRIMER_CANVAS_CONSTANTS } from '../canvas-constants';
import { calculateCdsHeight, RULER_HEIGHT } from '../layout-constants';
import type { HitDetectionConfig, LineTrackBounds } from './types';

export function calculateLineTrackBounds(
  line: Layout2DRow,
  config: HitDetectionConfig,
  showReverseComplement: boolean,
  hasForwardPrimers: boolean,
  hasReversePrimers: boolean
): LineTrackBounds {
  const packedLine = {
    ...line,
    forwardPrimerLaneCount: line.forwardPrimerLaneCount ?? (hasForwardPrimers ? 1 : 0),
    reversePrimerLaneCount: line.reversePrimerLaneCount ?? (hasReversePrimers ? 1 : 0),
  };
  const fullConfig = { ...DEFAULT_EDITOR_CONFIG, ...config, showReverseComplement };
  const positions = computeLineTrackPositions(packedLine, fullConfig);
  const laneHeight =
    config.rowHeight *
    (PRIMER_CANVAS_CONSTANTS.TRACK_HEIGHT_RATIO + PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO);
  const primerHeight = (count: number) =>
    config.showPrimers && count > 0
      ? count * laneHeight - config.rowHeight * PRIMER_CANVAS_CONSTANTS.ARROW_PADDING_RATIO
      : 0;
  return {
    annotationY: 0,
    annotationHeight: positions.translationY - positions.annotationY,
    translationY: positions.translationY - line.y,
    translationHeight: calculateCdsHeight(
      line.translationLaneCount ?? 0,
      0,
      config.showTranslation,
      config.rowHeight,
      config.showResidueNumbers,
      cdsLayoutProgress(config),
      config.cdsZoomPresentation?.aaHeight
    ),
    forwardPrimerY: positions.forwardPrimerY - line.y,
    forwardPrimerHeight: primerHeight(packedLine.forwardPrimerLaneCount),
    sequenceY: positions.sequenceY - line.y,
    sequenceHeight: config.rowHeight,
    complementY: (showReverseComplement ? positions.complementY : positions.sequenceY) - line.y,
    complementHeight: showReverseComplement ? config.rowHeight : 0,
    reversePrimerY: positions.reversePrimerY - line.y,
    reversePrimerHeight: primerHeight(packedLine.reversePrimerLaneCount),
    rulerY: positions.rulerY - line.y,
    rulerHeight: RULER_HEIGHT,
  };
}

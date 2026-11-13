import { cdsPresentationGeometry } from '../cds-presentation';

import type { Layout2DRow, PrimerDisplay } from '../types';
import type { SelectionRange } from '../selection-model';
import { calculateLineTrackBounds } from './track-bounds';
import { detectAnnotationHit, detectCDSLabelHit } from './annotation';
import { detectCodonHit } from './codon';
import { isSplicedCDS } from '../translation';
import { findIntronAtPosition, orderedCdsSegments } from './spliced-cds';
import { findLineAtY, getPositionFromX, detectHandleHit } from './position';
import type { HitDetectionConfig, HitTarget, AlignmentModeHitOptions } from './types';

export function getHitTarget(
  mouseX: number,
  mouseY: number,
  scrollTop: number,
  lines: Layout2DRow[],
  totalHeight: number,
  config: HitDetectionConfig,
  seqLen: number,
  currentSelection: SelectionRange | null,
  showReverseComplement: boolean,
  primers: PrimerDisplay[],
  alignmentMode?: AlignmentModeHitOptions
): HitTarget {
  const contentY = mouseY + scrollTop;

  const line = findLineAtY(contentY, lines, totalHeight);
  if (!line) {
    return { type: 'empty' };
  }

  const hasForwardPrimers =
    config.showPrimers &&
    primers.some(
      (p) => p.direction === 'forward' && p.start < line.endPos && p.end > line.startPos
    );
  const hasReversePrimers =
    config.showPrimers &&
    primers.some(
      (p) => p.direction === 'reverse' && p.start < line.endPos && p.end > line.startPos
    );

  const bounds = calculateLineTrackBounds(
    line,
    config,
    showReverseComplement,
    hasForwardPrimers,
    hasReversePrimers
  );

  const position = getPositionFromX(mouseX, line, config, seqLen);
  const paintedRowX = mouseX - (line.xOffset ?? 0);

  if (position !== null) {
    const handleHit = detectHandleHit(position, currentSelection);
    if (handleHit) {
      return handleHit;
    }
  }

  if (config.cdsDetailProgress !== undefined) {
    const chip = detectCDSLabelHit(paintedRowX, contentY, line, bounds, config, seqLen);
    if (chip) return chip;
  }

  const annotationHit = detectAnnotationHit(paintedRowX, contentY, line, bounds, config, seqLen);
  if (annotationHit) {
    return annotationHit;
  }

  const cdsLabelHit = detectCDSLabelHit(paintedRowX, contentY, line, bounds, config, seqLen);
  if (cdsLabelHit) {
    return cdsLabelHit;
  }

  const codonHit = detectCodonHit(
    paintedRowX,
    contentY,
    line,
    bounds,
    config,
    seqLen,
    alignmentMode
  );
  if (codonHit) {
    return codonHit;
  }

  if (config.showTranslation && bounds.translationHeight > 0 && position !== null) {
    const relY = contentY - line.y;
    const cdsAnns = line.classifiedCDSs || [];
    for (const cds of cdsAnns) {
      if (cds.translationLane < 0) continue;
      const pose = cdsPresentationGeometry(cds, bounds.translationY, bounds.annotationY, config);
      if (relY < pose.intronY - 7 || relY > pose.intronY + 7) continue;
      if (!isSplicedCDS(cds, seqLen)) continue;
      const intronRange = findIntronAtPosition(position, orderedCdsSegments(cds), seqLen);
      if (intronRange) {
        return {
          type: 'annotation',
          annotation: cds,
          start: intronRange.start,
          end: intronRange.end,
        };
      }
    }
  }

  if (position !== null) {
    return {
      type: 'nucleotide',
      position,
    };
  }

  return { type: 'empty' };
}

import { cdsPresentationGeometry } from '../cds-presentation';

import type { Layout2DRow } from '../types';
import {
  ANNOTATION_BAR_HEIGHT,
  TRANSLATION_LABEL_HEIGHT,
  TRANSLATION_PILL_HEIGHT,
} from '../layout-constants';
import { ANNOTATION_CANVAS_CONSTANTS } from '../canvas-constants';
import { getVisibleRangeSegments } from '../utils/range-utils';
import type { HitDetectionConfig, LineTrackBounds, HitTargetAnnotation } from './types';

export function detectAnnotationHit(
  mouseX: number,
  contentY: number,
  line: Layout2DRow,
  bounds: LineTrackBounds,
  config: HitDetectionConfig,
  seqLen: number
): HitTargetAnnotation | null {
  if (!config.showAnnotations || line.annotationLaneCount === 0) {
    return null;
  }

  const canvasLaneSpacing = ANNOTATION_BAR_HEIGHT + ANNOTATION_CANVAS_CONSTANTS.LANE_SPACING;

  const relativeY = contentY - line.y;
  if (relativeY < bounds.annotationY || relativeY > bounds.annotationY + bounds.annotationHeight) {
    return null;
  }

  const laneIndex = Math.floor((relativeY - bounds.annotationY) / canvasLaneSpacing);

  for (const ann of line.annotations) {
    if (ann.lane !== laneIndex) continue;

    const annStart = ann.start - 1;
    const annEnd = ann.end - 1;

    const annotationSpansOrigin = ann.start > ann.end;

    if (annotationSpansOrigin) {
      const lineSpansOrigin = line.startPos > line.endPos;

      if (lineSpansOrigin) {
        const hit = checkOriginSpanningAnnotationOnOriginSpanningLine(
          mouseX,
          annStart,
          annEnd,
          line,
          config,
          seqLen
        );
        if (hit) {
          return {
            type: 'annotation',
            annotation: ann,
            start: annStart,
            end: annEnd,
          };
        }
      } else {
        const hit = checkOriginSpanningAnnotationOnNormalLine(
          mouseX,
          annStart,
          annEnd,
          line,
          config,
          seqLen
        );
        if (hit) {
          return {
            type: 'annotation',
            annotation: ann,
            start: annStart,
            end: annEnd,
          };
        }
      }
    } else {
      const hit = checkNormalAnnotation(mouseX, annStart, annEnd, line, config, seqLen);
      if (hit) {
        return {
          type: 'annotation',
          annotation: ann,
          start: annStart,
          end: annEnd,
        };
      }
    }
  }

  return null;
}

function checkNormalAnnotation(
  mouseX: number,
  annStart: number,
  annEnd: number,
  line: Layout2DRow,
  config: HitDetectionConfig,
  seqLen: number
): boolean {
  const segments = getVisibleRangeSegments(
    annStart,
    annEnd + 1,
    line.startPos,
    line.endPos,
    seqLen
  );
  return segments.some((segment) => {
    const barX = config.marginLeft + segment.charIndexStart * config.charWidth;
    const barWidth = (segment.end - segment.start) * config.charWidth;
    return mouseX >= barX && mouseX <= barX + barWidth;
  });
}

function checkOriginSpanningAnnotationOnNormalLine(
  mouseX: number,
  annStart: number,
  annEnd: number,
  line: Layout2DRow,
  config: HitDetectionConfig,
  seqLen: number
): boolean {
  if (line.startPos < seqLen && line.endPos > annStart) {
    const visibleStart = Math.max(annStart, line.startPos);
    const visibleEnd = Math.min(seqLen - 1, line.endPos - 1);

    if (visibleEnd >= visibleStart) {
      const barX = config.marginLeft + (visibleStart - line.startPos) * config.charWidth;
      const barWidth = (visibleEnd - visibleStart + 1) * config.charWidth;

      if (mouseX >= barX && mouseX <= barX + barWidth) {
        return true;
      }
    }
  }

  if (line.startPos <= annEnd || line.endPos > 0) {
    const visibleStart = Math.max(0, line.startPos);
    const visibleEnd = Math.min(annEnd, line.endPos - 1);

    if (visibleEnd >= visibleStart && visibleStart <= annEnd) {
      const barX = config.marginLeft + (visibleStart - line.startPos) * config.charWidth;
      const barWidth = (visibleEnd - visibleStart + 1) * config.charWidth;

      if (mouseX >= barX && mouseX <= barX + barWidth) {
        return true;
      }
    }
  }

  return false;
}

function checkOriginSpanningAnnotationOnOriginSpanningLine(
  mouseX: number,
  annStart: number,
  annEnd: number,
  line: Layout2DRow,
  config: HitDetectionConfig,
  seqLen: number
): boolean {
  const ann1LineStart = Math.max(annStart, line.startPos);
  const ann1LineEnd = seqLen - 1;
  if (ann1LineEnd >= ann1LineStart) {
    const charIndex = ann1LineStart - line.startPos;
    const barX = config.marginLeft + charIndex * config.charWidth;
    const barWidth = (ann1LineEnd - ann1LineStart + 1) * config.charWidth;

    if (mouseX >= barX && mouseX <= barX + barWidth) {
      return true;
    }
  }

  const ann2VisibleStart = 0;
  const ann2VisibleEnd = Math.min(annEnd, line.endPos - 1);
  if (ann2VisibleEnd >= ann2VisibleStart) {
    const preOriginLength = seqLen - line.startPos;
    const charIndex = preOriginLength + ann2VisibleStart;
    const barX = config.marginLeft + charIndex * config.charWidth;
    const barWidth = (ann2VisibleEnd - ann2VisibleStart + 1) * config.charWidth;

    if (mouseX >= barX && mouseX <= barX + barWidth) {
      return true;
    }
  }

  return false;
}

export function detectCDSLabelHit(
  mouseX: number,
  contentY: number,
  line: Layout2DRow,
  bounds: LineTrackBounds,
  config: HitDetectionConfig,
  _seqLen: number
): HitTargetAnnotation | null {
  if (
    (!config.showTranslation && config.lodLevel !== 'feature') ||
    (config.lodLevel === 'feature' && !config.showAnnotations)
  )
    return null;
  const cdsAnnotations = line.classifiedCDSs ?? [];
  const relativeY = contentY - line.y;
  for (const cds of cdsAnnotations) {
    if (cds.translationLane < 0) continue;
    const presentation = cdsPresentationGeometry(
      cds,
      bounds.translationY,
      bounds.annotationY,
      config
    );
    const contains = (pill: { x: number; w: number; y?: number; h?: number }) =>
      mouseX >= pill.x &&
      mouseX <= pill.x + pill.w &&
      contentY >= (pill.y ?? line.y + presentation.labelY) &&
      contentY <= (pill.y ?? line.y + presentation.labelY) + (pill.h ?? TRANSLATION_PILL_HEIGHT);
    for (const pill of cds._intronPillBounds ?? []) {
      if (contains(pill))
        return { type: 'annotation', annotation: cds, start: pill.rangeStart, end: pill.rangeEnd };
    }
    for (const pill of cds._exonPillBounds ?? []) {
      if (contains(pill))
        return { type: 'annotation', annotation: cds, start: pill.rangeStart, end: pill.rangeEnd };
    }
    if (cds._cdsPillBounds?.some(contains) || cds._cdsLineBounds?.some(contains)) {
      return { type: 'annotation', annotation: cds, start: cds.start - 1, end: cds.end - 1 };
    }
    if (!config.showTranslation && config.lodLevel !== 'feature') continue;
    if (config.cdsZoomPresentation) {
      if (
        presentation.colorAlpha >= 1 ||
        relativeY < presentation.barY ||
        relativeY > presentation.barY + presentation.barHeight
      )
        continue;
    } else if (
      relativeY < presentation.labelY ||
      relativeY > presentation.labelY + TRANSLATION_LABEL_HEIGHT
    )
      continue;
    const column = Math.floor((mouseX - config.marginLeft) / config.charWidth);
    if (column < 0 || column >= line.sequence.length) continue;
    const bp =
      line.preOriginLength !== undefined && column >= line.preOriginLength
        ? column - line.preOriginLength
        : line.startPos + column;
    const inCds =
      cds.start > cds.end
        ? bp >= cds.start - 1 || bp < cds.end
        : bp >= cds.start - 1 && bp < cds.end;
    if (
      inCds &&
      (config.cdsDetailProgress === undefined ||
        !cds.segments?.length ||
        cds.segments.some((seg) =>
          seg.start > seg.end
            ? bp >= seg.start - 1 || bp < seg.end
            : bp >= seg.start - 1 && bp < seg.end
        ))
    )
      return { type: 'annotation', annotation: cds, start: cds.start - 1, end: cds.end - 1 };
  }

  return null;
}

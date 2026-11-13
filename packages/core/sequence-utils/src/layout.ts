import type { Annotation, AnnotationLayer } from './types';

export function layoutAnnotations(annotations: Annotation[]): AnnotationLayer[] {
  const layers: AnnotationLayer[] = [];

  const sortedAnnotations = [...annotations].sort((a, b) => a.start - b.start);

  const rows: Array<Array<{ start: number; end: number }>> = [];

  sortedAnnotations.forEach((annotation) => {
    const { start, end } = annotation;

    let yOffset = 0;
    let placed = false;

    while (!placed) {
      if (!rows[yOffset]) {
        rows[yOffset] = [];
      }

      const currentRow = rows[yOffset]!;
      const overlaps = currentRow.some((range) => start < range.end && range.start < end);

      if (!overlaps) {
        currentRow.push({ start, end });
        layers.push({ annotation, yOffset });
        placed = true;
      } else {
        yOffset++;
      }
    }
  });

  return layers;
}

export function getVisibleAnnotations(
  annotations: Annotation[],
  viewportStart: number,
  viewportEnd: number,
  sequenceLength?: number
): Annotation[] {
  return annotations.filter((ann) => {
    const spansOrigin = ann.start > ann.end;

    if (spansOrigin && sequenceLength !== undefined) {
      const start0 = ann.start - 1;
      const end0 = ann.end - 1;

      const seg1Visible = start0 <= viewportEnd && sequenceLength - 1 >= viewportStart;

      const seg2Visible = 0 <= viewportEnd && end0 >= viewportStart;

      return seg1Visible || seg2Visible;
    }

    const start = ann.start - 1;
    const end = ann.end - 1;

    return start <= viewportEnd && end >= viewportStart;
  });
}

export function getAnnotationsAtPosition(
  annotations: Annotation[],
  position: number
): Annotation[] {
  return annotations.filter((ann) => {
    const start = ann.start - 1;
    const end = ann.end - 1;
    return position >= start && position <= end;
  });
}

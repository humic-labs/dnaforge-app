import type { PrimerDisplay } from '@waypoint/workspace-editor';
import type { Annotation } from '@waypoint/sequence-utils';

export type HighlightRange = { start: number; end: number; wraps?: boolean };

export function isPositionInHighlightRange(
  range: HighlightRange | null,
  position: number | null,
  sequenceLength: number
): boolean {
  if (!range || position == null || sequenceLength <= 0) return false;
  const pos = Math.max(0, Math.min(sequenceLength - 1, position));
  const start = Math.max(0, Math.min(sequenceLength - 1, range.start));
  const end = Math.max(0, Math.min(sequenceLength - 1, range.end));
  if (range.wraps || end < start) return pos >= start || pos <= end;
  return pos >= start && pos <= end;
}

export function annotationToHighlightRange(annotation: Annotation): HighlightRange {
  const start = annotation.start - 1;
  const end = annotation.end - 1;
  return { start, end, ...(end < start && { wraps: true }) };
}

export function primerToHighlightRange(
  primer: PrimerDisplay,
  sequenceLength: number
): HighlightRange {
  const end =
    sequenceLength > 0
      ? (((primer.end - 1) % sequenceLength) + sequenceLength) % sequenceLength
      : primer.end - 1;
  return { start: primer.start, end, ...(end < primer.start && { wraps: true }) };
}

export function contextTargetHighlightRange(input: {
  annotation: Annotation | null;
  primer?: PrimerDisplay | null;
  sequenceLength: number;
}): HighlightRange | null {
  if (input.primer) return primerToHighlightRange(input.primer, input.sequenceLength);
  if (input.annotation) return annotationToHighlightRange(input.annotation);
  return null;
}

export function resolveContextMenuHighlightRange(input: {
  currentRange: HighlightRange | null;
  position: number | null;
  annotation: Annotation | null;
  primer?: PrimerDisplay | null;
  sequenceLength: number;
}): HighlightRange | null {
  if (input.currentRange && (input.annotation || input.primer)) {
    return input.currentRange;
  }

  if (isPositionInHighlightRange(input.currentRange, input.position, input.sequenceLength)) {
    return input.currentRange;
  }

  return contextTargetHighlightRange(input);
}

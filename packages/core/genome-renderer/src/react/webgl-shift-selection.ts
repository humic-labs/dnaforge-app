import {
  handleOptionShiftClickAnnotation,
  handleShiftClickAnnotation,
} from '../../../workspace-editor/src/selection-model';
import type { ShiftClickRangeResolverInput } from '@waypoint/genome-renderer';

type LinearRange = { start: number; end: number };

function handleLinearShiftClickAnnotation(
  selection: LinearRange | null,
  annStart: number,
  annEnd: number
): LinearRange {
  if (!selection) {
    return { start: annStart, end: annEnd };
  }
  return {
    start: Math.min(selection.start, annStart),
    end: Math.max(selection.end, annEnd),
  };
}

export function resolveWebGLShiftClickRange(input: ShiftClickRangeResolverInput): [number, number] {
  const currentSelection = input.currentRange
    ? {
        start: input.currentRange[0],
        end: input.currentRange[1],
        ...(input.circular && input.currentRange[1] < input.currentRange[0]
          ? { wraps: true as const }
          : {}),
      }
    : null;
  if (!input.circular) {
    const next = handleLinearShiftClickAnnotation(
      currentSelection,
      input.rangeStart,
      input.rangeEnd
    );
    return [next.start, next.end];
  }
  const next = input.altKey
    ? handleOptionShiftClickAnnotation(
        currentSelection,
        input.rangeStart,
        input.rangeEnd,
        input.cursorPosition,
        input.genomeLength
      )
    : handleShiftClickAnnotation(
        currentSelection,
        input.rangeStart,
        input.rangeEnd,
        input.cursorPosition,
        input.genomeLength
      );
  return [next.start, next.end];
}

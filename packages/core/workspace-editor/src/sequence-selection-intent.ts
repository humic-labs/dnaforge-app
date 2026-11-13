import type { SearchMatch } from '@waypoint/sequence-utils';
import { annotationKeyOf, type AnnotationStateIdentity } from './annotation-render-state';

export interface SequenceSelectionRange {
  start: number;
  end: number;
  wraps?: boolean;
}

export type SequenceSelectionSource = 'local' | 'search';

export type SequenceSelectionIntent =
  | { kind: 'none'; source: SequenceSelectionSource }
  | { kind: 'cursor'; source: SequenceSelectionSource; position: number }
  | { kind: 'range'; source: SequenceSelectionSource; range: SequenceSelectionRange }
  | {
      kind: 'annotation';
      source: SequenceSelectionSource;
      annotation: AnnotationStateIdentity;
      range: SequenceSelectionRange | null;
    }
  | {
      kind: 'protein-match';
      source: SequenceSelectionSource;
      annotation: AnnotationStateIdentity;
      range: SequenceSelectionRange;
    };

export interface SequenceSelectionIntentInput {
  localCursor: number | null;
  localRange: SequenceSelectionRange | null;
  localSelectedAnnotation: AnnotationStateIdentity | null;
  activeSearchRange: SequenceSelectionRange | null;
  activeSearchMatch: SearchMatch | null;
}

export interface SequenceSelectionProjection {
  intent: SequenceSelectionIntent;
  canvas: {
    highlightedRange: SequenceSelectionRange | null;
    selectedAnnotation: AnnotationStateIdentity | null;
  };
  oneD: {
    selection: SequenceSelectionRange | null;
    selectedAnnotation: AnnotationStateIdentity | null;
    selectedAnnotationId: string | null;
  };
  minimap: {
    selectionStart: number | null;
    selectionEnd: number | null;
    selectionWraps?: boolean;
    selectedAnnotation: AnnotationStateIdentity | null;
  };
}

export function annotationIdentityFromSearchMatch(
  match: SearchMatch | null
): AnnotationStateIdentity | null {
  if (!match?.annotation) return null;
  return {
    type: match.annotation.type,
    name: match.annotation.name,
    start: match.annotation.start,
    end: match.annotation.end,
    direction: match.annotation.direction,
  };
}

export function annotationIdentityEqual(
  a: AnnotationStateIdentity | null,
  b: AnnotationStateIdentity | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return annotationKeyOf(a) === annotationKeyOf(b);
}

export function annotationIdForOneDimensionalView(
  annotation: AnnotationStateIdentity | null
): string | null {
  if (!annotation) return null;
  return `${annotation.name}:${annotation.start}-${annotation.end}:${annotation.direction ?? 1}`;
}

export function resolveSequenceSelectionIntent(
  input: SequenceSelectionIntentInput
): SequenceSelectionIntent {
  if (input.activeSearchRange) {
    const searchAnnotation = annotationIdentityFromSearchMatch(input.activeSearchMatch);
    if (searchAnnotation) {
      return input.activeSearchMatch?.type === 'protein'
        ? {
            kind: 'protein-match',
            source: 'search',
            annotation: searchAnnotation,
            range: input.activeSearchRange,
          }
        : {
            kind: 'annotation',
            source: 'search',
            annotation: searchAnnotation,
            range: input.activeSearchRange,
          };
    }
    return { kind: 'range', source: 'search', range: input.activeSearchRange };
  }

  if (input.localSelectedAnnotation) {
    return {
      kind: 'annotation',
      source: 'local',
      annotation: input.localSelectedAnnotation,
      range: input.localRange,
    };
  }

  if (input.localRange) return { kind: 'range', source: 'local', range: input.localRange };
  if (input.localCursor != null) {
    return { kind: 'cursor', source: 'local', position: input.localCursor };
  }
  return { kind: 'none', source: 'local' };
}

export function projectSequenceSelection(
  intent: SequenceSelectionIntent
): SequenceSelectionProjection {
  const range =
    intent.kind === 'range' || intent.kind === 'protein-match' || intent.kind === 'annotation'
      ? intent.range
      : null;
  const selectedAnnotation =
    intent.kind === 'annotation' || intent.kind === 'protein-match' ? intent.annotation : null;

  return {
    intent,
    canvas: {
      highlightedRange: range,
      selectedAnnotation,
    },
    oneD: {
      selection: range,
      selectedAnnotation,
      selectedAnnotationId: annotationIdForOneDimensionalView(selectedAnnotation),
    },
    minimap: {
      selectionStart: range?.start ?? null,
      selectionEnd: range?.end ?? null,
      selectionWraps: range?.wraps,
      selectedAnnotation,
    },
  };
}

export function projectSequenceSelectionFromInput(
  input: SequenceSelectionIntentInput
): SequenceSelectionProjection {
  return projectSequenceSelection(resolveSequenceSelectionIntent(input));
}

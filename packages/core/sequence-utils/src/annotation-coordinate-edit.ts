import type { Annotation } from './types';
import type {
  SequenceEditTransition,
  SequenceEditTransitionOperation,
} from './sequence-edit-transition';

export interface AnnotationCoordinateMapping<T> {
  annotation: T | null;
  substitutionOverlap: boolean;
}

function clearLocationString(ann: Annotation): Annotation {
  if (!ann.qualifiers?._locationString) return ann;
  const { _locationString: _, ...restQualifiers } = ann.qualifiers;
  return { ...ann, qualifiers: restQualifiers };
}

function remapRangeForInsert<T extends { start: number; end: number }>(
  range: T,
  insertPos: number,
  insertLen: number
): T {
  if (range.start > range.end) {
    const start = range.start > insertPos ? range.start + insertLen : range.start;
    const end = range.end > insertPos ? range.end + insertLen : range.end;
    return start === range.start && end === range.end ? range : { ...range, start, end };
  }
  if (range.start > insertPos) {
    return { ...range, start: range.start + insertLen, end: range.end + insertLen };
  }
  if (range.end > insertPos) return { ...range, end: range.end + insertLen };
  return range;
}

function originSpanningSegments(annotation: Annotation, sequenceLength?: number) {
  if (
    !Number.isSafeInteger(sequenceLength) ||
    sequenceLength === undefined ||
    annotation.start > sequenceLength ||
    annotation.end < 1
  )
    throw new Error('Origin-spanning annotation editing requires the current sequence length.');
  const segments = annotation.segments?.length
    ? annotation.segments
    : [
        { start: annotation.start, end: sequenceLength },
        { start: 1, end: annotation.end },
      ];
  return segments;
}

function withOriginSegments(
  annotation: Annotation,
  segments: Array<{ start: number; end: number }>
): Annotation | null {
  if (segments.length === 0) return null;
  return clearLocationString({
    ...annotation,
    start: segments[0].start,
    end: segments[segments.length - 1].end,
    segments,
  });
}

export function adjustAnnotationsForInsert(
  annotations: Annotation[],
  insertPos: number,
  insertLen: number,
  sequenceLength?: number
): Annotation[] {
  if (insertLen === 0) return annotations;
  return annotations.map((annotation) => {
    if (annotation.start > annotation.end && annotation.segments?.length)
      return withOriginSegments(
        annotation,
        originSpanningSegments(annotation, sequenceLength).map((segment) =>
          remapRangeForInsert(segment, insertPos, insertLen)
        )
      )!;
    if (annotation.start <= annotation.end && annotation.segments?.length) {
      const segments = annotation.segments.map((segment) =>
        remapRangeForInsert(segment, insertPos, insertLen)
      );
      const start = Math.min(...segments.map((segment) => segment.start));
      const end = Math.max(...segments.map((segment) => segment.end));
      if (
        start === annotation.start &&
        end === annotation.end &&
        segments.every((segment, index) => segment === annotation.segments?.[index])
      )
        return annotation;
      return clearLocationString({ ...annotation, start, end, segments });
    }
    const mapped = remapRangeForInsert(annotation, insertPos, insertLen);
    const segments = annotation.segments?.map((segment) =>
      remapRangeForInsert(segment, insertPos, insertLen)
    );
    if (
      mapped === annotation &&
      (!segments || segments.every((segment, index) => segment === annotation.segments?.[index]))
    )
      return annotation.start > annotation.end ? clearLocationString(annotation) : annotation;
    return clearLocationString({
      ...mapped,
      ...(segments ? { segments } : {}),
    });
  });
}

function remapSegmentsForDelete(
  segments: Array<{ start: number; end: number }>,
  deleteStart: number,
  deleteEnd: number
): Array<{ start: number; end: number }> {
  const deleteLength = deleteEnd - deleteStart;
  return segments
    .map((segment) => {
      const start0 = segment.start - 1;
      const end0 = segment.end - 1;
      if (start0 >= deleteEnd) {
        return { start: segment.start - deleteLength, end: segment.end - deleteLength };
      }
      if (end0 < deleteStart) return segment;
      if (start0 >= deleteStart && end0 < deleteEnd) return null;
      if (start0 < deleteStart && end0 >= deleteStart && end0 < deleteEnd) {
        return { start: segment.start, end: deleteStart };
      }
      if (start0 >= deleteStart && start0 < deleteEnd && end0 >= deleteEnd) {
        return { start: deleteStart + 1, end: segment.end - deleteLength };
      }
      if (start0 < deleteStart && end0 >= deleteEnd) {
        return { start: segment.start, end: segment.end - deleteLength };
      }
      return segment;
    })
    .filter(
      (segment): segment is { start: number; end: number } =>
        segment !== null && segment.end >= segment.start
    );
}

export function adjustAnnotationsForDelete(
  annotations: Annotation[],
  deleteStart: number,
  deleteEnd: number,
  sequenceLength?: number
): Annotation[] {
  const deleteLength = deleteEnd - deleteStart;
  if (deleteLength === 0) return annotations;
  return annotations
    .map((annotation) => {
      if (annotation.start > annotation.end)
        return withOriginSegments(
          annotation,
          remapSegmentsForDelete(
            originSpanningSegments(annotation, sequenceLength),
            deleteStart,
            deleteEnd
          )
        );
      const start0 = annotation.start - 1;
      const end0 = annotation.end - 1;
      const withSegments = (modified: Annotation): Annotation | null => {
        if (!annotation.segments?.length) return modified;
        const segments = remapSegmentsForDelete(annotation.segments, deleteStart, deleteEnd);
        if (segments.length === 0) return null;
        return {
          ...modified,
          segments,
          ...(annotation.start <= annotation.end
            ? {
                start: Math.min(...segments.map((segment) => segment.start)),
                end: Math.max(...segments.map((segment) => segment.end)),
              }
            : {}),
        };
      };

      if (start0 >= deleteEnd) {
        return withSegments(
          clearLocationString({
            ...annotation,
            start: annotation.start - deleteLength,
            end: annotation.end - deleteLength,
          })
        );
      }
      if (end0 < deleteStart) return annotation;
      if (start0 >= deleteStart && end0 < deleteEnd) return null;
      if (start0 < deleteStart && end0 >= deleteStart && end0 < deleteEnd) {
        return withSegments(clearLocationString({ ...annotation, end: deleteStart }));
      }
      if (start0 >= deleteStart && start0 < deleteEnd && end0 >= deleteEnd) {
        return withSegments(
          clearLocationString({
            ...annotation,
            start: deleteStart + 1,
            end: annotation.end - deleteLength,
          })
        );
      }
      if (start0 < deleteStart && end0 >= deleteEnd) {
        return withSegments(
          clearLocationString({ ...annotation, end: annotation.end - deleteLength })
        );
      }
      return annotation;
    })
    .filter((annotation): annotation is Annotation => annotation !== null);
}

export function mapAnnotationThroughSequenceEditTransition<T extends Annotation>(
  annotation: T,
  transition: SequenceEditTransition
): AnnotationCoordinateMapping<T> {
  assertTransitionShape(transition);
  if (annotation.start > annotation.end) {
    throw new Error('Origin-spanning annotations cannot be mapped through saved edits.');
  }

  let current: Annotation | null = { ...annotation };
  let offset = 0;
  let substitutionOverlap = false;
  for (const operation of transition.operations) {
    if (!current) break;
    if (operation.kind === 'insert') {
      const at = operation.at + offset;
      current = adjustAnnotationsForInsert([current], at, operation.length)[0] ?? null;
      offset += operation.length;
      continue;
    }
    if (operation.kind === 'delete') {
      const start = operation.start + offset;
      const end = operation.end + offset;
      current = adjustAnnotationsForDelete([current], start, end)[0] ?? null;
      offset -= operation.end - operation.start;
      continue;
    }
    if (overlapsOperation(current, operation, offset)) substitutionOverlap = true;
  }
  return { annotation: current as T | null, substitutionOverlap };
}

function overlapsOperation(
  annotation: Annotation,
  operation: Extract<SequenceEditTransitionOperation, { kind: 'substitute' }>,
  offset: number
): boolean {
  const start = operation.start + offset;
  const end = operation.end + offset;
  return start < annotation.end && end > annotation.start - 1;
}

function assertTransitionShape(transition: SequenceEditTransition): void {
  if (
    !Number.isSafeInteger(transition.beforeLength) ||
    !Number.isSafeInteger(transition.afterLength) ||
    transition.beforeLength < 0 ||
    transition.afterLength < 0
  ) {
    throw new Error('The saved edit transition has invalid sequence lengths.');
  }
  let previousCoordinate = -1;
  let delta = 0;
  for (const operation of transition.operations) {
    const coordinate = operation.kind === 'insert' ? operation.at : operation.start;
    if (!Number.isSafeInteger(coordinate) || coordinate < previousCoordinate) {
      throw new Error('The saved edit transition operations are not in canonical order.');
    }
    if (operation.kind === 'insert') {
      if (
        coordinate < 0 ||
        coordinate > transition.beforeLength ||
        !Number.isSafeInteger(operation.length) ||
        operation.length <= 0
      ) {
        throw new Error('The saved insertion is outside transition bounds.');
      }
      delta += operation.length;
    } else {
      if (
        !Number.isSafeInteger(operation.end) ||
        coordinate < 0 ||
        operation.end <= coordinate ||
        operation.end > transition.beforeLength
      ) {
        throw new Error('The saved edit range is outside transition bounds.');
      }
      if (operation.kind === 'delete') delta -= operation.end - coordinate;
    }
    previousCoordinate = coordinate;
  }
  if (transition.beforeLength + delta !== transition.afterLength) {
    throw new Error('The saved edit transition length delta is inconsistent.');
  }
}

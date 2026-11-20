import type {
  BackboneSegment,
  ParsedPlasmid,
  PlasmidFeature,
  Primer,
} from '@waypoint/plasmid-viewer';
import type { ColoredCutSite } from '@waypoint/sequence-utils';
import {
  reverseComplement,
  type NucleicAcid,
  createAssemblyScaffoldLayout,
  assemblyScaffoldSelectionLength,
  GOLDEN_GATE_JUNCTION_VISUAL,
  type AssemblyScaffoldLayout,
  type SequenceStrandOverride,
  type AnnotatedSequence,
  type Annotation,
} from '@waypoint/sequence-utils';
import type { MutationMarker, PrimerDisplay, RulerDecoration } from '@waypoint/workspace-editor';
import { getTraceData, reverseComplementTrace, rotateTrace } from '../../trace/public';
import type { AnnotationDraft } from '../types';
import type { SequenceOrientation } from './sequence-view-state';

export interface SequenceViewProjectionInput {
  sequenceLength: number;
  circular: boolean;
  orientation?: SequenceOrientation;
  originOffset?: number;
  backboneSegments?: BackboneSegment[];
  nucleicAcid?: NucleicAcid;
}

export interface SequenceViewProjection {
  sequenceLength: number;
  nucleicAcid: NucleicAcid;
  sourceLength: number;
  scaffoldLayout?: AssemblyScaffoldLayout;
  displayProjection?: SequenceViewProjection;
  strandOverrides?: SequenceStrandOverride[];
  circular: boolean;
  orientation: SequenceOrientation;
  originOffset: number;
  isIdentity: boolean;
  sourceIndexToView(sourceIndex: number): number;
  viewIndexToSource(viewIndex: number): number;
}

export type InclusiveSelectionRange = { start: number; end: number; wraps?: boolean };
export type EndExclusiveRange = { start: number; end: number; wraps?: boolean };

function mod(value: number, length: number): number {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(length - 1, Math.floor(value)));
}

function normalizeOrigin(
  originOffset: number | undefined,
  length: number,
  circular: boolean
): number {
  if (
    !circular ||
    length <= 0 ||
    typeof originOffset !== 'number' ||
    !Number.isFinite(originOffset)
  ) {
    return 0;
  }
  return mod(Math.floor(originOffset), length);
}

function normalizeOrientation(orientation: SequenceOrientation | undefined): SequenceOrientation {
  return orientation === 'reverse-complement' ? 'reverse-complement' : 'forward';
}

export function buildSequenceViewProjection(
  input: SequenceViewProjectionInput
): SequenceViewProjection {
  const sequenceLength = Math.max(0, Math.floor(input.sequenceLength));
  const scaffoldLayout = createAssemblyScaffoldLayout(
    sequenceLength,
    input.backboneSegments,
    input.circular
  );
  if (scaffoldLayout.gaps.length > 0) {
    const displayProjection = buildSequenceViewProjection({
      ...input,
      backboneSegments: undefined,
      sequenceLength: scaffoldLayout.displayLength,
      originOffset: input.originOffset ? scaffoldLayout.sourceToDisplay(input.originOffset) : 0,
    });
    return {
      ...displayProjection,
      sourceLength: sequenceLength,
      scaffoldLayout,
      displayProjection,
      strandOverrides: scaffoldLayout.strandOverrides.map((override) => {
        const count = (override.forward ?? override.reverse ?? '').length;
        const start = displayProjection.sourceIndexToView(
          displayProjection.orientation === 'forward' ? override.start : override.start + count - 1
        );
        return displayProjection.orientation === 'forward' || override.kind === 'label'
          ? { ...override, start }
          : {
              start,
              ...(override.reverse !== undefined
                ? { forward: override.reverse.split('').reverse().join('') }
                : {}),
              ...(override.forward !== undefined
                ? { reverse: override.forward.split('').reverse().join('') }
                : {}),
            };
      }),
      isIdentity: false,
      sourceIndexToView: (position) =>
        displayProjection.sourceIndexToView(
          scaffoldLayout.sourceToDisplay(
            input.circular ? mod(position, sequenceLength) : clampIndex(position, sequenceLength)
          )
        ),
      viewIndexToSource: (position) =>
        scaffoldLayout.displayToSource(displayProjection.viewIndexToSource(position)),
    };
  }
  const circular = input.circular === true;
  const originOffset = normalizeOrigin(input.originOffset, sequenceLength, circular);
  const orientation = normalizeOrientation(input.orientation);
  const isIdentity = orientation === 'forward' && originOffset === 0;

  return {
    sequenceLength,
    nucleicAcid: input.nucleicAcid ?? 'dna',
    sourceLength: sequenceLength,
    circular,
    orientation,
    originOffset,
    isIdentity,
    sourceIndexToView(sourceIndex: number): number {
      if (sequenceLength <= 0) return 0;
      const source = circular
        ? mod(sourceIndex, sequenceLength)
        : clampIndex(sourceIndex, sequenceLength);
      if (orientation === 'forward') {
        return circular ? mod(source - originOffset, sequenceLength) : source;
      }
      const reverseOriginAnchor = circular ? originOffset - 1 : sequenceLength - 1;
      return circular
        ? mod(reverseOriginAnchor - source, sequenceLength)
        : sequenceLength - 1 - source;
    },
    viewIndexToSource(viewIndex: number): number {
      if (sequenceLength <= 0) return 0;
      const view = circular
        ? mod(viewIndex, sequenceLength)
        : clampIndex(viewIndex, sequenceLength);
      if (orientation === 'forward') {
        return circular ? mod(originOffset + view, sequenceLength) : view;
      }
      const reverseOriginAnchor = circular ? originOffset - 1 : sequenceLength - 1;
      return circular ? mod(reverseOriginAnchor - view, sequenceLength) : sequenceLength - 1 - view;
    },
  };
}

function rotateSequence(value: string, originOffset: number): string {
  if (value.length === 0 || originOffset === 0) return value;
  return value.slice(originOffset) + value.slice(0, originOffset);
}

function rotateQuality(value: number[] | undefined, originOffset: number): number[] | undefined {
  if (!value || value.length === 0 || originOffset === 0) return value;
  return [...value.slice(originOffset), ...value.slice(0, originOffset)];
}

function flipAnnotationDirection(direction: Annotation['direction']): Annotation['direction'] {
  return direction === 1 ? -1 : direction === -1 ? 1 : 0;
}

function flipFeatureDirection(direction: PlasmidFeature['direction']): PlasmidFeature['direction'] {
  return direction === 'forward' ? 'reverse' : direction === 'reverse' ? 'forward' : 'none';
}

function flipPrimerDirection(direction: PrimerDisplay['direction']): PrimerDisplay['direction'] {
  return direction === 'forward' ? 'reverse' : 'forward';
}

function projectOneIndexedEndpoint(position: number, projection: SequenceViewProjection): number {
  if (projection.sequenceLength <= 0) return position;
  return projection.sourceIndexToView(position - 1) + 1;
}

function projectOneIndexedEndpointToSource(
  position: number,
  projection: SequenceViewProjection
): number {
  if (projection.sequenceLength <= 0) return position;
  return projection.viewIndexToSource(position - 1) + 1;
}

export function projectAnnotationToView(
  annotation: Annotation,
  projection: SequenceViewProjection
): Annotation {
  if (projection.isIdentity || projection.sequenceLength <= 0) return annotation;
  const start =
    projection.orientation === 'forward'
      ? projectOneIndexedEndpoint(annotation.start, projection)
      : projectOneIndexedEndpoint(annotation.end, projection);
  const end =
    projection.orientation === 'forward'
      ? projectOneIndexedEndpoint(annotation.end, projection)
      : projectOneIndexedEndpoint(annotation.start, projection);
  return {
    ...annotation,
    start,
    end,
    direction:
      projection.orientation === 'reverse-complement'
        ? flipAnnotationDirection(annotation.direction)
        : annotation.direction,
    segments: projectAnnotationSegmentsToView(annotation.segments, projection),
  };
}

export function projectAnnotationToSource(
  annotation: Annotation,
  projection: SequenceViewProjection
): Annotation {
  if (projection.isIdentity || projection.sequenceLength <= 0) return annotation;
  const start =
    projection.orientation === 'forward'
      ? projectOneIndexedEndpointToSource(annotation.start, projection)
      : projectOneIndexedEndpointToSource(annotation.end, projection);
  const end =
    projection.orientation === 'forward'
      ? projectOneIndexedEndpointToSource(annotation.end, projection)
      : projectOneIndexedEndpointToSource(annotation.start, projection);
  return {
    ...annotation,
    start,
    end,
    direction:
      projection.orientation === 'reverse-complement'
        ? flipAnnotationDirection(annotation.direction)
        : annotation.direction,
    segments: projectAnnotationSegmentsToSource(annotation.segments, projection),
  };
}

function projectAnnotationSegmentsToView(
  segments: Annotation['segments'],
  projection: SequenceViewProjection
): Annotation['segments'] {
  if (!segments || projection.isIdentity || projection.sequenceLength <= 0) return segments;
  const projected = segments.map((segment) => {
    if (projection.orientation === 'forward') {
      return {
        start: projectOneIndexedEndpoint(segment.start, projection),
        end: projectOneIndexedEndpoint(segment.end, projection),
      };
    }
    return {
      start: projectOneIndexedEndpoint(segment.end, projection),
      end: projectOneIndexedEndpoint(segment.start, projection),
    };
  });
  return projection.orientation === 'reverse-complement' ? projected.reverse() : projected;
}

function projectAnnotationSegmentsToSource(
  segments: Annotation['segments'],
  projection: SequenceViewProjection
): Annotation['segments'] {
  if (!segments || projection.isIdentity || projection.sequenceLength <= 0) return segments;
  const projected = segments.map((segment) => {
    if (projection.orientation === 'forward') {
      return {
        start: projectOneIndexedEndpointToSource(segment.start, projection),
        end: projectOneIndexedEndpointToSource(segment.end, projection),
      };
    }
    return {
      start: projectOneIndexedEndpointToSource(segment.end, projection),
      end: projectOneIndexedEndpointToSource(segment.start, projection),
    };
  });
  return projection.orientation === 'reverse-complement' ? projected.reverse() : projected;
}

function projectFeatureToView(
  feature: PlasmidFeature,
  projection: SequenceViewProjection
): PlasmidFeature {
  if (projection.isIdentity || projection.sequenceLength <= 0) return feature;
  const start =
    projection.orientation === 'forward'
      ? projectOneIndexedEndpoint(feature.start, projection)
      : projectOneIndexedEndpoint(feature.end, projection);
  const end =
    projection.orientation === 'forward'
      ? projectOneIndexedEndpoint(feature.end, projection)
      : projectOneIndexedEndpoint(feature.start, projection);
  return {
    ...feature,
    start,
    end,
    direction:
      projection.orientation === 'reverse-complement'
        ? flipFeatureDirection(feature.direction)
        : feature.direction,
    segments: projectAnnotationSegmentsToView(feature.segments, projection),
  };
}

export function projectSequenceToView(
  sequence: AnnotatedSequence,
  projection: SequenceViewProjection
): AnnotatedSequence {
  if (projection.isIdentity || projection.sequenceLength <= 0) return sequence;
  const displaySequence =
    projection.scaffoldLayout?.displaySequence(sequence.sequence) ?? sequence.sequence;
  const rotatedSequence = projection.circular
    ? rotateSequence(displaySequence, projection.originOffset)
    : displaySequence;
  const rotatedQuality = projection.circular
    ? rotateQuality(sequence.quality, projection.originOffset)
    : sequence.quality;
  const viewSequence =
    projection.orientation === 'reverse-complement'
      ? reverseComplement(rotatedSequence, projection.nucleicAcid)
      : rotatedSequence;
  const sourceTrace = getTraceData(sequence);
  const rotatedTrace = sourceTrace && rotateTrace(sourceTrace, projection.originOffset);
  return {
    ...sequence,
    sequence: viewSequence,
    ...(rotatedTrace && {
      metadata: {
        ...sequence.metadata,
        trace:
          projection.orientation === 'reverse-complement'
            ? reverseComplementTrace(rotatedTrace)
            : rotatedTrace,
      },
    }),
    length: viewSequence.length,
    strandOverrides: projection.strandOverrides,
    quality:
      projection.orientation === 'reverse-complement' && rotatedQuality
        ? [...rotatedQuality].reverse()
        : rotatedQuality,
    annotations: (sequence.annotations ?? []).map((annotation) =>
      projectAnnotationToView(annotation, projection)
    ),
  };
}

export function projectPlasmidToView(
  plasmid: ParsedPlasmid,
  projection: SequenceViewProjection
): ParsedPlasmid {
  if (projection.isIdentity || projection.sequenceLength <= 0) return plasmid;
  const displaySequence =
    projection.scaffoldLayout?.displaySequence(plasmid.sequence) ?? plasmid.sequence;
  const rotatedSequence = projection.circular
    ? rotateSequence(displaySequence, projection.originOffset)
    : displaySequence;
  const viewSequence =
    projection.orientation === 'reverse-complement'
      ? reverseComplement(rotatedSequence, projection.nucleicAcid)
      : rotatedSequence;
  return {
    ...plasmid,
    sequence: viewSequence,
    length: viewSequence.length,
    strandOverrides: projection.strandOverrides,
    features: plasmid.features.map((feature) => projectFeatureToView(feature, projection)),
    primers: projectPlasmidPrimersToView(plasmid.primers, projection),
  };
}

export function projectViewPositionToSource(
  position: number | null,
  projection: SequenceViewProjection
): number | null {
  if (position == null || projection.sequenceLength <= 0) return position;
  if (
    projection.displayProjection &&
    projection.scaffoldLayout?.gapAt(projection.displayProjection.viewIndexToSource(position))
  )
    return null;
  return projection.viewIndexToSource(position);
}

export function projectSourcePositionToView(
  position: number | null,
  projection: SequenceViewProjection
): number | null {
  if (position == null || projection.sequenceLength <= 0) return position;
  return projection.sourceIndexToView(position);
}

export function projectViewSelectionToSourceSelection(
  selection: InclusiveSelectionRange,
  projection: SequenceViewProjection
): InclusiveSelectionRange {
  if (projection.isIdentity || projection.sequenceLength <= 0) return selection;
  const start = projection.circular
    ? mod(selection.start, projection.sequenceLength)
    : clampIndex(selection.start, projection.sequenceLength);
  const end = projection.circular
    ? mod(selection.end, projection.sequenceLength)
    : clampIndex(selection.end, projection.sequenceLength);
  const sourceStart =
    projection.orientation === 'forward'
      ? projection.viewIndexToSource(start)
      : projection.viewIndexToSource(end);
  let sourceEnd =
    projection.orientation === 'forward'
      ? projection.viewIndexToSource(end)
      : projection.viewIndexToSource(start);
  if (projection.displayProjection) {
    const sourceEndView = projection.orientation === 'forward' ? end : start;
    const gap = projection.scaffoldLayout?.gapAt(
      projection.displayProjection.viewIndexToSource(sourceEndView)
    );
    if (gap) sourceEnd = gap.sourcePosition - 1;
    const gaps = projection.scaffoldLayout!.gaps.map((item) =>
      projectSourceSpanToViewSpan(item.start, item.end, projection.displayProjection!)
    );
    if (assemblyScaffoldSelectionLength(projection.sequenceLength, gaps, selection) === 0) {
      return { start: sourceStart, end: sourceStart - 1 };
    }
  }
  return {
    start: sourceStart,
    end: sourceEnd,
    ...(projection.circular && sourceEnd < sourceStart ? { wraps: true } : {}),
  };
}

export function projectSelectionToSourceRange(
  selection: InclusiveSelectionRange,
  projection: SequenceViewProjection
): EndExclusiveRange {
  if (projection.sequenceLength <= 0) return { start: selection.start, end: selection.end };
  const sourceSelection = projectViewSelectionToSourceSelection(selection, projection);
  const endExclusive = sourceSelection.end + 1;
  if (projection.circular && sourceSelection.wraps && endExclusive >= projection.sourceLength) {
    return { start: sourceSelection.start, end: 0, wraps: true };
  }
  return {
    start: sourceSelection.start,
    end: endExclusive,
    ...(sourceSelection.wraps ? { wraps: true } : {}),
  };
}

export function projectSourceSelectionToViewSelection(
  selection: InclusiveSelectionRange,
  projection: SequenceViewProjection
): InclusiveSelectionRange {
  if (projection.isIdentity || projection.sequenceLength <= 0) return selection;
  const start = projection.circular
    ? mod(selection.start, projection.sourceLength)
    : clampIndex(selection.start, projection.sourceLength);
  const end = projection.circular
    ? mod(selection.end, projection.sourceLength)
    : clampIndex(selection.end, projection.sourceLength);
  const viewStart =
    projection.orientation === 'forward'
      ? projection.sourceIndexToView(start)
      : projection.sourceIndexToView(end);
  const viewEnd =
    projection.orientation === 'forward'
      ? projection.sourceIndexToView(end)
      : projection.sourceIndexToView(start);
  return {
    start: viewStart,
    end: viewEnd,
    ...(projection.circular && viewEnd < viewStart ? { wraps: true } : {}),
  };
}

export function projectSourceRangeToViewSelection(
  range: InclusiveSelectionRange,
  projection: SequenceViewProjection
): InclusiveSelectionRange {
  return projectSourceSelectionToViewSelection(range, projection);
}

function spanLength(
  start: number,
  endExclusive: number,
  projection: SequenceViewProjection,
  length = projection.sequenceLength
): number {
  if (length <= 0) return 0;
  const startIndex = projection.circular ? mod(start, length) : clampIndex(start, length);
  const endIndex = projection.circular
    ? mod(endExclusive, length)
    : Math.max(0, Math.min(length, endExclusive));
  if (!projection.circular) return Math.max(0, endIndex - startIndex);
  if (endExclusive === start + length) return length;
  return endIndex > startIndex ? endIndex - startIndex : length - startIndex + endIndex;
}

function projectSourceSpanToViewSpan(
  start: number,
  endExclusive: number,
  projection: SequenceViewProjection
): { start: number; end: number } {
  if (projection.sequenceLength <= 0) return { start, end: endExclusive };
  const length = spanLength(start, endExclusive, projection, projection.sourceLength);
  if (length <= 0) return { start: 0, end: 0 };
  const sourceStart = projection.circular
    ? mod(start, projection.sourceLength)
    : clampIndex(start, projection.sourceLength);
  const sourceEndInclusive = projection.circular
    ? mod(sourceStart + length - 1, projection.sourceLength)
    : clampIndex(sourceStart + length - 1, projection.sourceLength);
  const viewStart =
    projection.orientation === 'forward'
      ? projection.sourceIndexToView(sourceStart)
      : projection.sourceIndexToView(sourceEndInclusive);
  const lastViewBase = projection.sourceIndexToView(
    projection.orientation === 'forward' ? sourceEndInclusive : sourceStart
  );
  const viewEnd = projection.circular
    ? mod(lastViewBase + 1, projection.sequenceLength)
    : lastViewBase + 1;
  return { start: viewStart, end: viewEnd };
}

function projectViewSpanToSourceSpan(
  start: number,
  endExclusive: number,
  projection: SequenceViewProjection
): { start: number; end: number } {
  if (projection.sequenceLength <= 0) return { start, end: endExclusive };
  const length = spanLength(start, endExclusive, projection);
  if (length <= 0) return { start: 0, end: 0 };
  const viewStart = projection.circular
    ? mod(start, projection.sequenceLength)
    : clampIndex(start, projection.sequenceLength);
  const viewEndInclusive = projection.circular
    ? mod(viewStart + length - 1, projection.sequenceLength)
    : clampIndex(viewStart + length - 1, projection.sequenceLength);
  const sourceStart =
    projection.orientation === 'forward'
      ? projection.viewIndexToSource(viewStart)
      : projection.viewIndexToSource(viewEndInclusive);
  const lastSourceBase = projection.viewIndexToSource(
    projection.orientation === 'forward' ? viewEndInclusive : viewStart
  );
  const sourceEnd = projection.circular
    ? mod(lastSourceBase + 1, projection.sourceLength)
    : lastSourceBase + 1;
  return { start: sourceStart, end: sourceEnd };
}

export function projectPrimerRangeToView<
  T extends { start: number; end: number; direction: 'forward' | 'reverse' },
>(primer: T, projection: SequenceViewProjection): T {
  if (projection.isIdentity) return primer;
  return {
    ...primer,
    ...projectSourceSpanToViewSpan(primer.start, primer.end, projection),
    direction:
      projection.orientation === 'reverse-complement'
        ? flipPrimerDirection(primer.direction)
        : primer.direction,
  };
}

export function projectPrimerRangeToSource<
  T extends { start: number; end: number; direction: 'forward' | 'reverse' },
>(primer: T, projection: SequenceViewProjection): T {
  if (projection.isIdentity) return primer;
  return {
    ...primer,
    ...projectViewSpanToSourceSpan(primer.start, primer.end, projection),
    direction:
      projection.orientation === 'reverse-complement'
        ? flipPrimerDirection(primer.direction)
        : primer.direction,
  };
}

export function projectPrimersToView(
  primers: PrimerDisplay[] | undefined,
  projection: SequenceViewProjection
): PrimerDisplay[] | undefined {
  if (!primers || projection.isIdentity || projection.sequenceLength <= 0) return primers;
  return primers.map((primer) => {
    const span = projectSourceSpanToViewSpan(primer.start, primer.end, projection);
    return {
      ...primer,
      start: span.start,
      end: span.end,
      direction: primer.isScarMarkerOnly
        ? 'forward'
        : projection.orientation === 'reverse-complement'
          ? flipPrimerDirection(primer.direction)
          : primer.direction,
      scarAbsolutePosition:
        typeof primer.scarAbsolutePosition === 'number'
          ? projection.sourceIndexToView(
              primer.scarAbsolutePosition +
                (projection.orientation === 'reverse-complement'
                  ? GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp - 1
                  : 0)
            )
          : primer.scarAbsolutePosition,
    };
  });
}

function projectPrimerDisplayToSource(
  primer: PrimerDisplay,
  projection: SequenceViewProjection
): PrimerDisplay {
  if (projection.isIdentity || projection.sequenceLength <= 0) return primer;
  const span = projectViewSpanToSourceSpan(primer.start, primer.end, projection);
  return {
    ...primer,
    start: span.start,
    end: span.end,
    direction:
      projection.orientation === 'reverse-complement'
        ? flipPrimerDirection(primer.direction)
        : primer.direction,
    scarAbsolutePosition:
      typeof primer.scarAbsolutePosition === 'number'
        ? projection.viewIndexToSource(primer.scarAbsolutePosition)
        : primer.scarAbsolutePosition,
  };
}

function projectPlasmidPrimersToView(
  primers: Primer[],
  projection: SequenceViewProjection
): Primer[] {
  if (projection.isIdentity || projection.sequenceLength <= 0) return primers;
  return primers.map((primer) => {
    const span = projectSourceSpanToViewSpan(primer.start, primer.end, projection);
    return {
      ...primer,
      start: span.start,
      end: span.end,
      direction: primer.isScarMarkerOnly
        ? 'forward'
        : projection.orientation === 'reverse-complement'
          ? flipPrimerDirection(primer.direction)
          : primer.direction,
      scarAbsolutePosition:
        typeof primer.scarAbsolutePosition === 'number'
          ? projection.sourceIndexToView(
              primer.scarAbsolutePosition +
                (projection.orientation === 'reverse-complement'
                  ? GOLDEN_GATE_JUNCTION_VISUAL.scarLengthBp - 1
                  : 0)
            )
          : primer.scarAbsolutePosition,
    };
  });
}

export function projectPrimerToSource(
  primer: PrimerDisplay,
  projection: SequenceViewProjection
): PrimerDisplay {
  return projectPrimerDisplayToSource(primer, projection);
}

export function projectAssemblyScaffoldDigestMarkers(
  projection: SequenceViewProjection
): PrimerDisplay[] {
  if (!projection.scaffoldLayout || !projection.displayProjection) return [];
  const markers: PrimerDisplay[] = projection.scaffoldLayout.junctions.map((end) => ({
    id: `scaffold-junction-${end.slotId}`,
    name: end.kind === 'schema' ? 'Schema junction' : 'Digest end',
    start: end.start,
    end: end.start + end.overhang.length,
    bases: end.overhang,
    direction: 'forward',
    tm: 0,
    gc: 0,
    overhangLength: end.overhang.length,
    cutPositionInOverhang: 1,
    pbsColor: 'transparent',
    overhangColor: 'transparent',
    enzymeName: end.enzyme,
    junctionIndex: end.junctionIndex,
    scarAbsolutePosition: end.start,
    isScarMarkerOnly: true,
  }));
  return projectPrimersToView(markers, projection.displayProjection)!;
}

export function projectBackboneSegmentsToView(
  segments: BackboneSegment[] | undefined,
  projection: SequenceViewProjection
): BackboneSegment[] | undefined {
  if (!segments || projection.isIdentity || projection.sequenceLength <= 0) return segments;
  return segments.map((segment) => {
    const gap =
      segment.scaffold &&
      projection.scaffoldLayout?.gaps.find(
        (candidate) => candidate.scaffold.slotId === segment.scaffold?.slotId
      );
    const span =
      gap && projection.displayProjection
        ? projectSourceSpanToViewSpan(gap.start, gap.end, projection.displayProjection)
        : projectSourceSpanToViewSpan(segment.start, segment.end, projection);
    return {
      ...segment,
      start: span.start,
      end: span.end,
      labelPosition:
        typeof segment.labelPosition === 'number'
          ? projection.sourceIndexToView(segment.labelPosition)
          : segment.labelPosition,
    };
  });
}

export function projectCutSitesToView(
  cutSites: ColoredCutSite[] | undefined,
  projection: SequenceViewProjection
): ColoredCutSite[] | undefined {
  if (!cutSites || projection.isIdentity || projection.sequenceLength <= 0) return cutSites;
  return cutSites.map((site) => {
    const recognition = projectSourceSpanToViewSpan(
      site.recognitionStart,
      site.recognitionEnd,
      projection
    );
    return {
      ...site,
      cutPositionTop: projection.sourceIndexToView(site.cutPositionTop),
      cutPositionBottom: projection.sourceIndexToView(site.cutPositionBottom),
      recognitionStart: recognition.start,
      recognitionEnd: recognition.end,
      strand:
        projection.orientation === 'reverse-complement'
          ? site.strand === 'forward'
            ? 'reverse'
            : 'forward'
          : site.strand,
    };
  });
}

export function projectRulerDecorationsToView(
  decorations: RulerDecoration[] | undefined,
  projection: SequenceViewProjection
): RulerDecoration[] | undefined {
  if (!decorations || projection.isIdentity || projection.sequenceLength <= 0) return decorations;
  return decorations.map((decoration) => {
    const selection = projectSourceSelectionToViewSelection(
      { start: decoration.start, end: decoration.end },
      projection
    );
    return { ...decoration, start: selection.start, end: selection.end };
  });
}

export function projectMutationsToView(
  mutations: MutationMarker[] | undefined,
  projection: SequenceViewProjection
): MutationMarker[] | undefined {
  if (!mutations || projection.isIdentity || projection.sequenceLength <= 0) return mutations;
  return mutations.map((mutation) => {
    const endColumn = mutation.endColumn ?? mutation.column;
    const selection = projectSourceSelectionToViewSelection(
      { start: mutation.column, end: endColumn },
      projection
    );
    return { ...mutation, column: selection.start, endColumn: selection.end };
  });
}

export function projectAnnotationIdentityToSource<
  T extends { start: number; end: number; direction?: number },
>(identity: T, projection: SequenceViewProjection): T {
  if (projection.isIdentity || projection.sequenceLength <= 0) return identity;
  const source = projectAnnotationToSource(
    {
      name: 'name' in identity && typeof identity.name === 'string' ? identity.name : '',
      type: 'type' in identity && typeof identity.type === 'string' ? identity.type : '',
      start: identity.start,
      end: identity.end,
      direction: identity.direction === 1 ? 1 : identity.direction === -1 ? -1 : 0,
    },
    projection
  );
  return { ...identity, start: source.start, end: source.end, direction: source.direction };
}

export function projectAnnotationIdentityToView<
  T extends { start: number; end: number; direction?: number },
>(identity: T | null | undefined, projection: SequenceViewProjection): T | null | undefined {
  if (!identity || projection.isIdentity || projection.sequenceLength <= 0) return identity;
  const viewed = projectAnnotationToView(
    {
      name: 'name' in identity && typeof identity.name === 'string' ? identity.name : '',
      type: 'type' in identity && typeof identity.type === 'string' ? identity.type : '',
      start: identity.start,
      end: identity.end,
      direction: identity.direction === 1 ? 1 : identity.direction === -1 ? -1 : 0,
    },
    projection
  );
  return { ...identity, start: viewed.start, end: viewed.end, direction: viewed.direction };
}

export function projectAnnotationDraftToSource(
  draft: AnnotationDraft,
  projection: SequenceViewProjection
): AnnotationDraft {
  if (projection.isIdentity || projection.sequenceLength <= 0) return draft;
  const source = projectAnnotationToSource(
    {
      name: draft.name,
      type: draft.type,
      start: draft.start,
      end: draft.end,
      direction: draft.direction,
      color: draft.color,
      qualifiers: draft.qualifiers,
    },
    projection
  );
  return {
    ...draft,
    start: source.start,
    end: source.end,
    direction: source.direction,
  };
}

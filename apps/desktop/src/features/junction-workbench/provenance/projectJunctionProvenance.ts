import type { DesignRegion } from '../../design/public/types';
import { isRestrictionDigestRegion } from '../../design/public/restriction-digest';
import type { SourceRef } from '../SourceContextRegistry';
import {
  registeredSourceAxis,
  sourceContextForRegion,
  sourcePositionForBioCol,
} from '../registered-source-axis';
import {
  asBioCol,
  asProductPosition,
  asRowPosition,
  asUnwrappedSourceBase,
  type UnwrappedSourceBoundary,
  normalizeSourceBase,
  sourceBaseInIntervals,
  unwrapCircularInterval,
  type ProductInterval,
  type UnwrappedSourceInterval,
} from './coordinates';
import type {
  DigestBoundaryProjection,
  ProjectSourceProvenanceInput,
  SourceBaseProjection,
} from './types';
import { validateSourceProvenance } from './validateJunctionProvenance';

export function projectSourceProvenance(input: ProjectSourceProvenanceInput) {
  const bufferLeft = input.bufferLeft ?? 0;
  const bufferRight = input.bufferRight ?? 0;
  const canonicalLength = input.registeredEndBioCol - input.registeredStartBioCol;
  const length = canonicalLength + bufferLeft + bufferRight;
  const extendedStart = input.registeredStartBioCol - bufferLeft;
  const sourceContext = sourceContextForRegion(input.region);
  const sourceLength = input.sourceWindow?.sourceLength ?? sourceContext.sequence.length;
  const circular = input.sourceWindow?.circular ?? sourceContext.circular;
  const sourceStart = input.sourceWindow?.sourceStart ?? sourceContext.start;
  const sourceEnd = input.sourceWindow?.sourceEnd ?? sourceContext.end;
  const physicalRegion = input.rawRegion ?? input.region;
  const physicalInterval = sourceIntervalForRegion(physicalRegion, {
    fallbackLength: sourceLength,
    fallbackCircular: circular,
  });
  const assembledInterval = unwrapCircularInterval(sourceStart, sourceEnd, sourceLength, circular);
  const axis = registeredSourceAxis(
    input.side,
    {
      sequence: '',
      sourceLength,
      start: sourceStart,
      end: sourceEnd,
      circular,
    },
    input.spacerLength
  );
  const bases: SourceBaseProjection[] = [];

  for (let rowPosition = 0; rowPosition < length; rowPosition++) {
    const bioCol = extendedStart + rowPosition;
    const rawSourceBase = sourcePositionForBioCol(axis, bioCol);
    const normalizedSourceBase = normalizeSourceBaseForProjection(
      rawSourceBase,
      sourceLength,
      circular
    );
    const base = readSourceBase(input, rawSourceBase, normalizedSourceBase);
    const sourceBase = base === null ? null : asUnwrappedSourceBase(rawSourceBase);
    const contributes =
      sourceBase !== null && sourceBaseInIntervals(sourceBase, [assembledInterval]);
    const productPosition = contributes
      ? asProductPosition(input.productJunctionPosition + bioCol)
      : null;

    bases.push({
      rowPosition: asRowPosition(rowPosition),
      bioCol: asBioCol(bioCol),
      sourceBase,
      normalizedSourceBase,
      productPosition,
      owner: sourceBase === null ? 'unavailable' : contributes ? 'contributing' : 'muted',
      provenanceId:
        sourceBase === null ? null : `${input.rowId}:source:${sourceStart}-${sourceEnd}`,
      base: base ?? ' ',
    });
  }

  const visibleSourceBases = bases
    .map((base) => base.sourceBase)
    .filter((sourceBase): sourceBase is NonNullable<typeof sourceBase> => sourceBase !== null)
    .map((sourceBase) => sourceBase as number);
  const visibleContextInterval =
    visibleSourceBases.length > 0
      ? unwrapCircularInterval(
          Math.min(...visibleSourceBases),
          Math.max(...visibleSourceBases) + 1,
          sourceLength,
          circular
        )
      : unwrapCircularInterval(sourceStart, sourceStart, sourceLength, circular);
  const productPositions = bases
    .map((base) => base.productPosition)
    .filter(
      (productPosition): productPosition is NonNullable<typeof productPosition> =>
        productPosition !== null
    )
    .map((productPosition) => productPosition as number);
  const productContributionInterval: ProductInterval | null =
    productPositions.length > 0
      ? { start: Math.min(...productPositions), end: Math.max(...productPositions) + 1 }
      : null;
  const digestBoundaries = digestBoundariesForRegion(input.rowId, physicalRegion, {
    sourceLength,
    circular,
    assembledContributionIntervals: [assembledInterval],
  });

  return validateSourceProvenance({
    rowId: input.rowId,
    side: input.side,
    regionId: input.region.id,
    sourceRef: sourceRefForProjection(input),
    sourceLength,
    circular,
    sourceStatus:
      input.sourceWindow?.status ?? (sourceContext.hasFullSource ? 'full' : 'clipped-fallback'),
    intervals: {
      physicalSourceInterval: physicalInterval,
      assembledContributionIntervals: [assembledInterval],
      visibleContextInterval,
      productContributionInterval,
    },
    digestBoundaries,
    scarAnnotations: [],
    bases,
  });
}

function readSourceBase(
  input: ProjectSourceProvenanceInput,
  rawSourceBase: number,
  normalizedSourceBase: number | null
): string | null {
  const sourceWindow = input.sourceWindow;
  if (
    sourceWindow &&
    rawSourceBase >= sourceWindow.sourceContextStart &&
    rawSourceBase < sourceWindow.sourceContextEnd
  ) {
    return (
      sourceWindow.sourceContextSequence[rawSourceBase - sourceWindow.sourceContextStart] ?? null
    );
  }

  const sourceContext = sourceContextForRegion(input.region);
  if (sourceContext.hasFullSource && normalizedSourceBase !== null) {
    return sourceContext.sequence[normalizedSourceBase] ?? null;
  }

  if (rawSourceBase >= input.region.sourceStart && rawSourceBase < input.region.sourceEnd) {
    return input.region.sequence[rawSourceBase - input.region.sourceStart] ?? null;
  }
  return null;
}

function normalizeSourceBaseForProjection(
  rawSourceBase: number,
  sourceLength: number,
  circular: boolean
) {
  if (circular) return normalizeSourceBase(rawSourceBase, sourceLength);
  if (rawSourceBase < 0 || rawSourceBase >= sourceLength) return null;
  return normalizeSourceBase(rawSourceBase, sourceLength);
}

function sourceRefForProjection(input: ProjectSourceProvenanceInput): SourceRef {
  if (input.sourceWindow) return input.sourceWindow.sourceRef;
  return {
    kind: input.region.sourceSequence ? 'inline' : 'unknown',
    id: input.region.sourceSequenceId || input.region.id,
    name: input.region.sourceSequenceName,
  };
}

function sourceIntervalForRegion(
  region: DesignRegion,
  fallback: { fallbackLength: number; fallbackCircular: boolean }
): UnwrappedSourceInterval {
  return unwrapCircularInterval(
    region.sourceStart,
    region.sourceEnd,
    region.sourceSequence?.length ?? fallback.fallbackLength,
    Boolean(region.sourceIsCircular ?? fallback.fallbackCircular)
  );
}

function digestBoundariesForRegion(
  rowId: string,
  region: DesignRegion,
  options: {
    sourceLength: number;
    circular: boolean;
    assembledContributionIntervals: UnwrappedSourceInterval[];
  }
): DigestBoundaryProjection[] {
  const enzymeName = region.rdSourceEnzymeName ?? region.rdSourceEnzyme;
  if (!enzymeName || !isRestrictionDigestRegion(region) || !region.rdEnds) return [];

  const boundaries: DigestBoundaryProjection[] = [];
  for (const [sourceEnd, rdEnd] of Object.entries(region.rdEnds) as Array<
    ['upstream' | 'downstream', NonNullable<DesignRegion['rdEnds']>['upstream']]
  >) {
    if (!rdEnd) continue;
    if (
      !isFiniteNumber(rdEnd.cutPositionTop) ||
      !isFiniteNumber(rdEnd.cutPositionBottom) ||
      !isFiniteNumber(rdEnd.recognitionStart) ||
      !isFiniteNumber(rdEnd.recognitionEnd)
    ) {
      continue;
    }

    const recognitionInterval = unwrapCircularInterval(
      rdEnd.recognitionStart,
      rdEnd.recognitionEnd,
      options.sourceLength,
      options.circular
    );
    const overhangLength = Math.abs(rdEnd.cutPositionBottom - rdEnd.cutPositionTop);
    const overhangKind =
      rdEnd.cutPositionTop === rdEnd.cutPositionBottom
        ? 'blunt'
        : rdEnd.cutPositionTop < rdEnd.cutPositionBottom
          ? '5prime'
          : '3prime';
    const overhangInterval =
      overhangLength > 0
        ? unwrapCircularInterval(
            Math.min(rdEnd.cutPositionTop, rdEnd.cutPositionBottom),
            Math.max(rdEnd.cutPositionTop, rdEnd.cutPositionBottom),
            options.sourceLength,
            options.circular
          )
        : null;
    const retainedScarLength = rdEnd.retainedScarLength ?? rdEnd.retainedScarSequence?.length ?? 0;
    const retainedScarStart = retainedScarStartForDigestEnd(sourceEnd, rdEnd, retainedScarLength);
    const retainedScarInterval =
      retainedScarLength > 0
        ? unwrapCircularInterval(
            retainedScarStart,
            retainedScarStart + retainedScarLength,
            options.sourceLength,
            options.circular
          )
        : null;
    const participatesInContribution = [
      rdEnd.cutPositionTop,
      rdEnd.cutPositionBottom,
      rdEnd.recognitionStart,
    ].some((position) => sourceBaseInIntervals(position, options.assembledContributionIntervals));

    boundaries.push({
      id: `${rowId}:${sourceEnd}:${enzymeName}:${rdEnd.cutPositionTop}:${rdEnd.cutPositionBottom}`,
      enzymeName,
      sourceEnd,
      recognitionInterval,
      topCutBoundary: rdEnd.cutPositionTop as UnwrappedSourceBoundary,
      bottomCutBoundary: rdEnd.cutPositionBottom as UnwrappedSourceBoundary,
      overhang: {
        kind: overhangKind,
        length: overhangLength,
        interval: overhangInterval,
      },
      retainedScarInterval,
      participatesInContribution,
    });
  }
  return boundaries;
}

function retainedScarStartForDigestEnd(
  sourceEnd: 'upstream' | 'downstream',
  rdEnd: NonNullable<NonNullable<DesignRegion['rdEnds']>['upstream']>,
  retainedScarLength: number
): number {
  const leftCut = Math.min(rdEnd.cutPositionTop ?? 0, rdEnd.cutPositionBottom ?? 0);
  const rightCut = Math.max(rdEnd.cutPositionTop ?? 0, rdEnd.cutPositionBottom ?? 0);
  if (retainedScarLength <= 0) return leftCut;
  return sourceEnd === 'upstream'
    ? Math.max(rdEnd.recognitionStart ?? leftCut, rightCut - retainedScarLength)
    : leftCut;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

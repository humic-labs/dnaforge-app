import {
  reverseComplement as sharedReverseComplement,
  type Annotation,
} from '@waypoint/sequence-utils';
import type {
  AcceptedAssemblyProjectionInput,
  AcceptedAssemblyQualifierBag,
  AcceptedAssemblyQualifierValue,
  AcceptedAssemblyRegionInput,
  AcceptedAssemblySourceAnnotationSnapshot,
  AcceptedAssemblySourceProvenanceSnapshot,
} from './accepted-types';

import { acceptedProductRegionPositions } from './accepted-product-layout';

type ProductRegionPosition = {
  start: number;
  end: number;
};

type ProjectableAnnotation = {
  name: string;
  type: string;
  start: number;
  end: number;
  strand: 'forward' | 'reverse' | 'none';
  color?: string;
  qualifiers?: Record<string, string>;
};

type SourceContributionSegment = {
  sourceStart: number;
  sourceEnd: number;
  productOffset: number;
};

type UnwrappedAnnotationInterval = {
  start: number;
  end: number;
};

type ProjectedSourceAnnotationSlice = {
  productStart: number;
  productEnd: number;
  sourceStart: number;
  sourceEnd: number;
  annotationStart: number;
  annotationEnd: number;
};

export function projectAcceptedAssemblyProductAnnotations(
  projectionInput: AcceptedAssemblyProjectionInput
): Annotation[] {
  const positions = acceptedProductRegionPositions(projectionInput);
  const sourceAnnotationsByRegionId = sourceAnnotationsByRegionIdFromProjection(projectionInput);
  const sourceProvenanceByRegionId = sourceProvenanceByRegionIdFromProjection(projectionInput);
  const consumedSourceCdsKeys = new Set<string>();
  const continuedCdss = synthesizeAcceptedCandidateContinuationCdss({
    projectionInput,
    positions,
    sourceAnnotationsByRegionId,
    consumedSourceCdsKeys,
  });

  return [
    ...projectAcceptedExistingProductAnnotations({
      projectionInput,
      positions,
      sourceAnnotationsByRegionId,
      sourceProvenanceByRegionId,
      consumedSourceCdsKeys,
    }),
    ...continuedCdss,
  ];
}

function projectAcceptedExistingProductAnnotations(input: {
  projectionInput: AcceptedAssemblyProjectionInput;
  positions: readonly ProductRegionPosition[];
  sourceAnnotationsByRegionId: ReadonlyMap<string, readonly ProjectableAnnotation[]>;
  sourceProvenanceByRegionId: ReadonlyMap<string, AcceptedAssemblySourceProvenanceSnapshot>;
  consumedSourceCdsKeys: ReadonlySet<string>;
}): Annotation[] {
  const annotations: Annotation[] = [];

  for (const [regionIndex, region] of input.projectionInput.regions.entries()) {
    const position = input.positions[regionIndex];
    if (!position) continue;

    const sourceAnnotations = input.sourceAnnotationsByRegionId.get(region.id) ?? [];
    if (sourceAnnotations.length > 0) {
      for (const annotation of sourceAnnotations) {
        if (input.consumedSourceCdsKeys.has(sourceAnnotationKey(region.id, annotation))) {
          continue;
        }
        annotations.push(
          ...projectSourceSpaceAnnotation(annotation, {
            position,
            region,
            sourceProvenance: input.sourceProvenanceByRegionId.get(region.id),
          })
        );
      }
    } else {
      for (const annotation of region.annotations) {
        annotations.push(
          projectCopiedAnnotation(annotation, {
            offset: position.start,
            fallbackName: annotation.name,
          })
        );
      }
    }

    const spacer = input.projectionInput.spacers.find((item) => item.junctionIndex === regionIndex);
    if (spacer && spacer.sequence.length > 0) {
      annotations.push({
        name: spacer.name ?? `Spacer ${spacer.id}`,
        type: 'misc_feature',
        start: position.end + 1,
        end: position.end + spacer.sequence.length,
        direction: 0,
        qualifiers: {
          assembly_spacer_id: [spacer.id],
          junction_index: [String(spacer.junctionIndex)],
          note: ['Synthetic spacer sequence inserted by assembly design.'],
        },
      });
    }
  }

  return annotations;
}

function synthesizeAcceptedCandidateContinuationCdss(input: {
  projectionInput: AcceptedAssemblyProjectionInput;
  positions: readonly ProductRegionPosition[];
  sourceAnnotationsByRegionId: ReadonlyMap<string, readonly ProjectableAnnotation[]>;
  consumedSourceCdsKeys: Set<string>;
}): Annotation[] {
  const candidates: Annotation[] = [];
  const productLength = input.projectionInput.productSequence.length;
  const regions = input.projectionInput.regions;
  if (productLength <= 0 || regions.length < 2) return candidates;
  const circularProduct = input.projectionInput.topology === 'circular';

  const junctionCount = circularProduct ? regions.length : Math.max(0, regions.length - 1);

  for (let leftIndex = 0; leftIndex < junctionCount; leftIndex++) {
    const rightIndex = (leftIndex + 1) % regions.length;
    const leftRegion = regions[leftIndex];
    const rightRegion = regions[rightIndex];
    const leftPosition = input.positions[leftIndex];
    const rightPosition = input.positions[rightIndex];
    if (!leftRegion || !rightRegion || !leftPosition || !rightPosition) continue;

    walkAcceptedForwardCandidates(candidates, {
      productSequence: input.projectionInput.productSequence,
      productLength,
      leftRegion,
      leftRegionStart: leftPosition.start,
      sourceAnnotations:
        input.sourceAnnotationsByRegionId.get(leftRegion.id) ??
        snapshotsToProjectable(leftRegion.annotations),
      consumedSourceCdsKeys: input.consumedSourceCdsKeys,
      circularProduct,
    });

    walkAcceptedReverseCandidates(candidates, {
      productSequence: input.projectionInput.productSequence,
      productLength,
      rightRegion,
      rightRegionStart: rightPosition.start,
      rightRegionEnd: rightPosition.end,
      sourceAnnotations:
        input.sourceAnnotationsByRegionId.get(rightRegion.id) ??
        snapshotsToProjectable(rightRegion.annotations),
      consumedSourceCdsKeys: input.consumedSourceCdsKeys,
      circularProduct,
    });
  }

  return candidates;
}

function walkAcceptedForwardCandidates(
  out: Annotation[],
  input: {
    productSequence: string;
    productLength: number;
    leftRegion: AcceptedAssemblyRegionInput;
    leftRegionStart: number;
    sourceAnnotations: readonly ProjectableAnnotation[];
    consumedSourceCdsKeys: Set<string>;
    circularProduct: boolean;
  }
): void {
  for (const cds of input.sourceAnnotations) {
    if (cds.type !== 'CDS' || cds.strand !== 'forward') continue;
    if (cds.end <= input.leftRegion.sourceEnd) continue;
    if (cds.start >= input.leftRegion.sourceEnd) continue;

    const codonStart = parseCodonStart(cds.qualifiers?.codon_start);
    const frameAnchorInProduct =
      input.leftRegionStart + (cds.start - input.leftRegion.sourceStart) + (codonStart - 1);
    const cdsStartInProduct = input.leftRegionStart + (cds.start - input.leftRegion.sourceStart);
    const candidateStart = Math.max(input.leftRegionStart, cdsStartInProduct);
    if (candidateStart >= input.productLength) continue;

    const candidateCodonStartOffset = positiveModulo(frameAnchorInProduct - candidateStart, 3);
    const firstContinuationCodonStart = candidateStart + candidateCodonStartOffset;
    const candidateEnd = walkCodonsForwardUntilStop(
      input.productSequence,
      firstContinuationCodonStart,
      input.productLength,
      input.circularProduct
    );

    pushAcceptedCandidate(out, {
      source: cds,
      name: `${cds.name} (predicted continuation)`,
      productStart: candidateStart,
      productEnd: candidateEnd,
      productLength: input.productLength,
      direction: 1,
      codonStart: (candidateCodonStartOffset + 1) as 1 | 2 | 3,
      circularProduct: input.circularProduct,
    });
    input.consumedSourceCdsKeys.add(sourceAnnotationKey(input.leftRegion.id, cds));
  }
}

function walkAcceptedReverseCandidates(
  out: Annotation[],
  input: {
    productSequence: string;
    productLength: number;
    rightRegion: AcceptedAssemblyRegionInput;
    rightRegionStart: number;
    rightRegionEnd: number;
    sourceAnnotations: readonly ProjectableAnnotation[];
    consumedSourceCdsKeys: Set<string>;
    circularProduct: boolean;
  }
): void {
  for (const cds of input.sourceAnnotations) {
    if (cds.type !== 'CDS' || cds.strand !== 'reverse') continue;
    if (cds.start >= input.rightRegion.sourceStart) continue;
    if (cds.end <= input.rightRegion.sourceStart) continue;

    const codonStart = parseCodonStart(cds.qualifiers?.codon_start);
    const frameAnchorInProduct =
      input.rightRegionStart + (cds.end - input.rightRegion.sourceStart) - (codonStart - 1);
    const cdsEndInProduct = input.rightRegionStart + (cds.end - input.rightRegion.sourceStart);
    const candidateEnd = Math.min(input.rightRegionEnd, cdsEndInProduct);
    if (candidateEnd <= 0) continue;

    const candidateCodonStartOffset = positiveModulo(candidateEnd - frameAnchorInProduct, 3);
    const firstContinuationCodonEnd = candidateEnd - candidateCodonStartOffset;
    const candidateStart = walkCodonsReverseUntilStop(
      input.productSequence,
      firstContinuationCodonEnd,
      input.circularProduct
    );

    pushAcceptedCandidate(out, {
      source: cds,
      name: `${cds.name} (predicted continuation)`,
      productStart: candidateStart,
      productEnd: candidateEnd,
      productLength: input.productLength,
      direction: -1,
      codonStart: (candidateCodonStartOffset + 1) as 1 | 2 | 3,
      circularProduct: input.circularProduct,
    });
    input.consumedSourceCdsKeys.add(sourceAnnotationKey(input.rightRegion.id, cds));
  }
}

function pushAcceptedCandidate(
  out: Annotation[],
  input: {
    source: ProjectableAnnotation;
    name: string;
    productStart: number;
    productEnd: number;
    productLength: number;
    direction: 1 | -1;
    codonStart: 1 | 2 | 3;
    circularProduct: boolean;
  }
): void {
  if (input.productLength <= 0) return;
  const wrapsCircularProduct =
    input.circularProduct &&
    (input.productEnd <= input.productStart ||
      input.productStart < 0 ||
      input.productEnd > input.productLength);
  if (wrapsCircularProduct) {
    const start = positiveModulo(input.productStart, input.productLength);
    const end = positiveModulo(input.productEnd, input.productLength);
    if (start === end) return;
    const segments = [
      { start: start + 1, end: input.productLength },
      { start: 1, end },
    ].filter((segment) => segment.end >= segment.start);

    out.push({
      name: input.name,
      type: 'CDS',
      start: start + 1,
      end,
      direction: input.direction,
      color: input.source.color,
      segments,
      qualifiers: {
        ...qualifierBagToSequenceQualifiers(input.source.qualifiers),
        _locationString: [
          wrappedCandidateLocationString({
            direction: input.direction,
            start,
            end,
            productLength: input.productLength,
          }),
        ],
        candidate: ['true'],
        codon_start: [String(input.codonStart)],
      },
    });
    return;
  }

  const start = Math.max(0, input.productStart);
  const end = Math.min(input.productLength, input.productEnd);
  if (end <= start) return;

  out.push({
    name: input.name,
    type: 'CDS',
    start: start + 1,
    end,
    direction: input.direction,
    color: input.source.color,
    qualifiers: {
      ...qualifierBagToSequenceQualifiers(input.source.qualifiers),
      candidate: ['true'],
      codon_start: [
        String(
          clippedCandidateCodonStart({
            direction: input.direction,
            codonStart: input.codonStart,
            productStart: start,
            productEnd: end,
            clippedStart: start,
            clippedEnd: end,
          })
        ),
      ],
    },
  });
}

function sourceAnnotationsByRegionIdFromProjection(
  projectionInput: AcceptedAssemblyProjectionInput
): ReadonlyMap<string, readonly ProjectableAnnotation[]> {
  const map = new Map<string, readonly ProjectableAnnotation[]>();
  for (const snapshot of projectionInput.sourceProvenance) {
    map.set(snapshot.regionId, snapshotsToProjectable(snapshot.sourceAnnotations));
  }
  return map;
}

function sourceProvenanceByRegionIdFromProjection(
  projectionInput: AcceptedAssemblyProjectionInput
): ReadonlyMap<string, AcceptedAssemblySourceProvenanceSnapshot> {
  const map = new Map<string, AcceptedAssemblySourceProvenanceSnapshot>();
  for (const snapshot of projectionInput.sourceProvenance) {
    map.set(snapshot.regionId, snapshot);
  }
  return map;
}

function snapshotsToProjectable(
  snapshots: readonly AcceptedAssemblySourceAnnotationSnapshot[]
): ProjectableAnnotation[] {
  return snapshots.map((snapshot) => ({
    name: snapshot.name,
    type: snapshot.type,
    start: snapshot.start,
    end: snapshot.end,
    strand: snapshot.strand,
    color: snapshot.color,
    qualifiers: qualifierBagToDesignQualifiers(snapshot.qualifiers),
  }));
}

function projectSourceSpaceAnnotation(
  annotation: ProjectableAnnotation,
  options: {
    position: ProductRegionPosition;
    region: AcceptedAssemblyRegionInput;
    sourceProvenance?: AcceptedAssemblySourceProvenanceSnapshot;
  }
): Annotation[] {
  const slices = projectedSourceAnnotationSlices(annotation, options);
  if (slices.length === 0) return [];
  const mergedSlices = mergeProjectedSourceAnnotationSlices(slices);
  const firstSlice = mergedSlices[0];
  const lastSlice = mergedSlices[mergedSlices.length - 1];
  if (!firstSlice || !lastSlice) return [];

  const segments =
    mergedSlices.length > 1
      ? mergedSlices.map((slice) => ({
          start: slice.productStart + 1,
          end: slice.productEnd,
        }))
      : undefined;

  const projected: Annotation = {
    name: annotation.name,
    type: annotation.type,
    start: firstSlice.productStart + 1,
    end: lastSlice.productEnd,
    direction: annotation.strand === 'forward' ? 1 : annotation.strand === 'reverse' ? -1 : 0,
    color: annotation.color,
    ...(segments ? { segments } : {}),
    qualifiers: qualifierBagToSequenceQualifiers(
      qualifiersForAcceptedSourceSpaceAnnotationSlice({
        annotation,
        slice: annotation.strand === 'reverse' ? lastSlice : firstSlice,
      })
    ),
  };
  return [projected];
}

function projectedSourceAnnotationSlices(
  annotation: ProjectableAnnotation,
  options: {
    position: ProductRegionPosition;
    region: AcceptedAssemblyRegionInput;
    sourceProvenance?: AcceptedAssemblySourceProvenanceSnapshot;
  }
): ProjectedSourceAnnotationSlice[] {
  const sourceLength = sourceLengthForProjection(options.region, options.sourceProvenance);
  const circular =
    Boolean(options.sourceProvenance?.sourceIsCircular) ||
    Boolean(options.sourceProvenance?.selectedSourceRange.wraps) ||
    options.region.sourceEnd < options.region.sourceStart;
  const contributions = sourceContributionSegmentsForRegion({
    region: options.region,
    sourceProvenance: options.sourceProvenance,
    sourceLength,
    circular,
  });
  if (contributions.length === 0) return [];

  const slices: ProjectedSourceAnnotationSlice[] = [];
  for (const contribution of contributions) {
    for (const interval of annotationIntervalsNearContribution(annotation, contribution, {
      sourceLength,
      circular,
    })) {
      const clippedStart = Math.max(interval.start, contribution.sourceStart);
      const clippedEnd = Math.min(interval.end, contribution.sourceEnd);
      if (clippedEnd <= clippedStart) continue;

      slices.push({
        productStart:
          options.position.start +
          contribution.productOffset +
          clippedStart -
          contribution.sourceStart,
        productEnd:
          options.position.start +
          contribution.productOffset +
          clippedEnd -
          contribution.sourceStart,
        sourceStart: clippedStart,
        sourceEnd: clippedEnd,
        annotationStart: interval.start,
        annotationEnd: interval.end,
      });
    }
  }

  return dedupeProjectedSlices(slices).sort(
    (left, right) => left.productStart - right.productStart
  );
}

function sourceLengthForProjection(
  region: AcceptedAssemblyRegionInput,
  sourceProvenance?: AcceptedAssemblySourceProvenanceSnapshot
): number {
  return Math.max(
    sourceProvenance?.sourceLength ?? 0,
    region.sourceStart,
    region.sourceEnd,
    region.sequence.length
  );
}

function sourceContributionSegmentsForRegion(input: {
  region: AcceptedAssemblyRegionInput;
  sourceProvenance?: AcceptedAssemblySourceProvenanceSnapshot;
  sourceLength: number;
  circular: boolean;
}): SourceContributionSegment[] {
  const sourceSegments =
    input.sourceProvenance?.includedSourceSegments.filter(
      (segment) => segment.role === 'included-template'
    ) ?? [];
  const fallbackSegment = input.sourceProvenance?.selectedSourceRange ?? {
    start: input.region.sourceStart,
    end: input.region.sourceEnd,
    wraps: input.region.sourceEnd < input.region.sourceStart,
  };
  const segments = sourceSegments.length > 0 ? sourceSegments : [fallbackSegment];
  const contributions: SourceContributionSegment[] = [];
  let productOffset = 0;

  for (const segment of segments) {
    const unwrapped = unwrapSourceRange(segment.start, segment.end, {
      sourceLength: input.sourceLength,
      circular: input.circular || Boolean(segment.wraps),
    });
    const length = unwrapped.end - unwrapped.start;
    if (length <= 0) continue;
    contributions.push({
      sourceStart: unwrapped.start,
      sourceEnd: unwrapped.end,
      productOffset,
    });
    productOffset += length;
  }

  return contributions;
}

function annotationIntervalsNearContribution(
  annotation: ProjectableAnnotation,
  contribution: SourceContributionSegment,
  options: { sourceLength: number; circular: boolean }
): UnwrappedAnnotationInterval[] {
  const base = unwrapSourceRange(annotation.start, annotation.end, options);
  if (base.end <= base.start) return [];
  if (!options.circular || options.sourceLength <= 0) return [base];

  const approximateShift = Math.floor(
    (contribution.sourceStart - base.start) / options.sourceLength
  );
  const intervals: UnwrappedAnnotationInterval[] = [];
  for (const shift of [approximateShift - 1, approximateShift, approximateShift + 1]) {
    intervals.push({
      start: base.start + shift * options.sourceLength,
      end: base.end + shift * options.sourceLength,
    });
  }
  return intervals;
}

function unwrapSourceRange(
  start: number,
  end: number,
  options: { sourceLength: number; circular: boolean }
): UnwrappedAnnotationInterval {
  if (!options.circular || options.sourceLength <= 0) return { start, end };
  const normalizedStart = positiveModulo(start, options.sourceLength);
  const normalizedEnd = positiveModulo(end, options.sourceLength);
  return {
    start: normalizedStart,
    end: normalizedEnd > normalizedStart ? normalizedEnd : normalizedEnd + options.sourceLength,
  };
}

function dedupeProjectedSlices(
  slices: readonly ProjectedSourceAnnotationSlice[]
): ProjectedSourceAnnotationSlice[] {
  const seen = new Set<string>();
  const deduped: ProjectedSourceAnnotationSlice[] = [];
  for (const slice of slices) {
    const key = [
      slice.productStart,
      slice.productEnd,
      slice.sourceStart,
      slice.sourceEnd,
      slice.annotationStart,
      slice.annotationEnd,
    ].join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(slice);
  }
  return deduped;
}

function mergeProjectedSourceAnnotationSlices(
  slices: readonly ProjectedSourceAnnotationSlice[]
): ProjectedSourceAnnotationSlice[] {
  const merged: ProjectedSourceAnnotationSlice[] = [];
  for (const slice of slices) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.productEnd === slice.productStart &&
      previous.sourceEnd === slice.sourceStart &&
      previous.annotationEnd === slice.annotationStart
    ) {
      previous.productEnd = slice.productEnd;
      previous.sourceEnd = slice.sourceEnd;
      previous.annotationEnd = slice.annotationEnd;
      continue;
    }
    merged.push({ ...slice });
  }
  return merged;
}

function projectCopiedAnnotation(
  annotation: AcceptedAssemblySourceAnnotationSnapshot,
  options: { offset: number; fallbackName: string }
): Annotation {
  return {
    name: annotation.name || options.fallbackName,
    type: annotation.type,
    start: options.offset + annotation.start + 1,
    end: options.offset + annotation.end,
    direction: annotation.strand === 'forward' ? 1 : annotation.strand === 'reverse' ? -1 : 0,
    color: annotation.color,
    qualifiers: qualifierBagToSequenceQualifiers(annotation.qualifiers),
  };
}

function qualifiersForAcceptedSourceSpaceAnnotationSlice(input: {
  annotation: ProjectableAnnotation;
  slice: ProjectedSourceAnnotationSlice;
}): Record<string, string> | undefined {
  const qualifiers = input.annotation.qualifiers ? { ...input.annotation.qualifiers } : undefined;
  if (input.annotation.type !== 'CDS') return qualifiers;
  if (input.annotation.strand !== 'forward' && input.annotation.strand !== 'reverse') {
    return qualifiers;
  }
  if (input.slice.sourceEnd <= input.slice.sourceStart) return qualifiers;

  const existingOffset = parseCodonStart(input.annotation.qualifiers?.codon_start) - 1;
  const skippedFromFivePrime =
    input.annotation.strand === 'forward'
      ? input.slice.sourceStart - input.slice.annotationStart
      : input.slice.annotationEnd - input.slice.sourceEnd;
  const localOffset = positiveModulo(existingOffset - skippedFromFivePrime, 3);

  return {
    ...(qualifiers ?? {}),
    codon_start: String(localOffset + 1),
  };
}

function walkCodonsForwardUntilStop(
  product: string,
  startPos: number,
  productLength: number,
  circularProduct: boolean
): number {
  let pos = startPos;
  let scanned = 0;
  while (scanned + 3 <= productLength) {
    if (!circularProduct && pos + 3 > productLength) break;
    const codon = circularProduct
      ? circularProductSlice(product, pos, 3)
      : product.slice(pos, pos + 3);
    if (isStopCodon(codon)) {
      return circularProduct ? positiveModulo(pos + 3, productLength) : pos + 3;
    }
    pos += 3;
    scanned += 3;
  }
  return circularProduct ? startPos : productLength;
}

function walkCodonsReverseUntilStop(
  product: string,
  endPos: number,
  circularProduct: boolean
): number {
  const productLength = product.length;
  let pos = endPos;
  let scanned = 0;
  while (scanned + 3 <= productLength) {
    if (!circularProduct && pos - 3 < 0) break;
    const codon = reverseComplement(
      circularProduct ? circularProductSlice(product, pos - 3, 3) : product.slice(pos - 3, pos)
    );
    if (isStopCodon(codon)) return pos - 3;
    pos -= 3;
    scanned += 3;
  }
  return circularProduct ? endPos : 0;
}

function circularProductSlice(product: string, start: number, length: number): string {
  if (product.length <= 0 || length <= 0) return '';
  let out = '';
  for (let offset = 0; offset < length; offset++) {
    out += product[positiveModulo(start + offset, product.length)] ?? 'N';
  }
  return out;
}

function clippedCandidateCodonStart(input: {
  direction: 1 | -1;
  codonStart: 1 | 2 | 3;
  productStart: number;
  productEnd: number;
  clippedStart: number;
  clippedEnd: number;
}): 1 | 2 | 3 {
  const baseOffset = Math.max(0, Math.min(2, input.codonStart - 1));
  const skippedFromFivePrime =
    input.direction === 1
      ? input.clippedStart - input.productStart
      : input.productEnd - input.clippedEnd;
  return (positiveModulo(baseOffset - skippedFromFivePrime, 3) + 1) as 1 | 2 | 3;
}

function wrappedCandidateLocationString(input: {
  direction: 1 | -1;
  start: number;
  end: number;
  productLength: number;
}): string {
  const tail = `${input.start + 1}..${input.productLength}`;
  const head = `1..${input.end}`;
  if (input.direction === -1) return `complement(join(${head},${tail}))`;
  return `join(${tail},${head})`;
}

function sourceAnnotationKey(regionId: string, annotation: ProjectableAnnotation): string {
  return [
    regionId,
    annotation.name,
    annotation.type,
    annotation.start,
    annotation.end,
    annotation.strand,
  ].join(':');
}

function parseCodonStart(value: string | undefined): 1 | 2 | 3 {
  const parsed = value ? Number.parseInt(value, 10) : 1;
  return parsed === 2 ? 2 : parsed === 3 ? 3 : 1;
}

function isStopCodon(codon: string): boolean {
  return (
    codon.toUpperCase() === 'TAA' || codon.toUpperCase() === 'TAG' || codon.toUpperCase() === 'TGA'
  );
}

const reverseComplement = sharedReverseComplement;

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function qualifierBagToDesignQualifiers(
  qualifiers: AcceptedAssemblyQualifierBag | undefined
): Record<string, string> | undefined {
  if (!qualifiers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(qualifiers)) {
    const first = firstQualifierValue(value);
    if (first !== undefined) result[key] = first;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function qualifierBagToSequenceQualifiers(
  qualifiers: AcceptedAssemblyQualifierBag | Record<string, string> | undefined
): Annotation['qualifiers'] {
  if (!qualifiers) return undefined;
  const result: NonNullable<Annotation['qualifiers']> = {};
  for (const [key, value] of Object.entries(qualifiers)) {
    if (key === '_locationString' || key === 'dnaforge_ann_id') continue;
    if (Array.isArray(value)) {
      result[key] = [...value];
    } else {
      result[key] = [value as string];
    }
  }
  return result;
}

function firstQualifierValue(value: AcceptedAssemblyQualifierValue): string | undefined {
  return Array.isArray(value) ? value[0] : (value as string);
}

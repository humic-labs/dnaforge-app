import type { Feature, Genome } from '@waypoint/genome-renderer';
import type { CoordinateSpace } from '@waypoint/workspace-editor';
import { formatTranslExcept, parseTranslExcept } from '@waypoint/sequence-utils';
import { buildSharedSequenceAxis, type SharedSequenceAxis } from './shared-sequence-read-model';
import { primaryBiologicalSelectionForColumns } from './shared-sequence-read-selection';

export interface AlignmentCodingProjection {
  readonly genome: Genome;
  readonly axis: SharedSequenceAxis;
}

export function buildAlignmentCodingProjection(
  reference: Genome,
  coordinateSpace: CoordinateSpace,
  referenceAxis = buildSharedSequenceAxis(reference.sequence ?? '', coordinateSpace)
): AlignmentCodingProjection {
  if (coordinateSpace.mode !== 'gapped') return { genome: reference, axis: referenceAxis };
  const alignedQuery = coordinateSpace.alignedQuery;
  if (!alignedQuery || !coordinateSpace.gappedSequence)
    throw new Error('Query CDS translation requires aligned reference and query DNA');
  const sequence = alignedQuery.replace(/-/g, '');
  const axis = buildSharedSequenceAxis(sequence, {
    mode: 'gapped',
    gappedSequence: alignedQuery,
    alignedQuery: coordinateSpace.gappedSequence,
  });
  const mapLinearRange = (start: number, end: number) => {
    const firstColumn = referenceAxis.bioToColumn(start);
    const lastColumn = referenceAxis.bioToColumn(end - 1);
    if (firstColumn === null || lastColumn === null || end <= start) return null;
    const selected = primaryBiologicalSelectionForColumns(axis, {
      start: firstColumn,
      end: lastColumn,
    });
    return selected ? { start: selected.start, end: selected.end + 1 } : null;
  };
  const mapRange = (start: number, end: number) => {
    if (end >= start) return mapLinearRange(start, end);
    if (!reference.circular) return null;
    const parts = [mapLinearRange(start, reference.length), mapLinearRange(0, end)].filter(
      (range) => range !== null
    );
    return parts.length ? { start: parts[0].start, end: parts[parts.length - 1].end } : null;
  };
  const mapIntervals = (intervals: Readonly<Feature['segments']>) =>
    intervals?.flatMap((interval) => {
      const mapped = mapRange(interval.start - 1, interval.end);
      return mapped ? [{ start: mapped.start + 1, end: mapped.end }] : [];
    });
  const coveredFirst = axis.bioToColumn(0);
  const coveredLast = axis.bioToColumn(sequence.length - 1);
  const missingCodingPrefix = (feature: Feature): number => {
    const intervals = feature.cds?.length
      ? feature.cds
      : feature.segments?.length
        ? feature.segments
        : feature.end >= feature.start
          ? [{ start: feature.start + 1, end: feature.end }]
          : [
              { start: feature.start + 1, end: reference.length },
              { start: 1, end: feature.end },
            ];
    const reverse = feature.direction === 'reverse';
    let missing = 0;
    for (const interval of reverse ? [...intervals].reverse() : intervals) {
      let low = interval.start - 1;
      let high = interval.end;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const column = referenceAxis.bioToColumn(middle)!;
        if (reverse ? column <= coveredLast! : column < coveredFirst!) low = middle + 1;
        else high = middle;
      }
      const count = reverse ? interval.end - low : low - (interval.start - 1);
      missing += count;
      if (count < interval.end - interval.start + 1) break;
    }
    return missing;
  };
  const mapException = (value: string): string[] => {
    const parsed = parseTranslExcept(value);
    if (!parsed || parsed.location.accession) return [value];
    const mapped = mapLinearRange(parsed.location.start - 1, parsed.location.end);
    if (!mapped || mapped.end - mapped.start !== parsed.location.end - parsed.location.start + 1)
      return [];
    return [
      formatTranslExcept({
        ...parsed,
        location: { ...parsed.location, start: mapped.start + 1, end: mapped.end },
      }),
    ];
  };
  const features = reference.features?.flatMap((feature) => {
    const range = mapRange(feature.start, feature.end);
    if (!range) return [];
    const segments = mapIntervals(feature.segments);
    const exons = mapIntervals(feature.exons);
    const cds = mapIntervals(feature.cds);
    if (
      (feature.type === 'CDS' && feature.segments?.length && !segments?.length) ||
      (feature.cds?.length && !cds?.length)
    )
      return [];
    let qualifiers = feature.qualifiers;
    let qualifierValues = feature.qualifierValues;
    const missing =
      coveredFirst !== null && coveredLast !== null ? missingCodingPrefix(feature) : 0;
    if (missing) {
      const rawOffset =
        Number.parseInt(
          feature.qualifiers?.codon_start ?? feature.qualifierValues?.codon_start?.[0] ?? '1',
          10
        ) - 1;
      const offset =
        Number.isInteger(rawOffset) && rawOffset >= 0 && rawOffset <= 2 ? rawOffset : 0;
      const codonStart = String(((((offset - missing) % 3) + 3) % 3) + 1);
      qualifiers = { ...qualifiers, codon_start: codonStart };
      if (qualifierValues) qualifierValues = { ...qualifierValues, codon_start: [codonStart] };
    }
    const exceptions =
      feature.qualifierValues?.transl_except ??
      (feature.qualifiers?.transl_except ? [feature.qualifiers.transl_except] : undefined);
    if (exceptions) {
      const mapped = exceptions.flatMap(mapException);
      qualifiers = { ...qualifiers, transl_except: mapped[0] };
      qualifierValues = { ...qualifierValues, transl_except: mapped };
    }
    return [{ ...feature, ...range, segments, exons, cds, qualifiers, qualifierValues }];
  });
  return {
    genome: {
      ...reference,
      sequence,
      length: sequence.length,
      sequenceWindow: undefined,
      features,
    },
    axis,
  };
}

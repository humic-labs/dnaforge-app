import type { Feature, Genome } from '../../../types';
import { isCompositeFeature } from '../overlays/annotation-feature-semantics';
import {
  getCDSIntrons,
  translateCDS,
  type BaseReader,
  type CodonInfo,
  type IntronInfo,
} from '../../../biology/translation';

export interface CodonCarrierRange {
  readonly start: number;
  readonly end: number;
  readonly segments: Feature['cds'];

  readonly legacy: boolean;
}

export function codonCarrierRange(feature: Feature): CodonCarrierRange | null {
  if (feature.direction === 'none') return null;
  const legacy = feature.type === 'CDS';
  const cds = !legacy && feature.cds?.length ? feature.cds : null;
  if (!legacy && !cds) return null;
  return {
    start: cds ? cds[0].start - 1 : feature.start,
    end: cds ? cds[cds.length - 1].end : feature.end,
    segments: cds ?? feature.segments,
    legacy: legacy && !isCompositeFeature(feature),
  };
}

export function codonCarrierIntersectsViewport(
  range: CodonCarrierRange,
  start: number,
  end: number
): boolean {
  const margin = end - start;
  const lo = start - margin;
  const hi = end + margin;
  return range.segments
    ? range.segments.some((segment) => segment.end >= lo && segment.start - 1 <= hi)
    : range.end >= lo && range.start <= hi;
}

export function translateCodonCarrier(
  feature: Feature,
  range: CodonCarrierRange,
  reader: BaseReader,
  genome: Pick<Genome, 'length' | 'circular' | 'geneticCode' | 'geneticCodeBasis'>
): { codons: CodonInfo[]; introns: IntronInfo[] } {
  const options = {
    segments: range.segments,
    qualifiers: feature.qualifiers,
    qualifierValues: feature.qualifierValues,
  };
  return {
    codons: translateCDS(
      reader,
      range.start,
      range.end,
      feature.direction,
      genome.length,
      genome.circular,
      {
        ...options,
        geneticCodeBasis: genome.geneticCodeBasis,
        sequenceGeneticCode: genome.geneticCode,
      }
    ),
    introns: getCDSIntrons(reader, range.start, range.end, feature.direction, {
      ...options,
      geneticCodeBasis: genome.geneticCodeBasis,
      sequenceGeneticCode: genome.geneticCode,
    }),
  };
}

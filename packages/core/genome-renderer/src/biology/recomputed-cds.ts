import type { Feature, Genome } from '../types';
import { getCDSIntrons, translateCDS, type CodonInfo, type IntronInfo } from './translation';

export interface RecomputedCds {
  readonly feature: Feature;
  readonly codons: readonly CodonInfo[];
  readonly introns: readonly IntronInfo[];
  readonly protein: string;
  readonly terminated: boolean;
  readonly uncertain: boolean;
}

function takeCodingParts(
  parts: NonNullable<Feature['segments']>,
  limit: number,
  reverse: boolean
): NonNullable<Feature['segments']> {
  let remaining = limit;
  const result: NonNullable<Feature['segments']> = [];
  for (const part of reverse ? [...parts].reverse() : parts) {
    if (remaining <= 0) break;
    const count = Math.min(remaining, part.end - part.start + 1);
    const clipped = reverse
      ? { start: part.end - count + 1, end: part.end }
      : { start: part.start, end: part.start + count - 1 };
    if (reverse) result.unshift(clipped);
    else result.push(clipped);
    remaining -= count;
  }
  return result;
}

export function recomputeCds(feature: Feature, genome: Genome): RecomputedCds {
  const sequence = genome.sequence;
  if (!sequence || sequence.length !== genome.length)
    throw new Error('Whole CDS computation requires the actual complete sequence');
  const reverse = feature.direction === 'reverse';
  const originalParts = feature.cds?.length
    ? feature.cds
    : (feature.segments ?? (feature.type === 'CDS' ? feature.exons : undefined));
  const scanParts = originalParts?.flatMap((part) =>
    part.start <= part.end
      ? [{ ...part }]
      : [
          { start: part.start, end: genome.length },
          { start: 1, end: part.end },
        ]
  );
  let scanStart = reverse ? (genome.circular ? feature.end % genome.length : 0) : feature.start;
  let scanEnd = reverse ? feature.end : genome.circular ? feature.start : genome.length;
  if (scanParts?.length) {
    if (feature.type !== 'CDS' && feature.exons?.length) {
      if (reverse) {
        const first = scanParts[0];
        const earlier = feature.exons.filter((exon) => exon.start < first.start);
        for (const exon of [...earlier].reverse()) {
          if (exon.end >= first.start - 1) first.start = exon.start;
          else scanParts.unshift({ ...exon });
        }
      } else {
        const last = scanParts[scanParts.length - 1];
        for (const exon of feature.exons.filter((exon) => exon.end > last.end)) {
          if (exon.start <= last.end + 1) last.end = exon.end;
          else scanParts.push({ ...exon });
        }
      }
    } else if (genome.circular) {
      const first = scanParts[0];
      const last = scanParts[scanParts.length - 1];
      const firstStart = first.start;
      const lastEnd = last.end;
      if (reverse) {
        first.start = firstStart > lastEnd ? lastEnd + 1 : 1;
        if (firstStart <= lastEnd && lastEnd < genome.length)
          scanParts.unshift({ start: lastEnd + 1, end: genome.length });
      } else {
        last.end = lastEnd < firstStart ? firstStart - 1 : genome.length;
        if (lastEnd >= firstStart && firstStart > 1)
          scanParts.push({ start: 1, end: firstStart - 1 });
      }
    } else if (reverse) scanParts[0].start = 1;
    else scanParts[scanParts.length - 1].end = genome.length;
    scanStart = scanParts[0].start - 1;
    scanEnd = scanParts[scanParts.length - 1].end;
  }
  const options = {
    segments: scanParts,
    qualifiers: feature.qualifiers,
    qualifierValues: feature.qualifierValues,
    geneticCodeBasis: genome.geneticCodeBasis,
    sequenceGeneticCode: genome.geneticCode,
  };
  const availableParts =
    scanParts ??
    (scanEnd > scanStart
      ? [{ start: scanStart + 1, end: scanEnd }]
      : genome.circular
        ? [
            { start: scanStart + 1, end: genome.length },
            ...(scanEnd > 0 ? [{ start: 1, end: scanEnd }] : []),
          ]
        : []);
  const availableBases = availableParts.reduce((sum, part) => sum + part.end - part.start + 1, 0);
  const anchoredBases =
    originalParts?.reduce(
      (sum, part) =>
        sum +
        (part.end >= part.start
          ? part.end - part.start + 1
          : genome.length - part.start + 1 + part.end),
      0
    ) ??
    (feature.end > feature.start
      ? feature.end - feature.start
      : genome.circular
        ? genome.length - feature.start + feature.end
        : 0);
  let limit = Math.min(availableBases, Math.max(3, anchoredBases));
  let scanned: CodonInfo[] = [];
  let stop: CodonInfo | undefined;
  for (;;) {
    const bounded = takeCodingParts(availableParts, limit, reverse);
    scanned = translateCDS(
      sequence,
      bounded[0]?.start ? bounded[0].start - 1 : scanStart,
      bounded[bounded.length - 1]?.end ?? scanEnd,
      feature.direction,
      genome.length,
      genome.circular,
      { ...options, segments: bounded }
    );
    stop = scanned.find((codon) => codon.isStop);
    if (stop || limit >= availableBases) break;
    limit = Math.min(availableBases, Math.max(limit + 384, limit * 2));
  }
  const lastIndex = stop?.residueIndex ?? scanned[scanned.length - 1]?.residueIndex ?? 0;
  const codons = scanned.filter((codon) => (codon.residueIndex ?? 0) <= lastIndex);
  const phaseRaw = Number.parseInt(
    feature.qualifierValues?.codon_start?.[0] ?? feature.qualifiers?.codon_start ?? '1',
    10
  );
  const phase = phaseRaw === 2 || phaseRaw === 3 ? phaseRaw - 1 : 0;
  const codingBases = phase + lastIndex * 3;
  let start = feature.start;
  let end = feature.end;
  let parts: Feature['segments'];
  if (scanParts?.length) {
    parts = takeCodingParts(scanParts, codingBases, reverse);
    if (parts.length) {
      start = parts[0].start - 1;
      end = parts[parts.length - 1].end;
    }
  } else if (codingBases > 0) {
    if (reverse)
      start = (((feature.end - codingBases) % genome.length) + genome.length) % genome.length;
    else {
      end = (feature.start + codingBases) % genome.length;
      if (end === 0) end = genome.length;
    }
  }
  const protein = [...new Map(codons.map((codon) => [codon.residueIndex, codon.aa])).values()].join(
    ''
  );
  const translation = protein.replace(/\*$/, '');
  const computed: Feature = {
    ...feature,
    ...(feature.type === 'CDS'
      ? {
          start,
          end,
          ...(feature.exons?.length ? { exons: parts ?? [{ start: start + 1, end }] } : {}),
        }
      : {}),
    ...(originalParts
      ? {
          segments: feature.type === 'CDS' ? parts : feature.segments,
          cds: feature.cds?.length ? parts : undefined,
        }
      : {}),
    qualifiers: { ...feature.qualifiers, translation },
    qualifierValues: { ...feature.qualifierValues, translation: [translation] },
  };
  const introns = getCDSIntrons(sequence, start, end, feature.direction, {
    ...options,
    segments: parts,
  });
  return {
    feature: computed,
    codons,
    introns,
    protein,
    terminated: !!stop,
    uncertain: codons.some((codon) => codon.aa === 'X' && codon.display?.kind !== 'residue'),
  };
}

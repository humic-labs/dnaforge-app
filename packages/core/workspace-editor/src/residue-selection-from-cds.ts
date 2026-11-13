import type { Annotation } from '@waypoint/sequence-utils';
import type { ResidueSelection, ResidueSelectionSource } from './residue-selection-store';
import { applyResidueSelectionCommand } from './residue-selection-store';
import { translatedCdsFeatureKey, translatedCdsMoleculeId } from './residue-biomolecule';
import { buildSplicedCodingSequence, isSplicedCDS } from './translation/spliced-coding-sequence';

export interface CdsCodonSelectionHit {
  start: number;
  end: number;
  strand: 1 | -1;
  residueIndex?: number;
}

export interface BuildResidueSelectionForCdsCodonArgs {
  referenceId: string;
  cds: Annotation;
  codon: CdsCodonSelectionHit;
  fullSequence?: string;
  source?: ResidueSelectionSource;
}

export interface BuildResidueSelectionForCdsCodonRangeArgs {
  referenceId: string;
  cds: Annotation;
  anchorCodon: CdsCodonSelectionHit;
  codon: CdsCodonSelectionHit;
  existingSelection?: ResidueSelection;
  fullSequence?: string;
  source?: ResidueSelectionSource;
}

export function buildResidueSelectionForCdsCodon({
  referenceId,
  cds,
  codon,
  fullSequence,
  source,
}: BuildResidueSelectionForCdsCodonArgs): ResidueSelection | null {
  const residueIndex = residueIndexForCdsCodon(cds, codon, fullSequence);
  if (residueIndex === null) return null;

  const featureId = translatedCdsFeatureKey(cds);
  return {
    selectionId: `translation-track:${referenceId}:${featureId}:${residueIndex}`,
    source: source ?? {
      kind: 'translation-track',
      id: referenceId,
      surface: 'sequence-cds',
      label: featureId,
    },
    target: {
      moleculeId: translatedCdsMoleculeId(referenceId, cds),
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: residueIndex, end: residueIndex }],
      label: featureId,
    },
    mappings: [
      {
        kind: 'coding-dna',
        referenceId,
        featureId,
        strand: codon.strand,
        intervals: [{ start: codon.start, end: codon.end }],
      },
    ],
  };
}

export function buildResidueSelectionForCdsCodonRange({
  referenceId,
  cds,
  anchorCodon,
  codon,
  existingSelection,
  fullSequence,
  source,
}: BuildResidueSelectionForCdsCodonRangeArgs): ResidueSelection | null {
  const anchorResidueIndex = residueIndexForCdsCodon(cds, anchorCodon, fullSequence);
  const residueIndex = residueIndexForCdsCodon(cds, codon, fullSequence);
  if (anchorResidueIndex === null || residueIndex === null) return null;

  const featureId = translatedCdsFeatureKey(cds);
  const moleculeId = translatedCdsMoleculeId(referenceId, cds);
  const additiveIntervals =
    existingSelection?.target.moleculeId === moleculeId &&
    existingSelection.target.moleculeKind === 'translated-cds'
      ? existingSelection.target.intervals
      : [];
  const residueStart = Math.min(
    anchorResidueIndex,
    residueIndex,
    ...additiveIntervals.map((interval) => interval.start)
  );
  const residueEnd = Math.max(
    anchorResidueIndex,
    residueIndex,
    ...additiveIntervals.map((interval) => interval.end)
  );
  const codingDnaIntervals = codingDnaIntervalsForCdsResidueRange({
    cds,
    residueStart,
    residueEnd,
    fullSequence,
  });
  if (!codingDnaIntervals) return null;

  return {
    selectionId: `translation-track:${referenceId}:${featureId}:${residueStart}-${residueEnd}`,
    source: source ?? {
      kind: 'translation-track',
      id: referenceId,
      surface: 'sequence-cds',
      label: featureId,
    },
    target: {
      moleculeId,
      moleculeKind: 'translated-cds',
      coordinateSystem: 'residue',
      intervals: [{ start: residueStart, end: residueEnd }],
      label: featureId,
    },
    mappings: [
      {
        kind: 'coding-dna',
        referenceId,
        featureId,
        strand: codon.strand,
        intervals: codingDnaIntervals,
      },
    ],
  };
}

export function toggleResidueSelection(
  current: ReadonlyArray<ResidueSelection>,
  selection: ResidueSelection
): ReadonlyArray<ResidueSelection> {
  return applyResidueSelectionCommand(current, { type: 'toggle', selection });
}

export function residueIndexForCdsCodon(
  cds: Annotation,
  codon: CdsCodonSelectionHit,
  fullSequence?: string
): number | null {
  if (Number.isInteger(codon.residueIndex) && codon.residueIndex! > 0) {
    return codon.residueIndex! - 1;
  }

  if (isSplicedCDS(cds, fullSequence?.length)) {
    if (!fullSequence) return null;
    const spliced = buildSplicedCodingSequence(cds, fullSequence);
    const hitStart = Math.min(codon.start, codon.end);
    const hitEnd = Math.max(codon.start, codon.end);
    for (let index = 0; index < spliced.proteinLength; index += 1) {
      const offset = spliced.codonStartOffset + index * 3;
      const genomic = spliced.genomicCoordinateMap.slice(offset, offset + 3);
      if (genomic.length < 3) continue;
      if (Math.min(...genomic) === hitStart && Math.max(...genomic) === hitEnd) {
        return index;
      }
    }
    return null;
  }

  const strand = codon.strand;
  const cdsStart = cds.start - 1;
  const cdsEnd = cds.end - 1;

  if (cds.start <= cds.end) {
    if (codon.start < cdsStart || codon.end > cdsEnd) return null;
    if (strand === 1) return Math.floor((codon.start - cdsStart) / 3);
    return Math.floor((cdsEnd - codon.end) / 3);
  }

  if (!fullSequence || fullSequence.length === 0) return null;
  const seqLen = fullSequence.length;
  if (strand === 1) {
    const offset =
      codon.start >= cdsStart ? codon.start - cdsStart : seqLen - cdsStart + codon.start;
    return Math.floor(offset / 3);
  }

  const offset = codon.end <= cdsEnd ? cdsEnd - codon.end : cdsEnd + (seqLen - codon.end);
  return Math.floor(offset / 3);
}

function codingDnaIntervalsForCdsResidueRange({
  cds,
  residueStart,
  residueEnd,
  fullSequence,
}: {
  cds: Annotation;
  residueStart: number;
  residueEnd: number;
  fullSequence?: string;
}): Array<{ start: number; end: number }> | null {
  const intervals: Array<{ start: number; end: number }> = [];
  for (let residueIndex = residueStart; residueIndex <= residueEnd; residueIndex += 1) {
    const interval = codingDnaIntervalForCdsResidue(cds, residueIndex, fullSequence);
    if (!interval) return null;
    intervals.push(interval);
  }
  return intervals;
}

function codingDnaIntervalForCdsResidue(
  cds: Annotation,
  residueIndex: number,
  fullSequence?: string
): { start: number; end: number } | null {
  if (residueIndex < 0) return null;

  if (isSplicedCDS(cds, fullSequence?.length)) {
    if (!fullSequence) return null;
    const spliced = buildSplicedCodingSequence(cds, fullSequence);
    const offset = spliced.codonStartOffset + residueIndex * 3;
    const genomic = spliced.genomicCoordinateMap.slice(offset, offset + 3);
    if (genomic.length < 3) return null;
    return { start: Math.min(...genomic), end: Math.max(...genomic) };
  }

  const strand = cds.direction === -1 ? -1 : 1;
  const codonStartOffset = codonStartOffsetForCds(cds);
  const cdsStart = cds.start - 1;
  const cdsEnd = cds.end - 1;

  if (cds.start <= cds.end) {
    if (strand === 1) {
      const start = cdsStart + codonStartOffset + residueIndex * 3;
      const end = start + 2;
      if (end > cdsEnd) return null;
      return { start, end };
    }
    const end = cdsEnd - codonStartOffset - residueIndex * 3;
    const start = end - 2;
    if (start < cdsStart) return null;
    return { start, end };
  }

  if (!fullSequence || fullSequence.length === 0) return null;
  const seqLen = fullSequence.length;
  let codonLow: number;
  if (strand === 1) {
    codonLow = positiveModulo(cdsStart + codonStartOffset + residueIndex * 3, seqLen);
  } else {
    codonLow = positiveModulo(cdsEnd - codonStartOffset - residueIndex * 3 - 2, seqLen);
  }
  return { start: codonLow, end: positiveModulo(codonLow + 2, seqLen) };
}

function codonStartOffsetForCds(cds: Annotation): number {
  const raw = cds.qualifiers?.codon_start?.[0];
  const parsed = raw ? Number.parseInt(raw, 10) : 1;
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

export { translatedCdsMoleculeId } from './residue-biomolecule';

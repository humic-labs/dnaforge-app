import type {
  SelectionRegion,
  SelectionRegionResidue,
} from '../../../../ai/public/selection-descriptor/types';
import type { ResidueLocation } from '../types';
import {
  codingDnaRangeForStructureResidue,
  type ResidueSelectionLink,
} from './residueSelectionBridge';

export interface AskAiRegionsDerivation {
  regions: SelectionRegion[];
  mappedRegionCount: number;
  primaryRange: { start: number; end: number } | null;
  disjoint: boolean;
  proteinResidueNumbers: number[];
}

interface MappedCodon {
  start: number;
  end: number;
  strand: 1 | -1;
  residue: SelectionRegionResidue;
}

function strandSymbol(strand: 1 | -1): '+' | '-' {
  return strand === 1 ? '+' : '-';
}

export function deriveAskAiRegionsFromStructureResidues(
  link: ResidueSelectionLink | null | undefined,
  residues: ReadonlyArray<ResidueLocation>
): AskAiRegionsDerivation {
  const linked = !!link?.sequenceDocumentId;

  const mappedCodons: MappedCodon[] = [];
  const unmappedResidues: SelectionRegionResidue[] = [];

  for (const residue of residues) {
    const range =
      link?.sequenceDocumentId && !residue.compId
        ? codingDnaRangeForStructureResidue(link, residue)
        : null;
    if (!range) {
      unmappedResidues.push(residueIdentity(residue, undefined));
      continue;
    }
    mappedCodons.push({
      start: range.start,
      end: range.end,
      strand: range.strand,
      residue: residueIdentity(residue, range.residueIndex + 1),
    });
  }

  mappedCodons.sort((a, b) => a.start - b.start || a.end - b.end);

  const mappedRegions: SelectionRegion[] = [];
  for (const codon of mappedCodons) {
    const prev = mappedRegions[mappedRegions.length - 1];
    if (
      prev &&
      prev.codingDnaMapped &&
      prev.strand === strandSymbol(codon.strand) &&
      typeof prev.end === 'number' &&
      codon.start <= prev.end - 1 + 1
    ) {
      prev.end = Math.max(prev.end, codon.end + 1);
      if (!prev.residues.some((r) => sameResidue(r, codon.residue))) {
        prev.residues.push(codon.residue);
      }
      continue;
    }
    mappedRegions.push(toRegion(codon));
  }

  const regions: SelectionRegion[] = [...mappedRegions];
  if (unmappedResidues.length > 0) {
    regions.push({
      codingDnaMapped: false,
      strand: 'unspecified',
      reason: linked ? 'residue-not-in-coding-dna' : 'unlinked-structure-no-coding-dna',
      residues: unmappedResidues,
    });
  }

  const primaryRange =
    mappedRegions.length > 0 && typeof mappedRegions[0].start === 'number'
      ? { start: mappedRegions[0].start, end: mappedRegions[0].end as number }
      : null;

  const proteinResidueNumbers = Array.from(
    new Set(
      mappedRegions
        .flatMap((region) => region.residues)
        .map((r) => r.proteinResidue)
        .filter((n): n is number => typeof n === 'number')
    )
  ).sort((a, b) => a - b);

  return {
    regions,
    mappedRegionCount: mappedRegions.length,
    primaryRange,
    disjoint: regions.length >= 2,
    proteinResidueNumbers,
  };
}

function toRegion(codon: MappedCodon): SelectionRegion {
  return {
    codingDnaMapped: true,
    start: codon.start + 1,
    end: codon.end + 1,
    strand: strandSymbol(codon.strand),
    residues: [codon.residue],
  };
}

function residueIdentity(
  residue: ResidueLocation,
  proteinResidue: number | undefined
): SelectionRegionResidue {
  return {
    chain: residue.chain,
    residueNumber: residue.position,
    ...(typeof proteinResidue === 'number' ? { proteinResidue } : {}),
  };
}

function sameResidue(a: SelectionRegionResidue, b: SelectionRegionResidue): boolean {
  return a.chain === b.chain && a.residueNumber === b.residueNumber;
}

export function residueLabelClause(proteinResidueNumbers: number[]): string {
  const nums = [...proteinResidueNumbers].sort((a, b) => a - b);
  if (nums.length === 0) return '';
  if (nums.length === 1) return `residue ${nums[0]}`;
  const contiguous = nums[nums.length - 1] - nums[0] === nums.length - 1;
  if (contiguous) return `residues ${nums[0]}–${nums[nums.length - 1]}`;
  const CAP = 4;
  const head = nums.slice(0, CAP).join(', ');
  const rest = nums.length - CAP;
  return rest > 0 ? `residues ${head} +${rest} more` : `residues ${head}`;
}

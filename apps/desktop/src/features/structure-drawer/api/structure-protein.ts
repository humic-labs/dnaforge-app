import {
  cdsToProteinSpliced,
  reverseComplement,
  type Annotation,
  type GeneticCodeSpec,
} from '@waypoint/sequence-utils';

export type StructureProteinSource = 'qualifier_translation' | 'derived_cds';

export interface StructureProteinDerivation {
  protein: string;
  rawProtein: string;
  source: StructureProteinSource;
  startCodon: string | null;
  initiatorNormalized: boolean;
}

const STRUCTURE_INITIATOR_CODONS = new Set(['ATG', 'GTG', 'TTG', 'CTG']);

function normalizeProteinText(protein: string): string {
  const cleaned = protein.replace(/\s+/g, '').toUpperCase();
  return cleaned.endsWith('*') ? cleaned.slice(0, -1) : cleaned;
}

function extractForwardCdsDna(
  start: number,
  end: number,
  sequence: string,
  circular: boolean
): string {
  const start0 = start - 1;
  const end0 = end - 1;
  if (start0 < 0 || end0 < 0 || start0 >= sequence.length || end0 >= sequence.length) {
    return '';
  }
  if (start0 <= end0) {
    return sequence.slice(start0, end0 + 1);
  }
  if (!circular) return '';
  return sequence.slice(start0) + sequence.slice(0, end0 + 1);
}

function startCodonForCds(
  annotation: Annotation,
  sequence: string,
  circular: boolean
): string | null {
  if (annotation.direction !== 1 && annotation.direction !== -1) return null;
  const forwardDna = extractForwardCdsDna(annotation.start, annotation.end, sequence, circular);
  if (forwardDna.length < 3) return null;
  const codingDna = annotation.direction === -1 ? reverseComplement(forwardDna) : forwardDna;
  return codingDna.slice(0, 3).toUpperCase();
}

function normalizeInitiator(
  protein: string,
  startCodon: string | null
): {
  protein: string;
  applied: boolean;
} {
  if (!protein || !startCodon || !STRUCTURE_INITIATOR_CODONS.has(startCodon)) {
    return { protein, applied: false };
  }
  if (protein[0] === 'M') {
    return { protein, applied: false };
  }
  return { protein: `M${protein.slice(1)}`, applied: true };
}

export function deriveStructureProteinFromCds(
  annotation: Annotation,
  sequence: string,
  opts: { circular: boolean; sequenceGeneticCode?: GeneticCodeSpec }
): StructureProteinDerivation | null {
  if (annotation.type !== 'CDS') return null;

  const startCodon = startCodonForCds(annotation, sequence, opts.circular);
  const qualifierTranslation = annotation.qualifiers?.translation?.[0];
  if (qualifierTranslation) {
    const protein = normalizeProteinText(qualifierTranslation);
    return {
      protein,
      rawProtein: protein,
      source: 'qualifier_translation',
      startCodon,
      initiatorNormalized: false,
    };
  }

  if (annotation.direction !== 1 && annotation.direction !== -1) return null;
  const raw = cdsToProteinSpliced(annotation, sequence, {
    sequenceLength: opts.circular ? sequence.length : undefined,
    ...(opts.sequenceGeneticCode !== undefined
      ? { sequenceGeneticCode: opts.sequenceGeneticCode }
      : {}),
  });
  if (!raw) return null;
  const rawProtein = normalizeProteinText(raw);
  const normalized = normalizeInitiator(rawProtein, startCodon);
  return {
    protein: normalized.protein,
    rawProtein,
    source: 'derived_cds',
    startCodon,
    initiatorNormalized: normalized.applied,
  };
}

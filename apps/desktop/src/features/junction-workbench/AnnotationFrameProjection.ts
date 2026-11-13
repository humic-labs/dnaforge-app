import type { DesignAnnotation } from '../design/public/types';

const CODON_START_QUALIFIER = 'codon_start';

export interface SourceSpaceAnnotationFrameInput {
  annotation: Pick<DesignAnnotation, 'type' | 'start' | 'end' | 'strand' | 'qualifiers'>;
  clippedStart: number;
  clippedEnd: number;
}

export function qualifiersForSourceSpaceAnnotationSlice({
  annotation,
  clippedStart,
  clippedEnd,
}: SourceSpaceAnnotationFrameInput): Record<string, string> | undefined {
  const qualifiers = annotation.qualifiers ? { ...annotation.qualifiers } : undefined;
  if (annotation.type !== 'CDS') return qualifiers;
  if (annotation.strand !== 'forward' && annotation.strand !== 'reverse') return qualifiers;
  if (clippedEnd <= clippedStart) return qualifiers;

  const existingOffset = codonStartOffset(annotation.qualifiers?.[CODON_START_QUALIFIER]);
  const skippedFromFivePrime =
    annotation.strand === 'forward' ? clippedStart - annotation.start : annotation.end - clippedEnd;
  const localOffset = positiveModulo(existingOffset - skippedFromFivePrime, 3);

  return {
    ...(qualifiers ?? {}),
    [CODON_START_QUALIFIER]: String(localOffset + 1),
  };
}

function codonStartOffset(value: string | undefined): 0 | 1 | 2 {
  const parsed = value ? Number.parseInt(value, 10) : 1;
  return parsed === 2 ? 1 : parsed === 3 ? 2 : 0;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

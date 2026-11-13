import type { GeneticCodeSpec } from './genetic-code-spec';

export type AnnotationDirection = 1 | -1 | 0;

export interface Annotation {
  sourceId?: string;
  canonicalIdentity?: string;
  name: string;
  type: string;
  start: number;
  end: number;
  direction: AnnotationDirection;
  color?: string;
  label?: string;

  qualifiers?: Record<string, string[]>;

  segments?: Array<{ start: number; end: number }>;
}

export type MutationTypeString = 'substitution' | 'insertion' | 'deletion';

export type MutationCategory =
  | 'synonymous'
  | 'non-synonymous'
  | 'frameshift'
  | 'nonsense'
  | 'in-frame'
  | 'unknown';

export interface MutationClassification {
  classification: string;
  in_cds: boolean;
  cds_name?: string | null;
  codon_position?: number | null;
  ref_codon?: string | null;
  alt_codon?: string | null;
  ref_aa?: string | null;
  alt_aa?: string | null;
  ref_aa_3?: string | null;
  alt_aa_3?: string | null;
  aa_change?: string;
}

export interface Mutation {
  position: number;
  type: string;
  length?: number;
  sequence?: string;
  ref?: string;
  alt?: string;
  classification?: MutationClassification;
}

export interface Reference {
  id: string;
  name: string;
  description?: string;
  sequence: string;
  length: number;
  annotations: Annotation[];
  circular: boolean;
}

export interface AnnotatedSequence {
  id: string;
  name: string;
  sequence: string;
  strandOverrides?: import('./sequence-strand-display').SequenceStrandOverride[];
  length: number;
  annotations: Annotation[];
  circular?: boolean;
  description?: string;

  quality?: number[];

  metadata?: Record<string, unknown>;

  chosenGeneticCode?: GeneticCodeSpec;

  unreadableGeneticCode?: string;
  molecule?: string;
}

export interface SequenceSelection {
  start: number;
  end: number;
}

export interface ViewportBounds {
  startIndex: number;
  endIndex: number;
  startRow: number;
  endRow: number;
}

export interface AnnotationLayer {
  annotation: Annotation;
  yOffset: number;
}

import type { PlannotateFeature, DraftAnnotation } from '../types';
import { createDraftAnnotations } from '../annotation-review-utils';

export const FIXTURES: Record<
  string,
  {
    features: PlannotateFeature[];
    sequenceLength: number;
    description: string;
  }
> = {
  pBP010: {
    description: 'pBP010 Mj-tRNA_CUA_T4 — 3126bp circular, chloramphenicol resistance',
    sequenceLength: 3126,
    features: [
      {
        name: 'cat',
        start: 2267,
        end: 2923,
        strand: -1,
        identity: 100.0,
        coverage: 100.0,
        fragment: false,
        type: 'CDS',
        description:
          'CAT_ECOLX - Experimental evidence at protein level: Swiss-Prot protein existence level 1. This enzyme is an effector of chloramphenicol resistance in bacteria.',
        ref_start: 1,
        ref_end: 219,
        ref_length: 219,
        db_source: 'protein',
      },
      {
        name: 'cat promoter',
        start: 2924,
        end: 3026,
        strand: -1,
        identity: 100.0,
        coverage: 100.0,
        fragment: false,
        type: 'promoter',
        description: 'promoter of the E. coli cat gene encoding chloramphenicol acetyltransferase',
        ref_start: 1,
        ref_end: 103,
        ref_length: 103,
        db_source: 'nucleotide',
      },
      {
        name: 'rrnB T1 terminator',
        start: 1193,
        end: 1279,
        strand: 1,
        identity: 100.0,
        coverage: 100.0,
        fragment: false,
        type: 'terminator',
        description:
          'Escherichia coli rrnB; transcription terminator T1 from the E. coli rrnB gene',
        ref_start: 1,
        ref_end: 87,
        ref_length: 87,
        db_source: 'nucleotide',
      },
      {
        name: 'rrnB T1 terminator',
        start: 1855,
        end: 1941,
        strand: 1,
        identity: 100.0,
        coverage: 100.0,
        fragment: false,
        type: 'terminator',
        description:
          'Escherichia coli rrnB; transcription terminator T1 from the E. coli rrnB gene',
        ref_start: 1,
        ref_end: 87,
        ref_length: 87,
        db_source: 'nucleotide',
      },
      {
        name: 'ori',
        start: 1,
        end: 589,
        strand: 1,
        identity: 99.83,
        coverage: 100.0,
        fragment: false,
        type: 'rep_origin',
        description: 'high-copy-number ColE1/pMB1/pBR322/pUC origin of replication',
        ref_start: 1,
        ref_end: 589,
        ref_length: 589,
        db_source: 'nucleotide',
      },
      {
        name: 'rrnB T2 terminator',
        start: 1371,
        end: 1398,
        strand: 1,
        identity: 100.0,
        coverage: 100.0,
        fragment: false,
        type: 'terminator',
        description: 'transcription terminator T2 from the E. coli rrnB gene',
        ref_start: 1,
        ref_end: 28,
        ref_length: 28,
        db_source: 'nucleotide',
      },
      {
        name: 'rrnB T2 terminator',
        start: 2033,
        end: 2060,
        strand: 1,
        identity: 100.0,
        coverage: 100.0,
        fragment: false,
        type: 'terminator',
        description: 'transcription terminator T2 from the E. coli rrnB gene',
        ref_start: 1,
        ref_end: 28,
        ref_length: 28,
        db_source: 'nucleotide',
      },
      {
        name: 'T7 promoter',
        start: 2135,
        end: 2153,
        strand: -1,
        identity: 100.0,
        coverage: 100.0,
        fragment: false,
        type: 'promoter',
        description: 'promoter for bacteriophage T7 RNA polymerase',
        ref_start: 1,
        ref_end: 19,
        ref_length: 19,
        db_source: 'nucleotide',
      },
      {
        name: 'SP6 promoter',
        start: 1019,
        end: 1037,
        strand: 1,
        identity: 100.0,
        coverage: 100.0,
        fragment: false,
        type: 'promoter',
        description: 'promoter for bacteriophage SP6 RNA polymerase',
        ref_start: 1,
        ref_end: 19,
        ref_length: 19,
        db_source: 'nucleotide',
      },
      {
        name: 'AmpR promoter',
        start: 2163,
        end: 2220,
        strand: 1,
        identity: 100.0,
        coverage: 56.31,
        fragment: true,
        type: 'promoter',
        description: 'bla',
        ref_start: 2,
        ref_end: 59,
        ref_length: 103,
        db_source: 'nucleotide',
      },
      {
        name: 'SET1',
        start: 1624,
        end: 1640,
        strand: 1,
        identity: 100.0,
        coverage: 13.49,
        fragment: true,
        type: 'CDS',
        description: 'solubility-enhancement tag derived from T7 phage gene 10B',
        ref_start: 73,
        ref_end: 89,
        ref_length: 126,
        db_source: 'nucleotide',
      },
    ],
  },
};

export function createDraftsFromFixture(
  fixtureName: keyof typeof FIXTURES,
  existingAnnotations: Array<{
    name: string;
    type?: string;
    start: number;
    end: number;
  }> = []
): DraftAnnotation[] {
  const fixture = FIXTURES[fixtureName];
  if (!fixture) throw new Error(`Unknown fixture: ${fixtureName}`);
  return createDraftAnnotations(fixture.features, existingAnnotations);
}

export function makeFeature(
  overrides: Partial<PlannotateFeature> & Pick<PlannotateFeature, 'name' | 'start' | 'end'>
): PlannotateFeature {
  return {
    strand: 1,
    identity: 100,
    coverage: 100,
    fragment: false,
    type: 'CDS',
    description: '',
    ref_start: 1,
    ref_end: overrides.end - overrides.start,
    ref_length: overrides.end - overrides.start,
    db_source: 'nucleotide',
    ...overrides,
  };
}

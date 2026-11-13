import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { RestrictionEnzyme } from '@waypoint/sequence-utils';

vi.mock('./selection-tool-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./selection-tool-base')>();
  return { ...actual, resolveSelectionInput: vi.fn() };
});

                                                                             
                                                                                 
                                                                             
                                               
vi.mock('@waypoint/sequence-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@waypoint/sequence-utils')>();
  return { ...actual, loadAllEnzymes: vi.fn() };
});

import {
  createSelectionRestrictionSitesTool as originalCreateSelectionRestrictionSitesTool,
  selectionRestrictionSitesSchema,
} from './selection-restriction-sites';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { selectionRestrictionSitesOutputSchema } from './sequence-output-schemas';
const createSelectionRestrictionSitesTool = checkedSequenceToolFactory(
  originalCreateSelectionRestrictionSitesTool,
  selectionRestrictionSitesOutputSchema
);

import {
  resolveSelectionInput,
  resolveRawSelection,
  type ResolvedSelection,
  type RawSelectionInput,
} from './selection-tool-base';
import { loadAllEnzymes } from '@waypoint/sequence-utils';
import { execTool } from './test-helpers';

const ECORI: RestrictionEnzyme = {
  name: 'EcoRI',
  recognition_sequence: 'GAATTC',
  recognition_sequence_length: 6,
  cut_position_top: 1,
  cut_position_bottom: 5,
  overhang_type: '5_prime',
  overhang_length: 4,
  enzyme_type: 'Type_II',
  prototype: null,
  source_organism: null,
  methylation_site: null,
  methylation_sensitivity: null,
  optimal_temperature: null,
  heat_inactivation: null,
  suppliers: [],
  rebase_id: null,
  isoschizomers: [],
  neoschizomers: [],
};

function resolved(bases: string): ResolvedSelection {
  return {
    refId: 'ref-1',
    path: '/ws/x.gb',
    parentSequence: bases,
    parentLength: bases.length,
    topology: 'linear',
    range: { start: 100, end: 100 + bases.length - 1, wraps: false },
    sourceVersion: null,
    selectionBases: bases,
    strand: 'unspecified',
    translTable: null,
  };
}

function useRawResolver() {
  vi.mocked(resolveSelectionInput).mockImplementation((input) =>
    resolveRawSelection(input as RawSelectionInput)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAllEnzymes).mockResolvedValue([ECORI]);
});

describe('selection_restriction_sites tool', () => {
  it('reports the EcoRI recognition site for an app selection (positions, not bases)', async () => {
                                                                            
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved('AAGAATTCAA'));
    const tool = createSelectionRestrictionSitesTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1', enzymes: ['EcoRI'] });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].enzyme).toBe('EcoRI');
    expect(result.results[0].siteCount).toBe(1);
    expect(result.results[0].sites[0].recognitionStart).toBe(3);
                                                                              
    expect(result.results[0].sites[0].absoluteRecognitionStart).toBe(102);
    expect(result.refId).toBe('ref-1');
                                        
    expect(JSON.stringify(result)).not.toContain('AAGAATTCAA');
  });

  it('scans a RAW {sequence} input for the EcoRI site', async () => {
    useRawResolver();
    const tool = createSelectionRestrictionSitesTool([]);
    const result = await execTool<any>(tool, { sequence: 'AAGAATTCAA', enzymes: ['EcoRI'] });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].siteCount).toBe(1);
    expect(result.results[0].sites[0].recognitionStart).toBe(3);
                                                                                
    expect(result.results[0].sites[0].absoluteRecognitionStart).toBe(3);
    expect(result.refId).toBe('raw');
    expect(resolveSelectionInput).toHaveBeenCalledWith(
      { sequence: 'AAGAATTCAA', enzymes: ['EcoRI'] },
      []
    );
  });

  it('collects unknown enzyme names in notFound', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved('AAGAATTCAA'));
    const tool = createSelectionRestrictionSitesTool([]);
    const result = await execTool<any>(tool, {
      refId: 'ref-1',
      enzymes: ['EcoRI', 'NotARealEnzyme'],
    });

    expect(result.notFound).toEqual(['NotARealEnzyme']);
    expect(result.results).toHaveLength(1);
  });

  it('propagates resolver errors (refId path)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue({
      error: 'STALE_SELECTION',
      message: 'drifted',
    });
    const tool = createSelectionRestrictionSitesTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1', enzymes: ['EcoRI'] });
    expect(result.error).toBe('STALE_SELECTION');
  });

  describe('input schema (single object —  M1)', () => {
    it('is ONE object exposing refId AND sequence as top-level properties (never a union/oneOf)', () => {
      expect(selectionRestrictionSitesSchema).toBeInstanceOf(z.ZodObject);
      const shape = (selectionRestrictionSitesSchema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['refId', 'sequence', 'enzymes']));
    });
    it('accepts both {refId,enzymes} and {sequence,enzymes}', () => {
      expect(
        selectionRestrictionSitesSchema.safeParse({ refId: 'r', enzymes: ['EcoRI'] }).success
      ).toBe(true);
      expect(
        selectionRestrictionSitesSchema.safeParse({ sequence: 'GAATTC', enzymes: ['EcoRI'] })
          .success
      ).toBe(true);
    });
    it('rejects malformed input (missing enzymes, unknown key)', () => {
      expect(selectionRestrictionSitesSchema.safeParse({ refId: 'r' }).success).toBe(false);
      expect(selectionRestrictionSitesSchema.safeParse({ sequence: 'GAATTC' }).success).toBe(false);
      expect(
        selectionRestrictionSitesSchema.safeParse({
          sequence: 'GAATTC',
          enzymes: ['EcoRI'],
          unexpected: true,
        }).success
      ).toBe(false);
    });
  });
});

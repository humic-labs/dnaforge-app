import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { translateSequence } from '@waypoint/sequence-utils';

vi.mock('./selection-tool-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./selection-tool-base')>();
                                                                                  
                                                        
  return { ...actual, resolveSelectionInput: vi.fn() };
});

import {
  createSelectionTranslateTool as originalCreateSelectionTranslateTool,
  selectionTranslateSchema,
} from './selection-translate';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { selectionTranslateOutputSchema } from './sequence-output-schemas';
const createSelectionTranslateTool = checkedSequenceToolFactory(
  originalCreateSelectionTranslateTool,
  selectionTranslateOutputSchema
);

import {
  resolveSelectionInput,
  resolveRawSelection,
  type ResolvedSelection,
  type RawSelectionInput,
} from './selection-tool-base';
import { execTool } from './test-helpers';

function resolved(overrides: Partial<ResolvedSelection> = {}): ResolvedSelection {
  return {
    refId: 'ref-1',
    path: '/ws/x.gb',
    parentSequence: 'ATGGCCTGA',
    parentLength: 9,
    topology: 'linear',
    range: { start: 1, end: 9, wraps: false },
    sourceVersion: 1,
    selectionBases: 'ATGGCCTGA',
    strand: '+',
    translTable: 1,
    ...overrides,
  };
}

                                                                                     
function useRawResolver() {
  vi.mocked(resolveSelectionInput).mockImplementation((input) =>
    resolveRawSelection(input as RawSelectionInput)
  );
}

beforeEach(() => vi.clearAllMocks());

describe('selection_translate tool', () => {
  it('returns protein only (no raw bases) for a forward app selection (refId)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved());
    const tool = createSelectionTranslateTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });

    expect(result.protein).toBe('MA*');
    expect(result.proteinLengthAa).toBe(3);
    expect(result.strand).toBe('+');
    expect(result.startsWithMet).toBe(true);
    expect(result.refId).toBe('ref-1');
                                                          
    expect(JSON.stringify(result)).not.toContain('ATGGCC');
  });

  it('reverse-complements a minus-strand selection before translating', async () => {
                                                 
    vi.mocked(resolveSelectionInput).mockReturnValue(
      resolved({ selectionBases: 'TCAGGCCAT', strand: '-' })
    );
    const tool = createSelectionTranslateTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });

    expect(result.protein).toBe('MA*');
    expect(result.strand).toBe('-');
  });

  it('applies a declared non-standard translation table', async () => {
                                                                          
                                                                            
                                                       
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved({ translTable: 2 }));
    const tool = createSelectionTranslateTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });

    expect(result.translTable).toBe(2);
    expect(result.geneticCode).toBe('2 — Vertebrate Mitochondrial');
    expect(result.protein).toBe('MAW');
    expect(result.hasInternalStop).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it('falls back to the standard code and says so for an unpublished table id', async () => {
                                                                    
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved({ translTable: 7 }));
    const tool = createSelectionTranslateTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });

    expect(result.geneticCode).toBe('1 — Standard');
    expect(result.protein).toBe('MA*');
    expect(result.note).toMatch(/table 7/);
  });

  it('translates a RAW {sequence} input (matches an independent translate oracle)', async () => {
    useRawResolver();
    const bases = 'ATGAAATAG';         
    const tool = createSelectionTranslateTool([]);
    const result = await execTool<any>(tool, { sequence: bases });

    const oracle = translateSequence(bases, 1, 0)
      .map((c) => c.aminoAcid)
      .join('');
    expect(result.protein).toBe(oracle);
    expect(result.proteinLengthAa).toBe(oracle.length);
                                                                               
    expect(result.refId).toBe('raw');
    expect(resolveSelectionInput).toHaveBeenCalledWith({ sequence: bases }, []);
  });

  it('honors strand on a RAW minus-strand {sequence} input', async () => {
    useRawResolver();
                                                 
    const tool = createSelectionTranslateTool([]);
    const result = await execTool<any>(tool, { sequence: 'TCAGGCCAT', strand: '-' });

    expect(result.protein).toBe('MA*');
    expect(result.strand).toBe('-');
  });

  it('propagates STALE_SELECTION from the resolver (refId path only)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue({
      error: 'STALE_SELECTION',
      message: 'drifted',
    });
    const tool = createSelectionTranslateTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });

    expect(result.error).toBe('STALE_SELECTION');
  });

  it('returns DISJOINT_SELECTION for a multi-region selection — NEVER a concatenated protein', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue({
      error: 'DISJOINT_SELECTION',
      message:
        'This selection spans 3 disjoint regions (1-3; 5-7; 9-11). Run this tool per region.',
      regions: [
        { codingDnaMapped: true, start: 1, end: 3 },
        { codingDnaMapped: true, start: 5, end: 7 },
        { codingDnaMapped: true, start: 9, end: 11 },
      ],
    });
    const tool = createSelectionTranslateTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });

    expect(result.error).toBe('DISJOINT_SELECTION');
                                                              
    expect(result.protein).toBeUndefined();
    expect(result.proteinLengthAa).toBeUndefined();
    expect(result.regions).toHaveLength(3);
  });

  describe('input schema (single object —  M1)', () => {
    it('is ONE object exposing refId AND sequence as top-level properties (never a union/oneOf)', () => {
                                                                                 
                                                                                   
                                                                           
      expect(selectionTranslateSchema).toBeInstanceOf(z.ZodObject);
      const shape = (selectionTranslateSchema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['refId', 'sequence']));
    });
    it('accepts an app selection {refId}', () => {
      expect(selectionTranslateSchema.safeParse({ refId: 'r' }).success).toBe(true);
    });
    it('accepts raw {sequence} (with optional metadata)', () => {
      expect(selectionTranslateSchema.safeParse({ sequence: 'ATG' }).success).toBe(true);
      expect(
        selectionTranslateSchema.safeParse({
          sequence: 'ATG',
          strand: '-',
          translTable: 11,
          topology: 'circular',
          start: 1,
          end: 3,
        }).success
      ).toBe(true);
    });
    it('rejects unknown keys (strict)', () => {
      expect(selectionTranslateSchema.safeParse({ refId: 'r', unexpected: true }).success).toBe(
        false
      );
    });
    it('leaves the refId|sequence XOR to resolveSelectionInput, not the schema', () => {
                                                                                 
                                                                                      
                                                                                    
      expect(selectionTranslateSchema.safeParse({}).success).toBe(true);
      expect(selectionTranslateSchema.safeParse({ refId: 'r', sequence: 'ATG' }).success).toBe(
        true
      );
    });
  });
});

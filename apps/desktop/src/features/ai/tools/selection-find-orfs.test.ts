import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { findORFs } from '@waypoint/sequence-utils';

vi.mock('./selection-tool-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./selection-tool-base')>();
  return { ...actual, resolveSelectionInput: vi.fn() };
});

import {
  createSelectionFindOrfsTool as originalCreateSelectionFindOrfsTool,
  selectionFindOrfsSchema,
} from './selection-find-orfs';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { selectionFindOrfsOutputSchema } from './sequence-output-schemas';
const createSelectionFindOrfsTool = checkedSequenceToolFactory(
  originalCreateSelectionFindOrfsTool,
  selectionFindOrfsOutputSchema
);

import {
  resolveSelectionInput,
  resolveRawSelection,
  type ResolvedSelection,
  type RawSelectionInput,
} from './selection-tool-base';
import { execTool } from './test-helpers';

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

beforeEach(() => vi.clearAllMocks());

describe('selection_find_orfs tool', () => {
  it('returns an ORF table for an app selection (coordinates only, no raw bases)', async () => {
                                                                     
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved('ATGTGA'));
    const tool = createSelectionFindOrfsTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1', minLen: 6 });

    expect(result.orfCount).toBe(1);
    expect(result.orfs[0]).toMatchObject({
      start: 1,
      end: 6,
      strand: '+',
      frame: 1,
      lengthBp: 6,
      absoluteStart: 100,
    });
    expect(result.refId).toBe('ref-1');
    expect(JSON.stringify(result)).not.toContain('ATGTGA');
  });

  it('finds ORFs in a RAW {sequence} input (matches an independent findORFs oracle)', async () => {
    useRawResolver();
    const bases = 'ATGTGA';
    const tool = createSelectionFindOrfsTool([]);
    const result = await execTool<any>(tool, { sequence: bases, minLen: 6 });

    const oracle = findORFs(bases, 6);
    expect(result.orfCount).toBe(oracle.length);
    expect(result.orfs[0]).toMatchObject({ start: 1, end: 6, strand: '+', frame: 1, lengthBp: 6 });
                                                                                
    expect(result.orfs[0].absoluteStart).toBe(1);
    expect(result.refId).toBe('raw');
    expect(resolveSelectionInput).toHaveBeenCalledWith({ sequence: bases, minLen: 6 }, []);
  });

  it('propagates resolver errors (refId path)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue({
      error: 'NO_RANGE',
      message: 'no range',
    });
    const tool = createSelectionFindOrfsTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });
    expect(result.error).toBe('NO_RANGE');
  });

  describe('input schema (single object —  M1)', () => {
    it('is ONE object exposing refId AND sequence as top-level properties (never a union/oneOf)', () => {
      expect(selectionFindOrfsSchema).toBeInstanceOf(z.ZodObject);
      const shape = (selectionFindOrfsSchema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['refId', 'sequence', 'minLen']));
    });
    it('accepts both {refId} and {sequence} (with optional minLen)', () => {
      expect(selectionFindOrfsSchema.safeParse({ refId: 'r' }).success).toBe(true);
      expect(selectionFindOrfsSchema.safeParse({ sequence: 'ATGTGA', minLen: 6 }).success).toBe(
        true
      );
    });
    it('rejects unknown keys (strict)', () => {
      expect(
        selectionFindOrfsSchema.safeParse({ sequence: 'ATGTGA', unexpected: true }).success
      ).toBe(false);
    });
    it('leaves the refId|sequence XOR to resolveSelectionInput, not the schema', () => {
      expect(selectionFindOrfsSchema.safeParse({}).success).toBe(true);
      expect(selectionFindOrfsSchema.safeParse({ refId: 'r', sequence: 'ATGTGA' }).success).toBe(
        true
      );
    });
  });
});

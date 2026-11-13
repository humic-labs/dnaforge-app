import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { reverseComplement } from '@waypoint/sequence-utils';

vi.mock('./selection-tool-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./selection-tool-base')>();
  return { ...actual, resolveSelectionInput: vi.fn() };
});

import {
  createSelectionReverseComplementTool as originalCreateSelectionReverseComplementTool,
  selectionReverseComplementSchema,
  REVERSE_COMPLEMENT_CAP_BP,
} from './selection-reverse-complement';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { selectionReverseComplementOutputSchema } from './sequence-output-schemas';
const createSelectionReverseComplementTool = checkedSequenceToolFactory(
  originalCreateSelectionReverseComplementTool,
  selectionReverseComplementOutputSchema
);

import {
  resolveSelectionInput,
  resolveRawSelection,
  type ResolvedSelection,
  type RawSelectionInput,
} from './selection-tool-base';
import { execTool } from './test-helpers';

function resolved(bases: string, nucleicAcid: ResolvedSelection['nucleicAcid'] = 'dna'): ResolvedSelection {
  return {
    refId: 'ref-1',
    path: '/ws/x.gb',
    parentSequence: bases,
    parentLength: bases.length,
    topology: 'linear',
    range: { start: 1, end: bases.length, wraps: false },
    sourceVersion: null,
    selectionBases: bases,
    strand: 'unspecified',
    translTable: null,
    nucleicAcid,
  };
}

function useRawResolver() {
  vi.mocked(resolveSelectionInput).mockImplementation((input) =>
    resolveRawSelection(input as RawSelectionInput)
  );
}

beforeEach(() => vi.clearAllMocks());

describe('selection_reverse_complement tool', () => {
  it('returns the reverse complement of an app selection (refId)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved('ATGC'));
    const tool = createSelectionReverseComplementTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });

    expect(result.reverseComplement).toBe('GCAT');
    expect(result.length).toBe(4);
    expect(result.refId).toBe('ref-1');
  });

  it('reverse-complements a RAW {sequence} input (matches an independent oracle)', async () => {
    useRawResolver();
    const bases = 'ATGCAATTGC';
    const tool = createSelectionReverseComplementTool([]);
    const result = await execTool<any>(tool, { sequence: bases });

    expect(result.reverseComplement).toBe(reverseComplement(bases));
    expect(result.length).toBe(bases.length);
    expect(result.refId).toBe('raw');
    expect(resolveSelectionInput).toHaveBeenCalledWith({ sequence: bases }, []);
  });

  it('reverse-complements an RNA app selection with U ', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved('AUGGCU', 'rna'));
    const tool = createSelectionReverseComplementTool([]);
    const result = await execTool<{ reverseComplement: string }>(tool, { refId: 'ref-1' });

    expect(result.reverseComplement).toBe('AGCCAU');
  });

  it('reverse-complements RAW RNA input with U ', async () => {
    useRawResolver();
    const tool = createSelectionReverseComplementTool([]);
    const result = await execTool<{ reverseComplement: string }>(tool, { sequence: 'AAUGC' });

    expect(result.reverseComplement).toBe('GCAUU');
  });

  it('rejects a selection larger than the cap (refId path)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(
      resolved('A'.repeat(REVERSE_COMPLEMENT_CAP_BP + 1))
    );
    const tool = createSelectionReverseComplementTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });

    expect(result.error).toBe('RANGE_TOO_LARGE');
  });

  it('rejects a RAW {sequence} larger than the cap', async () => {
    useRawResolver();
    const tool = createSelectionReverseComplementTool([]);
    const result = await execTool<any>(tool, {
      sequence: 'A'.repeat(REVERSE_COMPLEMENT_CAP_BP + 1),
    });

    expect(result.error).toBe('RANGE_TOO_LARGE');
  });

  it('propagates resolver errors (refId path)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue({
      error: 'REFERENCE_NOT_FOUND',
      message: 'nope',
    });
    const tool = createSelectionReverseComplementTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });
    expect(result.error).toBe('REFERENCE_NOT_FOUND');
  });

  describe('input schema (single object —  M1)', () => {
    it('is ONE object exposing refId AND sequence as top-level properties (never a union/oneOf)', () => {
      expect(selectionReverseComplementSchema).toBeInstanceOf(z.ZodObject);
      const shape = (selectionReverseComplementSchema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['refId', 'sequence']));
    });
    it('accepts both {refId} and {sequence}', () => {
      expect(selectionReverseComplementSchema.safeParse({ refId: 'r' }).success).toBe(true);
      expect(selectionReverseComplementSchema.safeParse({ sequence: 'ATGC' }).success).toBe(true);
    });
    it('rejects unknown keys (strict)', () => {
      expect(
        selectionReverseComplementSchema.safeParse({ sequence: 'ATG', unexpected: true }).success
      ).toBe(false);
    });
    it('leaves the refId|sequence XOR to resolveSelectionInput, not the schema', () => {
      expect(selectionReverseComplementSchema.safeParse({}).success).toBe(true);
      expect(
        selectionReverseComplementSchema.safeParse({ refId: 'r', sequence: 'ATGC' }).success
      ).toBe(true);
    });
  });
});

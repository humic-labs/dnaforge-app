import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { calculateGcContent } from '../../design/algorithms/tm-calculator';

vi.mock('./selection-tool-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./selection-tool-base')>();
  return { ...actual, resolveSelectionInput: vi.fn() };
});

import {
  createSelectionGcProfileTool as originalCreateSelectionGcProfileTool,
  selectionGcProfileSchema,
} from './selection-gc-profile';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { selectionGcProfileOutputSchema } from './sequence-output-schemas';
const createSelectionGcProfileTool = checkedSequenceToolFactory(
  originalCreateSelectionGcProfileTool,
  selectionGcProfileOutputSchema
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
    range: { start: 1, end: bases.length, wraps: false },
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

describe('selection_gc_profile tool', () => {
  it('returns per-window and aggregate GC% for an app selection (no raw bases)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved('GGGGCCCCAAAATTTT'));
    const tool = createSelectionGcProfileTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1', window: 4 });

    expect(result.overallGcPercent).toBe(50);
    expect(result.windows).toHaveLength(4);
    expect(result.windows.map((w: any) => w.gcPercent)).toEqual([100, 100, 0, 0]);
    expect(result.windows[0]).toMatchObject({ start: 1, end: 4 });
    expect(result.refId).toBe('ref-1');
    expect(JSON.stringify(result)).not.toContain('GGGGCCCC');
  });

  it('profiles a RAW {sequence} input (matches an independent GC oracle)', async () => {
    useRawResolver();
    const bases = 'GGGGCCCCAAAATTTT';
    const tool = createSelectionGcProfileTool([]);
    const result = await execTool<any>(tool, { sequence: bases, window: 4 });

    expect(result.overallGcPercent).toBe(calculateGcContent(bases));
    expect(result.windows.map((w: any) => w.gcPercent)).toEqual([100, 100, 0, 0]);
    expect(result.refId).toBe('raw');
    expect(resolveSelectionInput).toHaveBeenCalledWith({ sequence: bases, window: 4 }, []);
  });

  it('propagates resolver errors (refId path)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue({
      error: 'SEQUENCE_UNAVAILABLE',
      message: 'gone',
    });
    const tool = createSelectionGcProfileTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1' });
    expect(result.error).toBe('SEQUENCE_UNAVAILABLE');
  });

  describe('input schema (single object —  M1)', () => {
    it('is ONE object exposing refId AND sequence as top-level properties (never a union/oneOf)', () => {
      expect(selectionGcProfileSchema).toBeInstanceOf(z.ZodObject);
      const shape = (selectionGcProfileSchema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).toEqual(expect.arrayContaining(['refId', 'sequence', 'window']));
    });
    it('accepts both {refId} and {sequence} (with optional window)', () => {
      expect(selectionGcProfileSchema.safeParse({ refId: 'r' }).success).toBe(true);
      expect(selectionGcProfileSchema.safeParse({ sequence: 'ATGC', window: 2 }).success).toBe(
        true
      );
    });
    it('rejects unknown keys (strict)', () => {
      expect(
        selectionGcProfileSchema.safeParse({ sequence: 'ATGC', unexpected: true }).success
      ).toBe(false);
    });
    it('leaves the refId|sequence XOR to resolveSelectionInput, not the schema', () => {
      expect(selectionGcProfileSchema.safeParse({}).success).toBe(true);
      expect(selectionGcProfileSchema.safeParse({ refId: 'r', sequence: 'ATGC' }).success).toBe(
        true
      );
    });
  });
});

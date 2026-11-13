import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('./selection-tool-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./selection-tool-base')>();
  return { ...actual, resolveSelectionInput: vi.fn() };
});

import { getSelectionBasesOutputSchema,
  createGetSelectionBasesTool as uncheckedcreateGetSelectionBasesTool,
  getSelectionBasesSchema,
  GET_SELECTION_BASES_CAP_BP,
} from './selection-bases';
import {
  resolveSelectionInput,
  resolveRawSelection,
  type ResolvedSelection,
  type RawSelectionInput,
} from './selection-tool-base';
import { execTool } from './test-helpers';

const PARENT = 'AAATTTGGGCCC';         

function resolved(overrides: Partial<ResolvedSelection> = {}): ResolvedSelection {
  return {
    refId: 'ref-1',
    documentId: 'catalog-x',
    parentSequence: PARENT,
    parentLength: PARENT.length,
    topology: 'circular',
    range: { start: 1, end: 12, wraps: false },
    sourceVersion: 1,
    selectionBases: PARENT,
    strand: 'unspecified',
    translTable: null,
    ...overrides,
  };
}

function useRawResolver() {
  vi.mocked(resolveSelectionInput).mockImplementation((input) =>
    resolveRawSelection(input as RawSelectionInput)
  );
}

beforeEach(() => vi.clearAllMocks());

describe('get_selection_bases tool', () => {
  it('returns a bounded raw window from an app selection using highlight_range semantics', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved());
    const tool = createGetSelectionBasesTool([]);
                                      
    const result = await execTool<any>(tool, { refId: 'ref-1', start: 4, end: 6 });

    expect(result.bases).toBe('TTT');
    expect(result.length).toBe(3);
    expect(result.start).toBe(4);
    expect(result.end).toBe(6);
    expect(result.refId).toBe('ref-1');
  });

  it('returns a bounded raw window from a RAW {sequence} input', async () => {
    useRawResolver();
    const tool = createGetSelectionBasesTool([]);
    const result = await execTool<any>(tool, { sequence: PARENT, start: 4, end: 6 });

    expect(result.bases).toBe('TTT');
    expect(result.length).toBe(3);
    expect(result.refId).toBe('raw');
    expect(result.documentId).toBeNull();
    expect(resolveSelectionInput).toHaveBeenCalledWith(
      { sequence: PARENT, start: 4, end: 6 },
      []
    );
  });

  it('supports an origin-wrapping window (app selection)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(resolved());
    const tool = createGetSelectionBasesTool([]);
                                
    const result = await execTool<any>(tool, { refId: 'ref-1', start: 11, end: 2, wraps: true });

    expect(result.bases).toBe('CCAA');
    expect(result.wraps).toBe(true);
  });

  it('supports an origin-wrapping window from a RAW {sequence} input', async () => {
    useRawResolver();
    const tool = createGetSelectionBasesTool([]);
    const result = await execTool<any>(tool, { sequence: PARENT, start: 11, end: 2, wraps: true });

    expect(result.bases).toBe('CCAA');
    expect(result.wraps).toBe(true);
    expect(result.refId).toBe('raw');
  });

  it('rejects a non-wrapping end < start before resolving (highlight_range contract)', async () => {
    const tool = createGetSelectionBasesTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1', start: 6, end: 4 });

    expect(result.code).toBe('INVALID_RANGE');
                                                   
    expect(resolveSelectionInput).not.toHaveBeenCalled();
  });

  it('hard-caps the raw window at the cap size (app selection)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue(
      resolved({ parentLength: 100000, parentSequence: 'A'.repeat(100000) })
    );
    const tool = createGetSelectionBasesTool([]);
    const result = await execTool<any>(tool, {
      refId: 'ref-1',
      start: 1,
      end: GET_SELECTION_BASES_CAP_BP + 1,
    });

    expect(result.code).toBe('RANGE_TOO_LARGE');
    expect(result.bases).toBeUndefined();
  });

  it('hard-caps the raw window at the cap size (RAW {sequence})', async () => {
    useRawResolver();
    const tool = createGetSelectionBasesTool([]);
    const result = await execTool<any>(tool, {
      sequence: 'A'.repeat(100000),
      start: 1,
      end: GET_SELECTION_BASES_CAP_BP + 1,
    });

    expect(result.code).toBe('RANGE_TOO_LARGE');
    expect(result.bases).toBeUndefined();
  });

  it('propagates STALE_SELECTION from the resolver (refId path only)', async () => {
    vi.mocked(resolveSelectionInput).mockReturnValue({
      error: 'STALE_SELECTION',
      message: 'drifted',
    });
    const tool = createGetSelectionBasesTool([]);
    const result = await execTool<any>(tool, { refId: 'ref-1', start: 1, end: 5 });
    expect(result.code).toBe('STALE_SELECTION');
  });

  describe('input schema (single object —  M1)', () => {
    it('is ONE object exposing refId AND sequence as top-level properties (never a union/oneOf)', () => {
      expect(getSelectionBasesSchema).toBeInstanceOf(z.ZodObject);
      const shape = (getSelectionBasesSchema as z.ZodObject<z.ZodRawShape>).shape;
      expect(Object.keys(shape)).toEqual(
        expect.arrayContaining(['refId', 'sequence', 'start', 'end'])
      );
    });
    it('accepts both {refId,start,end} and {sequence,start,end}', () => {
      expect(getSelectionBasesSchema.safeParse({ refId: 'r', start: 1, end: 5 }).success).toBe(
        true
      );
      expect(
        getSelectionBasesSchema.safeParse({ sequence: 'ATGC', start: 1, end: 3, wraps: false })
          .success
      ).toBe(true);
    });
    it('rejects malformed input (missing window bounds, unknown key)', () => {
      expect(getSelectionBasesSchema.safeParse({ refId: 'r', start: 1 }).success).toBe(false);
      expect(getSelectionBasesSchema.safeParse({ sequence: 'ATGC' }).success).toBe(false);
      expect(
        getSelectionBasesSchema.safeParse({ refId: 'r', start: 1, end: 5, unexpected: true })
          .success
      ).toBe(false);
    });
  });
});

import { checkedToolFactory } from '../../../test-utils/mcp-output-test-helper';
const createGetSelectionBasesTool = checkedToolFactory(uncheckedcreateGetSelectionBasesTool, getSelectionBasesOutputSchema);

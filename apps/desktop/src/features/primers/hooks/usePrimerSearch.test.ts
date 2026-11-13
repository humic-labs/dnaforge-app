import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrimerSearch } from './usePrimerSearch';
import type { PrimerSearchResult } from '../primer-search-service';

const operationMocks = vi.hoisted(() => ({
  beginToolOperation: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../../lib/analytics-operation', () => ({
  beginToolOperation: operationMocks.beginToolOperation,
}));

vi.mock('../primer-search-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primer-search-service')>();
  return { ...actual, findBindingCandidates: vi.fn() };
});
vi.mock('../primer-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primer-service')>();
  return { ...actual, searchPrimers: vi.fn(), createBinding: vi.fn() };
});
vi.mock('../primer-artifact-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../primer-artifact-service')>();
  return {
    ...actual,
    primerArtifactRelativePath: vi.fn((primer: { originDetails?: Record<string, unknown> }) =>
      primer.originDetails?.authority === 'primer_artifact'
        ? (primer.originDetails.artifactPath as string)
        : null
    ),
    attachPrimerArtifact: vi.fn(),
  };
});

import { findBindingCandidates } from '../primer-search-service';
import { searchPrimers } from '../primer-service';
import { attachPrimerArtifact } from '../primer-artifact-service';

const mockFind = vi.mocked(findBindingCandidates);
const mockSearchPrimers = vi.mocked(searchPrimers);
const mockAttachPrimerArtifact = vi.mocked(attachPrimerArtifact);

const REF = 'ACGT'.repeat(50);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hit(id = 'p1'): PrimerSearchResult {
  return {
    primer: { id, name: id, sequence: 'ACGTACGTACGTACGT' } as any,
    hits: [],
    bestHit: { start: 0, end: 16, strand: 1, identity: 1, editDistance: 0 } as any,
    isAttached: false,
  };
}

describe('usePrimerSearch — libraryEmpty + error derivation  edge 7a/7b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    operationMocks.beginToolOperation.mockReturnValue({
      operationId: '550e8400-e29b-41d4-a716-446655440020',
      consumed: false,
      complete: operationMocks.complete,
      fail: operationMocks.fail,
      cancel: operationMocks.cancel,
    });
  });

  it('sets libraryEmpty=true when a search returns no hits and the library is empty', async () => {
    mockFind.mockResolvedValueOnce([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSearchPrimers.mockResolvedValueOnce([] as any);
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));
    await act(async () => {
      await result.current.search({});
    });
    expect(result.current.libraryEmpty).toBe(true);
    expect(result.current.results).toEqual([]);
    expect(operationMocks.complete).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        resultCount: 0,
        usableResult: false,
        valueDelivered: false,
        outcomeKind: 'library_empty',
      })
    );
    expect(mockSearchPrimers).toHaveBeenCalledTimes(1);
  });

  it('sets libraryEmpty=false when no hits but the library is non-empty', async () => {
    mockFind.mockResolvedValueOnce([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSearchPrimers.mockResolvedValueOnce([{ id: 'p1' }] as any);
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));
    await act(async () => {
      await result.current.search({});
    });
    expect(result.current.libraryEmpty).toBe(false);
    expect(operationMocks.complete).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ outcomeKind: 'no_match', usableResult: false })
    );
  });

  it('does not probe the library and keeps libraryEmpty=false when there ARE hits', async () => {
    mockFind.mockResolvedValueOnce([hit()]);
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));
    await act(async () => {
      await result.current.search({});
    });
    expect(result.current.results).toHaveLength(1);
    expect(result.current.libraryEmpty).toBe(false);
    expect(mockSearchPrimers).not.toHaveBeenCalled();
    expect(operationMocks.beginToolOperation).toHaveBeenCalledWith({
      toolId: 'primer_design',
      surface: 'sidebar',
      action: 'searched',
    });
    expect(operationMocks.complete).toHaveBeenCalledOnce();
    expect(operationMocks.complete).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ outcomeKind: 'candidates', usableResult: true, resultCount: 1 })
    );
  });

  it('leaves libraryEmpty unchanged and does not crash when the library probe throws', async () => {
    mockFind.mockResolvedValueOnce([]);
    mockSearchPrimers.mockRejectedValueOnce(new Error('DB error'));
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));
    await act(async () => {
      await result.current.search({});
    });
    expect(result.current.libraryEmpty).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('sets error and clears results (no crash) when the search itself fails', async () => {
    mockFind.mockRejectedValueOnce(new Error('Could not reach the primer matcher'));
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));
    await act(async () => {
      await result.current.search({});
    });
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toMatch(/matcher/i);
    expect(result.current.results).toEqual([]);
    expect(operationMocks.fail).toHaveBeenCalledOnce();
    expect(operationMocks.fail).toHaveBeenCalledWith('sidecar');
    expect(operationMocks.complete).not.toHaveBeenCalled();
  });

  it('attach marks the primer attached but KEEPS the other results (session stays alive)', async () => {
    mockFind.mockResolvedValueOnce([hit('p1'), hit('p2')]);
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));
    await act(async () => {
      await result.current.search({});
    });
    expect(result.current.results).toHaveLength(2);

    await act(async () => {
      await result.current.attach(
        result.current.results[0].primer,
        result.current.results[0].bestHit!
      );
    });

    expect(result.current.results).toHaveLength(2);
    expect(result.current.results.find((r) => r.primer.id === 'p1')?.isAttached).toBe(true);
    expect(result.current.results.find((r) => r.primer.id === 'p2')?.isAttached).toBe(false);
  });

  it('attaches an artifact-backed primer by revising the workspace file', async () => {
    const resultRow = hit('artifact-primer');
    resultRow.primer.originDetails = {
      authority: 'primer_artifact',
      artifactPath: 'primers/Artifact.primer.json',
    };
    mockFind.mockResolvedValueOnce([resultRow]);
    mockAttachPrimerArtifact.mockResolvedValueOnce({} as any);
    const { createBinding } = await import('../primer-service');
    const { result } = renderHook(() =>
      usePrimerSearch(42, REF, false, {
        workspaceRoot: '/workspace',
        targetFilePath: '/workspace/pUC19.gb',
      })
    );
    await act(async () => result.current.search({}));

    await act(async () => result.current.attach(resultRow.primer, resultRow.bestHit!));

    expect(mockAttachPrimerArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        primer: resultRow.primer,
        workspaceRoot: '/workspace',
        targetFilePath: '/workspace/pUC19.gb',
        bindingSequenceId: 42,
      })
    );
    expect(createBinding).not.toHaveBeenCalled();
  });

  it('clear() cancels an in-flight search so it cannot repopulate results', async () => {
    let resolveFind!: (v: PrimerSearchResult[]) => void;
    mockFind.mockReturnValueOnce(
      new Promise<PrimerSearchResult[]>((res) => {
        resolveFind = res;
      })
    );
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));

    let searchPromise!: Promise<void>;
    act(() => {
      searchPromise = result.current.search({});
    });
    expect(result.current.isSearching).toBe(true);

    act(() => {
      result.current.clear();
    });
    expect(result.current.isSearching).toBe(false);

    await act(async () => {
      resolveFind([hit('p1'), hit('p2')]);
      await searchPromise;
    });
    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
    expect(operationMocks.cancel).toHaveBeenCalledOnce();
    expect(operationMocks.complete).not.toHaveBeenCalled();
    expect(operationMocks.fail).not.toHaveBeenCalled();
  });

  it('clear() resets results, error, and libraryEmpty', async () => {
    mockFind.mockResolvedValueOnce([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockSearchPrimers.mockResolvedValueOnce([] as any);
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));
    await act(async () => {
      await result.current.search({});
    });
    expect(result.current.libraryEmpty).toBe(true);
    act(() => {
      result.current.clear();
    });
    expect(result.current.libraryEmpty).toBe(false);
    expect(result.current.results).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('cancels a superseded generation and allows only the newest generation to complete', async () => {
    let resolveFirst!: (value: PrimerSearchResult[]) => void;
    mockFind
      .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
      .mockResolvedValueOnce([hit('newest')]);
    const { result } = renderHook(() => usePrimerSearch(42, REF, false));

    let first!: Promise<void>;
    act(() => {
      first = result.current.search({});
    });
    await act(async () => result.current.search({ maxMismatches: 1 }));
    await act(async () => {
      resolveFirst([hit('stale')]);
      await first;
    });

    expect(result.current.results.map((row) => row.primer.id)).toEqual(['newest']);
    expect(operationMocks.cancel).toHaveBeenCalledOnce();
    expect(operationMocks.complete).toHaveBeenCalledOnce();
    expect(operationMocks.fail).not.toHaveBeenCalled();
  });

  it('no-ops (no search, no error) when sequenceId is null', async () => {
    const { result } = renderHook(() => usePrimerSearch(null, REF, false));
    await act(async () => {
      await result.current.search({});
    });
    expect(mockFind).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(operationMocks.beginToolOperation).not.toHaveBeenCalled();
  });
});

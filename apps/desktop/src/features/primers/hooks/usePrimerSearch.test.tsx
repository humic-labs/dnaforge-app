import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrimerSearchResult } from '../primer-search-service';
import type { Primer } from '../types';
import { usePrimerSearch } from './usePrimerSearch';

const { findLibrary, findLibraryOnTarget, cancelTelemetry } = vi.hoisted(() => ({
  findLibrary: vi.fn(),
  findLibraryOnTarget: vi.fn(),
  cancelTelemetry: vi.fn(),
}));

vi.mock('../primer-services', () => ({
  primerServices: {
    bindingSearch: { findLibrary, findLibraryOnTarget },
    persistence: {
      searchLegacyPrimers: vi.fn().mockResolvedValue([{ id: 'primer-a' }]),
      attachBinding: vi.fn(),
      createLegacyBinding: vi.fn(),
    },
  },
}));

vi.mock('../primer-artifact-service', () => ({
  primerArtifactRelativePath: () => null,
}));

vi.mock('../../../lib/analytics-operation', () => ({
  beginToolOperation: () => ({
    complete: vi.fn(),
    fail: vi.fn(),
    cancel: cancelTelemetry,
  }),
}));

vi.mock('../../../lib/workflow-telemetry', () => ({
  runWorkflowAction: vi.fn(),
}));

function primer(): Primer {
  return {
    id: 'primer-a',
    catalogNumber: 'P-1',
    name: 'Primer A',
    sequence: 'primer-one',
    length: 10,
    tm: null,
    gcPercent: 0,
    origin: 'manual',
    originDetails: null,
    status: 'designed',
    vendor: null,
    orderDate: null,
    application: null,
    scale: null,
    purification: null,
    modifications: null,
    stockLocation: null,
    concentration: null,
    notes: null,
    workspaceId: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function candidate(): PrimerSearchResult {
  return {
    primer: primer(),
    hits: [],
    bestHit: null,
    isAttached: false,
  };
}

describe('usePrimerSearch drawer detachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('searches a saved file target without inventing a native sequence ID', async () => {
    findLibraryOnTarget.mockResolvedValueOnce([candidate()]);
    const context = {
      workspaceRoot: '/hosted/project-a',
      targetDocumentId: 'document-a',
      targetFilePath: '/hosted/project-a/sequences/a/a.gb',
    };
    const { result } = renderHook(() =>
      usePrimerSearch(null, 'target-one', false, context, true, 'document-a')
    );
    await act(async () => {
      await result.current.search({ maxMismatches: 2 });
    });
    expect(findLibrary).not.toHaveBeenCalled();
    expect(findLibraryOnTarget).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        targetDocumentId: 'document-a',
        targetFilePath: context.targetFilePath,
        referenceSequence: 'target-one',
        maxMismatches: 2,
      })
    );
    expect(await findLibraryOnTarget.mock.calls[0][0].loadAttachedBindingIds()).toEqual(new Map());
    expect(result.current.results).toEqual([candidate()]);
  });

  it('does not start a search without a native ID or a saved file target', async () => {
    const { result } = renderHook(() =>
      usePrimerSearch(null, 'target-one', false, undefined, true, 'document-a')
    );
    await act(async () => {
      await result.current.search();
    });
    expect(findLibrary).not.toHaveBeenCalled();
    expect(findLibraryOnTarget).not.toHaveBeenCalled();
  });

  it('hides previews while closed and reveals the same completed search on reopen', async () => {
    let finishSearch!: (value: PrimerSearchResult[]) => void;
    findLibrary.mockReturnValueOnce(
      new Promise<PrimerSearchResult[]>((resolve) => {
        finishSearch = resolve;
      })
    );

    const { result, rerender } = renderHook(
      ({ visible }) => usePrimerSearch(7, 'target-one', false, undefined, visible),
      { initialProps: { visible: true } }
    );

    act(() => {
      void result.current.search();
    });
    await waitFor(() => expect(result.current.isSearching).toBe(true));

    rerender({ visible: false });
    await act(async () => {
      finishSearch([candidate()]);
      await Promise.resolve();
    });

    expect(result.current.results).toEqual([]);
    expect(findLibrary).toHaveBeenCalledTimes(1);
    expect(cancelTelemetry).not.toHaveBeenCalled();

    rerender({ visible: true });
    await waitFor(() => expect(result.current.results).toHaveLength(1));
    expect(findLibrary).toHaveBeenCalledTimes(1);
  });

  it('clears prior candidates while a changed search is running', async () => {
    let finishChangedSearch!: (value: PrimerSearchResult[]) => void;
    findLibrary.mockResolvedValueOnce([candidate()]).mockReturnValueOnce(
      new Promise<PrimerSearchResult[]>((resolve) => {
        finishChangedSearch = resolve;
      })
    );

    const { result } = renderHook(() => usePrimerSearch(7, 'target-one', false, undefined, true));

    await act(async () => {
      await result.current.search();
    });
    expect(result.current.results).toHaveLength(1);

    act(() => {
      void result.current.search({ maxMismatches: 2 });
    });

    await waitFor(() => expect(result.current.isSearching).toBe(true));
    expect(result.current.results).toEqual([]);

    await act(async () => {
      finishChangedSearch([]);
      await Promise.resolve();
    });
  });

  it('suppresses a late result after the target changes', async () => {
    let finishOldSearch!: (value: PrimerSearchResult[]) => void;
    findLibrary.mockReturnValueOnce(
      new Promise<PrimerSearchResult[]>((resolve) => {
        finishOldSearch = resolve;
      })
    );

    const { result, rerender } = renderHook(
      ({ sequenceId, referenceSequence }) =>
        usePrimerSearch(sequenceId, referenceSequence, false, undefined, true),
      { initialProps: { sequenceId: 7, referenceSequence: 'target-one' } }
    );

    act(() => {
      void result.current.search();
    });
    await waitFor(() => expect(result.current.isSearching).toBe(true));
    const oldSignal = findLibrary.mock.calls[0][0].signal as AbortSignal;

    rerender({ sequenceId: 8, referenceSequence: 'target-two' });
    expect(oldSignal.aborted).toBe(true);

    await act(async () => {
      finishOldSearch([candidate()]);
      await Promise.resolve();
    });

    expect(result.current.results).toEqual([]);
    expect(result.current.isSearching).toBe(false);
  });
});

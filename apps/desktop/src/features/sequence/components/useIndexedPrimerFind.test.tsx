import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PrimerSearchResult } from '../../primers/public/primer-search-service';
import type { Primer } from '../../primers/public/types';
import type { IndexedGenomePrimerBinding } from '../../../shared/indexed-genome';
import { useIndexedPrimerFind } from './useIndexedPrimerFind';

const { findLibraryOnTarget } = vi.hoisted(() => ({ findLibraryOnTarget: vi.fn() }));

vi.mock('../../primers/public/primer-services', () => ({
  primerServices: {
    bindingSearch: { findLibraryOnTarget },
    persistence: { searchLegacyPrimers: vi.fn().mockResolvedValue([{ id: 'p1' }]) },
  },
}));

const chromosomes = [
  { chrom: 'chr1', length: 10_000 },
  { chrom: 'chr2', length: 5_000 },
];
const chromGlobalStart = new Map([
  ['chr1', 0],
  ['chr2', 10_000],
]);

const PRIMER = { id: 'p1', name: 'JUN-F', sequence: 'acgtacgt' } as Primer;

function result(start: number, end: number, strand: 1 | -1): PrimerSearchResult {
  const hit = {
    start,
    end,
    strand,
    identity: 1,
    editDistance: 0,
    mismatchPositions: [],
    threePrimeMatchLength: 8,
    effectiveTm: 60,
  };
  return { primer: { ...PRIMER }, hits: [hit], bestHit: hit, isAttached: false };
}

function setup(initialBindings: IndexedGenomePrimerBinding[] = []) {
  let bindings = initialBindings;
  const persistBindings = vi.fn(
    (
      updater: (
        previous: readonly IndexedGenomePrimerBinding[]
      ) => readonly IndexedGenomePrimerBinding[]
    ) => {
      bindings = [...updater(bindings)];
    }
  );
  const onRevealRange = vi.fn();
  const readSequence = vi.fn(async (_chrom: string, start0: number, end0: number) =>
    'a'.repeat(end0 - start0)
  );
  const hook = renderHook(
    (props: { bindings: readonly IndexedGenomePrimerBinding[] }) =>
      useIndexedPrimerFind({
        scopeKey: 'GRCh38',
        bindings: props.bindings,
        persistBindings,
        chromosomes,
        chromGlobalStart,
        viewport: { start: 11_000, end: 11_200 },
        selection: null,
        readSequence,
        onRevealRange,
      }),
    { initialProps: { bindings } }
  );
  return {
    hook,
    persistBindings,
    onRevealRange,
    readSequence,
    bindings: () => bindings,
  };
}

describe('indexed primer Find', () => {
  beforeEach(() => findLibraryOnTarget.mockReset());

  it('searches only the visible stretch and reports hits in chromosome coordinates', async () => {
    findLibraryOnTarget.mockResolvedValue([result(10, 18, 1)]);
    const { hook, readSequence, onRevealRange } = setup();

    expect(hook.result.current.drawerProps.searchDisabledReason).toBeNull();
    act(() => hook.result.current.drawerProps.onSearch({}));
    await waitFor(() => expect(hook.result.current.drawerProps.searchResults).toHaveLength(1));

    expect(readSequence).toHaveBeenCalledWith('chr2', 1_000, 1_200);
    const request = findLibraryOnTarget.mock.calls[0]![0];
    expect(request.referenceSequence).toHaveLength(200);
    expect(request.circular).toBe(false);
    expect(request.targetDocumentId).toBe('indexed-reference:GRCh38:chr2:1000-1200');
    expect(request.regionStart).toBeUndefined();

    const shown = hook.result.current.drawerProps.searchResults[0]!;
    expect(shown.bestHit).toMatchObject({ start: 1_010, end: 1_018 });
    expect(hook.result.current.drawerProps.formatSearchHitRange(shown.bestHit!)).toBe(
      'chr2:1,011–1,018'
    );

    hook.result.current.drawerProps.onSearchResultClick(shown.bestHit!);
    expect(onRevealRange).toHaveBeenCalledWith(11_010, 11_018);
  });

  it('attaches a match as an attached binding at the searched site, once', async () => {
    findLibraryOnTarget.mockResolvedValue([result(10, 18, -1)]);
    const { hook, persistBindings, bindings } = setup();
    act(() => hook.result.current.drawerProps.onSearch({}));
    await waitFor(() => expect(hook.result.current.drawerProps.searchResults).toHaveLength(1));
    const shown = hook.result.current.drawerProps.searchResults[0]!;

    await act(() => hook.result.current.drawerProps.onAttach(shown.primer, shown.bestHit!));
    expect(bindings()).toEqual([
      expect.objectContaining({
        primerId: 'p1',
        primerName: 'JUN-F',
        primerBases: 'acgtacgt',
        chrom: 'chr2',
        start0: 1_010,
        end0: 1_018,
        strand: '-',
        source: 'attached',
      }),
    ]);

    hook.rerender({ bindings: bindings() });
    expect(hook.result.current.drawerProps.searchResults[0]!.isAttached).toBe(true);

    await act(() => hook.result.current.drawerProps.onAttach(shown.primer, shown.bestHit!));
    expect(persistBindings).toHaveBeenCalledTimes(2);
    expect(bindings()).toHaveLength(1);
  });

  it('refuses to attach a match outside the searched stretch', async () => {
    findLibraryOnTarget.mockResolvedValue([result(10, 18, 1)]);
    const { hook, persistBindings } = setup();
    act(() => hook.result.current.drawerProps.onSearch({}));
    await waitFor(() => expect(hook.result.current.drawerProps.searchResults).toHaveLength(1));
    const shown = hook.result.current.drawerProps.searchResults[0]!;

    await expect(
      hook.result.current.drawerProps.onAttach(shown.primer, {
        ...shown.bestHit!,
        start: 1_195,
        end: 1_203,
      })
    ).rejects.toThrow(/outside the searched region/);
    expect(persistBindings).not.toHaveBeenCalled();
  });

  it('previews a clicked result on the map in assembly coordinates', async () => {
    findLibraryOnTarget.mockResolvedValue([result(10, 18, 1)]);
    const { hook } = setup();
    act(() => hook.result.current.drawerProps.onSearch({}));
    await waitFor(() => expect(hook.result.current.drawerProps.searchResults).toHaveLength(1));

    act(() =>
      hook.result.current.drawerProps.onCandidatePreview({
        id: '__candidate_p1__',
        name: 'JUN-F',
        bases: 'ACGTACGT',
        start: 1_010,
        end: 1_018,
        direction: 'forward',
        tm: 0,
        gc: 50,
        overhangLength: 0,
        pbsColor: '#D97706',
        isCandidate: true,
      })
    );
    expect(hook.result.current.candidatePreview).toMatchObject({
      start: 11_010,
      end: 11_018,
      isCandidate: true,
    });
  });

  it('never draws an attached result again as a dashed candidate', async () => {
    findLibraryOnTarget.mockResolvedValue([result(10, 18, 1)]);
    const { hook, bindings } = setup();
    act(() => hook.result.current.drawerProps.onSearch({}));
    await waitFor(() => expect(hook.result.current.drawerProps.searchResults).toHaveLength(1));
    const preview = {
      id: '__candidate_p1__',
      name: 'JUN-F',
      bases: 'ACGTACGT',
      start: 1_010,
      end: 1_018,
      direction: 'forward' as const,
      tm: 0,
      gc: 50,
      overhangLength: 0,
      pbsColor: '#D97706',
      isCandidate: true,
    };
    act(() => hook.result.current.drawerProps.onCandidatePreview(preview));
    expect(hook.result.current.candidatePreview).not.toBeNull();

    const shown = hook.result.current.drawerProps.searchResults[0]!;
    shown.primer.sequence = 'aCgTaCgT';
    await act(() => hook.result.current.drawerProps.onAttach(shown.primer, shown.bestHit!));
    expect(bindings()[0]?.primerBases).toBe('aCgTaCgT');
    hook.rerender({ bindings: bindings() });
    expect(hook.result.current.candidatePreview).toBeNull();

    act(() => hook.result.current.drawerProps.onCandidatePreview(preview));
    expect(hook.result.current.candidatePreview).toBeNull();
  });

  it('opens Find scoped to the selection from the right-click menu', () => {
    const { hook } = setup();
    act(() => hook.result.current.openFind({ chrom: 'chr1', start0: 5, end0: 50 }));
    expect(hook.result.current.drawerProps.autoScope?.nonce).toBe(1);
    expect(hook.result.current.drawerProps.searchDisabledReason).toMatch(/Select a region/);
  });
});

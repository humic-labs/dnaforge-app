/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Tab } from '../../canvas/types';
import { useCanvasStore } from '../../canvas/store';
import type { IndexedGenomeTabState } from '../../../shared/indexed-genome';
import {
  commitIndexedGenomeTabState,
  mergeIndexedGenomePersistState,
  useIndexedGenomeTabPersist,
} from './useIndexedGenomeTabPersist';

function tabState(overrides: Partial<IndexedGenomeTabState> = {}): IndexedGenomeTabState {
  return {
    sourcePath: '/workspace/chr11.fa',
    sourceExt: 'fa',
    chrom: 'chr11',
    ...overrides,
  };
}

const assembly: NonNullable<IndexedGenomeTabState['assembly']> = {
  assemblyId: 'grch38',
  displayName: 'GRCh38',
  chromosomes: [],
};

const bamTracks: NonNullable<IndexedGenomeTabState['bamTracks']> = [
  {
    trackId: 'tumor',
    label: 'Tumor',
    source: { bamPath: '/data/tumor.bam', indexPath: '/data/tumor.bam.bai' },
    visible: true,
    coverageCutoffDepth: 0,
  },
];

const signalReadPileupViews: NonNullable<IndexedGenomeTabState['signalReadPileupViews']> = [
  {
    contract: 'dnaforge.signal-read-pileup-view.v1',
    trackId: 'combined',
    readsTrackId: 'tumor',
    signalTrackId: 'signal',
    label: 'Coverage to reads',
    visible: true,
    color: 0xa8ceff,
    trackPx: 276,
    laneHeightPx: 3,
    maxLanes: 80,
    overflowBandHeightPx: 36,
    coverageCutoffDepth: 80,
    loadingAnimation: 'diagonal-scan',
  },
];

const variantSource: NonNullable<IndexedGenomeTabState['variantSource']> = {
  sourcePath: '/data/vars.vcf.gz',
  queryPath: '/data/vars.vcf.gz',
  indexPath: '/data/vars.vcf.gz.tbi',
  format: 'vcf',
  label: 'vars',
  sourceSizeBytes: 1,
  sourceMtimeNs: '1',
  sourceIdentity: 'id-1',
  matchedReferences: ['chr11'],
  samples: [],
  attachedAt: 1,
};

const userAnnotations: NonNullable<IndexedGenomeTabState['userAnnotations']> = [
  {
    id: 'annotation-1',
    chrom: 'chr11',
    annotation: {
      name: 'reviewed locus',
      type: 'misc_feature',
      start: 11,
      end: 20,
      direction: 1,
    },
  },
];

function sequenceTab(indexedGenome: IndexedGenomeTabState): Tab {
  return {
    id: 'tab-chr11',
    type: 'sequence',
    label: 'chr11.fa',
    entityId: 'indexed-sequence:chr11',
    sequenceDocument: {
      kind: 'indexed-sequence',
      documentId: 'indexed-sequence:chr11',
    },
    loadStatus: 'indexed',
    indexedGenome,
  };
}

describe('mergeIndexedGenomePersistState', () => {
  it('keeps next values when they are present', () => {
    const next = tabState({
      workspaceRoot: '/next',
      assembly,
      scope: { kind: 'chromosome', chrom: 'chr11' },
      bamTracks,
      dataTracks: [],
      signalReadPileupViews,
      ucscTracks: [],
      variantSource,
      userAnnotations,
    });
    const persisted = tabState({
      workspaceRoot: '/persisted',
      assembly: { ...assembly, assemblyId: 'persisted' },
      scope: { kind: 'all' },
      bamTracks: [],
      dataTracks: [],
      ucscTracks: [],
      variantSource: { ...variantSource, sourceIdentity: 'persisted' },
    });
    const prev = tabState({
      workspaceRoot: '/prev',
      assembly: { ...assembly, assemblyId: 'prev' },
      scope: { kind: 'all' },
      bamTracks: [],
      variantSource: { ...variantSource, sourceIdentity: 'prev' },
    });

    expect(mergeIndexedGenomePersistState(next, persisted, prev)).toMatchObject({
      workspaceRoot: '/next',
      assembly,
      scope: { kind: 'chromosome', chrom: 'chr11' },
      bamTracks,
      dataTracks: [],
      signalReadPileupViews,
      ucscTracks: [],
      variantSource,
      userAnnotations,
    });
  });

  it('fills omitted assembly, scope, and track fields from persisted then prev', () => {
    const next = tabState({ chrom: 'chrX' });
    const persisted = tabState({
      workspaceRoot: '/persisted',
      assembly,
      scope: { kind: 'all' },
      bamTracks,
      dataTracks: [],
      signalReadPileupViews,
      variantSource,
      userAnnotations,
    });
    const prev = tabState({
      workspaceRoot: '/prev',
      assembly: { ...assembly, assemblyId: 'prev' },
      scope: { kind: 'chromosome', chrom: 'chr11' },
      bamTracks: [],
      ucscTracks: [],
      variantSource: { ...variantSource, sourceIdentity: 'prev' },
    });

    expect(mergeIndexedGenomePersistState(next, persisted, prev)).toEqual({
      ...next,
      workspaceRoot: '/persisted',
      assembly,
      scope: { kind: 'all' },
      bamTracks,
      dataTracks: [],
      signalReadPileupViews,
      ucscTracks: [],
      variantSource,
      userAnnotations,
    });
  });

  it('preserves the portable bundle identity while leaving unrelated fields untouched', () => {
    const next = tabState({ error: 'session failed' });
    const prev = tabState({
      assemblyPortableBundleFingerprint: 'abc',
      error: 'stale',
    });
    const merged = mergeIndexedGenomePersistState(next, undefined, prev);
    expect(merged.assemblyPortableBundleFingerprint).toBe('abc');
    expect(merged.error).toBe('session failed');
  });

  it('retains reference identities and the update notice through anchor-session readiness', () => {
    const identity = { sequenceIdentity: 'a'.repeat(64), annotationIdentity: 'b'.repeat(64) };
    const history = [{ ...identity, bundleFingerprint: 'c'.repeat(64), assetGenerations: [] }];
    const persisted = tabState({
      assemblyReferenceIdentity: identity,
      assemblyReferenceVersionHistory: history,
      referenceAnnotationUpdateNotice: 'Annotations updated',
    });
    for (const [stored, previous] of [
      [persisted, null],
      [undefined, persisted],
    ] as const) {
      const merged = mergeIndexedGenomePersistState(tabState(), stored, previous);
      expect(merged).toMatchObject({
        assemblyReferenceIdentity: identity,
        assemblyReferenceVersionHistory: history,
        referenceAnnotationUpdateNotice: 'Annotations updated',
      });
    }
  });

  it('treats empty-string workspaceRoot as present', () => {
    const merged = mergeIndexedGenomePersistState(
      tabState({ workspaceRoot: '' }),
      tabState({ workspaceRoot: '/persisted' }),
      tabState({ workspaceRoot: '/prev' })
    );
    expect(merged.workspaceRoot).toBe('');
  });
});

describe('commitIndexedGenomeTabState', () => {
  it('writes ref and React state, then updates the found tab', () => {
    const next = tabState({ sourceSizeBytes: 12 });
    const indexedStateRef = { current: null };
    const setIndexedState = vi.fn();
    const updateTab = vi.fn();

    commitIndexedGenomeTabState(next, {
      indexedStateRef,
      setIndexedState,
      found: { panelId: 'main', tabId: 'tab-chr11' },
      updateTab,
      tabPatch: { loadStatus: 'indexed', fileSizeBytes: next.sourceSizeBytes },
    });

    expect(indexedStateRef.current).toBe(next);
    expect(setIndexedState).toHaveBeenCalledWith(next);
    expect(updateTab).toHaveBeenCalledWith('main', 'tab-chr11', {
      loadStatus: 'indexed',
      fileSizeBytes: 12,
      indexedGenome: next,
    });
  });

  it('skips updateTab when the sequence tab is missing', () => {
    const next = tabState();
    const indexedStateRef = { current: null };
    const setIndexedState = vi.fn();
    const updateTab = vi.fn();

    commitIndexedGenomeTabState(next, {
      indexedStateRef,
      setIndexedState,
      found: null,
      updateTab,
      tabPatch: { loadStatus: 'indexed-error', fileSizeBytes: undefined },
    });

    expect(indexedStateRef.current).toBe(next);
    expect(setIndexedState).toHaveBeenCalledWith(next);
    expect(updateTab).not.toHaveBeenCalled();
  });

  it('omits loadStatus from track-only commits', () => {
    const next = tabState({ bamTracks });
    const indexedStateRef = { current: tabState() };
    const setIndexedState = vi.fn();
    const updateTab = vi.fn();

    commitIndexedGenomeTabState(next, {
      indexedStateRef,
      setIndexedState,
      found: { panelId: 'main', tabId: 'tab-chr11' },
      updateTab,
    });

    expect(updateTab).toHaveBeenCalledWith('main', 'tab-chr11', { indexedGenome: next });
  });
});

describe('useIndexedGenomeTabPersist', () => {
  it('merges omitted assembly fields into the canvas tab', () => {
    const initial = tabState({
      assembly,
      scope: { kind: 'all' },
      bamTracks,
      variantSource,
      userAnnotations,
    });
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [sequenceTab(initial)],
          activeTabId: 'tab-chr11',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    const indexedStateRef = { current: initial };
    const { result } = renderHook(() =>
      useIndexedGenomeTabPersist({
        entityId: 'indexed-sequence:chr11',
        indexedStateRef,
        setIndexedState: (state) => {
          indexedStateRef.current = state;
        },
      })
    );

    act(() => {
      result.current.persistIndexedState(
        tabState({ chrom: 'chrX', sourceSizeBytes: 9 }),
        'indexed'
      );
    });

    const stored = useCanvasStore.getState().panels.main.tabs[0]?.indexedGenome;
    expect(stored).toMatchObject({
      chrom: 'chrX',
      sourceSizeBytes: 9,
      assembly,
      scope: { kind: 'all' },
      bamTracks,
      variantSource,
      userAnnotations,
    });
    expect(useCanvasStore.getState().panels.main.tabs[0]?.loadStatus).toBe('indexed');
    expect(useCanvasStore.getState().panels.main.tabs[0]?.fileSizeBytes).toBe(9);
  });

  it('replaces BAM tracks without rewriting loadStatus', () => {
    const initial = tabState({ bamTracks: [] });
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ ...sequenceTab(initial), loadStatus: 'indexed', fileSizeBytes: 77 }],
          activeTabId: 'tab-chr11',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    const indexedStateRef = { current: initial };
    const { result } = renderHook(() =>
      useIndexedGenomeTabPersist({
        entityId: 'indexed-sequence:chr11',
        indexedStateRef,
        setIndexedState: (state) => {
          indexedStateRef.current = state;
        },
      })
    );

    act(() => {
      result.current.persistBamTracks(() => bamTracks);
    });

    const storedTab = useCanvasStore.getState().panels.main.tabs[0];
    expect(storedTab?.indexedGenome?.bamTracks).toEqual(bamTracks);
    expect(storedTab?.loadStatus).toBe('indexed');
    expect(storedTab?.fileSizeBytes).toBe(77);
  });

  it('persists signal-to-reads views and user annotations without rewriting load status', () => {
    const initial = tabState({ signalReadPileupViews: [], userAnnotations: [] });
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ ...sequenceTab(initial), loadStatus: 'indexed', fileSizeBytes: 77 }],
          activeTabId: 'tab-chr11',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    const indexedStateRef = { current: initial };
    const { result } = renderHook(() =>
      useIndexedGenomeTabPersist({
        entityId: 'indexed-sequence:chr11',
        indexedStateRef,
        setIndexedState: (state) => {
          indexedStateRef.current = state;
        },
      })
    );

    act(() => {
      result.current.persistSignalReadPileupViews(() => signalReadPileupViews);
      result.current.persistUserAnnotations(() => userAnnotations);
    });

    const storedTab = useCanvasStore.getState().panels.main.tabs[0];
    expect(storedTab?.indexedGenome?.signalReadPileupViews).toEqual(signalReadPileupViews);
    expect(indexedStateRef.current.signalReadPileupViews).toEqual(signalReadPileupViews);
    expect(storedTab?.indexedGenome?.userAnnotations).toEqual(userAnnotations);
    expect(indexedStateRef.current.userAnnotations).toEqual(userAnnotations);
    expect(storedTab?.loadStatus).toBe('indexed');
    expect(storedTab?.fileSizeBytes).toBe(77);
  });

  it('removes a variant source without rewriting load status', () => {
    const initial = tabState({ variantSource });
    useCanvasStore.setState({
      panels: {
        main: {
          id: 'main',
          tabs: [{ ...sequenceTab(initial), loadStatus: 'indexed', fileSizeBytes: 77 }],
          activeTabId: 'tab-chr11',
        },
      },
      layout: { type: 'panel', panelId: 'main' },
      focusedPanelId: 'main',
      oversizeScanComplete: true,
    });

    const indexedStateRef = { current: initial };
    const { result } = renderHook(() =>
      useIndexedGenomeTabPersist({
        entityId: 'indexed-sequence:chr11',
        indexedStateRef,
        setIndexedState: (state) => {
          indexedStateRef.current = state;
        },
      })
    );

    act(() => result.current.persistVariantSource(null));

    const storedTab = useCanvasStore.getState().panels.main.tabs[0];
    expect(storedTab?.indexedGenome?.variantSource).toBeUndefined();
    expect(indexedStateRef.current.variantSource).toBeUndefined();
    expect(storedTab?.loadStatus).toBe('indexed');
    expect(storedTab?.fileSizeBytes).toBe(77);
  });
});

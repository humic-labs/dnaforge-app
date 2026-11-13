import { useCallback, type MutableRefObject } from 'react';

import { useCanvasStore } from '../../canvas/public/store';
import type { Tab } from '../../canvas/public/types';
import type {
  IndexedGenomePrimerBinding,
  IndexedGenomeTabState,
} from '../../../shared/indexed-genome';
import type { PersistedBamTrackUpdater } from './usePersistedBamTracks';
import type { PersistedDataTrackUpdater } from './usePersistedUcscTracks';
import type { PersistedSignalReadPileupViewUpdater } from './usePersistedSignalReadPileupViews';

export type PersistedPrimerBindingUpdater = (
  previous: readonly IndexedGenomePrimerBinding[]
) => readonly IndexedGenomePrimerBinding[];

export type PersistedUserAnnotationUpdater = (
  previous: NonNullable<IndexedGenomeTabState['userAnnotations']>
) => NonNullable<IndexedGenomeTabState['userAnnotations']>;

type SequenceTabLocation = { panelId: string; tabId: string };

export type IndexedGenomeTabPersistPatch = {
  loadStatus: Tab['loadStatus'];
  fileSizeBytes: number | undefined;
};

export function mergeIndexedGenomePersistState(
  next: IndexedGenomeTabState,
  persisted: IndexedGenomeTabState | undefined,
  prev: IndexedGenomeTabState | null
): IndexedGenomeTabState {
  return {
    ...next,
    workspaceRoot: next.workspaceRoot ?? persisted?.workspaceRoot ?? prev?.workspaceRoot,
    assembly: next.assembly ?? persisted?.assembly ?? prev?.assembly,
    assemblySearchSource:
      next.assemblySearchSource ?? persisted?.assemblySearchSource ?? prev?.assemblySearchSource,
    assemblyAssetGeneration:
      next.assemblyAssetGeneration ??
      persisted?.assemblyAssetGeneration ??
      prev?.assemblyAssetGeneration,
    assemblyAssetGenerationsByTheme:
      next.assemblyAssetGenerationsByTheme ??
      persisted?.assemblyAssetGenerationsByTheme ??
      prev?.assemblyAssetGenerationsByTheme,
    assemblyPortableBundleFingerprint:
      next.assemblyPortableBundleFingerprint ??
      persisted?.assemblyPortableBundleFingerprint ??
      prev?.assemblyPortableBundleFingerprint,
    assemblyReferenceIdentity:
      next.assemblyReferenceIdentity ??
      persisted?.assemblyReferenceIdentity ??
      prev?.assemblyReferenceIdentity,
    assemblyReferenceVersionHistory:
      next.assemblyReferenceVersionHistory ??
      persisted?.assemblyReferenceVersionHistory ??
      prev?.assemblyReferenceVersionHistory,
    referenceAnnotationUpdateNotice:
      next.referenceAnnotationUpdateNotice ??
      persisted?.referenceAnnotationUpdateNotice ??
      prev?.referenceAnnotationUpdateNotice,
    assemblyAnnotationTrackTypes:
      next.assemblyAnnotationTrackTypes ??
      persisted?.assemblyAnnotationTrackTypes ??
      prev?.assemblyAnnotationTrackTypes,
    assemblySourceReadiness:
      next.assemblySourceReadiness ??
      persisted?.assemblySourceReadiness ??
      prev?.assemblySourceReadiness,
    assemblyAnnotationProductsReadiness:
      next.assemblyAnnotationProductsReadiness ??
      persisted?.assemblyAnnotationProductsReadiness ??
      prev?.assemblyAnnotationProductsReadiness,
    assemblySearchReadiness:
      next.assemblySearchReadiness ??
      persisted?.assemblySearchReadiness ??
      prev?.assemblySearchReadiness,
    scope: next.scope ?? persisted?.scope ?? prev?.scope,
    bamTracks: next.bamTracks ?? persisted?.bamTracks ?? prev?.bamTracks,
    dataTracks: next.dataTracks ?? persisted?.dataTracks ?? prev?.dataTracks,
    signalReadPileupViews:
      next.signalReadPileupViews ?? persisted?.signalReadPileupViews ?? prev?.signalReadPileupViews,
    ucscTracks: next.ucscTracks ?? persisted?.ucscTracks ?? prev?.ucscTracks,
    variantSource: next.variantSource ?? persisted?.variantSource ?? prev?.variantSource,
    userAnnotations: next.userAnnotations ?? persisted?.userAnnotations ?? prev?.userAnnotations,
    primerBindings: next.primerBindings ?? persisted?.primerBindings ?? prev?.primerBindings,
  };
}

export function commitIndexedGenomeTabState(
  next: IndexedGenomeTabState,
  input: {
    indexedStateRef: MutableRefObject<IndexedGenomeTabState | null>;
    setIndexedState: (state: IndexedGenomeTabState) => void;
    found: SequenceTabLocation | null;
    updateTab: (panelId: string, tabId: string, updates: Partial<Tab>) => void;
    tabPatch?: IndexedGenomeTabPersistPatch;
  }
): void {
  input.indexedStateRef.current = next;
  input.setIndexedState(next);
  if (!input.found) return;
  if (input.tabPatch) {
    input.updateTab(input.found.panelId, input.found.tabId, {
      loadStatus: input.tabPatch.loadStatus,
      fileSizeBytes: input.tabPatch.fileSizeBytes,
      indexedGenome: next,
    });
    return;
  }
  input.updateTab(input.found.panelId, input.found.tabId, { indexedGenome: next });
}

function persistedIndexedGenomeForFoundTab(
  found: SequenceTabLocation | null
): IndexedGenomeTabState | undefined {
  if (!found) return undefined;
  return useCanvasStore
    .getState()
    .panels[found.panelId]?.tabs.find((candidate) => candidate.id === found.tabId)?.indexedGenome;
}

export function useIndexedGenomeTabPersist({
  entityId,
  indexedStateRef,
  setIndexedState,
}: {
  entityId: string;
  indexedStateRef: MutableRefObject<IndexedGenomeTabState | null>;
  setIndexedState: (state: IndexedGenomeTabState) => void;
}): {
  persistIndexedState: (next: IndexedGenomeTabState, loadStatus: Tab['loadStatus']) => void;
  persistBamTracks: (updater: PersistedBamTrackUpdater) => void;
  persistDataTracks: (updater: PersistedDataTrackUpdater) => void;
  persistSignalReadPileupViews: (updater: PersistedSignalReadPileupViewUpdater) => void;
  persistVariantSource: (variantSource: IndexedGenomeTabState['variantSource'] | null) => void;
  persistUserAnnotations: (updater: PersistedUserAnnotationUpdater) => void;
  persistPrimerBindings: (updater: PersistedPrimerBindingUpdater) => void;
} {
  const updateTab = useCanvasStore((s) => s.updateTab);
  const findTab = useCanvasStore((s) => s.findTab);
  const findSequenceTab = useCallback(
    (): SequenceTabLocation | null => findTab('sequence', entityId),
    [entityId, findTab]
  );

  const persistIndexedState = useCallback(
    (next: IndexedGenomeTabState, loadStatus: Tab['loadStatus']) => {
      const found = findSequenceTab();
      const merged = mergeIndexedGenomePersistState(
        next,
        persistedIndexedGenomeForFoundTab(found),
        indexedStateRef.current
      );
      commitIndexedGenomeTabState(merged, {
        indexedStateRef,
        setIndexedState,
        found,
        updateTab,
        tabPatch: { loadStatus, fileSizeBytes: merged.sourceSizeBytes },
      });
    },
    [findSequenceTab, indexedStateRef, setIndexedState, updateTab]
  );

  const persistBamTracks = useCallback(
    (updater: PersistedBamTrackUpdater) => {
      const current = indexedStateRef.current;
      if (!current) return;
      const previous = current.bamTracks ?? [];
      const updated = updater(previous);
      if (updated === previous) return;
      const next: IndexedGenomeTabState = {
        ...current,
        bamTracks: [...updated],
      };
      commitIndexedGenomeTabState(next, {
        indexedStateRef,
        setIndexedState,
        found: findSequenceTab(),
        updateTab,
      });
    },
    [findSequenceTab, indexedStateRef, setIndexedState, updateTab]
  );

  const persistDataTracks = useCallback(
    (updater: PersistedDataTrackUpdater) => {
      const current = indexedStateRef.current;
      if (!current) return;
      const previous = current.dataTracks ?? current.ucscTracks ?? [];
      const updated = updater(previous);
      if (updated === previous) return;
      const next: IndexedGenomeTabState = {
        ...current,
        dataTracks: [...updated],
        ucscTracks: undefined,
      };
      commitIndexedGenomeTabState(next, {
        indexedStateRef,
        setIndexedState,
        found: findSequenceTab(),
        updateTab,
      });
    },
    [findSequenceTab, indexedStateRef, setIndexedState, updateTab]
  );

  const persistVariantSource = useCallback(
    (variantSource: IndexedGenomeTabState['variantSource'] | null) => {
      const current = indexedStateRef.current;
      if (!current) return;
      commitIndexedGenomeTabState(
        { ...current, variantSource: variantSource ?? undefined },
        {
          indexedStateRef,
          setIndexedState,
          found: findSequenceTab(),
          updateTab,
        }
      );
    },
    [findSequenceTab, indexedStateRef, setIndexedState, updateTab]
  );

  const persistSignalReadPileupViews = useCallback(
    (updater: PersistedSignalReadPileupViewUpdater) => {
      const current = indexedStateRef.current;
      if (!current) return;
      const previous = current.signalReadPileupViews ?? [];
      const updated = updater(previous);
      if (updated === previous) return;
      commitIndexedGenomeTabState(
        { ...current, signalReadPileupViews: [...updated] },
        {
          indexedStateRef,
          setIndexedState,
          found: findSequenceTab(),
          updateTab,
        }
      );
    },
    [findSequenceTab, indexedStateRef, setIndexedState, updateTab]
  );

  const persistUserAnnotations = useCallback(
    (updater: PersistedUserAnnotationUpdater) => {
      const current = indexedStateRef.current;
      if (!current) return;
      const previous = current.userAnnotations ?? [];
      const updated = updater(previous);
      if (updated === previous) return;
      commitIndexedGenomeTabState(
        { ...current, userAnnotations: [...updated] },
        {
          indexedStateRef,
          setIndexedState,
          found: findSequenceTab(),
          updateTab,
        }
      );
    },
    [findSequenceTab, indexedStateRef, setIndexedState, updateTab]
  );

  const persistPrimerBindings = useCallback(
    (updater: PersistedPrimerBindingUpdater) => {
      const current = indexedStateRef.current;
      if (!current) return;
      const previous = current.primerBindings ?? [];
      const updated = updater(previous);
      if (updated === previous) return;
      commitIndexedGenomeTabState(
        { ...current, primerBindings: [...updated] },
        {
          indexedStateRef,
          setIndexedState,
          found: findSequenceTab(),
          updateTab,
        }
      );
    },
    [findSequenceTab, indexedStateRef, setIndexedState, updateTab]
  );

  return {
    persistIndexedState,
    persistBamTracks,
    persistPrimerBindings,
    persistDataTracks,
    persistSignalReadPileupViews,
    persistVariantSource,
    persistUserAnnotations,
  };
}

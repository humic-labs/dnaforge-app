import { useEffect } from 'react';
import { getSequenceDocumentMetadata, type AnnotatedSequence } from '@waypoint/sequence-utils';
import { useFileContent } from '../../../hooks/useFileContent';
import { useSequenceStore } from '../store';
import { useCanvasStore } from '../../canvas/public/store';
import { bindSangerReadProjection } from '../sanger-read-lifecycle-telemetry';
import type { SequenceFileLoadErrorClass } from '../../../hooks/useFileContent';
import {
  registerReadOnlySequencePreview,
  isNativeSequenceClientInputPending,
} from '../sequence-client-port';

interface UseSequenceResult {
  data: AnnotatedSequence | null;
  isLoading: boolean;
  editingPending: boolean;
  error: string | null;
  errorClass: SequenceFileLoadErrorClass | null;
  refetch: () => Promise<void>;
}

type ReadCacheOwner = {
  path: string;
  sequence: AnnotatedSequence;
  release: () => void;
};

const readCacheOwners = new Map<string, ReadCacheOwner>();

function keepReadCacheUntilTabClose(
  path: string,
  documentKey: string,
  sequence: AnnotatedSequence
) {
  const metadata = getSequenceDocumentMetadata(sequence);
  if (metadata?.format !== 'ab1' || metadata.source.path !== path) return;
  const isOpen = (state: ReturnType<typeof useCanvasStore.getState>) =>
    Object.values(state.panels).some((panel) =>
      panel.tabs.some(
        (tab) => tab.entityId === documentKey && (tab.type === 'sequence' || tab.type === 'file')
      )
    );
  if (!isOpen(useCanvasStore.getState())) return;
  const previous = readCacheOwners.get(documentKey);
  if (previous?.path === path) {
    previous.sequence = sequence;
    return;
  }
  previous?.release();
  const owner: ReadCacheOwner = { path, sequence, release: () => {} };
  const unsubscribe = useCanvasStore.subscribe((state) => {
    if (isOpen(state)) return;
    owner.release();
    const current = useSequenceStore.getState();
    if (
      current.sequences[documentKey] === owner.sequence &&
      !current.dirtyPaths[documentKey] &&
      getSequenceDocumentMetadata(owner.sequence)?.source.path === owner.path
    )
      current.clearSequence(documentKey);
  });
  owner.release = () => {
    unsubscribe();
    if (readCacheOwners.get(documentKey) === owner) readCacheOwners.delete(documentKey);
  };
  readCacheOwners.set(documentKey, owner);
}

export function useSequence(filePath: string, documentKey: string): UseSequenceResult {
  const cachedData = useSequenceStore((state) => state.sequences[documentKey]);
  const storeIsLoading = useSequenceStore((state) => state.isLoading(documentKey));
  const setSequence = useSequenceStore((state) => state.setSequence);

  const isGuarded = useCanvasStore((state) => {
    for (const panel of Object.values(state.panels)) {
      for (const tab of panel.tabs) {
        if (tab.entityId !== documentKey) continue;
        if (tab.type !== 'sequence' && tab.type !== 'file') continue;
        if (tab.loadStatus && tab.loadStatus !== 'loaded') return true;
      }
    }
    return false;
  });
  const isReadOnlyPreview = useCanvasStore((state) =>
    Object.values(state.panels).some((panel) =>
      panel.tabs.some(
        (tab) =>
          tab.entityId === documentKey &&
          (tab.sequenceDocument?.kind === 'import-source-sequence' ||
            tab.sequenceDocument?.kind === 'indexed-sequence')
      )
    )
  );

  const { sequence, acceptedRevision, loading, error, errorClass, reload } = useFileContent(
    isGuarded || cachedData ? null : filePath
  );

  useEffect(() => {
    if (sequence && !cachedData) {
      if (isReadOnlyPreview) registerReadOnlySequencePreview(documentKey);
      setSequence(documentKey, sequence, acceptedRevision ?? undefined);
      const published = useSequenceStore.getState();
      const document = published.sequences[documentKey];
      const version = published.getVersion(documentKey);
      const lineage = published.draftLineages[documentKey];
      if (document)
        bindSangerReadProjection(sequence, document, () => {
          const current = useSequenceStore.getState();
          return (
            current.sequences[documentKey] === document &&
            current.getVersion(documentKey) === version &&
            current.draftLineages[documentKey] === lineage
          );
        });
    }
  }, [sequence, acceptedRevision, cachedData, documentKey, setSequence, isReadOnlyPreview]);

  useEffect(() => {
    if (cachedData && useSequenceStore.getState().sequences[documentKey] === cachedData)
      keepReadCacheUntilTabClose(filePath, documentKey, cachedData);
  }, [cachedData, filePath, documentKey]);

  const data = cachedData ?? sequence;
  const isLoading = loading || storeIsLoading;

  return {
    data,
    isLoading,
    editingPending: isLoading || isNativeSequenceClientInputPending(documentKey),
    error,
    errorClass,
    refetch: reload,
  };
}

import { useEffect, useRef } from 'react';
import { sequenceFormatFromFilename, type AnnotatedSequence } from '@waypoint/sequence-utils';
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

export function useSequence(filePath: string, documentKey: string): UseSequenceResult {
  const cachedData = useSequenceStore((state) => state.sequences[documentKey]);
  const storeIsLoading = useSequenceStore((state) => state.isLoading(documentKey));
  const isDirty = useSequenceStore((state) => state.dirtyPaths[documentKey] === true);
  const setSequence = useSequenceStore((state) => state.setSequence);
  const readOwner = useRef<{
    filePath: string;
    documentKey: string;
    cachedData: AnnotatedSequence | undefined;
    version: number;
    parsed: AnnotatedSequence | null;
  } | null>(null);
  if (
    !readOwner.current ||
    readOwner.current.filePath !== filePath ||
    readOwner.current.documentKey !== documentKey
  ) {
    readOwner.current = {
      filePath,
      documentKey,
      cachedData,
      version: useSequenceStore.getState().getVersion(documentKey),
      parsed: null,
    };
  }
  const refreshRead = sequenceFormatFromFilename(filePath) === 'ab1' && !isDirty;

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
    isGuarded || (cachedData && !refreshRead) ? null : filePath
  );

  useEffect(() => {
    const owner = readOwner.current;
    const current = useSequenceStore.getState();
    if (
      sequence &&
      owner &&
      owner.parsed !== sequence &&
      (!cachedData || refreshRead) &&
      current.sequences[documentKey] === owner.cachedData &&
      current.getVersion(documentKey) === owner.version &&
      !current.dirtyPaths[documentKey]
    ) {
      if (isReadOnlyPreview) registerReadOnlySequencePreview(documentKey);
      setSequence(documentKey, sequence, acceptedRevision ?? undefined);
      const published = useSequenceStore.getState();
      const document = published.sequences[documentKey];
      const version = published.getVersion(documentKey);
      const lineage = published.draftLineages[documentKey];
      owner.cachedData = document;
      owner.version = version;
      owner.parsed = sequence;
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
  }, [
    sequence,
    acceptedRevision,
    cachedData,
    documentKey,
    setSequence,
    isReadOnlyPreview,
    refreshRead,
  ]);

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

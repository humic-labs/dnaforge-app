import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotatedSequence } from '@waypoint/sequence-utils';
import type { ManagedSequenceDocumentRef } from '../../../shared/managed-sequence-document';
import {
  readSequencePackageHistoryIndex,
  readSequencePackageRevision,
  type SequencePackageHistoryIndex,
  type SequencePackageHistoryFs,
} from '../../../db/sequence-package-history-io';
import { parseSequenceFileAsDocument } from '../../../shared/parse-sequence-file';
import { platform } from '../../../platform';
import { readScientificNamespace } from '../../../services/read-scientific-namespace';
import { readScientificText } from '../../scientific-document/public/read-scientific-text';

const capturedReaders = new WeakMap<SequencePackageHistoryIndex, SequencePackageHistoryFs>();

export interface SequencePackageHistoryView {
  index: SequencePackageHistoryIndex | null;
  workspaceRoot?: string | null;
  selectedRevisionId: string | null;
  selectedSequence: AnnotatedSequence | null;
  selectedParentSequence: AnnotatedSequence | null;
  selectedParentStatus: 'none' | 'loading' | 'available' | 'unavailable';
  isLoading: boolean;
  error: string | null;
  readFs?: SequencePackageHistoryFs;
  selectRevision(id: string | null): void;
  refresh(): void;
}

type HistoryOwner = {
  packageId: string;
  packageRoot: string;
  workspaceRoot: string;
};
type IndexState =
  | { phase: 'idle' }
  | { phase: 'loading'; owner: HistoryOwner }
  | { phase: 'ready'; owner: HistoryOwner; index: SequencePackageHistoryIndex }
  | { phase: 'error'; owner: HistoryOwner; error: string };
type ParentState =
  | { phase: 'none' | 'loading' | 'unavailable' }
  | { phase: 'available'; sequence: AnnotatedSequence };
type SelectionState =
  | { phase: 'none' }
  | { phase: 'loading'; owner: HistoryOwner; revisionId: string }
  | { phase: 'error'; owner: HistoryOwner; error: string }
  | {
      phase: 'ready';
      owner: HistoryOwner;
      revisionId: string;
      sequence: AnnotatedSequence;
      parent: ParentState;
    };

export function useSequencePackageHistory(
  documentRef: ManagedSequenceDocumentRef | undefined,
  workspaceRoot: string | null
): SequencePackageHistoryView {
  const packageId = documentRef?.packageId;
  const packageRoot = documentRef?.packageRoot;
  const owner = useMemo<HistoryOwner | null>(
    () =>
      packageId && packageRoot && workspaceRoot ? { packageId, packageRoot, workspaceRoot } : null,
    [packageId, packageRoot, workspaceRoot]
  );
  const [indexState, setIndexState] = useState<IndexState>({ phase: 'idle' });
  const [selection, setSelection] = useState<SelectionState>({ phase: 'none' });
  const [requested, setRequested] = useState<{ owner: HistoryOwner; id: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const indexSerial = useRef(0);
  const revisionSerial = useRef(0);
  const fs = platform().fs;
  const currentIndex =
    indexState.phase !== 'idle' && indexState.owner === owner ? indexState : null;
  const index = currentIndex?.phase === 'ready' ? currentIndex.index : null;
  const currentSelection =
    selection.phase !== 'none' && selection.owner === owner ? selection : null;
  const requestedRevisionId = requested?.owner === owner ? requested?.id : null;

  const refresh = useCallback(() => setRefreshKey((value) => value + 1), []);
  const selectRevision = useCallback(
    (id: string | null) => {
      if (id && requested?.owner === owner && requested.id === id) return;
      revisionSerial.current += 1;
      setRequested(id && owner ? { owner, id } : null);
      setSelection({ phase: 'none' });
    },
    [owner, requested]
  );

  useEffect(() => {
    setRequested(null);
    setSelection({ phase: 'none' });
  }, [owner]);

  useEffect(() => {
    if (!packageRoot) return;
    const onChanged = (event: Event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (path === workspaceRoot || path === packageRoot || path?.startsWith(`${packageRoot}/`))
        refresh();
    };
    window.addEventListener('waypoint:workspace-files-changed', onChanged);
    return () => window.removeEventListener('waypoint:workspace-files-changed', onChanged);
  }, [packageRoot, workspaceRoot, refresh]);

  useEffect(() => {
    const serial = ++indexSerial.current;
    if (!owner) {
      setIndexState({ phase: 'idle' });
      return;
    }
    setIndexState({ phase: 'loading', owner });
    void (async () => {
      const namespace = await readScientificNamespace(owner.workspaceRoot);
      const reader: SequencePackageHistoryFs = namespace
        ? {
            ...fs,
            readTextFile: async (path) =>
              (await readScientificText(path, owner.workspaceRoot, fs.readTextFile, namespace.head))
                .content,
          }
        : fs;
      const loaded = await readSequencePackageHistoryIndex({
        packageRoot: owner.packageRoot,
        workspaceRoot: owner.workspaceRoot,
        expectedPackageId: owner.packageId,
        fs: reader,
      });
      capturedReaders.set(loaded, reader);
      return loaded;
    })()
      .then((loaded) => {
        if (serial === indexSerial.current) setIndexState({ phase: 'ready', owner, index: loaded });
      })
      .catch((cause: unknown) => {
        if (serial === indexSerial.current)
          setIndexState({
            phase: 'error',
            owner,
            error: cause instanceof Error ? cause.message : String(cause),
          });
      });
    return () => {
      indexSerial.current += 1;
    };
  }, [fs, owner, refreshKey]);

  useEffect(() => {
    const serial = ++revisionSerial.current;
    if (!requestedRevisionId || !index || !owner) return;
    if (
      !index.document.versionHistory.revisions.some(
        (revision) => revision.id === requestedRevisionId
      )
    ) {
      setRequested(null);
      setSelection({ phase: 'none' });
      return;
    }
    setSelection({ phase: 'loading', owner, revisionId: requestedRevisionId });
    const publishParent = (parent: ParentState) => {
      if (serial !== revisionSerial.current) return;
      setSelection((previous) =>
        previous.phase === 'ready' &&
        previous.owner === owner &&
        previous.revisionId === requestedRevisionId
          ? { ...previous, parent }
          : previous
      );
    };
    void readSequencePackageRevision({
      index,
      revisionId: requestedRevisionId,
      workspaceRoot: owner.workspaceRoot,
      fs: capturedReaders.get(index) ?? fs,
    })
      .then((read) => {
        if (serial !== revisionSerial.current) return;
        if (read.status === 'unavailable') {
          setRequested(null);
          setSelection({ phase: 'error', owner, error: read.reason });
          return;
        }
        const sequence = parseSequenceFileAsDocument(read.content, index.productPath).sequence;
        sequence.id = index.document.id;
        const parentId = read.revision.parentId;
        setSelection({
          phase: 'ready',
          owner,
          revisionId: requestedRevisionId,
          sequence,
          parent: { phase: parentId ? 'loading' : 'none' },
        });
        if (parentId) {
          void readSequencePackageRevision({
            index,
            revisionId: parentId,
            workspaceRoot: owner.workspaceRoot,
            fs: capturedReaders.get(index) ?? fs,
          })
            .then((parent) => {
              if (serial !== revisionSerial.current) return;
              if (parent.status !== 'available') {
                publishParent({ phase: 'unavailable' });
                return;
              }
              const parentSequence = parseSequenceFileAsDocument(
                parent.content,
                index.productPath
              ).sequence;
              parentSequence.id = index.document.id;
              publishParent({ phase: 'available', sequence: parentSequence });
            })
            .catch(() => publishParent({ phase: 'unavailable' }));
        }
      })
      .catch((cause: unknown) => {
        if (serial !== revisionSerial.current) return;
        setRequested(null);
        setSelection({
          phase: 'error',
          owner,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      revisionSerial.current += 1;
    };
  }, [fs, index, requestedRevisionId, owner]);

  const readySelection = currentSelection?.phase === 'ready' ? currentSelection : null;
  return {
    index,
    workspaceRoot,
    selectedRevisionId: readySelection?.revisionId ?? null,
    selectedSequence: readySelection?.sequence ?? null,
    selectedParentSequence:
      readySelection?.parent.phase === 'available' ? readySelection.parent.sequence : null,
    selectedParentStatus: readySelection?.parent.phase ?? 'none',
    isLoading:
      currentIndex?.phase === 'loading' ||
      (currentSelection?.phase === 'loading' && Boolean(index)),
    error:
      currentSelection?.phase === 'error'
        ? currentSelection.error
        : currentIndex?.phase === 'error'
          ? currentIndex.error
          : null,
    readFs: index ? (capturedReaders.get(index) ?? fs) : fs,
    selectRevision,
    refresh,
  };
}

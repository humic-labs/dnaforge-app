import { installNativeNotebookCatalogPublisher } from './native-notebook-catalog-publisher';
import { migrateLegacyNotebookDrafts } from '../features/page/notebook-document-client';
import {
  installFileDocumentClientSync,
  setNativeFileDocumentReadiness,
} from '../features/workspace/public/file-document-client';
import { migrateLegacyFileDrafts } from '../features/workspace/file-document-legacy-client';
import { platform } from '../platform';
import { useWorkspaceStore } from '../stores/workspaceStore';
import {
  getNativeSequenceDocumentClient,
  installNativeSequenceDocumentClient,
} from '../features/sequence/sequence-document-client';
import { sequenceDocumentModel } from '../features/sequence/store';
import { migrateLegacySequenceDrafts } from '../features/sequence/legacy-sequence-recovery-client';

export function deferNativeDocumentWorkspaceStartup(): () => void {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  setNativeFileDocumentReadiness(ready);
  return resolve;
}

export function installNativeDocumentWorkspacePublisher(loadId: string): () => void {
  let disposed = false;
  const detachNotebookCatalog = installNativeNotebookCatalogPublisher();
  const detachFileSync = installFileDocumentClientSync(loadId);
  const detachSequenceClient = installNativeSequenceDocumentClient(sequenceDocumentModel);
  let previous: string | undefined;
  const publish = () => {
    if (disposed) return;
    const roots = [
      ...new Set(
        useWorkspaceStore
          .getState()
          .folders.filter((folder) => !folder.pinned)
          .map((folder) => folder.path)
      ),
    ].sort();
    const readableRoots = [
      ...new Set(useWorkspaceStore.getState().folders.map((folder) => folder.path)),
    ].sort();
    const key = JSON.stringify({ roots, readableRoots });
    if (key === previous) return;
    previous = key;
    const readiness = platform()
      .workspace.setDocumentCommandRoots({ loadId, roots, readableRoots })
      .then(async (enrolled) => {
        if (enrolled && !disposed && key === previous) {
          await migrateLegacyFileDrafts();
          await migrateLegacySequenceDrafts();
          await migrateLegacyNotebookDrafts();
          if (!disposed && key === previous)
            getNativeSequenceDocumentClient()?.refreshAvailableDocuments();
        }
      })
      .catch((error: unknown) => {
        if (disposed || key !== previous) return;
        previous = undefined;
        console.warn('[Document jobs] Could not enroll the current workspaces:', error);
        throw error;
      });
    setNativeFileDocumentReadiness(readiness);
  };
  const unsubscribe = useWorkspaceStore.subscribe(publish);
  publish();
  return () => {
    disposed = true;
    unsubscribe();
    detachFileSync();
    detachNotebookCatalog();
    detachSequenceClient();
  };
}

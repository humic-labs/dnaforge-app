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
import { reconcileWorkspaceAfterFilesChanged } from './workspace-operations';

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
  let currentReadiness: Promise<void> = Promise.resolve();
  let currentEnrollment: { key: string; writableRoots: string[]; ready: boolean } | undefined;
  const migrations = new Map<
    string,
    { changed: boolean; enrollment: NonNullable<typeof currentEnrollment> }
  >();
  const requestMigration = (root: string) => {
    const enrollment = currentEnrollment;
    if (disposed || !enrollment?.writableRoots.includes(root)) return;
    const existing = migrations.get(root);
    if (existing?.enrollment === enrollment) {
      existing.changed = true;
      return;
    }
    const state = { changed: false, enrollment };
    migrations.set(root, state);
    const ready = currentReadiness;
    void ready
      .then(async () => {
        const assertCurrent = () => {
          if (disposed || currentEnrollment !== enrollment || !enrollment.ready)
            throw new Error('The document project enrollment changed during migration.');
        };
        if (disposed || currentEnrollment !== enrollment || !enrollment.ready) return;
        do {
          state.changed = false;
          await reconcileWorkspaceAfterFilesChanged({ workspaceRoot: root, assertCurrent });
          assertCurrent();
        } while (state.changed);
      })
      .catch((error: unknown) => {
        if (!disposed && currentEnrollment === enrollment)
          console.warn('[Document jobs] Automatic entity migration remains pending:', error);
      })
      .finally(() => {
        if (migrations.get(root) === state) migrations.delete(root);
      });
  };
  const detachMigrationCandidates = platform().workspace.onMigrationCandidatesChanged?.(
    ({ workspaceRoot }) => requestMigration(workspaceRoot)
  );
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
    const enrollment = { key, writableRoots: roots, ready: false };
    currentEnrollment = enrollment;
    const readiness = platform()
      .workspace.setDocumentCommandRoots({ loadId, roots, readableRoots })
      .then(async (enrolled) => {
        if (enrolled && !disposed && key === previous) {
          await migrateLegacyFileDrafts();
          await migrateLegacySequenceDrafts();
          await migrateLegacyNotebookDrafts();
          if (!disposed && key === previous) {
            enrollment.ready = true;
            getNativeSequenceDocumentClient()?.refreshAvailableDocuments();
          }
        }
      })
      .catch((error: unknown) => {
        if (disposed || key !== previous) return;
        previous = undefined;
        console.warn('[Document jobs] Could not enroll the current workspaces:', error);
        throw error;
      });
    currentReadiness = readiness;
    setNativeFileDocumentReadiness(readiness);
    void readiness
      .then(async () => {
        if (disposed || key !== previous || !enrollment.ready) return;
        for (const root of roots) requestMigration(root);
      })
      .catch((error: unknown) => {
        if (!disposed && key === previous)
          console.warn('[Document jobs] Automatic entity migration remains pending:', error);
      });
  };
  const unsubscribe = useWorkspaceStore.subscribe(publish);
  publish();
  return () => {
    disposed = true;
    unsubscribe();
    detachFileSync();
    detachNotebookCatalog();
    detachSequenceClient();
    detachMigrationCandidates?.();
  };
}

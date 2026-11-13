import type Database from 'better-sqlite3';
import { join } from 'node:path';
import { NativeDocumentDispatcher } from '../native-document-dispatcher';
import { createNativeFileDocuments } from '../native-file-documents';
import { createWorkspaceFileRelocator } from '../workspace-file-relocation';

export function createWorkspaceRelocationTestOwner(db: Database.Database, root: string) {
  const options = {
    db: () => db,
    workspaceRoots: () =>
      (db.prepare('SELECT path FROM workspaces').all() as Array<{ path: string }>).map(
        (row) => row.path
      ),
    profileDirectory: () => join(root, '.native-document-test-profile'),
  };
  const documents = new NativeDocumentDispatcher({
    db: options.db,
    workspaceRoots: options.workspaceRoots,
    ordinary: createNativeFileDocuments(options),
    adapters: [],
  });
  return createWorkspaceFileRelocator({ db: options.db, fileDocuments: () => documents });
}

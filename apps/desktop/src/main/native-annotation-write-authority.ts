import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import type { ManagedDocumentOperationTarget } from '@waypoint/domain-services';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import type { NativeAnnotationDocument } from './managed-annotation-document-command';
import {
  assertAcceptingSharedProjectContentWritable,
  assertSharedProjectContentWritable,
} from './shared-project-write-access';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';

interface CatalogOwner {
  id: string;
  type: string;
  status: string;
  locator: string;
  storage_type: string;
}
interface FileOwner {
  id: string;
  workspace_id: number | null;
  path: string;
  file_kind: string;
}
interface WorkspaceOwner {
  id: number;
  path: string;
  repo_uuid: string | null;
}
interface ProjectedOwner {
  fields: string | null;
  tombstone: number;
  archived_at: number | null;
}
interface RemoteOwner {
  workspace_uuid: string;
  owner_account_id: string;
  owner_org_id: string | null;
  remote_workspace_id: string | null;
}

function readCheckedOwner(
  db: Database.Database,
  document: NativeAnnotationDocument,
  insideAcceptance = false
) {
  if (!insideAcceptance) assertCommittedDatabaseReadAllowed(db);
  const catalog = db
    .prepare<
      [string],
      CatalogOwner
    >("SELECT id,type,status,locator,storage_type FROM catalog_entities WHERE id=? AND type='sequence' AND status='active'")
    .get(document.documentId);
  if (!catalog) throw new Error('The target sequence document has no current native owner.');
  const files = db
    .prepare<
      [string],
      FileOwner
    >("SELECT id,workspace_id,path,file_kind FROM catalog_entity_files WHERE entity_id=? AND status='current' ORDER BY id LIMIT 2")
    .all(document.documentId);
  if (files.length !== 1) throw new Error('The document has no unique current catalog file.');
  const workspace = db
    .prepare<
      [number | null],
      WorkspaceOwner
    >("SELECT id,path,repo_uuid FROM workspaces WHERE id=? AND access_mode='writable' AND archived_at IS NULL AND trashed_at IS NULL")
    .get(files[0].workspace_id);
  if (
    !workspace ||
    workspaceMutationRootIdentity(workspace.path) !==
      workspaceMutationRootIdentity(document.workspaceRoot)
  )
    throw new Error('The target sequence document has no current writable owning project.');
  if (insideAcceptance) assertAcceptingSharedProjectContentWritable(db, workspace.path);
  else assertSharedProjectContentWritable(db, workspace.path);
  const projection = db
    .prepare<
      [string],
      ProjectedOwner
    >('SELECT fields,tombstone,archived_at FROM lims_entity WHERE id=?')
    .get(document.documentId);
  if (projection?.tombstone || projection?.archived_at != null)
    throw new Error('The target sequence document is archived.');
  const fields: unknown = JSON.parse(projection?.fields ?? '{}');
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new Error('The document has an invalid native catalog projection.');
  let managed: ReturnType<typeof readManagedSequenceDocumentRef> = null;
  if (MANAGED_SEQUENCE_DOCUMENT_FIELD in fields) {
    managed = readManagedSequenceDocumentRef(fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
    if (!managed || managed.packageId !== document.documentId)
      throw new Error('The managed document locator does not match its catalog identity.');
  }
  const remote = db
    .prepare<
      [number],
      RemoteOwner
    >('SELECT workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id FROM workspace_sync_bindings WHERE workspace_id=?')
    .get(workspace.id);
  return { catalog, file: files[0], workspace, managed, remote };
}

export async function captureNativeAnnotationWriteAuthority(options: {
  db(): Database.Database;
  resolve(target: ManagedDocumentOperationTarget): Promise<NativeAnnotationDocument>;
  target: ManagedDocumentOperationTarget;
  document: NativeAnnotationDocument;
}): Promise<{ assertCurrent(): void; assertAcceptanceCurrent(): void }> {
  const db = options.db();
  const captured = readCheckedOwner(db, options.document);
  if (options.document.documentId !== options.target.targetDocumentId)
    throw new Error('The annotation request does not match its native document owner.');
  const current = await options.resolve(options.target);
  if (!isDeepStrictEqual(current, options.document))
    throw new Error('The annotation target document moved during write admission.');
  const assertOwner = (insideAcceptance: boolean): void => {
    if (
      options.db() !== db ||
      !isDeepStrictEqual(readCheckedOwner(db, options.document, insideAcceptance), captured)
    )
      throw new Error('The annotation target document owner changed before publication.');
  };
  assertOwner(false);
  return {
    assertCurrent: () => assertOwner(false),
    assertAcceptanceCurrent: () => assertOwner(true),
  };
}

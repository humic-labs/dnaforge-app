import { isEntityArtifactPath, parseEntityArtifact } from '../shared/entity-artifact';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { hashWorkspaceSyncFileOnDisk, SourceDigestChangedError } from './workspace-sync-blob-cache';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scopedProjectionId, workspaceScopeKey } from '../shared/workspace-scoped-identity';
import { ensureWorkspaceOwnerInDb } from './catalog-projection-commands';
import { workspaceMutationRootIdentity } from './workspace-sync-mutation-lease';
import { assertWorkspaceWriteAllowed } from './workspace-write-admission';
import { assertRendererDatabaseStatementAllowed } from './workspace-sync-database-fence';
import {
  prepareAppendedSavedFileSource,
  publishRetainedFileReplacement,
  captureSavedFileSource,
  recordSavedFilePublicationWitness,
  commitSavedFileSource,
  prepareSavedFileSource,
  recoverPendingSavedFileSources,
  rejectSavedFileSource,
} from './saved-file-sources';
import {
  WorkspaceFilePreconditionError,
  WorkspaceFilePublicationUncertainError,
} from './primer-artifact-files';

export function savedFileWorkspace(
  db: Database.Database,
  workspaceRoot?: string
): { id: number; repo_uuid: string | null } | undefined {
  if (!workspaceRoot) return undefined;
  const identity = workspaceMutationRootIdentity(workspaceRoot);
  const candidates = (
    db.prepare('SELECT id,path,repo_uuid FROM workspaces').all() as Array<{
      id: number;
      path: string;
      repo_uuid: string | null;
    }>
  ).filter((row) => workspaceMutationRootIdentity(row.path) === identity);
  if (candidates.length > 1) throw new Error('The saved file has ambiguous workspace ownership.');
  if (candidates[0]) return candidates[0];
  return { id: ensureWorkspaceOwnerInDb(db, workspaceRoot), repo_uuid: null };
}
export async function publishTypedSavedText<T>(
  db: Database.Database,
  input: {
    workspaceRoot?: string;
    entityId: string;
    workspaceScoped?: boolean;
    path: string;
    content: string;
    expectedSha256: string | null;
    blobRoot?: string;
  },
  write: (mark: (stagedPath: string) => void) => Promise<T>
): Promise<T> {
  assertRendererDatabaseStatementAllowed(db, undefined);
  assertWorkspaceWriteAllowed(db, [input.path]);
  const workspace = savedFileWorkspace(db, input.workspaceRoot);
  const workspaceId = workspace?.id ?? null;
  const entityId = input.workspaceScoped
    ? scopedProjectionId(workspaceScopeKey(workspace?.repo_uuid, workspaceId), input.entityId)
    : input.entityId;
  const source = { workspaceId, entityId, path: resolve(input.path), blobRoot: input.blobRoot };
  await recoverPendingSavedFileSources(db, source);
  try {
    if (input.expectedSha256)
      await captureSavedFileSource(db, { ...source, expectedSha256: input.expectedSha256 });
  } catch (error) {
    if (error instanceof SourceDigestChangedError)
      throw new WorkspaceFilePreconditionError(error.message);
    throw error;
  }
  const receipt = await prepareSavedFileSource(db, {
    ...source,
    members: [{ relativePath: '', bytes: Buffer.from(input.content) }],
  });
  let result: T;
  try {
    assertRendererDatabaseStatementAllowed(db, undefined);
    result = await write((path) => recordSavedFilePublicationWitness(db, receipt, path));
  } catch (error) {
    if (!(error instanceof WorkspaceFilePublicationUncertainError))
      rejectSavedFileSource(db, receipt);
    throw error;
  }
  assertRendererDatabaseStatementAllowed(db, undefined);
  commitSavedFileSource(db, receipt);
  return result;
}

export async function writeWithBoundFileRetention<T>(
  db: Database.Database,
  input: {
    path: string;
    content: string | Uint8Array;
    append?: boolean;
    blobRoot?: string;
    publishRetained?: () => void;
    documentId?: string;
    workspaceRoot?: string;
    expectedSha256?: string;
  },
  write: (mark: (stagedPath: string) => void) => Promise<T>
): Promise<T> {
  const path = resolve(input.path);
  const row = db
    .prepare(
      "SELECT id,entity_id,workspace_id,content_hash FROM catalog_entity_files WHERE path=? AND status='current'"
    )
    .get(path) as
    | { id: string; entity_id: string; workspace_id: number | null; content_hash: string | null }
    | undefined;
  if (!row && input.workspaceRoot && typeof input.content === 'string' &&
      (path.toLowerCase().endsWith('.wpselection.json') || isEntityArtifactPath(path))) {
    const id = isEntityArtifactPath(path) ? parseEntityArtifact(input.content).id
      : (await import('@waypoint/workspace-editor/saved-residue-selection')).parseSavedResidueSelectionDocument(input.content).id;
    return publishTypedSavedText(
      db,
      {
        workspaceRoot: input.workspaceRoot,
        entityId: id,
        path,
        content: input.content,
        expectedSha256: input.expectedSha256 ?? null,
        blobRoot: input.blobRoot,
      },
      write
    );
  }
  if (!row && input.documentId && typeof input.content === 'string') {
    return publishTypedSavedText(
      db,
      {
        workspaceRoot: input.workspaceRoot,
        entityId: input.documentId,
        path,
        content: input.content,
        expectedSha256: input.expectedSha256?.replace(/^sha256:/, '') ?? null,
        blobRoot: input.blobRoot,
      },
      write
    );
  }
  if (!row) return write(() => {});
  const owner = {
    workspaceId: row.workspace_id,
    entityId: row.entity_id,
    path,
    blobRoot: input.blobRoot,
  };
  await recoverPendingSavedFileSources(db, owner);
  const present = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (present && !present.isFile()) throw new Error('Linked file writes require a regular file.');
  const prior = present
    ? await captureSavedFileSource(db, {
        ...owner,
        ...(row.content_hash && /^sha256:[a-f0-9]{64}$/.test(row.content_hash)
          ? { expectedSha256: row.content_hash }
          : {}),
      })
    : undefined;
  const bytes = Buffer.from(input.content);
  const { receipt, sha256 } =
    input.append && prior
      ? await prepareAppendedSavedFileSource(db, { ...owner, prior, suffix: bytes })
      : {
          receipt: await prepareSavedFileSource(db, {
            ...owner,
            members: [{ relativePath: '', bytes }],
          }),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
  const result = input.publishRetained
    ? ((await publishRetainedFileReplacement(db, {
        receipt,
        prior,
        path,
        blobRoot: input.blobRoot,
        assertCurrent: input.publishRetained,
      })) as T)
    : await write((staged) => recordSavedFilePublicationWitness(db, receipt, staged));
  const actual = await hashWorkspaceSyncFileOnDisk(path);
  if (actual.sha256 !== sha256)
    throw new Error(
      'Linked file changed before publication settled; its prior and candidate sources have been preserved.'
    );
  db.transaction(() => {
    if (
      !db
        .prepare(
          "UPDATE catalog_entity_files SET content_hash=?,size_bytes=?,sequence_fingerprint=NULL WHERE id=? AND entity_id=? AND path=? AND content_hash IS ? AND status='current'"
        )
        .run('sha256:' + sha256, actual.sizeBytes, row.id, row.entity_id, path, row.content_hash)
        .changes
    )
      throw new Error('Linked file owner changed before publication settled.');
    commitSavedFileSource(db, receipt);
  })();
  return result;
}

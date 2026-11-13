import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertKnownWorkspaceContentWritable } from './workspace-content-write-access';
import {
  inspectResourceRevision,
  inspectResourceState,
  parseWorkspacePath,
  type BlobHash,
} from '@waypoint/workspace-revisions';
import type { ScientificFileEntry } from '@waypoint/scientific-objects';
import { runWorkspaceFileTrash } from './workspace-file-trash';
import { setCatalogFileStateInDb } from './catalog-projection-commands';
import {
  limsEntityFromRow,
  type LimsEntityRow,
  type LimsEntityActionInput,
  type LimsRevertEntityResult,
} from '../shared/lims';
import { ScientificObjectStore, hasAcceptedScientificWorkspace } from './scientific-object-store';
import { submitScientificWorkspace } from './scientific-workspace-service';
import { reconcileScientificProjections } from './scientific-projection-service';
import { assertRendererDatabaseStatementAllowed } from './workspace-sync-database-fence';
import {
  findKnownWorkspaceRoot,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';
import { readAcceptedSequencePackage } from './scientific-sequence-package';

type Renderer = { ownerId: number; mutationToken?: string };
function assertAvailable(db: Database.Database, renderer?: Renderer): void {
  assertRendererDatabaseStatementAllowed(db, renderer?.ownerId);
  if (db.inTransaction)
    throw new Error('Scientific lifecycle cannot enter an open database transaction.');
}
function assertDelivered(
  result: Awaited<ReturnType<typeof submitScientificWorkspace>>,
  verb: string
): void {
  if (
    result.acceptance.kind !== 'changed' &&
    result.acceptance.kind !== 'no-op' &&
    result.acceptance.kind !== 'replay'
  )
    throw new Error(
      `The scientific ${verb} was not accepted. Refresh the project before retrying.`
    );
  if (result.delivery?.kind !== 'complete')
    throw new Error(
      `${verb} accepted; file delivery remains pending: ${result.delivery?.kind === 'blocked' ? result.delivery.error : 'unavailable'}`
    );
}

export async function trashAcceptedScientificPath(input: {
  db: Database.Database;
  path: string;
  renderer?: Renderer;
  mutationLease?: () => void;
  assertCurrent?: () => void;
  expectedContentHash?: BlobHash;
}): Promise<boolean> {
  assertAvailable(input.db, input.renderer);
  input.assertCurrent?.();
  const owner = findKnownWorkspaceRoot(input.db, input.path);
  if (!owner) return false;
  const rows = (
    input.db
      .prepare('SELECT id,path FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL')
      .all() as { id: number; path: string }[]
  ).filter((row) => workspaceMutationRootIdentity(row.path) === owner);
  if (rows.length !== 1) throw new Error('The scientific file has no unique owning workspace.');
  const workspace = rows[0];
  const sourcePath = relative(owner, workspaceMutationRootIdentity(input.path))
    .split('\\')
    .join('/');
  const store = new ScientificObjectStore(input.db, workspace.id);
  const accepted = store.catalog();
  const live = accepted.entries.filter(
    (slot) =>
      !slot.tombstone &&
      slot.path &&
      (slot.path === sourcePath || slot.path.startsWith(`${sourcePath}/`))
  );
  if (!accepted.head || !live.length) return false;
  assertKnownWorkspaceContentWritable(input.db, owner);
  const readOwner = () => ({
    root: findKnownWorkspaceRoot(input.db, input.path),
    workspace: input.db
      .prepare(
        'SELECT id,path,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE id=?'
      )
      .get(workspace.id),
    shared: input.db
      .prepare(
        'SELECT workspace_uuid,owner_account_id,owner_org_id,remote_workspace_id,enabled,access_role FROM workspace_sync_bindings WHERE workspace_id=?'
      )
      .get(workspace.id),
    owners: input.db
      .prepare(
        'SELECT id,path FROM workspaces WHERE archived_at IS NULL AND trashed_at IS NULL ORDER BY id'
      )
      .all()
      .filter(
        (row) =>
          typeof row === 'object' &&
          row !== null &&
          'path' in row &&
          typeof row.path === 'string' &&
          workspaceMutationRootIdentity(row.path) === owner
      ),
    file: input.db
      .prepare('SELECT workspace_id,entity_id,path,status FROM catalog_entity_files WHERE path=?')
      .get(input.path),
  });
  const capturedOwner = readOwner();
  const assertOwnerCurrent = () => {
    if (!isDeepStrictEqual(readOwner(), capturedOwner))
      throw new Error('The accepted file owner or write access changed before deletion.');
  };
  const { graph, reader } = store.read();
  const standalone = live.length === 1 && live[0].path === sourcePath ? live[0] : null;
  const opaque = standalone && !reader.current(standalone.resourceId) ? standalone : null;
  let workingFileHash: BlobHash | undefined;
  if (opaque || input.expectedContentHash !== undefined) {
    if (!standalone) throw new Error('The accepted source is not an exact standalone file.');
    const revision = inspectResourceRevision(graph, standalone.revisionId);
    const state =
      revision.ok && revision.value.stateHash
        ? inspectResourceState(graph, revision.value.stateHash)
        : null;
    if (
      !state?.ok ||
      state.value.layout !== 'file' ||
      (opaque && state.value.resourceKind.startsWith('dnaforge.scientific.'))
    )
      throw new Error('The accepted standalone file state is unavailable.');
    const inspected = await runWorkspaceFileTrash({
      kind: 'inspect',
      workspaceRoot: owner,
      path: input.path,
    });
    if (
      inspected.kind !== 'inspect' ||
      inspected.source.type !== 'file' ||
      inspected.source.path !== sourcePath ||
      inspected.source.contentHash !== state.value.blob.hash ||
      (input.expectedContentHash !== undefined &&
        state.value.blob.hash !== input.expectedContentHash)
    )
      throw new Error('The accepted standalone file changed before deletion.');
    workingFileHash = state.value.blob.hash;
    input.assertCurrent?.();
  }
  const entries: ScientificFileEntry[] = [];
  if (opaque) {
    for (const slot of accepted.entries) {
      if (slot.tombstone || !slot.path) continue;
      const snapshot = reader.current(slot.resourceId);
      if (snapshot)
        entries.push({
          resourceId: slot.resourceId,
          path: slot.path,
          ...(snapshot.representation
            ? { representation: snapshot.representation }
            : { document: snapshot.document }),
        });
    }
  }
  input.assertCurrent?.();
  assertDelivered(
    await submitScientificWorkspace({
      db: input.db,
      workspaceId: workspace.id,
      renderer: input.renderer,
      mutationLease: input.mutationLease,
      beforeAccept: assertOwnerCurrent,
      request: {
        operationId: `scientific-delete:${randomUUID()}`,
        expectedHead: accepted.head,
        source: opaque ? { kind: 'documents', entries } : { kind: 'delete', sourcePath },
      },
      ...(opaque && opaque.path && workingFileHash
        ? {
            publication: {
              mutations: [
                {
                  kind: 'delete-resource' as const,
                  resourceId: opaque.resourceId,
                  expectedRevision: opaque.revisionId,
                  expectedPath: opaque.path,
                },
              ],
              blobs: [],
              workingFileHashes: new Map([[opaque.path, workingFileHash]]),
              onAcceptedInsideTx: () => {
                const binding = input.db
                  .prepare('SELECT workspace_id FROM catalog_entity_files WHERE path=?')
                  .get(input.path);
                if (
                  binding &&
                  (typeof binding !== 'object' ||
                    !('workspace_id' in binding) ||
                    binding.workspace_id !== workspace.id)
                )
                  throw new Error('The retired file catalog belongs to another workspace.');
                setCatalogFileStateInDb(input.db, input.path, 'missing', 'accepted-file-trashed');
                return undefined;
              },
            },
          }
        : {}),
    }),
    'Delete'
  );
  return true;
}

export async function actOnAcceptedScientificEntity(input: {
  db: Database.Database;
  input: LimsEntityActionInput;
  action: 'archive' | 'restore' | 'revert';
  renderer?: Renderer;
}): Promise<LimsRevertEntityResult | null> {
  assertAvailable(input.db, input.renderer);
  const row = input.db.prepare('SELECT * FROM lims_entity WHERE id=?').get(input.input.id) as
    | LimsEntityRow
    | undefined;
  if (!row || row.workspace_id === null) return null;
  if (!hasAcceptedScientificWorkspace(input.db, row.workspace_id)) return null;
  const store = new ScientificObjectStore(input.db, row.workspace_id);
  const accepted = store.catalog();
  const slot = accepted.entries.find((candidate) => candidate.resourceId === input.input.id);
  if (!accepted.head || !slot) return null;
  const entity = limsEntityFromRow(row);
  if (
    input.input.expectedEventSeq !== undefined &&
    input.input.expectedEventSeq !== entity.eventSeq
  )
    throw new Error('The scientific record changed. Refresh before changing its lifecycle.');
  if (input.action !== 'revert' && slot.tombstone === (input.action === 'archive')) {
    await reconcileScientificProjections({
      db: input.db,
      workspaceId: row.workspace_id,
      renderer: input.renderer,
    });
    return {
      entity: limsEntityFromRow(
        input.db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entity.id) as LimsEntityRow
      ),
      reverted: false,
    };
  }
  let sourcePath = slot.path;
  if (input.action === 'archive') {
    const { graph, reader } = store.read();
    const snapshot = reader.current(slot.resourceId);
    if (
      !snapshot ||
      !sourcePath ||
      !['primer', 'sequence', 'strain'].includes(snapshot.document.kind)
    )
      throw new Error('This accepted identity is not a supported scientific record.');
    if (
      snapshot.representation?.format === 'genbank-v1' &&
      readAcceptedSequencePackage({
        store,
        graph,
        head: accepted.head,
        sequenceId: slot.resourceId,
        productPath: sourcePath,
        productText: snapshot.representation.text,
      })
    ) {
      const packageRoot = parseWorkspacePath(dirname(sourcePath));
      if (!packageRoot.ok) throw new Error('The accepted package root is unavailable.');
      sourcePath = packageRoot.value;
    }
  }
  const result = await submitScientificWorkspace({
    db: input.db,
    workspaceId: row.workspace_id,
    renderer: input.renderer,
    request: {
      operationId: input.input.operationId ?? `scientific-${input.action}:${randomUUID()}`,
      expectedHead: accepted.head,
      source:
        input.action === 'archive'
          ? { kind: 'delete', sourcePath: sourcePath! }
          : {
              kind: input.action === 'revert' ? 'revert-record' : 'restore-record',
              resourceId: slot.resourceId,
            },
    },
  });
  assertDelivered(
    result,
    input.action === 'archive' ? 'Archive' : input.action === 'revert' ? 'Revert' : 'Restore'
  );
  return {
    entity: limsEntityFromRow(
      input.db.prepare('SELECT * FROM lims_entity WHERE id=?').get(entity.id) as LimsEntityRow
    ),
    reverted: result.acceptance.kind !== 'no-op',
    ...(input.action === 'revert' && result.acceptance.kind === 'no-op'
      ? { reason: 'no-prior-edit' as const }
      : {}),
  };
}

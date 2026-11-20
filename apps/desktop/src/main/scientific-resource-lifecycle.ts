import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { parseWorkspacePath } from '@waypoint/workspace-revisions';
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
    ...(input.action === 'archive' ? { archiveResourceId: slot.resourceId } : {}),
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

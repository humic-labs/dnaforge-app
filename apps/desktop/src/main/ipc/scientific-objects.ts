import {
  resolveScientificWorkspace,
  submitScientificObjectInMain,
} from '../scientific-object-commands';
export {
  resolveScientificWorkspace,
  scientificSubmissionReceipt,
} from '../scientific-object-commands';
import type Database from 'better-sqlite3';
import type {
  ScientificAcceptedWorkspace,
  ScientificWorkspaceSubmitResult,
  ScientificWorkspaceProjectionResult,
  ScientificWorkspaceCatalog,
} from '@waypoint/domain-services';
import {
  listWorkspaceResources,
  parseResourceId,
  parseResourceRevisionId,
  type Result,
} from '@waypoint/workspace-revisions';

import { handleGroup } from '../../shared/ipc-contract';
import { scientificObjectsContract } from '../../shared/ipc/scientific-objects.contract';

import { ScientificObjectStore } from '../scientific-object-store';

import { reconcileScientificProjections } from '../scientific-projection-service';

import { withRendererDatabaseRead } from '../workspace-sync-database-fence';
import { getDb } from './database';
import type { DesktopScientificWorkspaceRequest } from '../../shared/scientific-objects-ipc';

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok)
    throw new TypeError(`Invalid scientific identity: ${JSON.stringify(result.error)}`);
  return result.value;
};

export function registerScientificObjectHandlers(resolveDb: () => Database.Database = getDb): void {
  handleGroup(scientificObjectsContract, {
    catalog: (
      event,
      input: DesktopScientificWorkspaceRequest
    ): Promise<ScientificWorkspaceCatalog> => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () => ({
        workspace: input.request.workspace,
        ...new ScientificObjectStore(db, resolveScientificWorkspace(db, input)).catalog(),
      }));
    },
    reconcileProjections: async (event, input): Promise<ScientificWorkspaceProjectionResult> => {
      const db = resolveDb();
      if (db.inTransaction)
        throw new Error('Scientific projection cannot enter an open database transaction.');
      return reconcileScientificProjections({
        db,
        workspaceId: resolveScientificWorkspace(db, input),
        renderer: {
          ownerId: event.sender.id,
          ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
        },
      });
    },
    list: (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () =>
        db
          .transaction((): ScientificAcceptedWorkspace => {
            const workspaceId = resolveScientificWorkspace(db, input);
            const { graph, head, reader } = new ScientificObjectStore(db, workspaceId).read();
            const entries: ScientificAcceptedWorkspace['entries'][number][] = [];
            if (head !== null)
              for (const slot of must(listWorkspaceResources(graph, head))) {
                if (!slot.path || slot.tombstone) continue;
                const snapshot = reader.current(slot.resourceId);
                if (snapshot)
                  entries.push({
                    resourceId: snapshot.resourceId,
                    revisionId: snapshot.revisionId,
                    path: slot.path,
                    document: snapshot.document,
                  });
              }
            return { workspace: input.request.workspace, head, entries };
          })
          .deferred()
      );
    },
    read: (event, input) => {
      const db = resolveDb();
      return withRendererDatabaseRead(db, event.sender, () =>
        db
          .transaction(() => {
            const store = new ScientificObjectStore(db, resolveScientificWorkspace(db, input));
            const { reader } = store.read();
            const resourceId = must(parseResourceId(input.request.resourceId));
            return input.request.revisionId === undefined
              ? reader.current(resourceId)
              : reader.revision({
                  resourceId,
                  revisionId: must(parseResourceRevisionId(input.request.revisionId)),
                });
          })
          .deferred()
      );
    },
    submit: (event, input): Promise<ScientificWorkspaceSubmitResult> => {
      const assertCurrent = () => {
        if (event.sender.isDestroyed()) throw new Error('The setup caller is no longer available.');
      };
      return submitScientificObjectInMain(resolveDb(), input, {
        renderer: {
          ownerId: event.sender.id,
          ...(input.mutationToken ? { mutationToken: input.mutationToken } : {}),
        },
        ...(input.request.source.kind === 'initialize-empty-namespace'
          ? { beforeAccept: assertCurrent, beforePublish: assertCurrent }
          : {}),
      });
    },
  });
}

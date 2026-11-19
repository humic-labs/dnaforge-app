import { backfillSavedFileSources } from './backfill-saved-file-sources';
import { recoverPendingSavedFileSources } from './saved-file-sources';
import type Database from 'better-sqlite3';
import { resolve } from 'node:path';
import {
  savedFileSourceRequest,
  type SavedFileSourceRequest,
  type SavedFileSourceResult,
} from '../shared/saved-file-source-command';
import { listSavedFileVersions, restoreSavedFileSource } from './saved-file-sources';
import { assertWorkspaceProjectionPathSafe } from './workspace-projection-boundary';

export async function runSavedFileSourceCommand(
  db: Database.Database,
  input: SavedFileSourceRequest,
  scope: { workspaceId: number | null; root: string; assertCurrent(): void }
): Promise<SavedFileSourceResult> {
  const { operation } = savedFileSourceRequest.parse(input);
  const owner = { workspaceId: scope.workspaceId, entityId: operation.entityId };
  scope.assertCurrent();
  if (operation.kind === 'versions') {
    await recoverPendingSavedFileSources(db, {
      workspaceId: owner.workspaceId,
      entityId: owner.entityId,
      assertCurrent: scope.assertCurrent,
    });
    let { unavailable } = await backfillSavedFileSources(db, { ...owner, assertCurrent: scope.assertCurrent });
    try {
      const {retainHistoricalRegistryFileSources}=await import('./entity-artifact-mutations');
      await retainHistoricalRegistryFileSources(db,{...owner,assertCurrent:scope.assertCurrent});
    } catch { scope.assertCurrent(); unavailable++; }
    scope.assertCurrent();
    const versions = listSavedFileVersions(db, {
      ...owner,
      offset: operation.offset,
      limit: operation.limit,
    });
    return unavailable ? { ...versions, unavailableSources: unavailable } : versions;
  }
  const destination = resolve(scope.root, operation.destination);
  assertWorkspaceProjectionPathSafe(scope.root, destination);
  const recovered = await restoreSavedFileSource(db, {
    ...owner,
    destination,
    revisionId: operation.revisionId,
    assertCurrent: () => {
      scope.assertCurrent();
      assertWorkspaceProjectionPathSafe(scope.root, destination);
    },
  });
  return { restored: { id: recovered.id, relativePath: operation.destination } };
}

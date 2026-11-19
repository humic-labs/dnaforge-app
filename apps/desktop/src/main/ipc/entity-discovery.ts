import { entityDiscoveryContract } from '../../shared/ipc/entity-discovery.contract';
import { handleGroup } from '../../shared/ipc-contract';
import { entityDiscoveryTypesInDb } from '../entity-discovery';
import {
  resolveNotebookEntityTargets,
  searchNotebookEntityTargets,
} from '../resolve-notebook-entity-targets';
import { getDb } from './database';
import {
  assertCommittedDatabaseReadAllowed,
  withRendererDatabaseRead,
  type RendererDatabaseLifecycleSender,
} from '../workspace-sync-database-fence';
import { assertLimsSafetyNotQuarantined } from '../lims-safety-quarantine';

function discoveryRead<T>(
  sender: RendererDatabaseLifecycleSender,
  read: (db: ReturnType<typeof getDb>, assertCurrent: () => void) => T
) {
  const db = getDb();
  const assertCurrent = () => {
    assertCommittedDatabaseReadAllowed(db);
    assertLimsSafetyNotQuarantined(db);
  };
  return withRendererDatabaseRead(db, sender, () => {
    assertCurrent();
    return read(db, assertCurrent);
  });
}

export function registerEntityDiscoveryHandlers(): void {
  handleGroup(entityDiscoveryContract, {
    search: (event, request) =>
      discoveryRead(event.sender, (db, assertCurrent) =>
        searchNotebookEntityTargets(db, request, assertCurrent)
      ),
    resolve: (event, request) =>
      discoveryRead(event.sender, (db, assertCurrent) =>
        resolveNotebookEntityTargets(db, request, assertCurrent)
      ),
    types: (event, request) =>
      discoveryRead(event.sender, (db) => entityDiscoveryTypesInDb(db, request)),
  });
}

import { entityDiscoveryContract } from '../../shared/ipc/entity-discovery.contract';
import { handleGroup } from '../../shared/ipc-contract';
import { entityDiscoveryTypesInDb } from '../entity-discovery';
import {
  resolveNotebookEntityTargets,
  searchNotebookEntityTargets,
} from '../resolve-notebook-entity-targets';
import { getDb } from './database';
import {
  assertRendererDatabaseStatementAllowed,
  withRendererDatabaseRead,
} from '../workspace-sync-database-fence';
import { assertLimsSafetyNotQuarantined } from '../lims-safety-quarantine';

export function registerEntityDiscoveryHandlers(): void {
  handleGroup(entityDiscoveryContract, {
    search: (event, request) => {
      const db = getDb();
      return withRendererDatabaseRead(db, event.sender, () => {
        assertLimsSafetyNotQuarantined(db);
        return searchNotebookEntityTargets(db, request, () => {
          assertRendererDatabaseStatementAllowed(db, event.sender.id);
          assertLimsSafetyNotQuarantined(db);
        });
      });
    },
    resolve: (event, request) => {
      const db = getDb();
      return withRendererDatabaseRead(db, event.sender, () => {
        assertLimsSafetyNotQuarantined(db);
        return resolveNotebookEntityTargets(db, request, () => {
          assertRendererDatabaseStatementAllowed(db, event.sender.id);
          assertLimsSafetyNotQuarantined(db);
        });
      });
    },
    types: (event, request) => {
      const db = getDb();
      return withRendererDatabaseRead(db, event.sender, () => {
        assertLimsSafetyNotQuarantined(db);
        return entityDiscoveryTypesInDb(db, request);
      });
    },
  });
}

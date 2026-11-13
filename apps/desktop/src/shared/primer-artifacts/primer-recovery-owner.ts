import type { PrimerRecoveryDependencies } from './primer-recovery-port';
import { createPrimerTrashReader } from './primer-trash-state';
import { createPrimerRelationshipReader } from './primer-registry-relationships';
import { createPrimerRecoveryReportOwner } from './primer-recovery-report';
import { createPrimerRecordRecoveryOwner } from './recover-primer-records';
export function createPrimerRecoveryServices(
  input: Omit<
    PrimerRecoveryDependencies,
    'findTrashedPrimerDocument' | 'readPrimerRegistryRelationships'
  >
) {
  const deps: PrimerRecoveryDependencies = {
    ...input,
    findTrashedPrimerDocument: (...args) => trash.findTrashedPrimerDocument(...args),
    readPrimerRegistryRelationships: (...args) =>
      relationships.readPrimerRegistryRelationships(...args),
  };
  const trash = createPrimerTrashReader(deps),
    relationships = createPrimerRelationshipReader(deps);
  return {
    ...trash,
    ...relationships,
    ...createPrimerRecoveryReportOwner(deps),
    ...createPrimerRecordRecoveryOwner(deps),
  };
}

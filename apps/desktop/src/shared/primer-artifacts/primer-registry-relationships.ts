import { limsLinkFromRow, type LimsLinkRow } from '../lims';
import {
  parsePrimerRegistryRelationships,
  type PrimerRegistryRelationship,
} from '../primer-registry-relationships';
import type { PrimerRecoveryDependencies } from './primer-recovery-port';
export function createPrimerRelationshipReader(dependencies: PrimerRecoveryDependencies) {
  const platform = dependencies.io;

  async function readPrimerRegistryRelationships(
    entityId: string
  ): Promise<PrimerRegistryRelationship[]> {
    const rows = await platform().db.select<
      Array<LimsLinkRow & { owner_repo_uuid: string | null }>
    >(
      `SELECT l.*, w.repo_uuid AS owner_repo_uuid FROM lims_link l
     LEFT JOIN workspaces w ON w.id = l.workspace_id
     WHERE l.from_entity_id = ? OR l.to_entity_id = ? ORDER BY l.id`,
      [entityId, entityId]
    );
    return parsePrimerRegistryRelationships(
      rows.map((row) => {
        const link = limsLinkFromRow(row);
        return {
          id: link.id,
          fromEntityId: link.fromEntityId,
          toEntityId: link.toEntityId,
          type: link.type,
          payload: link.payload,
          project:
            row.workspace_id === null
              ? { status: 'unassigned' as const }
              : row.owner_repo_uuid
                ? { status: 'assigned' as const, repoUuid: row.owner_repo_uuid }
                : { status: 'unresolved' as const },
          actor: link.actor,
          sourceEventSeq: link.eventSeq,
          archived: link.tombstone,
          createdAt: link.createdAt,
          updatedAt: link.updatedAt,
          archivedAt: link.archivedAt,
        };
      }),
      entityId
    );
  }
  return { readPrimerRegistryRelationships };
}

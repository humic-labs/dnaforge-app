import type { LimsEntity, LimsRegistryOpenTarget } from '../../shared/lims';
import { queryLimsEntities } from './operations';
import { registryRepresentationForEntity } from '../../shared/registry-entity-opening';

export type LimsSequenceFileOpenTarget = Extract<LimsRegistryOpenTarget, { kind: 'sequence_file' }>;
export type LimsRecordDetailOpenTarget = Extract<LimsRegistryOpenTarget, { kind: 'record_detail' }>;
export type LimsMissingEntityOpenTarget = Extract<
  LimsRegistryOpenTarget,
  { kind: 'missing_entity' }
>;
export type LimsOpenTarget = LimsRegistryOpenTarget;

export async function getLimsEntityById(entityId: string): Promise<LimsEntity | null> {
  const entities = await queryLimsEntities({ id: entityId, includeArchived: true, limit: 1 });
  return entities[0] ?? null;
}

export async function resolveLimsEntityOpenTarget(entityId: string): Promise<LimsOpenTarget> {
  const entity = await getLimsEntityById(entityId);
  if (!entity || entity.tombstone) {
    return {
      kind: 'missing_entity',
      entityId,
      label: entity?.name ?? entityId,
      reason: 'not_found',
    };
  }
  return resolveLimsEntityOpenTargetFromEntity(entity);
}

export function resolveLimsEntityOpenTargetFromEntity(entity: LimsEntity): LimsOpenTarget {
  return registryRepresentationForEntity(entity).openTarget;
}

export function hasOpenableFileRepresentation(entity: LimsEntity): boolean {
  const sequence = entity.fields.sequence;
  return Boolean(
    sequence &&
    typeof sequence === 'object' &&
    'mode' in sequence &&
    sequence.mode === 'file' &&
    registryRepresentationForEntity(entity).canOpen
  );
}

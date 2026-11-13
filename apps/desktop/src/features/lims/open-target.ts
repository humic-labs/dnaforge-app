import type {
  DnaSequenceRef,
  FileDnaSequenceRef,
  InlineDnaSequenceRef,
  LimsEntity,
  LimsRegistryOpenTarget,
} from '../../shared/lims';
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
  return dnaSequenceRefForEntity(entity)?.mode === 'file';
}

function dnaSequenceRefForEntity(entity: LimsEntity): DnaSequenceRef | null {
  const value = entity.fields.sequence;
  if (!value || typeof value !== 'object') return null;
  const sequence = value as Partial<DnaSequenceRef>;
  if (sequence.mode === 'file' && typeof sequence.relPath === 'string') {
    return sequence as FileDnaSequenceRef;
  }
  if (sequence.mode === 'inline' && typeof sequence.length === 'number') {
    return sequence as InlineDnaSequenceRef;
  }
  if (sequence.mode === 'unresolved') {
    return { mode: 'unresolved' };
  }
  return null;
}

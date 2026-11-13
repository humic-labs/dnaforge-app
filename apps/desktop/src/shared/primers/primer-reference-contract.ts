import type { LimsEntity } from '../lims';
import type { PrimerArtifactBindingV1 } from './primer-artifact';

export function canonicalPrimerReferenceSnapshot(
  entity: Pick<LimsEntity, 'id' | 'name'>,
  owned?: { primerId: string; workspaceRoot: string },
  binding?: PrimerArtifactBindingV1,
  registryWorkspaceRoot: string | null = null
) {
  const data = {
    registryEntityId: entity.id,
    ...(owned ? { primerId: owned.primerId } : { localOnly: true }),
    ...(binding
      ? {
          bindingId: binding.id,
          targetDocumentId: binding.target.documentId,
          ...(binding.target.projectId ? { targetProjectId: binding.target.projectId } : {}),
        }
      : {}),
  };
  return {
    entityId: entity.id,
    registryEntityId: entity.id,
    primerId: owned?.primerId ?? null,
    bindingId: binding?.id ?? null,
    displayLabel: entity.name,
    locator: `entity://primer/${entity.id}`,
    data,
    deepLinkParams: binding
      ? { bindingStart: binding.coordinates.start + 1, bindingEnd: binding.coordinates.end }
      : null,
    workspaceRoot: owned?.workspaceRoot ?? registryWorkspaceRoot,
    localOnly: !owned,
  };
}

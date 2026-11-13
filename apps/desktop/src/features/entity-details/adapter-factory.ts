import type { LimsRegistryPreview } from '../../shared/lims';
import type { EntityDetailsDefinition, EntityDetailsTarget } from './types';

export interface EntityDetailsAdapter {
  id: string;
  matches: (preview: LimsRegistryPreview, target: EntityDetailsTarget) => boolean;
  create: (
    preview: LimsRegistryPreview,
    target: EntityDetailsTarget
  ) => Promise<EntityDetailsDefinition>;
}

export function createEntityDetailsFactory(adapters: readonly EntityDetailsAdapter[]) {
  const ids = adapters.map((adapter) => adapter.id);
  if (new Set(ids).size !== ids.length) throw new Error('Metadata adapter names must be unique.');
  return async (
    preview: LimsRegistryPreview,
    target: EntityDetailsTarget
  ): Promise<EntityDetailsDefinition> => {
    if (preview.entity.id !== target.entityId)
      throw new Error('The metadata identity does not match the requested entity.');
    const adapter = adapters.find((candidate) => candidate.matches(preview, target));
    if (!adapter) throw new Error('Metadata is unavailable for this record.');
    const definition = await adapter.create(preview, target);
    if (definition.record.id !== target.entityId)
      throw new Error('The metadata owner returned a different entity.');
    return definition;
  };
}

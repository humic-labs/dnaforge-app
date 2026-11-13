import { platform } from '../platform';
import { getCatalogEntityForFilePath } from '../db/workspace-catalog';
import { findPrimerRegistryEntityId } from '../db/primer-reference-search';
import type { LimsEntity } from '../shared/lims';

export type EntityRegistryReference =
  | { kind: 'entity'; entityId: string }
  | { kind: 'sequence'; documentId: string }
  | { kind: 'file'; path: string }
  | { kind: 'primer'; primerId: string };

export async function resolveEntityRegistryReference(
  reference: EntityRegistryReference,
  includeTracked = false
): Promise<LimsEntity | null> {
  const query = async (
    input: Parameters<ReturnType<typeof platform>['lims']['queryEntities']>[0]
  ) => platform().lims.queryEntities(input);
  const byId = async (id: string) => (id ? query({ id, includeArchived: true, limit: 1 }) : []);
  let entities: LimsEntity[];
  if (reference.kind === 'entity') entities = await byId(reference.entityId);
  else if (reference.kind === 'primer') {
    const id = await findPrimerRegistryEntityId(reference.primerId);
    entities = id ? await byId(id) : [];
  } else if (reference.kind === 'file') {
    const entity = await getCatalogEntityForFilePath(reference.path);
    entities = entity ? await byId(entity.id) : [];
  } else {
    const [direct, linked] = await Promise.all([
      byId(reference.documentId),
      query({ sequenceDocumentId: reference.documentId, includeArchived: true, limit: 100 }),
    ]);
    entities = [...new Map([...direct, ...linked].map((entity) => [entity.id, entity])).values()];
  }
  const registered = entities.filter((entity) => entity.registrationStatus !== 'tracked');
  const eligible = registered.length ? registered : includeTracked ? entities : [];
  if (eligible.length > 1)
    throw new Error(
      'More than one Registry record refers to this document. Select its registration in Registry.'
    );
  return eligible[0] ?? null;
}

import { buildSequencePackageDocument, type SequencePackageDocument } from './sequence-package';

export function copySequencePackageDocument(
  source: SequencePackageDocument,
  name: string,
  mintId: () => string = () => crypto.randomUUID()
): SequencePackageDocument {
  const original = structuredClone(source);
  const id = mintId();
  return buildSequencePackageDocument({
    existing: original,
    id,
    name,
    product: original.product,
    ...(original.assembly ? { assembly: original.assembly } : {}),
    members: original.members.map((member) => ({ ...member, id: mintId() })),
    entity: {
      ...original.entity,
      registrationStatus: 'tracked',
      registryId: null,
      relationships: [
        ...original.entity.relationships.map((relationship) => ({
          ...relationship,
          fromEntityId: relationship.fromEntityId === source.id ? id : relationship.fromEntityId,
          toEntityId: relationship.toEntityId === source.id ? id : relationship.toEntityId,
        })),
        {
          type: 'derived_from',
          fromEntityId: id,
          toEntityId: source.id,
          payload: { operation: 'duplicate' },
        },
      ],
    },
  });
}

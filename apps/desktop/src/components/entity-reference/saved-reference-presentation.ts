import {
  isPortableNativeEntityId,
  nativeEntityReferenceIdFromHref,
} from '../../shared/native-entity-reference';
import type { DBEntityReference } from '../../db/entity-references';
import type { MolecularReference } from '../../shared/molecular-reference';
import type { ReferenceTypeLookup } from './useReferenceEntityType';

export function savedReferencePresentation(
  reference: DBEntityReference,
  molecular: MolecularReference | null
): { entityType: string; iconKind?: string; typeLookup?: ReferenceTypeLookup } {
  if (molecular) {
    switch (molecular.kind) {
      case 'document':
        return { entityType: 'molecular-document' };
      case 'selection':
        return { entityType: 'selection', iconKind: 'annotation' };
      case 'view':
        if (molecular.target.groupId) return { entityType: 'selection', iconKind: 'annotation' };
        return { entityType: 'view', iconKind: 'molecular-document' };
      case 'visualization':
        return { entityType: 'view', iconKind: 'molecular-document' };
      case 'structure':
        return { entityType: 'file' };
    }
  }
  let entityId = nativeEntityReferenceIdFromHref(reference.locator);
  const route = /^entity:\/\/([^/]+)\/(.+)$/u.exec(reference.locator);
  if (route && isPortableNativeEntityId(route[2])) {
    if (
      (reference.entity_type === 'record' && ['record', 'lims'].includes(route[1])) ||
      (['sequence', 'protein', 'primer', 'file'].includes(reference.entity_type) &&
        route[1] === reference.entity_type)
    ) {
      entityId = route[2];
    }
  }
  return {
    entityType: reference.entity_type,
    ...(entityId ? { typeLookup: { entityId, projectRoot: reference.workspace_root_path } } : {}),
  };
}

import {
  getCatalogEntity,
  getCurrentCatalogFileForEntity,
  getCurrentSequenceFileForDocumentId,
} from '../../db/workspace-catalog';
import type { AcceptedAssemblySourceIdentityResolver } from './accepted-service';
import { assertCanonicalSequenceSource } from '../sequence/public/sequence-document-repository';

export const resolveAcceptedSourceIdentity: AcceptedAssemblySourceIdentityResolver = async (
  sourceSequenceId,
  sourceSequenceChecksum
) => {
  if (!sourceSequenceChecksum) return null;
  const binding = await getCurrentSequenceFileForDocumentId(sourceSequenceId);
  const entity = await getCatalogEntity(binding?.entity_id ?? sourceSequenceId);
  if (!entity) return null;
  const source = binding ?? (await getCurrentCatalogFileForEntity(entity.id));
  if (source) await assertCanonicalSequenceSource(entity.id, source.path);
  return {
    sourceConstructId: entity.id,
    sourceSequenceVersionId: sourceSequenceChecksum,
    sourceLocator: `waypoint://sequence/${encodeURIComponent(entity.id)}`,
  };
};

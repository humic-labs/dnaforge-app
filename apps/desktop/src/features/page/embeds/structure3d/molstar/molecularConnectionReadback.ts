import { z } from 'zod';
import type { MolecularConnectionCoverage } from './molecularConnections';

export const molecularConnectionQuerySchema = z
  .object({
    kind: z
      .enum(['covalent', 'disulfide', 'metal-coordination', 'hydrogen-bond', 'unknown'])
      .optional(),
    attachmentsOnly: z.boolean().optional(),
    labelAsymId: z.string().min(1).max(100).optional(),
    authSeqId: z.number().int().optional(),
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(64).optional(),
  })
  .strict();
export type MolecularConnectionQuery = z.infer<typeof molecularConnectionQuerySchema>;

export function pageMolecularConnections(
  inventory: readonly MolecularConnectionCoverage[],
  query: MolecularConnectionQuery = {}
) {
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 32;
  const countsByKind: Record<string, number> = {};
  const countsByStatus: Record<string, number> = {};
  for (const connection of inventory) {
    countsByKind[connection.kind] = (countsByKind[connection.kind] ?? 0) + 1;
    countsByStatus[connection.status] = (countsByStatus[connection.status] ?? 0) + 1;
  }
  const matches = inventory.filter((connection) => {
    if (query.kind && connection.kind !== query.kind) return false;
    if (query.attachmentsOnly && !connection.attachment) return false;
    return [connection.a, connection.b].some(
      (endpoint) =>
        (!query.labelAsymId || endpoint.labelAsymId === query.labelAsymId) &&
        (query.authSeqId === undefined || endpoint.authSeqId === query.authSeqId)
    );
  });
  matches.sort((a, b) => Number(b.attachment) - Number(a.attachment));
  const publicEndpoint = (endpoint: MolecularConnectionCoverage['a']) => {
    const {
      atomIndex: _nativeAtomIndex,
      residueIndex: _nativeResidueIndex,
      ...identity
    } = endpoint;
    return identity;
  };
  const connections = matches.slice(offset, offset + limit).map((connection) => ({
    ...connection,
    a: publicEndpoint(connection.a),
    b: publicEndpoint(connection.b),
  }));
  const nextOffset =
    offset + connections.length < matches.length ? offset + connections.length : null;
  return {
    connections,
    summary: {
      total: inventory.length,
      attachmentCount: inventory.filter((connection) => connection.attachment).length,
      incompleteAttachmentCount: inventory.filter(
        (connection) =>
          connection.attachment && !['drawn', 'not-depicted'].includes(connection.status)
      ).length,
      countsByKind,
      countsByStatus,
      page: {
        query,
        offset,
        limit,
        matched: matches.length,
        returned: connections.length,
        nextOffset,
      },
      guidance:
        'This is a page, not the complete inventory. Attachment records come first. Use each endpoint.selector within its connection.structureIndex: resolved atom_index values are deposited source indices, not native graph indices. Use connectionQuery in mol_get_state or mol_get_scene to filter by kind, attachmentsOnly, labelAsymId and authSeqId, or continue with offset: nextOffset. representationOwners are native.componentRefs, ordered like native.components. All attachment integrity checks use the complete native graph.',
    },
  };
}

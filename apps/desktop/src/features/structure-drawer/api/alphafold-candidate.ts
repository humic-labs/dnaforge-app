import {
  alphaFoldProviderIdentityKeyForHit,
  alphaFoldStructureRefForHit,
  alphaFoldVersionForHit,
  type AfdbHit,
} from './afdb-validate';
import { makeStructureCandidateId } from './candidates';
import type { ResolverSource, StructureCandidate } from '../types/structure-drawer';

export function alphaFoldCandidateFromHit(
  hit: AfdbHit,
  resolverSource: ResolverSource
): StructureCandidate {
  const providerIdentityKey = alphaFoldProviderIdentityKeyForHit(hit);
  const structure = alphaFoldStructureRefForHit(hit);
  return {
    id: makeStructureCandidateId({ provider: 'alphafold', externalId: providerIdentityKey }),
    provider: 'alphafold',
    structure,
    label: hit.accession,
    group: 'alphafold',
    rank: 0,
    metadata: {
      uniprotAccession: hit.accession,
      meanPlddt: hit.meanPlddt,
    },
    provenance: {
      resolverSource,
      identity: 1,
      structureIdentity: {
        kind: 'alphafold',
        providerIdentityKey,
        accession: hit.accession.toUpperCase(),
        fragment: structure.fragment ?? 'F1',
        version: structure.version ?? alphaFoldVersionForHit(hit),
        modelId: structure.modelId,
      },
    },
  };
}

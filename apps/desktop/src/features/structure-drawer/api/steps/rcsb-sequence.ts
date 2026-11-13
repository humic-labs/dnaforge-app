import {
  sidecarFetchRcsbMetadata,
  sidecarRcsbSequenceSearch,
  type SidecarRcsbMetadata,
  type SidecarRcsbSequenceHit,
} from '../sidecar-client';
import { makeStructureCandidateId, rankStructureCandidates } from '../candidates';
import type { ResolverStep, StructureCandidate, StructureRef } from '../../types/structure-drawer';

export const rcsbSequenceStep: ResolverStep = {
  name: 'rcsb_sequence',
  hintsRequired: [],
  priority: 4,
  async resolve(sequence, _hints, signal, request) {
    const moleculeType = request?.moleculeType;
    if (moleculeType !== 'rna' && moleculeType !== 'dna') return null;
    const hits = await sidecarRcsbSequenceSearch(sequence, moleculeType, signal, {
      size: 10,
      identityCutoff: 0.9,
    });
    if (hits.length === 0) return null;
    const candidates = await rcsbCandidatesForHits(hits, moleculeType, signal);
    if (candidates.length === 0) return null;
    const ranked = rankStructureCandidates(candidates);
    const recommended = ranked.candidates[0];
    return {
      source: 'rcsb_sequence',
      identity: recommended.provenance.sequenceIdentity ?? recommended.provenance.identity,
      structure: recommended.structure,
      recommendedCandidateId: ranked.recommendedCandidateId,
      candidates: ranked.candidates,
      confidenceNote: `${moleculeType.toUpperCase()} sequence match in RCSB`,
    };
  },
};

async function rcsbCandidatesForHits(
  hits: readonly SidecarRcsbSequenceHit[],
  moleculeType: 'rna' | 'dna',
  signal: AbortSignal
): Promise<StructureCandidate[]> {
  const out: StructureCandidate[] = [];
  const queue = [...hits];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0) {
      const hit = queue.shift();
      if (!hit) return;
      const candidate = await rcsbCandidateForHit(hit, moleculeType, signal);
      if (candidate) out.push(candidate);
    }
  });
  await Promise.all(workers);
  return out;
}

async function rcsbCandidateForHit(
  hit: SidecarRcsbSequenceHit,
  moleculeType: 'rna' | 'dna',
  signal: AbortSignal
): Promise<StructureCandidate | null> {
  const providerIdentityKey = rcsbProviderIdentityKey(hit.pdbId, hit.entityId);
  let metadata: SidecarRcsbMetadata | null = null;
  try {
    metadata = await sidecarFetchRcsbMetadata(providerIdentityKey, signal);
  } catch (err) {
    if ((err as Error).name === 'AbortError' || (err as Error).name === 'SidecarAuthError') {
      throw err;
    }
  }
  const structure: StructureRef = {
    kind: 'pdb',
    pdbId: hit.pdbId,
    providerIdentityKey,
    ...(hit.entityId ? { pdbEntityId: hit.entityId } : {}),
  };
  const identity = hit.sequenceIdentity ?? 0;
  return {
    id: makeStructureCandidateId({ provider: 'pdb', externalId: providerIdentityKey }),
    provider: 'pdb',
    structure,
    label: hit.entityId ? `${hit.pdbId} entity ${hit.entityId}` : hit.pdbId,
    group: 'rcsb',
    rank: 0,
    metadata: {
      pdbId: hit.pdbId,
      title: metadata?.title,
      method: metadata?.method,
      resolution: metadata?.resolution,
      chainCount: metadata?.chainCount,
      chainIds: metadata?.chainIds,
      polymerTypes: metadata?.polymerTypes?.length
        ? metadata.polymerTypes
        : [moleculeType === 'rna' ? 'RNA' : 'DNA'],
      entityDescriptions: metadata?.entityDescriptions,
      organism: metadata?.organism,
      sourceUrl: metadata?.sourceUrl ?? `https://www.rcsb.org/structure/${hit.pdbId}`,
      license: metadata?.license,
      attribution: metadata?.attribution,
      depositionDate: metadata?.depositionDate,
      initialReleaseDate: metadata?.initialReleaseDate,
      revisionDate: metadata?.revisionDate,
      revisionVersion: metadata?.revisionVersion,
      description:
        hit.sequenceIdentity !== undefined
          ? `${Math.round(hit.sequenceIdentity * 100)}% ${moleculeType.toUpperCase()} sequence identity`
          : `${moleculeType.toUpperCase()} sequence match`,
    },
    provenance: {
      resolverSource: 'rcsb_sequence',
      identity,
      sequenceIdentity: hit.sequenceIdentity,
      structureIdentity: {
        kind: 'rcsb',
        providerIdentityKey,
        pdbId: hit.pdbId,
        ...(hit.entityId ? { pdbEntityId: hit.entityId } : {}),
      },
      externalResourceId: metadata?.externalResourceId,
      cacheHit: metadata?.cacheHit,
    },
  };
}

function rcsbProviderIdentityKey(pdbId: string, entityId: string | undefined): string {
  const base = `RCSB:${pdbId.trim().toUpperCase()}:ENTRY`;
  return entityId ? `${base}:ENTITY:${entityId.trim().toUpperCase()}` : base;
}

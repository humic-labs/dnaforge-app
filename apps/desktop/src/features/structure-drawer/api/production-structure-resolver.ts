import { resolveStructureRequest } from './structure-resolver';
import { sidecarFetchUniProtEntry, type SidecarFetchUniProtOptions } from './sidecar-client';
import {
  deriveCacheKey,
  getCachedExternalResourceResult,
  setCachedExternalResourceResult,
} from '../hooks/useExternalResourceCache';
import type { StructureResolver } from '../types/structure-drawer';
import type { ResolverResult, StructureDrawerRequest } from '../types/structure-drawer';
import { useWorkspaceStore } from '../../../stores/workspaceStore';

async function registerWithSubstrate(
  result: ResolverResult,
  request: StructureDrawerRequest,
  signal: AbortSignal
): Promise<void> {
  if (result.structure.kind !== 'uniprot') return;
  const opts: SidecarFetchUniProtOptions = {};
  if (request.entityId) {
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceFile ?? undefined;
    if (workspaceId) {
      opts.workspaceId = workspaceId;
      opts.bindTo = {
        sourceKind: 'sequence',
        sourceUri: request.entityId,
        relationship: 'has_structure',
        evidence: 'asserted',
      };
    }
  }
  try {
    await sidecarFetchUniProtEntry(result.structure.accession, signal, opts);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
  }
}

export const productionStructureResolver: StructureResolver = async (request, signal) => {
  if (request.proteinIdentity) {
    await deriveCacheKey(request);
  }

  const useCache = !request.skipSteps || request.skipSteps.length === 0;
  if (useCache) {
    const cached = await getCachedExternalResourceResult(request, signal);
    if (cached) {
      return { result: cached, cacheHit: true };
    }
  }

  const result = await resolveStructureRequest(request, signal, {
    skipSteps: request.skipSteps,
  });

  if (result && (!request.skipSteps || request.skipSteps.length === 0)) {
    void registerWithSubstrate(result, request, signal)
      .then(() => setCachedExternalResourceResult(request, result, signal))
      .catch(() => {});
  }

  return { result, cacheHit: false };
};

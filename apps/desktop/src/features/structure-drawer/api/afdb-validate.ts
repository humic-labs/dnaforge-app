import { sidecarValidateAfdb } from './sidecar-client';
import type { StructureRef } from '../types/structure-drawer';

export interface AfdbHit {
  accession: string;
  meanPlddt?: number;
  latestVersion?: number;
  cifUrl?: string;
  providerIdentityKey?: string;
  fragment?: string;
  modelId?: string;
}

export async function validateAfdbExists(
  accession: string,
  signal: AbortSignal
): Promise<AfdbHit | null> {
  let hit;
  try {
    hit = await sidecarValidateAfdb(accession, signal);
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'AbortError' || name === 'SidecarAuthError' || name === 'SidecarProviderError') {
      throw err;
    }
    return null;
  }
  if (!hit) return null;
  return {
    accession: hit.accession,
    meanPlddt: hit.meanPlddt,
    latestVersion: hit.latestVersion,
    cifUrl: hit.cifUrl,
    providerIdentityKey: hit.providerIdentityKey,
    fragment: hit.fragment,
    modelId: hit.modelId,
  };
}

export function alphaFoldVersionForHit(hit: AfdbHit): string {
  return hit.latestVersion !== undefined ? `V${hit.latestVersion}` : 'LATEST';
}

function alphaFoldFragmentForHit(hit: AfdbHit): string {
  return hit.fragment ?? 'F1';
}

function alphaFoldModelIdForHit(hit: AfdbHit): string | undefined {
  return (
    hit.modelId ??
    (hit.latestVersion !== undefined
      ? `AF-${hit.accession.toUpperCase()}-${alphaFoldFragmentForHit(hit)}-model_v${hit.latestVersion}`
      : undefined)
  );
}

export function alphaFoldProviderIdentityKeyForHit(hit: AfdbHit): string {
  if (hit.providerIdentityKey) return hit.providerIdentityKey;
  const base = `AF:${hit.accession.toUpperCase()}:${alphaFoldFragmentForHit(hit)}:${alphaFoldVersionForHit(hit)}`;
  const modelId = alphaFoldModelIdForHit(hit);
  return modelId ? `${base}:MODEL:${modelId}` : base;
}

export function alphaFoldStructureRefForHit(
  hit: AfdbHit
): Extract<StructureRef, { kind: 'uniprot' }> {
  const version = alphaFoldVersionForHit(hit);
  const fragment = alphaFoldFragmentForHit(hit);
  const modelId = alphaFoldModelIdForHit(hit);
  return {
    kind: 'uniprot',
    accession: hit.accession,
    providerIdentityKey: alphaFoldProviderIdentityKeyForHit(hit),
    fragment,
    version,
    modelId,
  };
}

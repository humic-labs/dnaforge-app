import { makeStructureCandidateId, rankStructureCandidates } from '../candidates';
import { alphaFoldCandidateFromHit } from '../alphafold-candidate';
import { validateAfdbExists } from '../afdb-validate';
import { sidecarFetchRcsbMetadata, type SidecarRcsbMetadata } from '../sidecar-client';
import { extractUniProtAccessions } from './uniprot-xref';
import type { ResolverStep, StructureCandidate } from '../../types/structure-drawer';

const PDB_XREF_PREFIXES = ['PDB:', 'PDBe:'] as const;
const PDB_ID_RE = /^[0-9][A-Z0-9]{3}$/;

export function extractPdbId(dbXrefs: readonly string[] | undefined): string | null {
  return extractPdbIds(dbXrefs)[0] ?? null;
}

export function extractPdbIds(dbXrefs: readonly string[] | undefined): string[] {
  if (!dbXrefs) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const xref of dbXrefs) {
    for (const prefix of PDB_XREF_PREFIXES) {
      if (xref.startsWith(prefix)) {
        const id = xref.slice(prefix.length).trim();
        const normalized = id.toUpperCase();
        if (PDB_ID_RE.test(normalized) && !seen.has(normalized)) {
          ids.push(normalized);
          seen.add(normalized);
        }
      }
    }
  }
  return ids;
}

export const pdbXrefStep: ResolverStep = {
  name: 'pdb_xref',
  hintsRequired: ['dbXrefs'],
  priority: 10,
  async resolve(_translation, hints, _signal) {
    const pdbIds = extractPdbIds(hints.dbXrefs);
    if (pdbIds.length === 0) return null;
    const afdbHits = [];
    for (const accession of extractUniProtAccessions(hints.dbXrefs)) {
      const hit = await validateOptionalAfdbFallback(accession, _signal);
      if (hit) afdbHits.push(hit);
    }
    const fallbackAccession = afdbHits[0]?.accession;
    const rcsbMetadataByIdentity = await fetchRcsbMetadataForPdbIds(pdbIds, _signal);
    const ranked = rankStructureCandidates([
      ...pdbIds.map((pdbId) => {
        const providerIdentityKey = rcsbProviderIdentityKey(pdbId);
        return toPdbCandidate(
          pdbId,
          fallbackAccession,
          rcsbMetadataByIdentity.get(providerIdentityKey)
        );
      }),
      ...afdbHits.map((hit) => alphaFoldCandidateFromHit(hit, 'pdb_xref')),
    ]);
    const recommended = ranked.candidates[0];
    return {
      source: 'pdb_xref',
      identity: 1,
      structure: recommended.structure,
      recommendedCandidateId: ranked.recommendedCandidateId,
      candidates: ranked.candidates,
    };
  },
};

async function validateOptionalAfdbFallback(accession: string, signal: AbortSignal) {
  try {
    return await validateAfdbExists(accession, signal);
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'AbortError' || name === 'SidecarAuthError') throw err;
    if (name === 'SidecarProviderError') return null;
    throw err;
  }
}

async function fetchRcsbMetadataForPdbIds(
  pdbIds: readonly string[],
  signal: AbortSignal
): Promise<Map<string, SidecarRcsbMetadata>> {
  const uniqueExternalIds = [...new Set(pdbIds.map((pdbId) => rcsbProviderIdentityKey(pdbId)))];
  const metadataByIdentity = new Map<string, SidecarRcsbMetadata>();
  for (const externalId of uniqueExternalIds) {
    try {
      const metadata = await sidecarFetchRcsbMetadata(externalId, signal);
      if (metadata) metadataByIdentity.set(externalId, metadata);
    } catch (err) {
      if ((err as Error).name === 'AbortError' || (err as Error).name === 'SidecarAuthError') {
        throw err;
      }
    }
  }
  return metadataByIdentity;
}

function toPdbCandidate(
  pdbId: string,
  fallbackAccession?: string,
  rcsbMetadata?: SidecarRcsbMetadata
): StructureCandidate {
  const providerIdentityKey = rcsbProviderIdentityKey(pdbId);
  return {
    id: makeStructureCandidateId({ provider: 'pdb', externalId: providerIdentityKey }),
    provider: 'pdb',
    structure: {
      kind: 'pdb',
      pdbId,
      providerIdentityKey,
      ...(fallbackAccession ? { uniprotFallback: { accession: fallbackAccession } } : {}),
    },
    label: pdbId,
    group: 'rcsb',
    rank: 0,
    metadata: {
      pdbId,
      title: rcsbMetadata?.title,
      method: rcsbMetadata?.method,
      resolution: rcsbMetadata?.resolution,
      chainCount: rcsbMetadata?.chainCount,
      chainIds: rcsbMetadata?.chainIds ?? [],
      polymerTypes: rcsbMetadata?.polymerTypes,
      entityDescriptions: rcsbMetadata?.entityDescriptions,
      organism: rcsbMetadata?.organism,
      sourceUrl: rcsbMetadata?.sourceUrl,
      license: rcsbMetadata?.license,
      attribution: rcsbMetadata?.attribution,
      depositionDate: rcsbMetadata?.depositionDate,
      initialReleaseDate: rcsbMetadata?.initialReleaseDate,
      revisionDate: rcsbMetadata?.revisionDate,
      revisionVersion: rcsbMetadata?.revisionVersion,
    },
    provenance: {
      resolverSource: 'pdb_xref',
      identity: 1,
      structureIdentity: {
        kind: 'rcsb',
        providerIdentityKey,
        pdbId: pdbId.toUpperCase(),
      },
      externalResourceId: rcsbMetadata?.externalResourceId,
      cacheHit: rcsbMetadata?.cacheHit,
    },
  };
}

function rcsbProviderIdentityKey(pdbId: string): string {
  return `RCSB:${pdbId.trim().toUpperCase()}:ENTRY`;
}

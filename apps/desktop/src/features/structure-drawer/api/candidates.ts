import type {
  RankedStructureCandidates,
  ResolverResult,
  StructureCandidate,
  StructureProviderKind,
} from '../types/structure-drawer';

export interface CandidateIdentityInput {
  provider: StructureProviderKind;
  externalId: string;
  chainId?: string;
}

export function makeStructureCandidateId({
  provider,
  externalId,
  chainId,
}: CandidateIdentityInput): string {
  if (provider === 'pdb') {
    const normalizedExternalId = normalizeRcsbCandidateExternalId(externalId);
    const scope = chainId?.trim() || 'all';
    return `rcsb:${normalizedExternalId}:${scope}`;
  }
  const normalizedExternalId = normalizeAlphaFoldCandidateExternalId(externalId);
  return `alphafold:${normalizedExternalId}:all`;
}

const RCSB_SCOPE_KEYS = new Set(['ASSEMBLY', 'ENTITY', 'LABEL_ASYM', 'AUTH_ASYM']);

function normalizeRcsbCandidateExternalId(externalId: string): string {
  const trimmed = externalId.trim();
  const parts = trimmed.split(':').map((part) => part.trim());
  if (parts[0]?.toUpperCase() !== 'RCSB' || parts.length < 2) {
    return trimmed.toUpperCase();
  }

  const normalized = ['RCSB', parts[1].toUpperCase()];
  for (let index = 2; index < parts.length; index += 1) {
    const token = parts[index];
    const upperToken = token.toUpperCase();
    if (upperToken === 'ENTRY') {
      normalized.push('ENTRY');
      continue;
    }
    if (RCSB_SCOPE_KEYS.has(upperToken) && index + 1 < parts.length) {
      normalized.push(upperToken, parts[index + 1]);
      index += 1;
      continue;
    }
    normalized.push(upperToken);
  }
  return normalized.join(':');
}

function normalizeAlphaFoldCandidateExternalId(externalId: string): string {
  const trimmed = externalId.trim();
  const parts = trimmed.split(':').map((part) => part.trim());
  if (parts[0]?.toUpperCase() !== 'AF' || parts.length < 2) {
    return trimmed.toUpperCase();
  }

  const normalized: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const previous = parts[index - 1]?.toUpperCase();
    if (index === 0) normalized.push('AF');
    else if (index === 1) normalized.push(parts[index].toUpperCase());
    else if (previous === 'MODEL') normalized.push(normalizeAlphaFoldModelId(parts[index]));
    else normalized.push(parts[index].toUpperCase());
  }
  return normalized.join(':');
}

function normalizeAlphaFoldModelId(modelId: string): string {
  const match = /^AF-([A-Z0-9]+)-(F\d+)-model_v(\d+)$/i.exec(modelId.trim());
  if (!match) return modelId.trim();
  return `AF-${match[1].toUpperCase()}-${match[2].toUpperCase()}-model_v${match[3]}`;
}

export function rankStructureCandidates(
  input: readonly StructureCandidate[]
): RankedStructureCandidates {
  const deduped = dedupeCandidates(input);
  if (deduped.length === 0) {
    throw new Error('Cannot rank an empty structure candidate list');
  }

  const candidates = deduped
    .slice()
    .sort(compareCandidates)
    .map((candidate, index) => ({
      ...candidate,
      rank: index,
    }));

  return {
    recommendedCandidateId: candidates[0].id,
    candidates,
  };
}

export function findStructureCandidateById(
  resolved: ResolverResult | null,
  candidateId: string | null
): StructureCandidate | null {
  if (!resolved || !candidateId) return null;
  return (
    candidateRowsForResolved(resolved).find((candidate) => candidate.id === candidateId) ?? null
  );
}

export function deriveResolvedForStructureCandidate(
  resolved: ResolverResult,
  candidate: StructureCandidate
): ResolverResult {
  return {
    ...resolved,
    structure: candidate.structure,
  };
}

export function deriveResolvedForStructureCandidateId(
  resolved: ResolverResult | null,
  candidateId: string | null
): ResolverResult | null {
  if (!resolved || !candidateId) return null;
  const candidate = findStructureCandidateById(resolved, candidateId);
  return candidate ? deriveResolvedForStructureCandidate(resolved, candidate) : null;
}

export function candidateRowsForResolved(resolved: ResolverResult): StructureCandidate[] {
  if (resolved.candidates?.length) return resolved.candidates;

  switch (resolved.structure.kind) {
    case 'uniprot':
      return [
        {
          id:
            resolved.recommendedCandidateId ??
            makeStructureCandidateId({
              provider: 'alphafold',
              externalId: resolved.structure.accession,
            }),
          provider: 'alphafold',
          structure: resolved.structure,
          label: resolved.structure.accession,
          group: 'alphafold',
          rank: 0,
          metadata: {
            uniprotAccession: resolved.structure.accession,
            description: resolved.confidenceNote,
            sourceUrl: `https://alphafold.ebi.ac.uk/entry/${resolved.structure.accession}`,
          },
          provenance: {
            resolverSource: resolved.source,
            identity: resolved.identity,
          },
        },
      ];
    case 'pdb':
      return [
        {
          id:
            resolved.recommendedCandidateId ??
            makeStructureCandidateId({
              provider: 'pdb',
              externalId: resolved.structure.pdbId,
            }),
          provider: 'pdb',
          structure: resolved.structure,
          label: resolved.structure.pdbId,
          group: 'rcsb',
          rank: 0,
          metadata: {
            pdbId: resolved.structure.pdbId,
            description: resolved.confidenceNote,
            sourceUrl: `https://www.rcsb.org/structure/${resolved.structure.pdbId}`,
          },
          provenance: {
            resolverSource: resolved.source,
            identity: resolved.identity,
          },
        },
      ];
    case 'url':
    case 'data':
      return [];
  }
}

function dedupeCandidates(candidates: readonly StructureCandidate[]): StructureCandidate[] {
  const byId = new Map<string, StructureCandidate>();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.id);
    byId.set(candidate.id, existing ? mergeCandidate(existing, candidate) : candidate);
  }
  return [...byId.values()];
}

function mergeCandidate(base: StructureCandidate, next: StructureCandidate): StructureCandidate {
  return {
    ...base,
    ...next,
    metadata: mergeDefined(base.metadata, next.metadata),
    provenance: mergeDefined(base.provenance, next.provenance),
  };
}

function mergeDefined<T extends Record<string, unknown>>(base: T, next: T): T {
  const merged = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) {
      merged[key as keyof T] = value as T[keyof T];
    }
  }
  return merged;
}

function compareCandidates(left: StructureCandidate, right: StructureCandidate): number {
  if (left.provider !== right.provider) {
    return left.provider === 'pdb' ? -1 : 1;
  }

  if (left.provider === 'pdb' && right.provider === 'pdb') {
    const leftResolution = resolutionSortValue(left);
    const rightResolution = resolutionSortValue(right);
    if (leftResolution !== rightResolution) {
      return leftResolution - rightResolution;
    }
  }

  if (left.provider === 'alphafold' && right.provider === 'alphafold') {
    const plddtDelta =
      (right.metadata.meanPlddt ?? -Infinity) - (left.metadata.meanPlddt ?? -Infinity);
    if (plddtDelta !== 0) return plddtDelta;
  }

  return left.id.localeCompare(right.id);
}

function resolutionSortValue(candidate: StructureCandidate): number {
  const resolution = candidate.metadata.resolution;
  return typeof resolution === 'number' && Number.isFinite(resolution) ? resolution : Infinity;
}

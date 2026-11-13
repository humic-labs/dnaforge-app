import {
  sidecarFetchRcsbMetadata,
  sidecarUniProtBySequence,
  type SidecarMatchEvidence,
  type SidecarQueryIdentity,
  type SidecarRcsbMetadata,
  type SidecarUniProtBySequenceHit,
  type SidecarUniProtBySequenceResult,
} from '../sidecar-client';
import {
  alphaFoldProviderIdentityKeyForHit,
  alphaFoldStructureRefForHit,
  alphaFoldVersionForHit,
  validateAfdbExists,
  type AfdbHit,
} from '../afdb-validate';
import { makeStructureCandidateId, rankStructureCandidates } from '../candidates';
import {
  makeIdentityEvidence,
  type IdentityEvidence,
  type ProteinIdentityLedger,
  type ProteinSequenceIdentity,
  type StructureIdentity,
} from '../protein-identity';
import type {
  ResolverResult,
  ResolverStep,
  StructureCandidate,
  StructureDrawerRequest,
  StructureRef,
} from '../../types/structure-drawer';

export const proteinSequenceStep: ResolverStep = {
  name: 'protein_sequence',
  hintsRequired: [],
  priority: 5,
  async resolve(translation, hints, signal, request) {
    if (!translation) return null;
    if (hasCuratedStructureXref(hints.dbXrefs)) return null;
    const response = await sidecarUniProtBySequence(translation, signal);
    if (response?.queryIdentity) {
      assertSidecarCanonicalizationMatchesRequest(request, response.queryIdentity);
    }
    const hit = response?.topHit;
    if (!hit) return null;
    const queryIdentity = response.queryIdentity;
    const matchEvidence = hit.matchEvidence ?? response.matchEvidence;
    if (!queryIdentity || !matchEvidence) return null;
    const providerProvenance = proteinSequenceProvenance(
      response,
      hit,
      queryIdentity,
      matchEvidence
    );

    if (hit.pdbIds.length > 0) {
      const afdb = await validateOptionalAfdbFallback(hit.accession, signal);
      const pdbInputs = (
        hit.pdbXrefs.length > 0
          ? hit.pdbXrefs
          : hit.pdbIds.map((pdbId) => ({
              pdbId,
              method: undefined,
              resolution: undefined,
              chains: [],
              rawProperties: {},
            }))
      ).map(toPdbCandidateInput);
      const rcsbMetadataByIdentity = await fetchRcsbMetadataForPdbCandidates(pdbInputs, signal);
      const pdbCandidates = pdbInputs.map((input) => {
        const rcsbMetadata = rcsbMetadataByIdentity.get(input.providerIdentityKey);
        const displayChainIds = input.chainIds.length
          ? input.chainIds
          : (rcsbMetadata?.chainIds ?? []);
        return pdbCandidate({
          pdbId: input.pdbId,
          method: rcsbMetadata?.method ?? input.method,
          resolution: rcsbMetadata?.resolution ?? input.resolution,
          chainIds: displayChainIds,
          labelAsymIds: input.labelAsymIds,
          authAsymIds: input.authAsymIds,
          providerIdentityKey: input.providerIdentityKey,
          fallbackAccession: afdb?.accession,
          rcsbMetadata,
          providerProvenance,
        });
      });
      const candidates = afdb
        ? [
            ...pdbCandidates,
            alphaFoldCandidate({
              accession: afdb.accession,
              meanPlddt: afdb.meanPlddt,
              latestVersion: afdb.latestVersion,
              cifUrl: afdb.cifUrl,
              providerIdentityKey: afdb.providerIdentityKey,
              fragment: afdb.fragment,
              modelId: afdb.modelId,
              providerProvenance,
            }),
          ]
        : pdbCandidates;
      const ranked = rankStructureCandidates(candidates);
      const recommended = ranked.candidates[0];
      return withConfirmedProteinIdentity(
        {
          source: 'protein_sequence',
          identity: 1.0,
          structure: recommended.structure,
          recommendedCandidateId: ranked.recommendedCandidateId,
          candidates: ranked.candidates,
          confidenceNote:
            hit.pdbIds.length > 1
              ? `Experimental structure ${recommended.label} · exact protein-sequence match (${hit.pdbIds.length - 1} more available)`
              : `Experimental structure ${recommended.label} · exact protein-sequence match`,
        },
        request,
        response,
        hit,
        queryIdentity,
        matchEvidence,
        afdb
      );
    }

    const afdb = await validateAfdbExists(hit.accession, signal);
    if (!afdb) return null;
    const alphafoldCandidate = alphaFoldCandidate({
      accession: afdb.accession,
      meanPlddt: afdb.meanPlddt,
      latestVersion: afdb.latestVersion,
      cifUrl: afdb.cifUrl,
      providerIdentityKey: afdb.providerIdentityKey,
      fragment: afdb.fragment,
      modelId: afdb.modelId,
      providerProvenance,
    });
    return withConfirmedProteinIdentity(
      {
        source: 'protein_sequence',
        identity: 1.0,
        structure: alphafoldCandidate.structure,
        recommendedCandidateId: alphafoldCandidate.id,
        candidates: [alphafoldCandidate],
        confidenceNote:
          afdb.meanPlddt !== undefined
            ? `Mean pLDDT ${afdb.meanPlddt.toFixed(1)} · exact protein-sequence match (predicted)`
            : 'Exact protein-sequence match (predicted)',
      },
      request,
      response,
      hit,
      queryIdentity,
      matchEvidence,
      afdb
    );
  },
};

function pdbCandidate({
  pdbId,
  method,
  resolution,
  chainIds,
  labelAsymIds,
  authAsymIds,
  providerIdentityKey,
  fallbackAccession,
  rcsbMetadata,
  providerProvenance,
}: {
  pdbId: string;
  method: string | undefined;
  resolution: number | undefined;
  chainIds: string[];
  labelAsymIds: string[] | undefined;
  authAsymIds: string[] | undefined;
  providerIdentityKey: string;
  fallbackAccession: string | undefined;
  rcsbMetadata: SidecarRcsbMetadata | undefined;
  providerProvenance: ProteinSequenceProviderProvenance;
}): StructureCandidate {
  const structure: StructureRef = {
    kind: 'pdb',
    pdbId,
    providerIdentityKey,
    labelAsymIds,
    authAsymIds,
    ...(fallbackAccession ? { uniprotFallback: { accession: fallbackAccession } } : {}),
  };
  return {
    id: makeStructureCandidateId({ provider: 'pdb', externalId: providerIdentityKey }),
    provider: 'pdb',
    structure,
    label: pdbId,
    group: 'rcsb',
    rank: 0,
    metadata: {
      pdbId,
      title: rcsbMetadata?.title,
      method,
      resolution,
      chainCount: rcsbMetadata?.chainCount,
      chainIds: rcsbMetadata?.chainIds?.length ? rcsbMetadata.chainIds : chainIds,
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
      resolverSource: 'protein_sequence',
      identity: 1,
      ...providerProvenance,
      structureIdentity: rcsbStructureProvenance(pdbId, { labelAsymIds, authAsymIds }),
      externalResourceId: rcsbMetadata?.externalResourceId,
      cacheHit: rcsbMetadata?.cacheHit,
    },
  };
}

interface PdbCandidateInput {
  pdbId: string;
  method: string | undefined;
  resolution: number | undefined;
  chainIds: string[];
  labelAsymIds: string[] | undefined;
  authAsymIds: string[] | undefined;
  providerIdentityKey: string;
}

function toPdbCandidateInput(xref: {
  pdbId: string;
  method: string | undefined;
  resolution: number | undefined;
  chains: string[];
}): PdbCandidateInput {
  const pdbId = xref.pdbId.toUpperCase();
  const chainIds = canonicalScopeTokens(xref.chains);
  const authAsymIds = chainIds.length ? chainIds : undefined;
  return {
    pdbId,
    method: xref.method,
    resolution: xref.resolution,
    chainIds,
    labelAsymIds: undefined,
    authAsymIds,
    providerIdentityKey: rcsbProviderIdentityKey(pdbId, { authAsymIds }),
  };
}

async function fetchRcsbMetadataForPdbCandidates(
  inputs: readonly PdbCandidateInput[],
  signal: AbortSignal
): Promise<Map<string, SidecarRcsbMetadata>> {
  const uniqueExternalIds = [...new Set(inputs.map((input) => input.providerIdentityKey))].slice(
    0,
    10
  );
  const metadataByIdentity = new Map<string, SidecarRcsbMetadata>();
  const queue = [...uniqueExternalIds];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length > 0) {
      const externalId = queue.shift();
      if (!externalId) return;
      try {
        const metadata = await sidecarFetchRcsbMetadata(externalId, signal);
        if (metadata) {
          metadataByIdentity.set(externalId, metadata);
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError' || (err as Error).name === 'SidecarAuthError') {
          throw err;
        }
      }
    }
  });
  await Promise.all(workers);
  return metadataByIdentity;
}

function alphaFoldCandidate({
  accession,
  meanPlddt,
  latestVersion,
  cifUrl,
  providerIdentityKey,
  fragment,
  modelId,
  providerProvenance,
}: {
  accession: string;
  meanPlddt: number | undefined;
  latestVersion: number | undefined;
  cifUrl: string | undefined;
  providerIdentityKey: string | undefined;
  fragment: string | undefined;
  modelId: string | undefined;
  providerProvenance: ProteinSequenceProviderProvenance;
}): StructureCandidate {
  const hit: AfdbHit = {
    accession,
    meanPlddt,
    latestVersion,
    cifUrl,
    providerIdentityKey,
    fragment,
    modelId,
  };
  const computedProviderIdentityKey = alphaFoldProviderIdentityKeyForHit(hit);
  return {
    id: makeStructureCandidateId({
      provider: 'alphafold',
      externalId: computedProviderIdentityKey,
    }),
    provider: 'alphafold',
    structure: alphaFoldStructureRefForHit(hit),
    label: accession,
    group: 'alphafold',
    rank: 0,
    metadata: {
      uniprotAccession: accession,
      meanPlddt,
    },
    provenance: {
      resolverSource: 'protein_sequence',
      identity: 1,
      ...providerProvenance,
      structureIdentity: alphaFoldStructureProvenance(hit),
    },
  };
}

type ProteinSequenceProviderProvenance = Pick<
  StructureCandidate['provenance'],
  'sequenceIdentity' | 'externalProtein' | 'queryIdentity'
>;

function proteinSequenceProvenance(
  response: SidecarUniProtBySequenceResult,
  hit: SidecarUniProtBySequenceHit,
  queryIdentity: SidecarQueryIdentity,
  matchEvidence: SidecarMatchEvidence
): ProteinSequenceProviderProvenance {
  return {
    sequenceIdentity: matchEvidence.sequenceIdentity ?? 1,
    externalProtein: {
      kind: 'uniprot',
      accession: hit.accession,
      reviewed: hit.reviewed,
      match: matchEvidenceKind(matchEvidence.kind),
      checksumMd5: matchEvidence.checksumMd5 ?? response.md5,
      rank: matchEvidence.rank,
      rankReasons: matchEvidence.rankReasons,
    },
    queryIdentity: queryIdentityProvenance(queryIdentity),
  };
}

function matchEvidenceKind(
  kind: SidecarMatchEvidence['kind'] | undefined
): NonNullable<StructureCandidate['provenance']['externalProtein']>['match'] {
  if (kind === 'xref' || kind === 'id_mapping' || kind === 'name_search') return kind;
  return 'exact_sequence';
}

function queryIdentityProvenance(
  identity: SidecarQueryIdentity
): NonNullable<StructureCandidate['provenance']['queryIdentity']> {
  return {
    kind: 'protein_sequence',
    canonicalForm: identity.canonicalForm,
    checksumMd5: identity.checksumMd5,
    checksumSha256: identity.checksumSha256,
    ineligible: identity.ineligible,
    evidenceKinds: identity.evidence.map((item) => item.kind),
  };
}

function assertSidecarCanonicalizationMatchesRequest(
  request: StructureDrawerRequest | undefined,
  identity: SidecarQueryIdentity
): void {
  const sequence = request?.proteinIdentity?.sequence;
  if (!sequence) {
    const rendererCanonical = request?.translation
      ? canonicalizeProteinForLegacyWarning(request.translation)
      : undefined;
    if (rendererCanonical && rendererCanonical !== identity.canonicalLookupSequence) {
      warnMissingProteinLedgerOnce();
    }
    return;
  }
  const matches =
    sequence.canonicalLookupSequence === identity.canonicalLookupSequence &&
    sequence.digests.sha256 === identity.checksumSha256;
  if (matches) return;
  if (sidecarIneligibleInternalStopMatchesRenderer(sequence, identity)) return;
  throw Object.assign(
    new Error(
      'Protein canonicalization mismatch: renderer preflight identity does not match sidecar-confirmed identity'
    ),
    { name: 'CanonicalizationMismatchError' }
  );
}

function sidecarIneligibleInternalStopMatchesRenderer(
  sequence: ProteinSequenceIdentity,
  identity: SidecarQueryIdentity
): boolean {
  return (
    identity.ineligible === true &&
    identity.ineligibleReason === 'internal_stop' &&
    identity.canonicalLookupSequence === '' &&
    identity.checksumMd5 === '' &&
    identity.checksumSha256 === '' &&
    identity.normalizedLength === sequence.canonicalLookupSequence.length &&
    sequence.canonicalLookupSequence.includes('*') &&
    identity.evidence.some((item) => item.kind === 'internal_stop' && item.residue === '*')
  );
}

let warnedMissingProteinLedger = false;

function warnMissingProteinLedgerOnce(): void {
  if (warnedMissingProteinLedger) return;
  warnedMissingProteinLedger = true;
  console.warn(
    '[structure-drawer] Protein resolver received sidecar canonicalization evidence without a renderer proteinIdentity ledger.'
  );
}

function canonicalizeProteinForLegacyWarning(sequence: string): string {
  const cleaned = [...sequence]
    .filter((char) => !/\s/u.test(char))
    .join('')
    .toUpperCase();
  return cleaned.endsWith('*') ? cleaned.slice(0, -1) : cleaned;
}

function withConfirmedProteinIdentity(
  result: ResolverResult,
  request: StructureDrawerRequest | undefined,
  response: SidecarUniProtBySequenceResult,
  hit: SidecarUniProtBySequenceHit,
  queryIdentity: SidecarQueryIdentity,
  matchEvidence: SidecarMatchEvidence,
  afdb: AfdbHit | null
): ResolverResult {
  const proteinIdentity = request?.proteinIdentity
    ? confirmProteinIdentityLedger(
        request.proteinIdentity,
        result.candidates ?? [],
        response,
        hit,
        queryIdentity,
        matchEvidence,
        afdb
      )
    : undefined;
  return proteinIdentity ? { ...result, proteinIdentity } : result;
}

function confirmProteinIdentityLedger(
  ledger: ProteinIdentityLedger,
  candidates: readonly StructureCandidate[],
  response: SidecarUniProtBySequenceResult,
  hit: SidecarUniProtBySequenceHit,
  queryIdentity: SidecarQueryIdentity,
  matchEvidence: SidecarMatchEvidence,
  afdb: AfdbHit | null
): ProteinIdentityLedger {
  const exactEvidence = makeIdentityEvidence({
    kind: 'exact_sequence_checksum',
    source: 'uniprot',
    confidence: 'exact',
    label: 'UniProt exact sequence checksum match',
    details: {
      accession: hit.accession,
      checksumMd5: matchEvidence.checksumMd5 ?? response.md5,
      checksumSha256: queryIdentity.checksumSha256,
      sequenceIdentity: matchEvidence.sequenceIdentity ?? 1,
      rank: matchEvidence.rank,
    },
  });
  const validationEvidence = afdb
    ? makeIdentityEvidence({
        kind: 'provider_validation',
        source: 'alphafold',
        confidence: 'strong',
        label: 'AlphaFold structure validation',
        details: { accession: afdb.accession, meanPlddt: afdb.meanPlddt },
      })
    : null;
  const externalProteinId = `uniprot:${hit.accession}`;
  const exactEvidenceIds = [exactEvidence.id];
  const resolutionHits = response.hits.length > 0 ? response.hits : [hit];
  const resolutionExternalProteinIds = new Set(
    resolutionHits.map((resolvedHit) => `uniprot:${resolvedHit.accession}`)
  );

  return {
    ...ledger,
    sequence: {
      ...ledger.sequence,
      canonicalizationStatus: 'sidecar_confirmed',
      canonicalLookupSequence: queryIdentity.canonicalLookupSequence,
      length: queryIdentity.normalizedLength,
      digests: {
        ...ledger.sequence.digests,
        md5: queryIdentity.checksumMd5,
        sha256: queryIdentity.checksumSha256,
      },
      evidenceIds: dedupeIds([...ledger.sequence.evidenceIds, exactEvidence.id]),
    },
    externalProteins: [
      ...ledger.externalProteins.filter((protein) => !resolutionExternalProteinIds.has(protein.id)),
      ...resolutionHits.map((resolvedHit) => {
        const resolvedEvidence = resolvedHit.matchEvidence ?? matchEvidence;
        return {
          kind: 'uniprot' as const,
          id: `uniprot:${resolvedHit.accession}`,
          accession: resolvedHit.accession,
          providerIdentityKey: resolvedHit.accession,
          reviewed: resolvedHit.reviewed,
          match: matchEvidenceKind(resolvedEvidence.kind),
          sequenceIdentity: resolvedEvidence.sequenceIdentity ?? 1,
          checksumMd5: resolvedEvidence.checksumMd5 ?? response.md5,
          rankReasons: resolvedEvidence.rankReasons,
          evidenceIds: exactEvidenceIds,
        };
      }),
    ],
    resolutionSets: [
      ...ledger.resolutionSets,
      {
        kind: 'protein_resolution_set',
        queryMd5: queryIdentity.checksumMd5,
        selectedExternalProteinId: externalProteinId,
        matches: resolutionHits.map((resolvedHit) => {
          const resolvedEvidence = resolvedHit.matchEvidence ?? matchEvidence;
          const id = `uniprot:${resolvedHit.accession}`;
          return {
            id,
            kind: 'uniprot' as const,
            accession: resolvedHit.accession,
            providerIdentityKey: resolvedHit.accession,
            reviewed: resolvedHit.reviewed,
            match: matchEvidenceKind(resolvedEvidence.kind),
            sequenceIdentity: resolvedEvidence.sequenceIdentity ?? 1,
            checksumMd5: resolvedEvidence.checksumMd5 ?? response.md5,
            rank: resolvedEvidence.rank,
            rankReasons: resolvedEvidence.rankReasons,
            selected: id === externalProteinId,
            evidenceIds: exactEvidenceIds,
          };
        }),
        evidenceIds: exactEvidenceIds,
      },
    ],
    structures: mergeStructureIdentities(
      ledger.structures,
      candidates.flatMap((candidate) =>
        structureIdentityForCandidate(candidate, exactEvidenceIds, validationEvidence?.id)
      )
    ),
    evidence: dedupeEvidence([
      ...ledger.evidence,
      exactEvidence,
      ...(validationEvidence ? [validationEvidence] : []),
    ]),
  };
}

function structureIdentityForCandidate(
  candidate: StructureCandidate,
  exactEvidenceIds: string[],
  validationEvidenceId: string | undefined
): StructureIdentity[] {
  if (candidate.provider === 'pdb') {
    const pdbId =
      candidate.metadata.pdbId ??
      (candidate.structure.kind === 'pdb' ? candidate.structure.pdbId : undefined);
    if (!pdbId) return [];
    const structureIdentity = candidate.provenance.structureIdentity;
    const providerIdentityKey =
      structureIdentity?.kind === 'rcsb'
        ? structureIdentity.providerIdentityKey
        : rcsbProviderIdentityKey(pdbId);
    return [
      {
        kind: 'rcsb',
        id: providerIdentityKey,
        pdbId: pdbId.toUpperCase(),
        providerIdentityKey,
        source: 'uniprot_xref',
        sequenceIdentity: 1,
        labelAsymIds:
          structureIdentity?.kind === 'rcsb' ? structureIdentity.labelAsymIds : undefined,
        authAsymIds: structureIdentity?.kind === 'rcsb' ? structureIdentity.authAsymIds : undefined,
        evidenceIds: exactEvidenceIds,
      },
    ];
  }
  const accession =
    candidate.metadata.uniprotAccession ??
    (candidate.structure.kind === 'uniprot' ? candidate.structure.accession : undefined);
  if (!accession) return [];
  const candidateRef = candidate.structure.kind === 'uniprot' ? candidate.structure : undefined;
  const version = candidateRef?.version ?? 'LATEST';
  const modelId = candidateRef?.modelId;
  const providerIdentityKey =
    candidate.provenance.structureIdentity?.kind === 'alphafold'
      ? candidate.provenance.structureIdentity.providerIdentityKey
      : `AF:${accession.toUpperCase()}:F1:${version}`;
  return [
    {
      kind: 'alphafold',
      id: providerIdentityKey,
      accession: accession.toUpperCase(),
      providerIdentityKey,
      fragment: 'F1',
      version,
      modelId,
      source: 'provider_validation',
      meanPlddt: candidate.metadata.meanPlddt,
      evidenceIds: validationEvidenceId
        ? dedupeIds([...exactEvidenceIds, validationEvidenceId])
        : exactEvidenceIds,
    },
  ];
}

function rcsbStructureProvenance(
  pdbId: string,
  scopes: { labelAsymIds?: string[]; authAsymIds?: string[] } = {}
): NonNullable<StructureCandidate['provenance']['structureIdentity']> {
  return {
    kind: 'rcsb',
    providerIdentityKey: rcsbProviderIdentityKey(pdbId, scopes),
    pdbId: pdbId.toUpperCase(),
    labelAsymIds: scopes.labelAsymIds,
    authAsymIds: scopes.authAsymIds,
  };
}

function alphaFoldStructureProvenance(
  hit: AfdbHit
): NonNullable<StructureCandidate['provenance']['structureIdentity']> {
  const structure = alphaFoldStructureRefForHit(hit);
  const version = structure.version ?? alphaFoldVersionForHit(hit);
  return {
    kind: 'alphafold',
    providerIdentityKey: alphaFoldProviderIdentityKeyForHit(hit),
    accession: hit.accession.toUpperCase(),
    fragment: structure.fragment ?? 'F1',
    version,
    modelId: structure.modelId,
  };
}

function rcsbProviderIdentityKey(
  pdbId: string,
  scopes: { labelAsymIds?: string[]; authAsymIds?: string[] } = {}
): string {
  const base = `RCSB:${pdbId.trim().toUpperCase()}:ENTRY`;
  const labelChains = canonicalScopeTokens(scopes.labelAsymIds ?? []);
  const authChains = canonicalScopeTokens(scopes.authAsymIds ?? []);
  const parts = [base];
  if (labelChains.length > 0) parts.push(`LABEL_ASYM:${labelChains.join(',')}`);
  if (authChains.length > 0) parts.push(`AUTH_ASYM:${authChains.join(',')}`);
  return parts.join(':');
}

function dedupeEvidence(items: IdentityEvidence[]): IdentityEvidence[] {
  const byId = new Map<string, IdentityEvidence>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

async function validateOptionalAfdbFallback(
  accession: string,
  signal: AbortSignal
): Promise<AfdbHit | null> {
  try {
    return await validateAfdbExists(accession, signal);
  } catch (err) {
    const name = (err as Error).name;
    if (name === 'AbortError' || name === 'SidecarAuthError') throw err;
    if (name === 'SidecarProviderError') return null;
    throw err;
  }
}

function hasCuratedStructureXref(dbXrefs: readonly string[] | undefined): boolean {
  return (dbXrefs ?? []).some((xref) => /^(?:PDB|PDBe):\s*[0-9][A-Za-z0-9]{3}\s*$/.test(xref));
}

function canonicalScopeTokens(tokens: string[]): string[] {
  return dedupeIds(tokens.map((token) => token.trim()).filter(Boolean)).sort();
}

function mergeStructureIdentities(
  existing: ProteinIdentityLedger['structures'],
  next: StructureIdentity[]
): ProteinIdentityLedger['structures'] {
  const byId = new Map<string, StructureIdentity>();
  for (const item of existing) byId.set(item.id, item);
  for (const item of next) byId.set(item.id, item);
  return [...byId.values()];
}

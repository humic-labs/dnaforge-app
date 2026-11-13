import { serviceManager } from '../../../services/service-manager';
import {
  getResourceByExternalIdExternalResourceByExternalIdGet,
  isApiError,
  postAfdbValidateExternalAlphafoldValidatePost,
  postFetchExternalFetchPost,
  postRcsbSequenceSearchExternalRcsbSequenceSearchPost,
  postUniprotBySequenceExternalUniprotBySequencePost,
  postUniprotSearchExternalUniprotSearchPost,
  type AfdbValidateRequestModel,
  type ExternalResourceModel,
  type FetchRequestModel,
  MatchEvidenceModelKind,
  type MatchEvidenceModel,
  type PdbXrefModel,
  QueryIdentityEvidenceModelKind,
  type QueryIdentityEvidenceModel,
  type QueryIdentityModel,
  type RcsbSequenceSearchHitModel,
  type RcsbSequenceSearchRequestModel,
  type UniProtBySequenceHitModel,
  type UniProtBySequenceRequestModel,
  type UniProtSearchHitModel,
  type UniProtSearchRequestModel,
} from '@waypoint/api-client';

export const RENDERER_DEFAULT_CAPABILITIES: readonly string[] = ['external-fetch:annotation'];

export const RENDERER_XREF_CAPABILITIES: readonly string[] = [
  'external-fetch:annotation',
  'external-fetch:xref-resolution',
];

export const RENDERER_HOMOLOGY_CAPABILITIES: readonly string[] = ['external-fetch:homology-search'];

export interface SidecarUniProtSearchHit {
  accession: string;
  reviewed: boolean;
  sequence?: string;
  taxonId?: number;
  organism?: string;
}

export interface SidecarAfdbValidateResult {
  accession: string;
  meanPlddt: number | undefined;
  latestVersion: number | undefined;
  cifUrl: string | undefined;
  providerIdentityKey: string | undefined;
  fragment: string | undefined;
  modelId: string | undefined;
}

export interface SidecarExternalResourceRow {
  id: string;
  provider: string;
  externalId: string;
  externalUrl: string | null;
  versionIdentifier: string | null;
  etag: string | null;
  fetchedAt: string;
  lastChecked: string;
}

export interface SidecarRcsbMetadata {
  externalResourceId: string;
  cacheHit: boolean;
  pdbId: string;
  title: string | undefined;
  method: string | undefined;
  resolution: number | undefined;
  chainCount: number | undefined;
  chainIds: string[];
  polymerTypes: string[];
  entityDescriptions: string[];
  organism: string | undefined;
  sourceUrl: string | undefined;
  license: string | undefined;
  attribution: string | undefined;
  depositionDate: string | undefined;
  initialReleaseDate: string | undefined;
  revisionDate: string | undefined;
  revisionVersion: string | undefined;
}

export interface SidecarRcsbSequenceHit {
  identifier: string;
  pdbId: string;
  entityId: string | undefined;
  score: number | undefined;
  sequenceIdentity: number | undefined;
  evalue: number | undefined;
  bitScore: number | undefined;
}

type StructureSidecarRoute =
  | '/external/uniprot/search'
  | '/external/uniprot/by-sequence'
  | '/external/fetch'
  | '/external/rcsb/sequence-search'
  | '/external/alphafold/validate'
  | '/external/resource/by-external-id';

function sidecarAuthError(route: StructureSidecarRoute, status: number): Error {
  return Object.assign(new Error(`Structure sidecar rejected ${route}: HTTP ${status}`), {
    name: 'SidecarAuthError',
  });
}

function sidecarProviderError(route: StructureSidecarRoute, detail: string): Error {
  return Object.assign(new Error(`Structure sidecar provider failure ${route}: ${detail}`), {
    name: 'SidecarProviderError',
  });
}

type SidecarResponse = { status: number; data: unknown };
type SuccessData<TResponse> = TResponse extends { status: 200; data: infer TData } ? TData : never;

async function sidecarCall<TResponse extends SidecarResponse>(
  route: StructureSidecarRoute,
  call: () => Promise<TResponse>
): Promise<SuccessData<TResponse> | null> {
  serviceManager.bindExternalLookupClient();
  let response: TResponse;
  try {
    response = await call();
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    if (isApiError(err)) {
      if (err.status === 401 || err.status === 403) throw sidecarAuthError(route, err.status);
      if (err.status === 422) {
        throw sidecarProviderError(route, `request rejected by the sidecar contract (HTTP 422)`);
      }
      if (err.status < 500 && err.status !== 429) return null;
      throw sidecarProviderError(route, `HTTP ${err.status}`);
    }
    throw sidecarProviderError(route, err instanceof Error ? err.message : String(err));
  }
  if (response.status === 204) return null;
  if (response.status !== 200) throw sidecarProviderError(route, `HTTP ${response.status}`);
  return response.data as SuccessData<TResponse>;
}

function hitsOf<THit>(route: StructureSidecarRoute, body: { hits: THit[] } | null): THit[] | null {
  if (body === null) return null;
  if (!Array.isArray(body.hits)) {
    throw sidecarProviderError(route, 'response has no hits list');
  }
  return body.hits;
}

function malformedResponse(what: string): Error {
  return Object.assign(new Error(`Structure sidecar provider failure: response ${what}`), {
    name: 'SidecarProviderError',
  });
}

function expectRecord<T extends object>(value: T | null | undefined, what: string): T {
  if (typeof value !== 'object' || value === null) {
    throw malformedResponse(`${what} is not an object`);
  }
  return value;
}

function expectAccession(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw malformedResponse(`${what} has no accession`);
  }
  return value;
}

function expectKind<TKind extends string>(
  value: unknown,
  allowed: Record<string, TKind>,
  what: string
): TKind {
  if (typeof value !== 'string' || !Object.values(allowed).includes(value as TKind)) {
    throw malformedResponse(`${what} has an unknown kind`);
  }
  return value as TKind;
}

export async function sidecarUniProtSearch(
  query: string,
  signal: AbortSignal,
  opts: { size?: number; workspaceId?: string; includeSequence?: boolean } = {}
): Promise<SidecarUniProtSearchHit | null> {
  const reviewedQuery = `${query} AND reviewed:true`;
  const reviewed = await runUniProtSearchOnce(reviewedQuery, signal, opts);
  if (reviewed.length > 0) return reviewed[0];
  const unreviewedQuery = `${query} AND reviewed:false`;
  const unreviewed = await runUniProtSearchOnce(unreviewedQuery, signal, opts);
  return unreviewed[0] ?? null;
}

export async function sidecarUniProtSearchMany(
  query: string,
  signal: AbortSignal,
  opts: {
    size?: number;
    workspaceId?: string;
    includeSequence?: boolean;
    includeUnreviewedAfterReviewed?: boolean;
  } = {}
): Promise<SidecarUniProtSearchHit[]> {
  const reviewed = await runUniProtSearchOnce(`${query} AND reviewed:true`, signal, opts);
  if (!opts.includeUnreviewedAfterReviewed && reviewed.length > 0) return reviewed;
  const unreviewed = await runUniProtSearchOnce(`${query} AND reviewed:false`, signal, opts);
  const seen = new Set<string>();
  return [...reviewed, ...unreviewed].filter((hit) => {
    if (seen.has(hit.accession)) return false;
    seen.add(hit.accession);
    return true;
  });
}

async function runUniProtSearchOnce(
  query: string,
  signal: AbortSignal,
  opts: { size?: number; workspaceId?: string; includeSequence?: boolean }
): Promise<SidecarUniProtSearchHit[]> {
  const route = '/external/uniprot/search';
  const request: UniProtSearchRequestModel = {
    query,
    size: opts.size ?? 1,
    workspace_id: opts.workspaceId,
    include_sequence: opts.includeSequence === true,
    granted_capabilities: [...RENDERER_DEFAULT_CAPABILITIES],
  };
  const hits = hitsOf(
    route,
    await sidecarCall(route, () => postUniprotSearchExternalUniprotSearchPost(request, { signal }))
  );
  return (hits ?? []).flatMap(toUniProtSearchHit);
}

export interface SidecarUniProtBySequenceHit {
  accession: string;
  reviewed: boolean;
  pdbIds: string[];
  pdbXrefs: SidecarPdbXref[];
  matchEvidence?: SidecarMatchEvidence;
}

export interface SidecarUniProtBySequenceResult {
  accession?: string;
  reviewed?: boolean;
  pdbIds: string[];
  pdbXrefs: SidecarPdbXref[];
  md5: string;
  hits: SidecarUniProtBySequenceHit[];
  topHit?: SidecarUniProtBySequenceHit;
  queryIdentity?: SidecarQueryIdentity;
  matchEvidence?: SidecarMatchEvidence;
}

export interface SidecarQueryIdentity {
  kind: 'protein_sequence';
  normalizedLength: number;
  checksumMd5: string;
  checksumSha256: string;
  canonicalForm: 'waypoint-protein-v2';
  canonicalLookupSequence: string;
  canonicalFormApplied: boolean;
  ineligible: boolean;
  ineligibleReason?: string;
  evidence: SidecarQueryIdentityEvidence[];
}

export interface SidecarQueryIdentityEvidence {
  kind: QueryIdentityEvidenceModel['kind'];
  residue?: string;
}

export interface SidecarMatchEvidence {
  kind: MatchEvidenceModel['kind'];
  checksumMd5?: string;
  sequenceIdentity?: number;
  taxonId?: number;
  organism?: string;
  rank: number;
  rankReasons: string[];
}

export interface SidecarPdbXref {
  pdbId: string;
  method: string | undefined;
  resolution: number | undefined;
  chains: string[];
  rawProperties: Record<string, string>;
}

export async function sidecarUniProtBySequence(
  sequence: string,
  signal: AbortSignal,
  opts: { workspaceId?: string } = {}
): Promise<SidecarUniProtBySequenceResult | null> {
  const route = '/external/uniprot/by-sequence';
  const request: UniProtBySequenceRequestModel = {
    sequence,
    canonical_form_hint: 'waypoint-protein-v2',
    workspace_id: opts.workspaceId,
    granted_capabilities: [...RENDERER_XREF_CAPABILITIES],
  };
  const result = await sidecarCall(route, () =>
    postUniprotBySequenceExternalUniprotBySequencePost(request, { signal })
  );
  const wireHits = hitsOf(route, result);
  if (result === null || wireHits === null) return null;
  const hits = wireHits.flatMap(toBySequenceHit);
  const top = hits[0];
  return {
    accession: top?.accession,
    reviewed: top?.reviewed,
    pdbIds: top?.pdbIds ?? [],
    pdbXrefs: top?.pdbXrefs ?? [],
    md5: result.md5,
    hits,
    topHit: top,
    queryIdentity: toQueryIdentity(result.query_identity),
    matchEvidence: top?.matchEvidence,
  };
}

export async function sidecarFetchRcsbMetadata(
  externalId: string,
  signal: AbortSignal,
  opts: { workspaceId?: string } = {}
): Promise<SidecarRcsbMetadata | null> {
  const request: FetchRequestModel = {
    provider: 'rcsb',
    external_id: externalId,
    workspace_id: opts.workspaceId,
    granted_capabilities: [...RENDERER_DEFAULT_CAPABILITIES],
  };
  const result = await sidecarCall('/external/fetch', () =>
    postFetchExternalFetchPost(request, { signal })
  );
  if (!result || !result.metadata) return null;
  const metadata = result.metadata;
  const canonicalPdbId = stringField(metadata.pdb_id) ?? parsePdbIdFromRcsbExternalId(externalId);
  return {
    externalResourceId: result.external_resource_id,
    cacheHit: !!result.cache_hit,
    pdbId: canonicalPdbId,
    title: stringField(metadata.title),
    method: stringField(metadata.experimental_method),
    resolution: numberField(metadata.resolution),
    chainCount: numberField(metadata.chain_count),
    chainIds: stringArrayField(metadata.chain_ids),
    polymerTypes: polymerTypesField(metadata.chains),
    entityDescriptions: entityDescriptionsField(metadata.chains),
    organism: stringField(metadata.organism),
    sourceUrl: stringField(metadata.provider_url),
    license: result.license ?? undefined,
    attribution: result.attribution ?? undefined,
    depositionDate: stringField(metadata.deposition_date),
    initialReleaseDate: stringField(metadata.initial_release_date),
    revisionDate: stringField(metadata.revision_date),
    revisionVersion: stringField(metadata.revision_version),
  };
}

export async function sidecarRcsbSequenceSearch(
  sequence: string,
  sequenceType: 'rna' | 'dna' | 'protein',
  signal: AbortSignal,
  opts: {
    workspaceId?: string;
    size?: number;
    identityCutoff?: number;
    evalueCutoff?: number;
  } = {}
): Promise<SidecarRcsbSequenceHit[]> {
  const route = '/external/rcsb/sequence-search';
  const request: RcsbSequenceSearchRequestModel = {
    sequence,
    sequence_type: sequenceType,
    size: opts.size ?? 10,
    identity_cutoff: opts.identityCutoff ?? 0.9,
    evalue_cutoff: opts.evalueCutoff ?? 0.1,
    workspace_id: opts.workspaceId,
    granted_capabilities: [...RENDERER_HOMOLOGY_CAPABILITIES],
  };
  const hits = hitsOf(
    route,
    await sidecarCall(route, () =>
      postRcsbSequenceSearchExternalRcsbSequenceSearchPost(request, { signal })
    )
  );
  return (hits ?? []).flatMap(toRcsbSequenceHit);
}

function parsePdbIdFromRcsbExternalId(externalId: string): string {
  const scoped = externalId.match(/^RCSB:([0-9][A-Z0-9]{3}):ENTRY/i);
  return scoped ? scoped[1].toUpperCase() : externalId.toUpperCase();
}

function toRcsbSequenceHit(wire: RcsbSequenceSearchHitModel): SidecarRcsbSequenceHit[] {
  const hit = expectRecord(wire, 'RCSB hit');
  const identifier = stringField(hit.identifier);
  const pdbId = stringField(hit.pdb_id) ?? identifier?.split('_')[0];
  if (!identifier || !pdbId || !/^[0-9][A-Z0-9]{3}$/i.test(pdbId)) return [];
  return [
    {
      identifier,
      pdbId: pdbId.toUpperCase(),
      entityId: stringField(hit.entity_id),
      score: numberField(hit.score),
      sequenceIdentity: numberField(hit.sequence_identity),
      evalue: numberField(hit.evalue),
      bitScore: numberField(hit.bit_score),
    },
  ];
}

function polymerTypesField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item): string[] => {
        if (!item || typeof item !== 'object') return [];
        const polymerType = (item as { polymer_type?: unknown }).polymer_type;
        return typeof polymerType === 'string' && polymerType.length > 0 ? [polymerType] : [];
      })
    ),
  ];
}

function entityDescriptionsField(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item): string[] => {
        if (!item || typeof item !== 'object') return [];
        const description = (item as { description?: unknown }).description;
        return typeof description === 'string' && description.length > 0 ? [description] : [];
      })
    ),
  ];
}

function toPdbXrefs(xrefs: PdbXrefModel[] | undefined): SidecarPdbXref[] {
  return (xrefs ?? []).flatMap((wire): SidecarPdbXref[] => {
    const xref = expectRecord(wire, 'PDB cross-reference');
    if (!xref.pdb_id) return [];
    return [
      {
        pdbId: xref.pdb_id.toUpperCase(),
        method: stringField(xref.method),
        resolution: numberField(xref.resolution),
        chains: stringArrayField(xref.chains),
        rawProperties: { ...(xref.raw_properties ?? {}) },
      },
    ];
  });
}

function toUniProtSearchHit(wire: UniProtSearchHitModel): SidecarUniProtSearchHit[] {
  const hit = expectRecord(wire, 'UniProt hit');
  return [
    {
      accession: expectAccession(hit.accession, 'UniProt hit').toUpperCase(),
      reviewed: hit.reviewed === true,
      sequence: stringField(hit.sequence)?.toUpperCase(),
      taxonId: numberField(hit.taxon_id),
      organism: stringField(hit.organism),
    },
  ];
}

function toBySequenceHit(wire: UniProtBySequenceHitModel): SidecarUniProtBySequenceHit[] {
  const hit = expectRecord(wire, 'UniProt sequence hit');
  return [
    {
      accession: expectAccession(hit.accession, 'UniProt sequence hit').toUpperCase(),
      reviewed: !!hit.reviewed,
      pdbIds: stringArrayField(hit.pdb_ids).map((id) => id.toUpperCase()),
      pdbXrefs: toPdbXrefs(hit.pdb_xrefs),
      matchEvidence: toMatchEvidence(hit.match_evidence),
    },
  ];
}

const TRUSTED_CANONICAL_FORM = 'waypoint-protein-v2';

function toQueryIdentity(
  identity: QueryIdentityModel | undefined
): SidecarQueryIdentity | undefined {
  if (!identity) return undefined;
  if (
    String(identity.kind) !== 'protein_sequence' ||
    String(identity.canonical_form) !== TRUSTED_CANONICAL_FORM
  ) {
    return undefined;
  }
  const ineligible = identity.ineligible === true;
  if (!Number.isFinite(identity.normalized_length) || identity.normalized_length < 0) {
    return undefined;
  }
  if (!ineligible) {
    if (
      identity.normalized_length <= 0 ||
      !/^[0-9A-F]{32}$/i.test(identity.checksum_md5) ||
      !/^[0-9a-f]{64}$/i.test(identity.checksum_sha256)
    ) {
      return undefined;
    }
  }
  return {
    kind: 'protein_sequence',
    normalizedLength: identity.normalized_length,
    checksumMd5: identity.checksum_md5,
    checksumSha256: identity.checksum_sha256,
    canonicalForm: TRUSTED_CANONICAL_FORM,
    canonicalLookupSequence: identity.canonical_lookup_sequence,
    canonicalFormApplied: identity.canonical_form_applied === true,
    ineligible,
    ineligibleReason: stringField(identity.ineligible_reason),
    evidence: (identity.evidence ?? []).map((wire) => {
      const item = expectRecord(wire, 'query identity evidence');
      return {
        kind: expectKind(item.kind, QueryIdentityEvidenceModelKind, 'query identity evidence'),
        residue: stringField(item.residue),
      };
    }),
  };
}

function toMatchEvidence(
  evidence: MatchEvidenceModel | undefined
): SidecarMatchEvidence | undefined {
  if (!evidence || !Number.isFinite(evidence.rank)) return undefined;
  return {
    kind: expectKind(evidence.kind, MatchEvidenceModelKind, 'match evidence'),
    checksumMd5: stringField(evidence.checksum_md5),
    sequenceIdentity: numberField(evidence.sequence_identity),
    taxonId: numberField(evidence.taxon_id),
    organism: stringField(evidence.organism),
    rank: evidence.rank,
    rankReasons: stringArrayField(evidence.rank_reasons),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayField(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

export async function sidecarValidateAfdb(
  accession: string,
  signal: AbortSignal,
  opts: { workspaceId?: string } = {}
): Promise<SidecarAfdbValidateResult | null> {
  const request: AfdbValidateRequestModel = {
    accession,
    workspace_id: opts.workspaceId,
    granted_capabilities: [...RENDERER_DEFAULT_CAPABILITIES],
  };
  const result = await sidecarCall('/external/alphafold/validate', () =>
    postAfdbValidateExternalAlphafoldValidatePost(request, { signal })
  );
  if (!result || !result.exists || !result.accession) return null;
  return {
    accession: result.accession.toUpperCase(),
    meanPlddt: numberField(result.mean_plddt),
    latestVersion: numberField(result.latest_version),
    cifUrl: stringField(result.cif_url),
    providerIdentityKey: stringField(result.provider_identity_key),
    fragment: stringField(result.fragment),
    modelId: stringField(result.model_id),
  };
}

export async function getExternalResourceByExternalId(
  provider: string,
  externalId: string,
  signal: AbortSignal
): Promise<SidecarExternalResourceRow | null> {
  const route = '/external/resource/by-external-id';
  let row: ExternalResourceModel | null;
  try {
    row = await sidecarCall(route, () =>
      getResourceByExternalIdExternalResourceByExternalIdGet(
        { provider, external_id: externalId },
        { signal }
      )
    );
  } catch (err) {
    if ((err as Error).name === 'SidecarProviderError') return null;
    throw err;
  }
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    externalId: row.external_id,
    externalUrl: row.external_url,
    versionIdentifier: row.version_identifier,
    etag: row.etag,
    fetchedAt: row.fetched_at,
    lastChecked: row.last_checked,
  };
}

export interface SidecarFetchUniProtOptions {
  workspaceId?: string;
  bindTo?: {
    sourceKind: 'sequence' | 'feature' | 'project';
    sourceUri: string;
    relationship: string;
    evidence?: 'asserted' | 'inferred' | 'predicted';
  };
}

export interface SidecarFetchUniProtResult {
  externalResourceId: string;
  cacheHit: boolean;
  versionIdentifier: string | null;
  etag: string | null;
  bindingId: string | null;
}

export async function sidecarFetchUniProtEntry(
  accession: string,
  signal: AbortSignal,
  opts: SidecarFetchUniProtOptions = {}
): Promise<SidecarFetchUniProtResult | null> {
  const request: FetchRequestModel = {
    provider: 'uniprot',
    external_id: accession,
    workspace_id: opts.workspaceId,
    granted_capabilities: [...RENDERER_DEFAULT_CAPABILITIES],
  };
  if (opts.bindTo) {
    request.bind_to = {
      source_kind: opts.bindTo.sourceKind,
      source_uri: opts.bindTo.sourceUri,
      relationship: opts.bindTo.relationship,
      evidence: opts.bindTo.evidence ?? 'asserted',
    };
  }
  const result = await sidecarCall('/external/fetch', () =>
    postFetchExternalFetchPost(request, { signal })
  );
  if (!result) return null;
  const row = await getExternalResourceByExternalId('uniprot', accession, signal);
  return {
    externalResourceId: result.external_resource_id,
    cacheHit: result.cache_hit,
    versionIdentifier: row?.versionIdentifier ?? null,
    etag: row?.etag ?? null,
    bindingId: result.binding_id ?? null,
  };
}

import type {
  UcscCatalogAttribute,
  UcscCatalogContainer,
  UcscCatalogLeaf,
  UcscCatalogSignalScale,
} from '@waypoint/genome-data';
import type { BbiRangeGrant } from './bbi-reader-worker-protocol';

import { resolveExternalLookupBaseUrl } from '../../services/sidecar-session';
import { sidecarFetch } from '../../services/sidecar-session';
import { isHostedBrowserRuntime } from '../../utils/environment';

const UCSC_CAPABILITIES = ['external-fetch:annotation'];
export const UCSC_NATIVE_SNAPSHOT_MAX_ITEMS = 1_000_000;

interface UcscRegionWire {
  records?: unknown;
  complete?: unknown;
  items_returned?: unknown;
  max_items_output?: unknown;
  track_type?: unknown;
}

export interface UcscRegionResponse {
  records: ReadonlyArray<Record<string, unknown>>;
  complete: boolean;
  itemsReturned: number;
  maxItemsOutput: number;
  trackType?: string;
}

interface UcscTrackAdmissionWire {
  source_uri?: unknown;
  source_token?: unknown;
  canonical_url_hash?: unknown;
  representation_sha256?: unknown;
  representation_identity_kind?: unknown;
  byte_length?: unknown;
  format?: unknown;
  etag?: unknown;
  last_modified?: unknown;
  expires_in_seconds?: unknown;
  provenance_id?: unknown;
}

export interface UcscBbiRangeGrant extends BbiRangeGrant {
  readonly representationSha256: string;
  readonly representationIdentityKind: 'strong-etag' | 'content-sha256';
}

export class UcscTrackRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly remoteStatusCode: number | null;

  constructor(
    message: string,
    options: {
      readonly code: string;
      readonly retryable: boolean;
      readonly remoteStatusCode?: number | null;
    }
  ) {
    super(message);
    this.name = 'UcscTrackRequestError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.remoteStatusCode = options.remoteStatusCode ?? null;
  }
}

export async function searchUcscTracks(
  input: { genome: string; query: string; limit?: number; hubUrl?: string },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<ReadonlyArray<UcscCatalogLeaf>> {
  const response = await postUcsc(
    '/external/ucsc/tracks/search',
    {
      genome: input.genome,
      query: input.query,
      limit: input.limit ?? 50,
      hub_url: input.hubUrl,
      granted_capabilities: UCSC_CAPABILITIES,
    },
    options
  );
  const body = (await response.json()) as { tracks?: unknown };
  if (!Array.isArray(body.tracks)) throw new Error('UCSC search returned an invalid track list.');
  return body.tracks.map((raw) => normalizeCatalogLeaf(input.genome, raw));
}

export interface UcscCatalogSnapshot {
  readonly genome: string;
  readonly hubUrl?: string;
  readonly tracks: ReadonlyArray<UcscCatalogLeaf>;
}

export async function fetchUcscCatalog(
  input: { genome: string; hubUrl?: string },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<UcscCatalogSnapshot> {
  const response = await postUcsc(
    '/external/ucsc/tracks/catalog',
    {
      genome: input.genome,
      hub_url: input.hubUrl,
      granted_capabilities: UCSC_CAPABILITIES,
    },
    options
  );
  const body = (await response.json()) as { tracks?: unknown; total?: unknown };
  if (!Array.isArray(body.tracks)) throw new Error('UCSC catalog returned an invalid track list.');
  return {
    genome: input.genome,
    ...(input.hubUrl ? { hubUrl: input.hubUrl } : {}),
    tracks: body.tracks.map((raw) => normalizeCatalogLeaf(input.genome, raw)),
  };
}

export async function fetchUcscTrackRegion(
  input: {
    genome: string;
    track: string;
    chrom: string;
    start: number;
    end: number;
    maxItemsOutput?: number;
    hubUrl?: string;
  },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<UcscRegionResponse> {
  return fetchUcscTrackData(
    {
      genome: input.genome,
      track: input.track,
      chrom: input.chrom,
      start: input.start,
      end: input.end,
      maxItemsOutput: input.maxItemsOutput ?? 10_000,
      hubUrl: input.hubUrl,
    },
    options
  );
}

export async function fetchUcscWholeTrack(
  input: { genome: string; track: string; hubUrl?: string; maxItemsOutput?: number },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<UcscRegionResponse> {
  return fetchUcscTrackData(
    {
      genome: input.genome,
      track: input.track,
      maxItemsOutput: input.maxItemsOutput ?? 100_000,
      hubUrl: input.hubUrl,
    },
    options
  );
}

async function fetchUcscTrackData(
  input: {
    genome: string;
    track: string;
    chrom?: string;
    start?: number;
    end?: number;
    maxItemsOutput: number;
    hubUrl?: string;
  },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<UcscRegionResponse> {
  const response = await postUcsc(
    '/external/ucsc/tracks/region',
    {
      genome: input.genome,
      track: input.track,
      chrom: input.chrom,
      start: input.start,
      end: input.end,
      max_items_output: input.maxItemsOutput,
      hub_url: input.hubUrl,
      granted_capabilities: UCSC_CAPABILITIES,
    },
    options
  );
  const body = (await response.json()) as UcscRegionWire;
  if (!Array.isArray(body.records)) throw new Error('UCSC region returned invalid records.');
  return {
    records: body.records.filter(isRecord),
    complete: body.complete === true,
    itemsReturned: finiteNumber(body.items_returned, body.records.length),
    maxItemsOutput: finiteNumber(body.max_items_output, 10_000),
    trackType: optionalString(body.track_type),
  };
}

export async function admitUcscTrack(
  input: {
    genome: string;
    track: string;
    formatId: 'bigwig' | 'bigbed';
    probeChrom: string;
    hubUrl?: string;
  },
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<UcscBbiRangeGrant> {
  const response = await postUcsc(
    '/external/ucsc/tracks/admit',
    {
      genome: input.genome,
      track: input.track,
      format_id: input.formatId,
      probe_chrom: input.probeChrom,
      hub_url: input.hubUrl,
      granted_capabilities: UCSC_CAPABILITIES,
    },
    options
  );
  const body = (await response.json()) as UcscTrackAdmissionWire;
  const sourceUri = requiredString(body.source_uri, 'source_uri');
  const sourceToken = requiredString(body.source_token, 'source_token');
  const canonicalUrlHash = requiredString(body.canonical_url_hash, 'canonical_url_hash');
  const representationSha256 = requiredString(body.representation_sha256, 'representation_sha256');
  const representationIdentityKind = requiredString(
    body.representation_identity_kind,
    'representation_identity_kind'
  );
  const byteLength = finiteNumber(body.byte_length, -1);
  const format = requiredString(body.format, 'format');
  const expiresInSeconds = finiteNumber(body.expires_in_seconds, -1);
  const provenanceId = requiredString(body.provenance_id, 'provenance_id');
  const etag = optionalString(body.etag);
  const lastModified = optionalString(body.last_modified);
  if (
    format !== input.formatId ||
    byteLength < 1 ||
    expiresInSeconds <= 0 ||
    !/^[0-9a-f]{64}$/u.test(representationSha256) ||
    (representationIdentityKind !== 'strong-etag' &&
      representationIdentityKind !== 'content-sha256')
  ) {
    throw new Error('UCSC admission returned invalid indexed-source metadata.');
  }
  return {
    baseUrl: (await resolveExternalLookupBaseUrl('ucsc-tracks')).replace(/\/+$/, ''),
    ...(isHostedBrowserRuntime() ? { maxRangeBytes: 4_000_000 } : {}),
    sourceUri,
    sourceToken,
    canonicalUrlHash,
    representationSha256,
    representationIdentityKind,
    byteLength,
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    provenanceId,
    expiresAtMs: Date.now() + expiresInSeconds * 1_000,
  };
}

export interface UcscHubGenome {
  readonly name: string;
  readonly organism?: string;
  readonly description?: string;
  readonly assemblyHub: boolean;
  readonly twoBitPath?: string;
}

export const UCSC_GENARK_HUB_ORIGIN = 'https://hgdownload.soe.ucsc.edu/hubs/';

export interface UcscGenArkGenome {
  readonly accession: string;
  readonly hubUrl: string;
  readonly scientificName?: string;
  readonly commonName?: string;
  readonly description?: string;
  readonly assemblyName?: string;
  readonly taxId?: number;
}

const GENARK_ACCESSION = /^GC[AF]_\d+\.\d+$/u;

export function genArkHubUrl(raw: string): string {
  const clean = raw.trim();
  if (/^https?:\/\//iu.test(clean)) return clean;
  const relative = clean.replace(/^\/?gbdb\/genark\//u, '').replace(/^\/+/u, '');
  return new URL(relative, UCSC_GENARK_HUB_ORIGIN).href;
}

const FIND_GENOME_METADATA_KEYS = new Set([
  'browser',
  'datatime',
  'downloadtime',
  'itemcount',
  'itemsreturned',
  'maxitemsoutput',
  'q',
  'statsonly',
  'totalmatchcount',
]);

export async function findUcscGenomes(
  query: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<ReadonlyArray<UcscGenArkGenome>> {
  const response = await postUcsc(
    '/external/ucsc/api/findGenome',
    { q: query.trim(), granted_capabilities: UCSC_CAPABILITIES },
    options
  );
  const body = (await response.json()) as { data?: unknown };
  if (!isRecord(body.data)) throw new Error('UCSC returned an invalid genome search result.');
  const genomes: UcscGenArkGenome[] = [];
  for (const [accession, value] of Object.entries(body.data)) {
    if (FIND_GENOME_METADATA_KEYS.has(accession.toLowerCase()) || !isRecord(value)) continue;
    const hubUrl = optionalString(value.hubUrl);
    if (!hubUrl || !GENARK_ACCESSION.test(accession)) continue;
    genomes.push({
      accession,
      hubUrl: genArkHubUrl(hubUrl),
      ...(optionalString(value.scientificName)
        ? { scientificName: optionalString(value.scientificName) }
        : {}),
      ...(optionalString(value.commonName) ? { commonName: optionalString(value.commonName) } : {}),
      ...(optionalString(value.description)
        ? { description: optionalString(value.description) }
        : {}),
    });
  }
  return genomes;
}

export async function describeUcscGenArkGenome(
  accession: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<UcscGenArkGenome> {
  const clean = accession.trim();
  const response = await postUcsc(
    '/external/ucsc/api/list/genarkGenomes',
    { genome: clean, granted_capabilities: UCSC_CAPABILITIES },
    options
  );
  const body = (await response.json()) as { data?: unknown };
  const listing =
    isRecord(body.data) && isRecord(body.data.genarkGenomes) ? body.data.genarkGenomes : null;
  const entry = listing?.[clean];
  if (!isRecord(entry)) throw new Error(`UCSC GenArk does not list ${clean}.`);
  const hubUrl = optionalString(entry.hubUrl);
  if (!hubUrl) throw new Error(`UCSC GenArk lists ${clean} without a hub address.`);
  const taxId = entry.taxId;
  return {
    accession: clean,
    hubUrl: genArkHubUrl(hubUrl),
    ...(optionalString(entry.asmName) ? { assemblyName: optionalString(entry.asmName) } : {}),
    ...(optionalString(entry.scientificName)
      ? { scientificName: optionalString(entry.scientificName) }
      : {}),
    ...(optionalString(entry.commonName) ? { commonName: optionalString(entry.commonName) } : {}),
    ...(typeof taxId === 'number' && Number.isSafeInteger(taxId) && taxId > 0 ? { taxId } : {}),
  };
}

export interface UcscHubDescription {
  readonly hubUrl: string;
  readonly genomes: ReadonlyArray<UcscHubGenome>;
}

export interface UcscPublicHub {
  readonly hubUrl: string;
  readonly shortLabel: string;
  readonly longLabel: string;
  readonly genomes: ReadonlyArray<string>;
}

const HUB_METADATA_KEYS = new Set([
  'datatime',
  'downloadtime',
  'genomes',
  'huburl',
  'itemsreturned',
]);

export async function inspectUcscHub(
  hubUrl: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<UcscHubDescription> {
  const response = await postUcsc(
    '/external/ucsc/api/list/hubGenomes',
    { hub_url: hubUrl.trim(), granted_capabilities: UCSC_CAPABILITIES },
    options
  );
  const body = (await response.json()) as { data?: unknown };
  const data = body.data;
  if (!isRecord(data)) throw new Error('UCSC returned an invalid hub description.');
  const nested = isRecord(data.genomes) ? data.genomes : null;
  const genomes: UcscHubGenome[] = [];
  for (const [name, value] of Object.entries(nested ?? data)) {
    if (!isRecord(value)) continue;
    if (nested === null) {
      if (HUB_METADATA_KEYS.has(name.toLowerCase())) continue;
      if (
        !(
          'trackDbFile' in value ||
          'organism' in value ||
          'description' in value ||
          'twoBitPath' in value
        )
      ) {
        continue;
      }
    }
    const cleanName = name.trim();
    if (!cleanName) continue;
    const twoBitPath = optionalString(value.twoBitPath);
    genomes.push({
      name: cleanName,
      ...(optionalString(value.organism) ? { organism: optionalString(value.organism) } : {}),
      ...(optionalString(value.description)
        ? { description: optionalString(value.description) }
        : {}),
      assemblyHub: Boolean(twoBitPath),
      ...(twoBitPath ? { twoBitPath } : {}),
    });
  }
  if (genomes.length === 0) throw new Error('UCSC returned no assemblies for this track hub.');
  genomes.sort((left, right) => left.name.localeCompare(right.name));
  return { hubUrl: optionalString(data.hubUrl) ?? hubUrl.trim(), genomes };
}

export async function listUcscPublicHubs(
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}
): Promise<ReadonlyArray<UcscPublicHub>> {
  const response = await postUcsc(
    '/external/ucsc/api/list/publicHubs',
    { granted_capabilities: UCSC_CAPABILITIES },
    options
  );
  const body = (await response.json()) as { data?: unknown };
  const raw = isRecord(body.data) ? body.data.publicHubs : undefined;
  if (!Array.isArray(raw)) throw new Error('UCSC returned an invalid public hub list.');
  const hubs: UcscPublicHub[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const hubUrl = optionalString(entry.hubUrl);
    if (!hubUrl) continue;
    hubs.push({
      hubUrl,
      shortLabel: optionalString(entry.shortLabel) ?? hubUrl,
      longLabel: optionalString(entry.longLabel) ?? '',
      genomes: (optionalString(entry.dbList) ?? '')
        .split(',')
        .map((genome) => genome.trim())
        .filter(Boolean),
    });
  }
  return hubs;
}

async function postUcsc(
  path: string,
  body: Record<string, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch }
): Promise<Response> {
  const baseUrl = (await resolveExternalLookupBaseUrl('ucsc-tracks')).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await sidecarFetch(
      `${baseUrl}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: options.signal,
      },
      fetchImpl
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new UcscTrackRequestError(
      `Could not reach UCSC through the compute service: ${(error as Error).message}`,
      { code: 'compute_service_unreachable', retryable: true }
    );
  }
  if (response.ok) return response;
  let message = '';
  let code = `http_${response.status}`;
  let retryable = isRetryableHttpStatus(response.status);
  let remoteStatusCode: number | null = null;
  try {
    const parsed = (await response.json()) as { detail?: unknown };
    const detail = parsed.detail;
    if (detail && typeof detail === 'object') {
      const structured = detail as Record<string, unknown>;
      message = typeof structured.message === 'string' ? structured.message : '';
      code =
        typeof structured.failure_kind === 'string'
          ? structured.failure_kind
          : typeof structured.error === 'string'
            ? structured.error
            : code;
      retryable = typeof structured.retryable === 'boolean' ? structured.retryable : retryable;
      remoteStatusCode =
        typeof structured.status_code === 'number' && Number.isFinite(structured.status_code)
          ? structured.status_code
          : null;
    } else if (typeof detail === 'string') {
      message = detail;
    }
  } catch {}
  throw new UcscTrackRequestError(message || `UCSC request failed (HTTP ${response.status}).`, {
    code,
    retryable,
    remoteStatusCode,
  });
}

function isRetryableHttpStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function normalizeCatalogLeaf(genome: string, raw: unknown): UcscCatalogLeaf {
  if (!isRecord(raw)) throw new Error('UCSC search returned an invalid track entry.');
  const track = requiredString(raw.track, 'track');
  const scientificKind = requiredString(raw.scientific_kind, 'scientific_kind');
  const formatId = requiredString(raw.format_id, 'format_id');
  const sourceKind = requiredString(raw.source_kind, 'source_kind');
  if (
    ![
      'transcript',
      'interval',
      'quantitative',
      'peak',
      'repeat',
      'reads',
      'variants',
      'unsupported',
    ].includes(scientificKind)
  ) {
    throw new Error(`UCSC track ${track} has unsupported scientific kind ${scientificKind}.`);
  }
  if (!['ucsc-native', 'bigbed', 'bigwig', 'bam', 'vcf'].includes(formatId)) {
    throw new Error(`UCSC track ${track} has unsupported format ${formatId}.`);
  }
  if (!['ucsc-native', 'ucsc-hub'].includes(sourceKind)) {
    throw new Error(`UCSC track ${track} has unsupported source ${sourceKind}.`);
  }
  const hubUrl = optionalString(raw.hub_url);
  if (sourceKind === 'ucsc-hub' && !hubUrl) {
    throw new Error(`UCSC hub track ${track} is missing its hub URL.`);
  }
  return {
    sourceKind: sourceKind as UcscCatalogLeaf['sourceKind'],
    catalogId: [sourceKind, genome, track, hubUrl ?? ''].join('\u0000'),
    track,
    shortLabel: requiredString(raw.short_label, 'short_label'),
    longLabel: requiredString(raw.long_label, 'long_label'),
    scientificKind: scientificKind as UcscCatalogLeaf['scientificKind'],
    formatId: formatId as UcscCatalogLeaf['formatId'],
    assembly: { ucscGenome: genome, aliases: [genome] },
    hubUrl,
    bigDataUrl: optionalString(raw.big_data_url),
    bigDataIndex: optionalString(raw.big_data_index),
    type: optionalString(raw.track_type),
    group: optionalString(raw.group),
    parentTrack: optionalString(raw.parent_track),
    parentParentTrack: optionalString(raw.parent_parent_track),
    catalogColor: optionalString(raw.catalog_color),
    experimentAccession: optionalString(raw.experiment_accession),
    fileAccession: optionalString(raw.file_accession),
    containerPath: normalizeContainerPath(raw.container_path),
    attributes: normalizeAttributes(raw.attributes),
    ...(normalizeSignalScale(raw.signal_scale)
      ? { signalScale: normalizeSignalScale(raw.signal_scale)! }
      : {}),
  };
}

function normalizeAttributes(value: unknown): ReadonlyArray<UcscCatalogAttribute> {
  if (!Array.isArray(value)) return [];
  const attributes: UcscCatalogAttribute[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const key = optionalString(entry.key);
    const declared = optionalString(entry.value);
    if (!key || !declared) continue;
    const origin = entry.origin === 'metadata' ? 'metadata' : 'subgroup';
    attributes.push({ key, value: declared, origin });
  }
  return attributes;
}

function normalizeSignalScale(value: unknown): UcscCatalogSignalScale | undefined {
  if (!isRecord(value)) return undefined;
  const minimum = finiteOrUndefined(value.minimum);
  const maximum = finiteOrUndefined(value.maximum);
  const bounded = minimum !== undefined && maximum !== undefined && maximum > minimum;
  return {
    auto: value.auto === true,
    alwaysZero: value.always_zero === true,
    ...(bounded ? { minimum, maximum } : {}),
  };
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const CONTAINER_KINDS: ReadonlyArray<UcscCatalogContainer['kind']> = [
  'composite',
  'super',
  'view',
  'container',
];

function normalizeContainerPath(value: unknown): ReadonlyArray<UcscCatalogContainer> {
  if (!Array.isArray(value)) return [];
  const path: UcscCatalogContainer[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const track = optionalString(entry.track);
    const shortLabel = optionalString(entry.short_label);
    if (!track || !shortLabel) continue;
    const rawKind = optionalString(entry.kind);
    const kind = CONTAINER_KINDS.find((candidate) => candidate === rawKind) ?? 'container';
    const longLabel = optionalString(entry.long_label);
    path.push({ track, shortLabel, kind, ...(longLabel ? { longLabel } : {}) });
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`UCSC response is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

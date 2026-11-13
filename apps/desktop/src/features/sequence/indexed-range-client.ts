import type { LocalAuthorityContext } from '../../shared/local-indexed-track-authority';
import { platform } from '../../platform';
import { sha256Hex } from '../../shared/sha256-sync';
import {
  rendererSidecarRequestAuthorityState,
  resolveSidecarBaseUrl,
  sidecarFetch,
} from '../../services/sidecar-session';

const INDEXED_RANGE_CAPABILITIES = ['external-fetch:annotation'];

export type IndexedRangeFormat =
  | 'bigwig'
  | 'bigbed'
  | 'bam'
  | 'cram'
  | 'bai'
  | 'crai'
  | 'csi'
  | 'vcf'
  | 'bcf'
  | 'tbi';

export { indexedRangeSourceFromTrackLocator } from '../../shared/genome/indexed-range-source';
import type { IndexedRangeSourceInput } from '../../shared/genome/indexed-range-source';
export type { IndexedRangeSourceInput } from '../../shared/genome/indexed-range-source';

export interface IndexedRangeGrant {
  readonly baseUrl: string;
  readonly sourceUri: string;
  readonly sourceToken: string;
  readonly canonicalUrlHash: string;
  readonly format: IndexedRangeFormat;
  readonly byteLength: number;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly provenanceId: string;
  readonly expiresAtMs: number;
}

interface IndexedRangeAdmissionWire {
  source_uri?: unknown;
  source_token?: unknown;
  canonical_url_hash?: unknown;
  byte_length?: unknown;
  format?: unknown;
  etag?: unknown;
  last_modified?: unknown;
  expires_in_seconds?: unknown;
  provenance_id?: unknown;
}

interface IndexedRangeMaterializationWire {
  source_path?: unknown;
  representation_sha256?: unknown;
  canonical_url_hash?: unknown;
  format?: unknown;
  byte_length?: unknown;
  expires_in_seconds?: unknown;
}

export interface IndexedRangeMaterialization {
  readonly sourcePath: string;
  readonly representationSha256: string;
  readonly expiresAtMs: number;
}

export async function admitIndexedRangeSource(
  input: {
    readonly source: IndexedRangeSourceInput;
    readonly formatId: IndexedRangeFormat;
    readonly provenanceId: string;
  },
  options: {
    readonly signal?: AbortSignal;
    readonly fetchImpl?: typeof fetch;
    readonly localAuthorityContext?: LocalAuthorityContext;
  } = {}
): Promise<IndexedRangeGrant> {
  const baseUrl = (await resolveSidecarBaseUrl('indexed-ranges')).replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  if (input.source.kind === 'path') await waitForLocalTrackAuthority(options.signal);
  if (input.source.kind !== 'path' && input.source.authRef) {
    await platform().genomeCredentials.prepare(input.source.authRef);
  }
  const localAuthority =
    input.source.kind === 'path'
      ? await platform().dialog.authorizeLocalIndexedTrack({
          path: input.source.path,
          ...(options.localAuthorityContext === 'dev-scenario-fixture'
            ? { devScenarioFixture: true }
            : {}),
          ...(options.localAuthorityContext === 'workspace-grounded'
            ? { workspaceGrounded: true }
            : {}),
        })
      : null;
  let response: Response;
  try {
    response = await sidecarFetch(
      `${baseUrl}/external/indexed-tracks/admit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...indexedRangeSourceWire(input.source, localAuthority?.canonicalPath),
          ...(localAuthority ? { local_path_authority: localAuthority.authority } : {}),
          format_id: input.formatId,
          provenance_id:
            input.provenanceId.length <= 500
              ? input.provenanceId
              : `indexed-source:${sha256Hex(input.provenanceId)}`,
          granted_capabilities: INDEXED_RANGE_CAPABILITIES,
        }),
        signal: options.signal,
      },
      fetchImpl
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new Error(`Could not reach the indexed-data service: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(
        (await responseMessage(response)) ||
          `Indexed source admission failed (HTTP ${response.status}).`
      ),
      { retryable: response.status === 408 || response.status === 429 || response.status >= 500 }
    );
  }

  const body = (await response.json()) as IndexedRangeAdmissionWire;
  const sourceUri = requiredString(body.source_uri, 'source_uri');
  const sourceToken = requiredString(body.source_token, 'source_token');
  const canonicalUrlHash = requiredString(body.canonical_url_hash, 'canonical_url_hash');
  const byteLength = finiteNumber(body.byte_length, -1);
  const format = requiredString(body.format, 'format');
  const expiresInSeconds = finiteNumber(body.expires_in_seconds, -1);
  const provenanceId = requiredString(body.provenance_id, 'provenance_id');
  const etag = optionalString(body.etag);
  const lastModified = optionalString(body.last_modified);
  if (format !== input.formatId || byteLength < 1 || expiresInSeconds <= 0) {
    throw new Error('Indexed source admission returned invalid metadata.');
  }
  return {
    baseUrl,
    sourceUri,
    sourceToken,
    canonicalUrlHash,
    format: input.formatId,
    byteLength,
    ...(etag ? { etag } : {}),
    ...(lastModified ? { lastModified } : {}),
    provenanceId,
    expiresAtMs: Date.now() + expiresInSeconds * 1_000,
  };
}

function indexedRangeSourceWire(
  source: IndexedRangeSourceInput,
  canonicalLocalPath?: string
): Readonly<Record<string, unknown>> {
  switch (source.kind) {
    case 'path':
      return { source_kind: 'path', source: canonicalLocalPath ?? source.path };
    case 'url':
      return {
        source_kind: 'url',
        source: source.url,
        ...(source.authRef ? { auth_ref: source.authRef } : {}),
      };
    case 's3':
      return {
        source_kind: 's3',
        bucket: source.bucket,
        object_key: source.key,
        ...(source.region ? { region: source.region } : {}),
        ...(source.requesterPays ? { requester_pays: true } : {}),
        ...(source.authRef ? { auth_ref: source.authRef } : {}),
      };
    case 'gcs':
      return {
        source_kind: 'gcs',
        bucket: source.bucket,
        object_key: source.object,
        ...(source.billingProject ? { billing_project: source.billingProject } : {}),
        ...(source.authRef ? { auth_ref: source.authRef } : {}),
      };
  }
}

export function indexedRangeSourceResourceName(
  source: IndexedRangeSourceInput,
  fallbackFormat: IndexedRangeFormat
): string {
  const locator =
    source.kind === 'path'
      ? source.path
      : source.kind === 'url'
        ? new URL(source.url).pathname
        : source.kind === 's3'
          ? source.key
          : source.object;
  return basename(locator) || `source.${fallbackFormat}`;
}

export function nativeRangeProxyUrl(grant: IndexedRangeGrant, resourceName: string): string {
  const suffix = `.${grant.format}`;
  const cleanName = basename(resourceName);
  if (!cleanName.toLowerCase().endsWith(suffix)) {
    throw new Error(`Native ${grant.format.toUpperCase()} proxy names must end in ${suffix}.`);
  }
  const proxy = new URL(grant.baseUrl);
  if (
    proxy.protocol !== 'http:' ||
    (proxy.hostname !== '127.0.0.1' && proxy.hostname !== 'localhost' && proxy.hostname !== '[::1]')
  ) {
    throw new Error('Native indexed-data proxy credentials require a loopback HTTP endpoint.');
  }
  proxy.username = 'dnaforge-source';
  proxy.password = grant.sourceToken;
  proxy.pathname = `/external/range-proxy/source${suffix}`;
  proxy.search = '';
  proxy.hash = '';
  return proxy.toString();
}

export async function materializeIndexedRangeSource(
  grant: IndexedRangeGrant,
  options: {
    readonly signal?: AbortSignal;
    readonly fetchImpl?: typeof fetch;
  } = {}
): Promise<IndexedRangeMaterialization> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await sidecarFetch(
      `${grant.baseUrl}/external/indexed-tracks/materialize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_token: grant.sourceToken }),
        signal: options.signal,
      },
      fetchImpl
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new Error(`Could not materialize the remote index: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(
      (await responseMessage(response)) ||
        `Remote index materialization failed (HTTP ${response.status}).`
    );
  }
  const body = (await response.json()) as IndexedRangeMaterializationWire;
  const sourcePath = requiredString(body.source_path, 'source_path');
  const representationSha256 = requiredString(body.representation_sha256, 'representation_sha256');
  const canonicalUrlHash = requiredString(body.canonical_url_hash, 'canonical_url_hash');
  const format = requiredString(body.format, 'format');
  const byteLength = finiteNumber(body.byte_length, -1);
  const expiresInSeconds = finiteNumber(body.expires_in_seconds, -1);
  if (
    !/^[a-f0-9]{64}$/u.test(representationSha256) ||
    canonicalUrlHash !== grant.canonicalUrlHash ||
    format !== grant.format ||
    byteLength !== grant.byteLength ||
    expiresInSeconds <= 0
  ) {
    throw new Error('Remote index materialization returned inconsistent metadata.');
  }
  return {
    sourcePath,
    representationSha256,
    expiresAtMs: Math.min(grant.expiresAtMs, Date.now() + expiresInSeconds * 1_000),
  };
}

async function waitForLocalTrackAuthority(signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 15_000;
  let state = await rendererSidecarRequestAuthorityState();
  while (state === 'pending') {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (Date.now() >= deadline) {
      throw new Error('The indexed-data service is still starting. Try the track again.');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    state = await rendererSidecarRequestAuthorityState();
  }
}

async function responseMessage(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { detail?: unknown };
    const detail = parsed.detail;
    if (typeof detail === 'string') return detail;
    if (
      detail &&
      typeof detail === 'object' &&
      typeof (detail as { message?: unknown }).message === 'string'
    ) {
      return (detail as { message: string }).message;
    }
  } catch {}
  return '';
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Indexed source response is missing ${field}.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function basename(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  const name = withoutQuery.split(/[\\/]/u).filter(Boolean).pop();
  if (!name) throw new Error('A native range proxy requires a resource filename.');
  return name;
}

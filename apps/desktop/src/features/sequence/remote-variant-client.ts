import { resolveSidecarBaseUrl, sidecarFetch } from '../../services/sidecar-session';
import type { IndexedRangeGrant } from './indexed-range-client';
import {
  isVariantPagePayload,
  isVariantRegionPayload,
  MAX_VARIANT_REGION_SIZE,
  VariantRequestError,
  type VariantPage,
  type VariantReferenceIdentity,
  type VariantRegion,
  validateRegionRequest,
} from './variant-client';

const REMOTE_VARIANT_TIMEOUT_MS = 30_000;
const MAX_PAGE_SIZE = 200;

export interface RemoteVariantRuntime {
  readonly format: 'vcf' | 'bcf';
  readonly sourceToken: string;
  readonly indexToken: string;
  readonly sourceIdentity: string;
  readonly assemblyRevision: string;
  readonly matchedReferences: ReadonlyArray<string>;
  readonly samples: ReadonlyArray<string>;
  readonly grantExpiresAtMs: number;
}

interface RemoteVariantPreparationWire {
  readonly format?: unknown;
  readonly source_identity?: unknown;
  readonly assembly_revision?: unknown;
  readonly matched_references?: unknown;
  readonly samples?: unknown;
  readonly expires_in_seconds?: unknown;
}

export async function prepareRemoteVariantRuntime(
  input: {
    readonly sourceGrant: IndexedRangeGrant;
    readonly indexGrant: IndexedRangeGrant;
    readonly references: ReadonlyArray<VariantReferenceIdentity>;
  },
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {}
): Promise<RemoteVariantRuntime> {
  if (input.sourceGrant.baseUrl !== input.indexGrant.baseUrl) {
    throw new Error('Remote variant source and index grants came from different sidecars.');
  }
  const body = await postRemoteVariantJson(
    `${input.sourceGrant.baseUrl}/external/indexed-variants/prepare`,
    {
      source_token: input.sourceGrant.sourceToken,
      index_token: input.indexGrant.sourceToken,
      references: input.references.map((reference) => ({ ...reference })),
    },
    options
  );
  const wire = body as RemoteVariantPreparationWire;
  const format = wire.format;
  const sourceIdentity = requiredPattern(
    wire.source_identity,
    /^[0-9a-f]{64}$/u,
    'source_identity'
  );
  const assemblyRevision = requiredPattern(
    wire.assembly_revision,
    /^variant-assembly-v1:sha256:[0-9a-f]{64}$/u,
    'assembly_revision'
  );
  const matchedReferences = stringArray(wire.matched_references, true, 'matched_references');
  const samples = stringArray(wire.samples, false, 'samples');
  const expiresInSeconds = finitePositiveNumber(wire.expires_in_seconds, 'expires_in_seconds');
  if (format !== input.sourceGrant.format || (format !== 'vcf' && format !== 'bcf')) {
    throw new Error('Remote variant preparation returned the wrong source format.');
  }
  return {
    format,
    sourceToken: input.sourceGrant.sourceToken,
    indexToken: input.indexGrant.sourceToken,
    sourceIdentity,
    assemblyRevision,
    matchedReferences,
    samples,
    grantExpiresAtMs: Math.min(
      input.sourceGrant.expiresAtMs,
      input.indexGrant.expiresAtMs,
      Date.now() + expiresInSeconds * 1_000
    ),
  };
}

export async function readRemoteVariantPage(
  input: {
    readonly runtime: RemoteVariantRuntime;
    readonly references: ReadonlyArray<VariantReferenceIdentity>;
    readonly cursor: string | null;
    readonly limit: number;
  },
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {}
): Promise<VariantPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
    throw new Error(`Variant page limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  const baseUrl = await sidecarBaseUrlForRuntime();
  const body = await postRemoteVariantJson(
    `${baseUrl}/external/indexed-variants/page`,
    {
      source_token: input.runtime.sourceToken,
      index_token: input.runtime.indexToken,
      source_identity: input.runtime.sourceIdentity,
      assembly_revision: input.runtime.assemblyRevision,
      references: input.references.map((reference) => ({ ...reference })),
      cursor: input.cursor,
      limit: input.limit,
    },
    options
  );
  if (!isVariantPagePayload(body) || body.variants.length > input.limit) {
    throw new Error('Remote variant query returned an invalid page.');
  }
  return body;
}

export async function readRemoteVariantRegion(
  input: {
    readonly runtime: RemoteVariantRuntime;
    readonly references: ReadonlyArray<VariantReferenceIdentity>;
    readonly chrom: string;
    readonly start: number;
    readonly end: number;
    readonly limit?: number;
  },
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {}
): Promise<VariantRegion> {
  const limit = input.limit ?? MAX_VARIANT_REGION_SIZE;
  validateRegionRequest(input.chrom, input.start, input.end, limit);
  const baseUrl = await sidecarBaseUrlForRuntime();
  const body = await postRemoteVariantJson(
    `${baseUrl}/external/indexed-variants/region`,
    {
      source_token: input.runtime.sourceToken,
      index_token: input.runtime.indexToken,
      source_identity: input.runtime.sourceIdentity,
      assembly_revision: input.runtime.assemblyRevision,
      references: input.references.map((reference) => ({ ...reference })),
      chrom: input.chrom,
      start: input.start,
      end: input.end,
      limit,
    },
    options
  );
  if (!isVariantRegionPayload(body, limit)) {
    throw new Error('Remote variant query returned an invalid region.');
  }
  return body;
}

async function sidecarBaseUrlForRuntime(): Promise<string> {
  return (await resolveSidecarBaseUrl('remote-variant-navigation')).replace(/\/+$/u, '');
}

async function postRemoteVariantJson(
  url: string,
  requestBody: unknown,
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch }
): Promise<unknown> {
  const controller = new AbortController();
  const abortFromUpstream = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), REMOTE_VARIANT_TIMEOUT_MS);
  try {
    const response = await sidecarFetch(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      },
      options.fetchImpl ?? fetch
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = errorDetail(body);
      throw new VariantRequestError(
        detail?.message ?? `Remote variant request failed (HTTP ${response.status}).`,
        {
          code: detail?.code ?? 'REMOTE_VARIANT_REQUEST_FAILED',
          status: response.status,
        }
      );
    }
    return body;
  } finally {
    globalThis.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromUpstream);
  }
}

function requiredPattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`Remote variant preparation returned invalid ${field}.`);
  }
  return value;
}

function stringArray(value: unknown, nonEmpty: boolean, field: string): string[] {
  if (
    !Array.isArray(value) ||
    (nonEmpty && value.length === 0) ||
    !value.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`Remote variant preparation returned invalid ${field}.`);
  }
  return [...value];
}

function finitePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Remote variant preparation returned invalid ${field}.`);
  }
  return value;
}

function errorDetail(value: unknown): { code?: string; message?: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const detail = (value as Record<string, unknown>).detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const raw = detail as Record<string, unknown>;
  const code =
    typeof raw.code === 'string' ? raw.code : typeof raw.error === 'string' ? raw.error : undefined;
  const message = typeof raw.message === 'string' ? raw.message : undefined;
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

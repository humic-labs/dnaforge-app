import { resolveSidecarBaseUrl, sidecarFetch } from '../../services/sidecar-session';
import { platform } from '../../platform';
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

const HTSGET_TIMEOUT_MS = 60_000;
const MAX_PAGE_SIZE = 200;

export interface HtsgetRuntime {
  readonly kind: 'htsget';
  readonly dataClass: 'reads' | 'variants';
  readonly format: 'BAM' | 'CRAM' | 'VCF' | 'BCF';
  readonly sourceToken: string;
  readonly sourceIdentity: string;
  readonly assemblyRevision: string;
  readonly references: ReadonlyArray<VariantReferenceIdentity>;
  readonly matchedReferences: ReadonlyArray<string>;
  readonly samples: ReadonlyArray<string>;
  readonly grantExpiresAtMs: number;
}

interface HtsgetPreparationWire {
  readonly source_token?: unknown;
  readonly source_identity?: unknown;
  readonly data_class?: unknown;
  readonly format?: unknown;
  readonly references?: unknown;
  readonly matched_references?: unknown;
  readonly samples?: unknown;
  readonly assembly_revision?: unknown;
  readonly expires_in_seconds?: unknown;
}

export async function prepareHtsgetRuntime(
  input: {
    readonly endpoint: string;
    readonly resourceId: string;
    readonly dataClass: 'reads' | 'variants';
    readonly format: 'BAM' | 'CRAM' | 'VCF' | 'BCF';
    readonly references: ReadonlyArray<VariantReferenceIdentity>;
    readonly authRef?: string;
  },
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {}
): Promise<HtsgetRuntime> {
  if (input.authRef) await platform().genomeCredentials.prepare(input.authRef);
  const baseUrl = await sidecarBaseUrl();
  const body = await postHtsgetJson(
    `${baseUrl}/external/htsget/prepare`,
    {
      endpoint: input.endpoint,
      resource_id: input.resourceId,
      data_class: input.dataClass,
      format: input.format,
      references: input.references.map((reference) => ({ ...reference })),
      ...(input.authRef ? { auth_ref: input.authRef } : {}),
    },
    options
  );
  const wire = body as HtsgetPreparationWire;
  const sourceToken = requiredPattern(
    wire.source_token,
    /^[-_A-Za-z0-9]{16,200}$/u,
    'source_token'
  );
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
  if (wire.data_class !== input.dataClass || wire.format !== input.format) {
    throw new Error('htsget preparation returned the wrong source class or format.');
  }
  const references = referenceArray(wire.references);
  const matchedReferences = stringArray(wire.matched_references, true, 'matched_references');
  const samples = stringArray(wire.samples, false, 'samples');
  const expiresInSeconds = finitePositiveNumber(wire.expires_in_seconds, 'expires_in_seconds');
  return {
    kind: 'htsget',
    dataClass: input.dataClass,
    format: input.format,
    sourceToken,
    sourceIdentity,
    assemblyRevision,
    references,
    matchedReferences,
    samples,
    grantExpiresAtMs: Date.now() + expiresInSeconds * 1_000,
  };
}

export async function readHtsgetVariantPage(
  input: {
    readonly runtime: HtsgetRuntime;
    readonly references: ReadonlyArray<VariantReferenceIdentity>;
    readonly cursor: string | null;
    readonly limit: number;
  },
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {}
): Promise<VariantPage> {
  if (input.runtime.dataClass !== 'variants') {
    throw new Error('The htsget runtime does not contain variants.');
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
    throw new Error(`Variant page limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  const baseUrl = await sidecarBaseUrl();
  const body = await postHtsgetJson(
    `${baseUrl}/external/htsget/variants/page`,
    {
      source_token: input.runtime.sourceToken,
      source_identity: input.runtime.sourceIdentity,
      assembly_revision: input.runtime.assemblyRevision,
      references: input.references.map((reference) => ({ ...reference })),
      cursor: input.cursor,
      limit: input.limit,
    },
    options
  );
  if (!isVariantPagePayload(body) || body.variants.length > input.limit) {
    throw new Error('htsget variant query returned an invalid page.');
  }
  return body;
}

export async function readHtsgetVariantRegion(
  input: {
    readonly runtime: HtsgetRuntime;
    readonly references: ReadonlyArray<VariantReferenceIdentity>;
    readonly chrom: string;
    readonly start: number;
    readonly end: number;
    readonly limit?: number;
  },
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch } = {}
): Promise<VariantRegion> {
  if (input.runtime.dataClass !== 'variants') {
    throw new Error('The htsget runtime does not contain variants.');
  }
  const limit = input.limit ?? MAX_VARIANT_REGION_SIZE;
  validateRegionRequest(input.chrom, input.start, input.end, limit);
  const baseUrl = await sidecarBaseUrl();
  const body = await postHtsgetJson(
    `${baseUrl}/external/htsget/variants/region`,
    {
      source_token: input.runtime.sourceToken,
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
    throw new Error('htsget variant query returned an invalid region.');
  }
  return body;
}

async function sidecarBaseUrl(): Promise<string> {
  return (await resolveSidecarBaseUrl('htsget-track-runtime')).replace(/\/+$/u, '');
}

async function postHtsgetJson(
  url: string,
  requestBody: unknown,
  options: { readonly signal?: AbortSignal; readonly fetchImpl?: typeof fetch }
): Promise<unknown> {
  const controller = new AbortController();
  const abortFromUpstream = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), HTSGET_TIMEOUT_MS);
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
        detail?.message ?? `htsget request failed (HTTP ${response.status}).`,
        {
          code: detail?.code ?? 'HTSGET_REQUEST_FAILED',
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
    throw new Error(`htsget preparation returned invalid ${field}.`);
  }
  return value;
}

function referenceArray(value: unknown): VariantReferenceIdentity[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).name === 'string' &&
        Number.isSafeInteger((item as Record<string, unknown>).length) &&
        Number((item as Record<string, unknown>).length) > 0
    )
  ) {
    throw new Error('htsget preparation returned invalid references.');
  }
  return value.map((item) => ({
    name: (item as { name: string }).name,
    length: (item as { length: number }).length,
  }));
}

function stringArray(value: unknown, nonEmpty: boolean, field: string): string[] {
  if (
    !Array.isArray(value) ||
    (nonEmpty && value.length === 0) ||
    !value.every((item) => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`htsget preparation returned invalid ${field}.`);
  }
  return [...value];
}

function finitePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`htsget preparation returned invalid ${field}.`);
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

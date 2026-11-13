import { withUserMessage } from '@waypoint/user-messages';
import { variantMessageKey } from './variant-user-messages';
import type {
  VariantFileGeneration,
  VariantSourceRequest,
  VariantSourceResult,
} from '@waypoint/api-client';
import type { VariantRecord } from '@waypoint/genome-data';

import { resolveSidecarBaseUrl } from '../../services/sidecar-session';
import {
  startVariantSourceOperation,
  waitForVariantSourceResult,
} from './variant-source-operation-client';

export type VariantReferenceIdentity = VariantSourceRequest['references'][number];
export type PreparedVariantSource = VariantSourceResult;

export type VariantSummary = VariantRecord;

export interface VariantPage {
  readonly variants: ReadonlyArray<VariantSummary>;
  readonly nextCursor: string | null;
}

export interface VariantRegion {
  readonly variants: ReadonlyArray<VariantSummary>;
  readonly truncated: boolean;
}

interface RequestOptions {
  readonly signal?: AbortSignal;
}

export class VariantRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { readonly code: string; readonly status: number }) {
    super(message);
    this.name = 'VariantRequestError';
    this.code = options.code;
    this.status = options.status;
    withUserMessage(this, variantMessageKey(options.code));
  }
}

export function isVariantSourceChangedError(error: unknown): boolean {
  return (
    error instanceof VariantRequestError &&
    error.status === 409 &&
    error.code === 'VARIANT_SOURCE_CHANGED'
  );
}

const PAGE_TIMEOUT_MS = 30_000;
const MAX_PAGE_SIZE = 200;
export const MAX_VARIANT_REGION_SIZE = 10_000;

export async function prepareVariantSource(
  input: {
    readonly variantPath: string;
    readonly references: ReadonlyArray<VariantReferenceIdentity>;
  },
  options: RequestOptions = {}
): Promise<PreparedVariantSource> {
  const operation = await startVariantSourceOperation({
    variantPath: input.variantPath,
    references: input.references.map((reference) => ({ ...reference })),
  });
  return waitForVariantSourceResult(operation.id, options);
}

export async function readVariantPage(
  input: {
    readonly queryPath: string;
    readonly indexPath: string;
    readonly references: ReadonlyArray<string>;
    readonly sourceGeneration: VariantFileGeneration;
    readonly queryGeneration: VariantFileGeneration;
    readonly indexGeneration: VariantFileGeneration;
    readonly assemblyRevision: string;
    readonly cursor: string | null;
    readonly limit: number;
  },
  fetchImpl: typeof fetch = fetch,
  options: RequestOptions = {}
): Promise<VariantPage> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
    throw new Error(`Variant page limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  const body = await postVariantJson(
    '/tiles/variants/page',
    {
      queryPath: input.queryPath,
      indexPath: input.indexPath,
      references: input.references,
      sourceGeneration: input.sourceGeneration,
      queryGeneration: input.queryGeneration,
      indexGeneration: input.indexGeneration,
      assemblyRevision: input.assemblyRevision,
      cursor: input.cursor,
      limit: input.limit,
    },
    fetchImpl,
    PAGE_TIMEOUT_MS,
    options.signal
  );
  if (!isVariantPagePayload(body) || body.variants.length > input.limit) {
    throw new Error('Variant query returned an invalid page.');
  }
  return body;
}

export async function readVariantRegion(
  input: {
    readonly queryPath: string;
    readonly indexPath: string;
    readonly sourceGeneration: VariantFileGeneration;
    readonly queryGeneration: VariantFileGeneration;
    readonly indexGeneration: VariantFileGeneration;
    readonly assemblyRevision: string;
    readonly chrom: string;
    readonly start: number;
    readonly end: number;
    readonly limit?: number;
  },
  fetchImpl: typeof fetch = fetch,
  options: RequestOptions = {}
): Promise<VariantRegion> {
  const limit = input.limit ?? MAX_VARIANT_REGION_SIZE;
  validateRegionRequest(input.chrom, input.start, input.end, limit);
  const body = await postVariantJson(
    '/tiles/variants/region',
    { ...input, limit },
    fetchImpl,
    PAGE_TIMEOUT_MS,
    options.signal
  );
  if (!isVariantRegionPayload(body, limit)) {
    throw new Error('Variant query returned an invalid region.');
  }
  return body;
}

async function postVariantJson(
  path: string,
  requestBody: unknown,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  upstreamSignal?: AbortSignal
): Promise<unknown> {
  const baseUrl = (await resolveSidecarBaseUrl('variant-navigation')).replace(/\/+$/, '');
  const controller = new AbortController();
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = errorDetail(body);
      throw new VariantRequestError(
        detail?.message ?? `Variant request failed (HTTP ${response.status}).`,
        {
          code: detail?.code ?? 'VARIANT_REQUEST_FAILED',
          status: response.status,
        }
      );
    }
    return body;
  } finally {
    globalThis.clearTimeout(timeout);
    upstreamSignal?.removeEventListener('abort', abortFromUpstream);
  }
}

export function isVariantPagePayload(value: unknown): value is VariantPage {
  if (!isRecord(value) || !Array.isArray(value.variants)) return false;
  if (value.variants.length > MAX_PAGE_SIZE) return false;
  if (value.nextCursor !== null && typeof value.nextCursor !== 'string') return false;
  return value.variants.every(isVariantSummary);
}

export function isVariantRegionPayload(
  value: unknown,
  limit = MAX_VARIANT_REGION_SIZE
): value is VariantRegion {
  return (
    isRecord(value) &&
    Array.isArray(value.variants) &&
    value.variants.length <= limit &&
    value.variants.every(isVariantSummary) &&
    typeof value.truncated === 'boolean'
  );
}

export function validateRegionRequest(
  chrom: string,
  start: number,
  end: number,
  limit: number
): void {
  if (!chrom || /\s/u.test(chrom)) throw new Error('Variant region requires a chromosome name.');
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end - start > 5_000_000
  ) {
    throw new Error('Variant region must satisfy 0 <= start < end within 5,000,000 bases.');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_VARIANT_REGION_SIZE) {
    throw new Error(`Variant region limit must be between 1 and ${MAX_VARIANT_REGION_SIZE}.`);
  }
}

function isVariantSummary(value: unknown): value is VariantSummary {
  if (!isRecord(value)) return false;
  if (
    !isNonEmptyString(value.id) ||
    (value.recordId !== null && typeof value.recordId !== 'string') ||
    !isNonEmptyString(value.chrom) ||
    !isSafeNonNegativeInteger(value.start) ||
    !isSafePositiveInteger(value.end) ||
    value.end <= value.start ||
    !isSafePositiveInteger(value.position) ||
    !isNonEmptyString(value.ref) ||
    !isStringArray(value.alts, true) ||
    (value.quality !== null &&
      (typeof value.quality !== 'number' || !Number.isFinite(value.quality))) ||
    !isStringArray(value.filters, false) ||
    !['substitution', 'insertion', 'deletion', 'replacement', 'mixed', 'structural'].includes(
      String(value.variantClass)
    ) ||
    !isRecord(value.genotypes)
  ) {
    return false;
  }
  return Object.values(value.genotypes).every((genotype) => typeof genotype === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown, nonEmpty: boolean): value is string[] {
  return (
    Array.isArray(value) &&
    (!nonEmpty || value.length > 0) &&
    value.every((item) => isNonEmptyString(item))
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function errorDetail(body: unknown): { readonly code?: string; readonly message: string } | null {
  if (!isRecord(body)) return null;
  if (isNonEmptyString(body.detail)) return { message: body.detail.trim() };
  if (!isRecord(body.detail) || !isNonEmptyString(body.detail.message)) return null;
  return {
    ...(isNonEmptyString(body.detail.code) ? { code: body.detail.code.trim() } : {}),
    message: body.detail.message.trim(),
  };
}

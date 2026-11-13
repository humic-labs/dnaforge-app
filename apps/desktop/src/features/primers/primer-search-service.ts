import { HostedSignUpRequiredError } from '../../hosted/capabilities';
import { searchPrimers, listBoundPrimers } from './primer-service';
import type { PrimerLibrarySearchRequest } from '@waypoint/api-client';
import type { Primer, BoundPrimer } from './types';
import {
  startPrimerLibrarySearchOperation,
  waitForPrimerLibrarySearchResult,
} from './primer-library-search-operation-client';

export class PrimerSearchSidecarError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PrimerSearchSidecarError';
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface BindingHit {
  start: number;
  end: number;
  strand: number;
  identity: number;
  editDistance: number;
  mismatchPositions: number[];
  threePrimeMatchLength: number;
  effectiveTm: number;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number')
    : [];
}

function operationHitToBindingHit(raw: unknown): BindingHit | null {
  if (!raw || typeof raw !== 'object') return null;
  const hit = raw as {
    start?: unknown;
    end?: unknown;
    strand?: unknown;
    identity?: unknown;
    edit_distance?: unknown;
    editDistance?: unknown;
    mismatch_positions?: unknown;
    mismatchPositions?: unknown;
    three_prime_match_length?: unknown;
    threePrimeMatchLength?: unknown;
    effective_tm?: unknown;
    effectiveTm?: unknown;
  };
  const start = finiteNumber(hit.start, Number.NaN);
  const end = finiteNumber(hit.end, Number.NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    start,
    end,
    strand: finiteNumber(hit.strand),
    identity: finiteNumber(hit.identity),
    editDistance: finiteNumber(hit.edit_distance ?? hit.editDistance),
    mismatchPositions: numberArray(hit.mismatch_positions ?? hit.mismatchPositions),
    threePrimeMatchLength: finiteNumber(hit.three_prime_match_length ?? hit.threePrimeMatchLength),
    effectiveTm: finiteNumber(hit.effective_tm ?? hit.effectiveTm),
  };
}

export interface PrimerSearchResult {
  primer: Primer;
  hits: BindingHit[];
  bestHit: BindingHit | null;
  isAttached: boolean;
  existingBindingId?: string;
}

export interface SearchOptions {
  sequenceId: number;
  targetDocumentId?: string;
  targetFilePath?: string;
  referenceSequence: string;
  circular: boolean;
  maxEditDistance?: number;
  regionStart?: number;
  regionEnd?: number;
  minMatchLength?: number;
  minEffectiveTm?: number;
  maxMismatches?: number;
  signal?: AbortSignal;
  onOperationAdmitted?: (operationId: string) => void;
}

export function hitsOverlapRegion(
  hits: BindingHit[],
  regionStart: number,
  regionEnd: number
): BindingHit[] {
  return hits.filter((h) => {
    if (h.start < h.end) {
      return h.start < regionEnd && h.end > regionStart;
    }
    return h.start < regionEnd || h.end > regionStart;
  });
}

export async function findBindingCandidates(options: SearchOptions): Promise<PrimerSearchResult[]> {
  const { sequenceId } = options;
  return searchLibraryPrimerBindings({
    ...options,
    targetDocumentId: options.targetDocumentId ?? `sequence:${sequenceId}`,
    loadAttachedBindingIds: async () => {
      let existingBindings: BoundPrimer[] = [];
      try {
        existingBindings = await listBoundPrimers(sequenceId);
      } catch {}
      return new Map(existingBindings.map((bp) => [bp.id, bp.binding.id]));
    },
  });
}

export interface LibraryPrimerBindingSearchOptions extends Omit<
  SearchOptions,
  'sequenceId' | 'targetDocumentId'
> {
  targetDocumentId: string;
  loadAttachedBindingIds: () => Promise<ReadonlyMap<string, string>>;
}

export async function searchLibraryPrimerBindings(
  options: LibraryPrimerBindingSearchOptions
): Promise<PrimerSearchResult[]> {
  const { targetDocumentId, referenceSequence, circular, maxEditDistance = 3 } = options;

  const allPrimers = (await searchPrimers({})).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );

  if (allPrimers.length === 0) return [];
  const attachedMap = await options.loadAttachedBindingIds();

  const hasSubRegion =
    options.regionStart != null &&
    options.regionEnd != null &&
    options.regionStart < options.regionEnd;

  const operationInput: PrimerLibrarySearchRequest = {
    targetDocumentId,
    referenceSequence,
    circular,
    primers: allPrimers.map((primer) => ({
      id: primer.id,
      sequence: primer.sequence,
      revision: `updated-at:${primer.updatedAt}`,
    })),
    maxEditDistance,
    minMatchLength: options.minMatchLength ?? 0,
    minEffectiveTm: options.minEffectiveTm ?? 0,
    maxMismatches: options.maxMismatches ?? 10,
    ...(hasSubRegion ? { regionStart: options.regionStart, regionEnd: options.regionEnd } : {}),
  };

  let batchResults: Array<{ primerId: string; hits: unknown[] }>;
  try {
    const operation = await startPrimerLibrarySearchOperation(
      operationInput,
      options.targetFilePath ? [{ key: 'target', path: options.targetFilePath }] : []
    );
    options.onOperationAdmitted?.(operation.id);
    const result = await waitForPrimerLibrarySearchResult(operation.id, {
      ...(options.signal ? { signal: options.signal } : {}),
    });
    batchResults = result.results;
  } catch (err) {
    if (err instanceof PrimerSearchSidecarError || err instanceof HostedSignUpRequiredError) {
      throw err;
    }
    throw new PrimerSearchSidecarError('Could not complete the managed primer search', {
      cause: err,
    });
  }

  const primersById = new Map<string, Primer>();
  for (const p of allPrimers) {
    primersById.set(p.id, p);
  }

  const results: PrimerSearchResult[] = [];

  for (const batch of batchResults) {
    const primer = primersById.get(batch.primerId);
    if (!primer) continue;

    const hits: BindingHit[] = batch.hits
      .map(operationHitToBindingHit)
      .filter((hit): hit is BindingHit => hit !== null);

    if (hits.length === 0) continue;

    const bestHit = hits.reduce(
      (best, h) => (h.identity > (best?.identity ?? 0) ? h : best),
      null as BindingHit | null
    );

    results.push({
      primer,
      hits,
      bestHit,
      isAttached: attachedMap.has(primer.id),
      existingBindingId: attachedMap.get(primer.id),
    });
  }

  results.sort((a, b) => (b.bestHit?.effectiveTm ?? 0) - (a.bestHit?.effectiveTm ?? 0));

  return results;
}

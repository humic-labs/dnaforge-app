import { referencePreparationTiming } from '../reference-assets/reference-prep-timing';
import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSearchPrepareResult,
  AssemblyProteinSearchPrepareResult,
} from '../../shared/indexed-genome';
import type {
  AssemblyAnnotationSearchCacheResourceHit,
  AssemblyAnnotationSearchCacheResourceReadResult,
  AssemblyAnnotationSearchCacheIndexReadResult,
} from './assembly-annotation-search-cache';
import type {
  AssemblyProteinSearchCacheResourceHit,
  AssemblyProteinSearchCacheResourceReadResult,
  AssemblyProteinSearchCacheIndexReadResult,
} from './assembly-protein-search-cache';
import type { SearchBuildPairingV1 } from './assembly-search-build-pairing';

export interface AssemblySearchArtifactReceiptV1 {
  readonly fingerprint: string;
  readonly byteCount: number;
  readonly featureCount: number;
  readonly payloadSha256: string;
  readonly contractSha256: string;
  readonly schema: string;
  readonly contractToken: string;
}

export interface AssemblySearchIndexReadinessV1 {
  readonly annotationSearch: AssemblySearchArtifactReceiptV1;
  readonly proteinSearch: AssemblySearchArtifactReceiptV1;
}

export interface AssemblySearchIndexReadinessOptionsV1 {
  readonly signal?: AbortSignal;
  readonly searchBuildPairing?: SearchBuildPairingV1;
}

export interface AssemblySearchIndexReadinessDepsV1 {
  readonly readAnnotationSearch: (
    request: AssemblyAnnotationSceneReadRequest,
    options?: AssemblySearchIndexReadinessOptionsV1
  ) => Promise<AssemblyAnnotationSearchCacheResourceReadResult | null>;
  readonly readAnnotationRevision: (
    request: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblyAnnotationSearchCacheIndexReadResult | null>;
  readonly migrateLegacyAnnotationSearch: (
    request: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblyAnnotationSearchCacheIndexReadResult | null>;
  readonly prepareAnnotationSearch: (
    request: AssemblyAnnotationSceneReadRequest,
    miss: Extract<AssemblyAnnotationSearchCacheResourceReadResult, { status: 'miss' }>,
    options?: AssemblySearchIndexReadinessOptionsV1
  ) => Promise<AssemblyAnnotationSearchPrepareResult>;
  readonly readProteinSearch: (
    request: AssemblyAnnotationSceneReadRequest,
    options?: AssemblySearchIndexReadinessOptionsV1
  ) => Promise<AssemblyProteinSearchCacheResourceReadResult | null>;
  readonly readProteinRevision: (
    request: AssemblyAnnotationSceneReadRequest
  ) => Promise<AssemblyProteinSearchCacheIndexReadResult | null>;
  readonly prepareProteinSearch: (
    request: AssemblyAnnotationSceneReadRequest,
    miss: Extract<AssemblyProteinSearchCacheResourceReadResult, { status: 'miss' }>,
    options?: AssemblySearchIndexReadinessOptionsV1
  ) => Promise<AssemblyProteinSearchPrepareResult>;
  readonly createSearchBuildPairing?: () => SearchBuildPairingV1;
}

interface InFlightAssemblySearchReadinessV1 {
  readonly controller: AbortController;
  readonly waiters: Set<symbol>;
  readonly task: Promise<AssemblySearchIndexReadinessV1>;
  readonly isSettled: () => boolean;
}

const MAX_VERIFIED_SEARCH_SOURCE_REVISIONS = 4;
const MAX_SHARED_SEARCH_READINESS_WAITERS = 32;

export class AssemblySearchIndexReadinessCoordinatorV1 {
  private readonly deps: AssemblySearchIndexReadinessDepsV1;
  private readonly ready = new Map<string, AssemblySearchIndexReadinessV1>();
  private readonly inFlight = new Map<string, InFlightAssemblySearchReadinessV1>();
  private readonly verificationInFlight = new Map<string, InFlightAssemblySearchReadinessV1>();

  constructor(deps: AssemblySearchIndexReadinessDepsV1) {
    this.deps = deps;
  }

  async verifyPrepared(
    request: AssemblyAnnotationSceneReadRequest,
    options: AssemblySearchIndexReadinessOptionsV1 = {}
  ): Promise<AssemblySearchIndexReadinessV1> {
    throwIfSearchReadinessAborted(options.signal);
    const [annotationProbe, proteinProbe] = await Promise.all([
      this.deps.readAnnotationRevision(request),
      this.deps.readProteinRevision(request),
    ]);
    throwIfSearchReadinessAborted(options.signal);
    const key = readinessAuthorityKey(request, annotationProbe, proteinProbe);
    const admitted = this.ready.get(key);
    if (
      admitted &&
      annotationProbe?.status === 'hit' &&
      proteinProbe?.status === 'hit' &&
      probeMatchesReceipt(annotationProbe, admitted.annotationSearch) &&
      probeMatchesReceipt(proteinProbe, admitted.proteinSearch)
    ) {
      this.ready.delete(key);
      this.ready.set(key, admitted);
      return admitted;
    }
    this.ready.delete(key);

    const incumbent = this.verificationInFlight.get(key);
    if (incumbent?.controller.signal.aborted) {
      await waitForSharedSearchReadinessSettlement(incumbent, options.signal);
      return this.verifyPrepared(request, options);
    }
    if (incumbent) return waitForSharedSearchReadiness(incumbent, options.signal);

    const controller = new AbortController();
    const waiters = new Set<symbol>();
    let settled = false;
    const task = verifyPreparedAssemblySearchIndexesV1(request, this.deps, {
      signal: controller.signal,
    })
      .then(({ readiness, finalAnnotation, finalProtein }) => {
        const finalKey = readinessAuthorityKey(request, finalAnnotation, finalProtein);
        this.ready.set(finalKey, readiness);
        while (this.ready.size > MAX_VERIFIED_SEARCH_SOURCE_REVISIONS) {
          const oldest = this.ready.keys().next().value as string | undefined;
          if (!oldest) break;
          this.ready.delete(oldest);
        }
        return readiness;
      })
      .finally(() => {
        settled = true;
        if (this.verificationInFlight.get(key)?.task === task) {
          this.verificationInFlight.delete(key);
        }
      });
    const entry: InFlightAssemblySearchReadinessV1 = {
      controller,
      waiters,
      task,
      isSettled: () => settled,
    };
    this.verificationInFlight.set(key, entry);
    return waitForSharedSearchReadiness(entry, options.signal);
  }

  async ensure(
    request: AssemblyAnnotationSceneReadRequest,
    options: AssemblySearchIndexReadinessOptionsV1 = {}
  ): Promise<AssemblySearchIndexReadinessV1> {
    throwIfSearchReadinessAborted(options.signal);
    const [annotationProbe, proteinProbe] = await Promise.all([
      this.deps.readAnnotationRevision(request),
      this.deps.readProteinRevision(request),
    ]);
    throwIfSearchReadinessAborted(options.signal);
    const key = readinessAuthorityKey(request, annotationProbe, proteinProbe);
    const admitted = this.ready.get(key);
    if (
      admitted &&
      annotationProbe?.status === 'hit' &&
      proteinProbe?.status === 'hit' &&
      probeMatchesReceipt(annotationProbe, admitted.annotationSearch) &&
      probeMatchesReceipt(proteinProbe, admitted.proteinSearch)
    ) {
      this.ready.delete(key);
      this.ready.set(key, admitted);
      return admitted;
    }
    this.ready.delete(key);

    const incumbent = this.inFlight.get(key);
    if (incumbent?.controller.signal.aborted) {
      await waitForSharedSearchReadinessSettlement(incumbent, options.signal);
      return this.ensure(request, options);
    }
    if (incumbent) return waitForSharedSearchReadiness(incumbent, options.signal);

    const controller = new AbortController();
    const waiters = new Set<symbol>();
    let settled = false;
    const task = ensureAssemblySearchIndexesReadyV1(request, this.deps, {
      signal: controller.signal,
    })
      .then(async (readiness) => {
        throwIfSearchReadinessAborted(controller.signal);
        const [finalAnnotation, finalProtein] = await Promise.all([
          this.deps.readAnnotationRevision(request),
          this.deps.readProteinRevision(request),
        ]);
        throwIfSearchReadinessAborted(controller.signal);
        if (
          finalAnnotation?.status !== 'hit' ||
          finalProtein?.status !== 'hit' ||
          !probeMatchesReceipt(finalAnnotation, readiness.annotationSearch) ||
          !probeMatchesReceipt(finalProtein, readiness.proteinSearch)
        ) {
          throw new Error('Assembly search-index identity changed after full verification.');
        }
        const finalKey = readinessAuthorityKey(request, finalAnnotation, finalProtein);
        this.ready.set(finalKey, readiness);
        while (this.ready.size > MAX_VERIFIED_SEARCH_SOURCE_REVISIONS) {
          const oldest = this.ready.keys().next().value as string | undefined;
          if (!oldest) break;
          this.ready.delete(oldest);
        }
        return readiness;
      })
      .finally(() => {
        settled = true;
        if (this.inFlight.get(key)?.task === task) this.inFlight.delete(key);
      });
    const entry: InFlightAssemblySearchReadinessV1 = {
      controller,
      waiters,
      task,
      isSettled: () => settled,
    };
    this.inFlight.set(key, entry);
    return waitForSharedSearchReadiness(entry, options.signal);
  }
}

async function verifyPreparedAssemblySearchIndexesV1(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblySearchIndexReadinessDepsV1,
  options: AssemblySearchIndexReadinessOptionsV1
): Promise<{
  readonly readiness: AssemblySearchIndexReadinessV1;
  readonly finalAnnotation: Extract<
    AssemblyAnnotationSearchCacheIndexReadResult,
    { status: 'hit' }
  >;
  readonly finalProtein: Extract<AssemblyProteinSearchCacheIndexReadResult, { status: 'hit' }>;
}> {
  throwIfSearchReadinessAborted(options.signal);
  const annotation = await deps.readAnnotationSearch(request, options);
  throwIfSearchReadinessAborted(options.signal);
  if (!annotation || annotation.status !== 'hit') {
    throw new Error('Prepared annotation search index is unavailable.');
  }
  const protein = await deps.readProteinSearch(request, options);
  throwIfSearchReadinessAborted(options.signal);
  if (!protein || protein.status !== 'hit') {
    throw new Error('Prepared protein search index is unavailable.');
  }
  const readiness = {
    annotationSearch: annotationReceipt(annotation),
    proteinSearch: proteinReceipt(protein),
  };
  const [finalAnnotation, finalProtein] = await Promise.all([
    deps.readAnnotationRevision(request),
    deps.readProteinRevision(request),
  ]);
  throwIfSearchReadinessAborted(options.signal);
  if (
    finalAnnotation?.status !== 'hit' ||
    finalProtein?.status !== 'hit' ||
    !probeMatchesReceipt(finalAnnotation, readiness.annotationSearch) ||
    !probeMatchesReceipt(finalProtein, readiness.proteinSearch)
  ) {
    throw new Error('Prepared assembly search-index identity changed during verification.');
  }
  return { readiness, finalAnnotation, finalProtein };
}

async function waitForSharedSearchReadiness(
  entry: InFlightAssemblySearchReadinessV1,
  signal: AbortSignal | undefined
): Promise<AssemblySearchIndexReadinessV1> {
  throwIfSearchReadinessAborted(signal);
  if (entry.waiters.size >= MAX_SHARED_SEARCH_READINESS_WAITERS) {
    throw new Error('Assembly search readiness waiter queue is full.');
  }
  const waiter = Symbol('assembly-search-readiness-waiter');
  entry.waiters.add(waiter);
  let rejectOnAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void => rejectOnAbort?.(searchReadinessAbortError(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([entry.task, aborted]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    entry.waiters.delete(waiter);
    if (!entry.isSettled() && entry.waiters.size === 0) {
      entry.controller.abort(searchReadinessAbortError(signal));
    }
  }
}

async function waitForSharedSearchReadinessSettlement(
  entry: InFlightAssemblySearchReadinessV1,
  signal: AbortSignal | undefined
): Promise<void> {
  throwIfSearchReadinessAborted(signal);
  if (entry.waiters.size >= MAX_SHARED_SEARCH_READINESS_WAITERS) {
    throw new Error('Assembly search readiness waiter queue is full.');
  }
  const waiter = Symbol('assembly-search-readiness-settlement-waiter');
  entry.waiters.add(waiter);
  let rejectOnAbort: ((error: Error) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const onAbort = (): void => rejectOnAbort?.(searchReadinessAbortError(signal));
  signal?.addEventListener('abort', onAbort, { once: true });
  const settled = entry.task.then(
    () => undefined,
    () => undefined
  );
  try {
    await (signal ? Promise.race([settled, aborted]) : settled);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    entry.waiters.delete(waiter);
  }
}

function throwIfSearchReadinessAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw searchReadinessAbortError(signal);
}

function searchReadinessAbortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Assembly search readiness was cancelled.');
  error.name = 'AbortError';
  return error;
}

export async function ensureAssemblySearchIndexesReadyV1(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblySearchIndexReadinessDepsV1,
  options: AssemblySearchIndexReadinessOptionsV1 = {}
): Promise<AssemblySearchIndexReadinessV1> {
  throwIfSearchReadinessAborted(options.signal);
  const timing = referencePreparationTiming('search');
  const pairing = deps.createSearchBuildPairing?.();
  const sideOptions = pairing ? { ...options, searchBuildPairing: pairing } : options;
  const [annotationSearch, proteinSearch] = await Promise.all([
    ensureAnnotationSearchReady(request, deps, sideOptions)
      .finally(() => pairing?.release('annotation'))
      .then((receipt) => {
        timing('annotation-search');
        return receipt;
      }),
    ensureProteinSearchReady(request, deps, sideOptions)
      .finally(() => pairing?.release('protein'))
      .then((receipt) => {
        timing('protein-search');
        return receipt;
      }),
  ]);
  const [finalAnnotation, finalProtein] = await Promise.all([
    deps.readAnnotationRevision(request),
    deps.readProteinRevision(request),
  ]);
  throwIfSearchReadinessAborted(options.signal);
  if (
    !finalAnnotation ||
    finalAnnotation.status !== 'hit' ||
    finalAnnotation.fingerprint !== annotationSearch.fingerprint ||
    !finalProtein ||
    finalProtein.status !== 'hit' ||
    finalProtein.fingerprint !== proteinSearch.fingerprint
  ) {
    throw new Error('Assembly search-index source revision changed before readiness commit.');
  }
  return { annotationSearch, proteinSearch };
}

async function ensureAnnotationSearchReady(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblySearchIndexReadinessDepsV1,
  options: AssemblySearchIndexReadinessOptionsV1
): Promise<AssemblySearchArtifactReceiptV1> {
  throwIfSearchReadinessAborted(options.signal);
  let initial = await deps.readAnnotationSearch(request, options);
  throwIfSearchReadinessAborted(options.signal);
  if (!initial) throw new Error('Annotation search index request could not be validated.');
  if (initial.status === 'hit') return annotationReceipt(initial);

  const migrated = await deps.migrateLegacyAnnotationSearch(request);
  throwIfSearchReadinessAborted(options.signal);
  if (!migrated) throw new Error('Annotation search index request could not be validated.');
  if (migrated.status === 'hit') {
    const verifiedMigration = await deps.readAnnotationSearch(request, options);
    throwIfSearchReadinessAborted(options.signal);
    if (!verifiedMigration || verifiedMigration.status !== 'hit') {
      throw new Error('Migrated annotation search index failed full verification.');
    }
    if (verifiedMigration.fingerprint !== initial.fingerprint) {
      throw new Error('Annotation search index source revision changed during migration.');
    }
    return annotationReceipt(verifiedMigration);
  }
  if (migrated.fingerprint !== initial.fingerprint) {
    throw new Error('Annotation search index source revision changed during migration.');
  }
  initial = migrated;

  const prepared = await deps.prepareAnnotationSearch(request, initial, options);
  throwIfSearchReadinessAborted(options.signal);
  assertPreparationReady('Annotation', initial.fingerprint, prepared);
  const verified = await deps.readAnnotationSearch(request, options);
  throwIfSearchReadinessAborted(options.signal);
  if (!verified || verified.status !== 'hit') {
    throw new Error('Annotation search index was not readable after preparation.');
  }
  if (verified.fingerprint !== initial.fingerprint) {
    throw new Error('Annotation search index source revision changed during preparation.');
  }
  return annotationReceipt(verified);
}

async function ensureProteinSearchReady(
  request: AssemblyAnnotationSceneReadRequest,
  deps: AssemblySearchIndexReadinessDepsV1,
  options: AssemblySearchIndexReadinessOptionsV1
): Promise<AssemblySearchArtifactReceiptV1> {
  throwIfSearchReadinessAborted(options.signal);
  const initial = await deps.readProteinSearch(request, options);
  throwIfSearchReadinessAborted(options.signal);
  if (!initial) throw new Error('Protein search index request could not be validated.');
  if (initial.status === 'hit') return proteinReceipt(initial);

  const prepared = await deps.prepareProteinSearch(request, initial, options);
  throwIfSearchReadinessAborted(options.signal);
  assertPreparationReady('Protein', initial.fingerprint, prepared);
  const verified = await deps.readProteinSearch(request, options);
  throwIfSearchReadinessAborted(options.signal);
  if (!verified || verified.status !== 'hit') {
    throw new Error('Protein search index was not readable after preparation.');
  }
  if (verified.fingerprint !== initial.fingerprint) {
    throw new Error('Protein search index source revision changed during preparation.');
  }
  return proteinReceipt(verified);
}

function assertPreparationReady(
  label: 'Annotation' | 'Protein',
  expectedFingerprint: string,
  prepared: AssemblyAnnotationSearchPrepareResult | AssemblyProteinSearchPrepareResult
): asserts prepared is Extract<
  AssemblyAnnotationSearchPrepareResult | AssemblyProteinSearchPrepareResult,
  { status: 'ready' }
> {
  if (prepared.status !== 'ready') {
    const detail = prepared.status === 'failed' ? `: ${prepared.message}` : `: ${prepared.reason}`;
    throw new Error(`${label} search index preparation did not become ready${detail}.`);
  }
  if (prepared.fingerprint !== expectedFingerprint) {
    throw new Error(`${label} search index source revision changed during preparation.`);
  }
}

function annotationReceipt(
  hit: AssemblyAnnotationSearchCacheResourceHit
): AssemblySearchArtifactReceiptV1 {
  return validatedReceipt({
    fingerprint: hit.fingerprint,
    byteCount: hit.byteCount,
    featureCount: hit.manifest.featureCount,
    payloadSha256: hit.payloadSha256,
    contractSha256: hit.manifest.integrity.contractSha256,
    schema: hit.manifest.schema,
    contractToken: hit.manifest.searchContract.contractToken,
  });
}

function proteinReceipt(
  hit: AssemblyProteinSearchCacheResourceHit
): AssemblySearchArtifactReceiptV1 {
  return validatedReceipt({
    fingerprint: hit.fingerprint,
    byteCount: hit.byteCount,
    featureCount: hit.manifest.featureCount,
    payloadSha256: hit.payloadSha256,
    contractSha256: hit.manifest.integrity.contractSha256,
    schema: hit.manifest.schema,
    contractToken: hit.manifest.searchContract.contractToken,
  });
}

function validatedReceipt(
  receipt: AssemblySearchArtifactReceiptV1
): AssemblySearchArtifactReceiptV1 {
  if (
    !/^[0-9a-f]{24}$/.test(receipt.fingerprint) ||
    !Number.isSafeInteger(receipt.byteCount) ||
    receipt.byteCount < 0 ||
    !Number.isSafeInteger(receipt.featureCount) ||
    receipt.featureCount < 0 ||
    !/^[0-9a-f]{64}$/.test(receipt.payloadSha256) ||
    !/^[0-9a-f]{64}$/.test(receipt.contractSha256) ||
    !receipt.schema.trim() ||
    !receipt.contractToken.trim()
  ) {
    throw new Error('Search index verification produced an invalid readiness receipt.');
  }
  return receipt;
}

function readinessAuthorityKey(
  request: AssemblyAnnotationSceneReadRequest,
  annotationProbe: AssemblyAnnotationSearchCacheIndexReadResult | null,
  proteinProbe: AssemblyProteinSearchCacheIndexReadResult | null
): string {
  return JSON.stringify([
    request.workspaceRoot,
    request.assemblyId,
    request.chromosomes,
    request.scope,
    request.datasetContract,
    annotationProbe?.fingerprint ?? null,
    proteinProbe?.fingerprint ?? null,
  ]);
}

function probeMatchesReceipt(
  probe:
    | Extract<AssemblyAnnotationSearchCacheIndexReadResult, { status: 'hit' }>
    | Extract<AssemblyProteinSearchCacheIndexReadResult, { status: 'hit' }>,
  receipt: AssemblySearchArtifactReceiptV1
): boolean {
  return (
    probe.fingerprint === receipt.fingerprint &&
    probe.byteCount === receipt.byteCount &&
    probe.payloadSha256 === receipt.payloadSha256 &&
    probe.manifest.integrity.contractSha256 === receipt.contractSha256 &&
    probe.manifest.schema === receipt.schema &&
    probe.manifest.searchContract.contractToken === receipt.contractToken
  );
}

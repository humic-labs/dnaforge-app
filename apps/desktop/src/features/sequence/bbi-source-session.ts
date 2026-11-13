import {
  isIndexedBbiTrackSource,
  isUcscTrackSource,
  requireTrackAdmissionRequest,
  type AdmittedTrackSource,
} from '@waypoint/genome-data';
import type { Assembly } from '@waypoint/genome-renderer';

import { remoteSignalReferenceReceipt } from './attach-remote-signal-bigwig';
import { isBbiRangeGrantExpiredError } from './bbi-range-grant-recovery';
import type { BbiReaderWorkerClient } from './bbi-reader-worker-client';
import type { BbiHeaderSummary, BbiRangeGrant } from './bbi-reader-worker-protocol';
import { assertBbiReferencesCompatible } from './bbi-reference-compatibility';
import { admitIndexedTrack } from './indexed-track-client';
import { indexedRangeSourceFromTrackLocator } from './indexed-range-client';
import { directRemoteSignalGrant, isTrustedRemoteSignalUrl } from './remote-signal-url';
import { admitUcscTrack } from './ucsc-track-client';

const RANGE_GRANT_REFRESH_SKEW_MS = 30_000;

export interface BbiSessionReader {
  open: BbiReaderWorkerClient['open'];
  peekOpen?: BbiReaderWorkerClient['peekOpen'];
  closeSource: BbiReaderWorkerClient['closeSource'];
}

export interface BbiQueryContext {
  readonly sourceKey: string;
  readonly header: BbiHeaderSummary;
}

export interface BbiSourceSession {
  execute<T>(signal: AbortSignal, operation: (context: BbiQueryContext) => Promise<T>): Promise<T>;
  dispose(): Promise<void>;
}

export function createBbiSourceSession(input: {
  readonly assembly: Assembly;
  readonly source: AdmittedTrackSource;
  readonly format: 'bigwig' | 'bigbed';
  readonly reader: BbiSessionReader;
  readonly admit?: typeof admitUcscTrack;
  readonly admitIndexed?: typeof admitIndexedTrack;
}): BbiSourceSession {
  const admit = input.admit ?? admitUcscTrack;
  const admitIndexed = input.admitIndexed ?? admitIndexedTrack;
  const ucscSource = isUcscTrackSource(input.source) ? input.source : null;
  const workerSourceKey = `${input.source.fingerprint}\u0000worker:${crypto.randomUUID()}`;
  let admitSource: () => Promise<BbiRangeGrant>;

  if (ucscSource) {
    const assemblyName = input.assembly.chromosomes[0]?.chromosome.id ?? 'chr1';
    admitSource = () =>
      admit({
        genome: ucscSource.provenance.ucscGenome,
        track: ucscSource.provenance.track,
        formatId: input.format,
        probeChrom: assemblyName,
        hubUrl: ucscSource.provenance.hubUrl,
      });
  } else {
    if (!isIndexedBbiTrackSource(input.source) || input.source.formatId !== input.format) {
      throw new Error(
        `The ${input.format === 'bigwig' ? 'BigWig' : 'BigBed'} reader needs an admitted UCSC, local, or URL source.`
      );
    }
    const indexedSource = input.source;
    if (isTrustedRemoteSignalUrl(indexedSource.uri)) {
      admitSource = () => Promise.resolve(directRemoteSignalGrant(indexedSource));
    } else {
      const request = requireTrackAdmissionRequest(indexedSource);
      if (request.source.kind === 'ucsc-track' || request.source.kind === 'htsget') {
        throw new Error(`The indexed BBI source cannot reopen ${request.source.kind}.`);
      }
      const admissionInput = {
        source: indexedRangeSourceFromTrackLocator(request.source),
        formatId: input.format,
        provenanceId: indexedSource.fingerprint,
      } as const;
      admitSource = () => {
        if (indexedSource.provenance.devScenarioFixture) {
          return admitIndexed(admissionInput, {
            localAuthorityContext: 'dev-scenario-fixture',
          });
        }
        if (request.source.kind === 'local-file') {
          return admitIndexed(admissionInput, {
            localAuthorityContext: 'workspace-grounded',
          });
        }
        return admitIndexed(admissionInput);
      };
    }
  }

  let currentHeader: BbiHeaderSummary | null = null;
  let grantExpiresAtMs = 0;
  let openPromise: Promise<BbiHeaderSummary> | null = null;
  let openGeneration = 0;
  let recoveryPromise: Promise<void> | null = null;
  let lifecycleGeneration = 0;
  let lifecycle:
    | { phase: 'active' }
    | { phase: 'disposing' | 'disposed'; completion: Promise<void> } = { phase: 'active' };

  const assertActive = (generation: number): void => {
    if (lifecycle.phase !== 'active' || generation !== lifecycleGeneration) throw abortError();
  };

  const ensureOpen = (): Promise<BbiHeaderSummary> => {
    if (lifecycle.phase !== 'active') return Promise.reject(abortError());
    const generation = lifecycleGeneration;
    if (currentHeader && Date.now() < grantExpiresAtMs - RANGE_GRANT_REFRESH_SKEW_MS) {
      return Promise.resolve(currentHeader);
    }
    if (openPromise) return openPromise;
    const cached = input.reader.peekOpen?.(workerSourceKey, input.format);
    if (cached) {
      assertActive(generation);
      currentHeader = cached.header;
      grantExpiresAtMs = cached.expiresAtMs;
      openGeneration += 1;
      return Promise.resolve(cached.header);
    }
    openPromise = (async () => {
      const grant = await admitSource();
      assertActive(generation);
      assertGrantMatchesDurableSource(input.source, grant);
      const header = await input.reader.open(workerSourceKey, input.format, grant);
      assertActive(generation);
      await assertAssemblyCompatible(input.assembly, input.source, input.format, header);
      assertActive(generation);
      currentHeader = header;
      grantExpiresAtMs = grant.expiresAtMs;
      openGeneration += 1;
      return header;
    })();
    const pendingOpen = openPromise;
    const clearPendingOpen = (): void => {
      if (openPromise === pendingOpen) openPromise = null;
    };
    void pendingOpen.then(clearPendingOpen, clearPendingOpen);
    return pendingOpen;
  };

  const recoverMissingGrant = async (failedGeneration: number): Promise<void> => {
    if (lifecycle.phase !== 'active') throw abortError();
    if (openGeneration !== failedGeneration) return;
    if (!recoveryPromise) {
      const generation = lifecycleGeneration;
      recoveryPromise = (async () => {
        assertActive(generation);
        await input.reader.closeSource(workerSourceKey);
        assertActive(generation);
        currentHeader = null;
        grantExpiresAtMs = 0;
        openPromise = null;
        await ensureOpen();
        assertActive(generation);
      })();
      const pendingRecovery = recoveryPromise;
      const clearPendingRecovery = (): void => {
        if (recoveryPromise === pendingRecovery) recoveryPromise = null;
      };
      void pendingRecovery.then(clearPendingRecovery, clearPendingRecovery);
    }
    await recoveryPromise;
  };

  return {
    async execute<T>(
      signal: AbortSignal,
      operation: (context: BbiQueryContext) => Promise<T>
    ): Promise<T> {
      if (signal.aborted) throw abortError();
      const generation = lifecycleGeneration;
      assertActive(generation);
      let header = await ensureOpen();
      assertActive(generation);
      if (signal.aborted) throw abortError();
      const failedGeneration = openGeneration;
      try {
        const result = await operation({ sourceKey: workerSourceKey, header });
        assertActive(generation);
        return result;
      } catch (error) {
        if (!isBbiRangeGrantExpiredError(error)) throw error;
        await recoverMissingGrant(failedGeneration);
        if (signal.aborted) throw abortError();
        header = await ensureOpen();
        assertActive(generation);
        if (signal.aborted) throw abortError();
        const result = await operation({ sourceKey: workerSourceKey, header });
        assertActive(generation);
        return result;
      }
    },
    dispose(): Promise<void> {
      if (lifecycle.phase !== 'active') return lifecycle.completion;
      lifecycleGeneration += 1;
      const pending: Promise<unknown>[] = [];
      if (openPromise) pending.push(openPromise);
      if (recoveryPromise) pending.push(recoveryPromise);
      const completion = (async () => {
        if (pending.length > 0) await Promise.allSettled(pending);
        await input.reader.closeSource(workerSourceKey);
        currentHeader = null;
        grantExpiresAtMs = 0;
        openPromise = null;
        recoveryPromise = null;
      })();
      lifecycle = { phase: 'disposing', completion };
      void completion.then(
        () => {
          lifecycle = { phase: 'disposed', completion };
        },
        () => undefined
      );
      return completion;
    },
  };
}

function assertGrantMatchesDurableSource(source: AdmittedTrackSource, grant: BbiRangeGrant): void {
  const expected = source.expectedValidators;
  const changed =
    grant.sourceUri !== source.uri ||
    (expected?.contentLength !== undefined && grant.byteLength !== expected.contentLength) ||
    (expected?.etag !== undefined && grant.etag !== expected.etag) ||
    (expected?.lastModified !== undefined && grant.lastModified !== expected.lastModified);
  if (changed) {
    throw new Error(
      'The indexed genomic source changed since it was added. Remove it and add the current file again.'
    );
  }
}

async function assertAssemblyCompatible(
  assembly: Assembly,
  source: AdmittedTrackSource,
  format: 'bigwig' | 'bigbed',
  header: BbiHeaderSummary
): Promise<void> {
  if (header.fileType !== format) {
    throw new Error(
      `The admitted source is ${header.fileType}, not ${format === 'bigwig' ? 'BigWig' : 'BigBed'}.`
    );
  }
  if (
    format === 'bigwig' &&
    isIndexedBbiTrackSource(source) &&
    isTrustedRemoteSignalUrl(source.uri)
  ) {
    await remoteSignalReferenceReceipt({
      assemblyId: assembly.id,
      expected: assembly.chromosomes.map((placement) => ({
        name: placement.chromosome.id,
        length: placement.chromosome.length,
      })),
      actual: header.references,
    });
    return;
  }
  await assertBbiReferencesCompatible({
    assemblyId: assembly.id,
    expected: assembly.chromosomes.map(({ chromosome }) => {
      const sourceName = source.referenceReceipt.contigMap[chromosome.id];
      return {
        name: chromosome.id,
        length: chromosome.length,
        ...(sourceName ? { aliases: [sourceName] } : {}),
      };
    }),
    actual: header.references,
    formatName: format === 'bigwig' ? 'BigWig' : 'BigBed',
    allowSourceSubset: true,
  });
}

export function bbiAbortError(): Error {
  const error = new Error('BBI tile request cancelled.');
  error.name = 'AbortError';
  return error;
}

function abortError(): Error {
  return bbiAbortError();
}

import type {
  IndexedGenomeManifest,
  LocalIndexedGenomeDataSourceOptions,
} from '@waypoint/genome-data';

import createGenomeDataWorker from './genome-data-worker-thread-entry?nodeWorker';
import {
  GenomeDataWorkerThreadSource,
  type GenomeDataWorkerRequestOptions,
} from './genome-data-worker-thread-client';

const failedInitializationSources = new Map<GenomeDataWorkerThreadSource, Error>();
let failedInitializationCleanup: Promise<void> | null = null;

export async function createGenomeDataWorkerThreadSource(
  manifest: IndexedGenomeManifest,
  options?: LocalIndexedGenomeDataSourceOptions,
  requestOptions: GenomeDataWorkerRequestOptions = {}
): Promise<GenomeDataWorkerThreadSource> {
  await closeFailedGenomeDataWorkerThreadSources();
  const source = new GenomeDataWorkerThreadSource(createGenomeDataWorker({}));
  try {
    await source.init(manifest, options, requestOptions);
    return source;
  } catch (error) {
    try {
      await source.close();
    } catch (closeError) {
      failedInitializationSources.set(source, normalizeError(closeError));
      throw new AggregateError(
        [error, closeError],
        'Genome data worker initialization and termination both failed.'
      );
    }
    throw error;
  }
}

export async function closeFailedGenomeDataWorkerThreadSources(): Promise<void> {
  if (failedInitializationCleanup) return failedInitializationCleanup;
  const cleanup = (async () => {
    const failures: Error[] = [];
    for (const source of failedInitializationSources.keys()) {
      try {
        await source.close();
        failedInitializationSources.delete(source);
      } catch (error) {
        const failure = normalizeError(error);
        failedInitializationSources.set(source, failure);
        failures.push(failure);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more failed genome worker initializations could not be terminated.'
      );
    }
  })();
  failedInitializationCleanup = cleanup;
  try {
    await cleanup;
  } finally {
    if (failedInitializationCleanup === cleanup) failedInitializationCleanup = null;
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

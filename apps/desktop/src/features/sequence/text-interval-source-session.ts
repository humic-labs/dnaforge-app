import {
  requireTrackAdmissionRequest,
  type AdmittedTrackSource,
  type TextIntervalTrackFormatId,
} from '@waypoint/genome-data';
import type { Assembly } from '@waypoint/genome-renderer';

import { platform } from '../../platform';
import type { FilesystemStat } from '../../shared/filesystem-stat';
import { getTextIntervalReaderWorkerClient } from './text-interval-reader-runtime';
import type { TextIntervalReaderWorkerClient } from './text-interval-reader-worker-client';
import type { TextIntervalHeaderSummary } from './text-interval-reader-worker-protocol';
import { MAX_TEXT_INTERVAL_SOURCE_BYTES } from './text-interval-source-decoder';
import { isTextIntervalFormatId } from './text-interval-track-admission';
import { assertTextIntervalReferencesCompatible } from './text-interval-reference-compatibility';

export interface TextIntervalQueryContext {
  readonly sourceKey: string;
  readonly header: TextIntervalHeaderSummary;
}

export interface TextIntervalSourceSession {
  execute<T>(
    signal: AbortSignal,
    operation: (context: TextIntervalQueryContext) => Promise<T>
  ): Promise<T>;
  dispose(): Promise<void>;
}

interface TextIntervalSessionReader {
  open: TextIntervalReaderWorkerClient['open'];
  closeSource: TextIntervalReaderWorkerClient['closeSource'];
}

export function createTextIntervalSourceSession(input: {
  readonly assembly: Assembly;
  readonly source: AdmittedTrackSource;
  readonly reader?: TextIntervalSessionReader;
}): TextIntervalSourceSession {
  const request = requireTrackAdmissionRequest(input.source);
  const formatId = requireTextIntervalSource(input.source);
  if (request.source.kind !== 'local-file') {
    throw new Error('The local text interval reader requires a local-file request.');
  }
  const localPath = request.source.path;
  const reader = input.reader ?? getTextIntervalReaderWorkerClient();
  const workerSourceKey = `${input.source.fingerprint}\u0000worker:${crypto.randomUUID()}`;
  const lifecycle = new AbortController();
  let header: TextIntervalHeaderSummary | null = null;
  let openPromise: Promise<TextIntervalHeaderSummary> | null = null;
  let disposed = false;
  let disposePromise: Promise<void> | null = null;

  const ensureOpen = (): Promise<TextIntervalHeaderSummary> => {
    if (disposed) return Promise.reject(abortError());
    if (header) return Promise.resolve(header);
    if (openPromise) return openPromise;
    const pending = (async () => {
      const authority = await platform().dialog.authorizeLocalIndexedTrack({
        path: localPath,
        ...(input.source.provenance.devScenarioFixture ? { devScenarioFixture: true } : {}),
      });
      throwIfAborted(lifecycle.signal);
      const before = await platform().fs.stat(authority.canonicalPath);
      assertRuntimeStat(before, input.source);
      const bytes = await platform().fs.readFileBounded(
        authority.canonicalPath,
        MAX_TEXT_INTERVAL_SOURCE_BYTES
      );
      const after = await platform().fs.stat(authority.canonicalPath);
      if (!sameFileGeneration(before, after)) throw changedSourceError();
      throwIfAborted(lifecycle.signal);
      const opened = await reader.open(
        workerSourceKey,
        formatId,
        bytes,
        requireTextScientificKind(input.source.scientificKind),
        lifecycle.signal
      );
      try {
        assertHeaderMatchesSource(input.source, opened);
        await assertTextIntervalReferencesCompatible({
          assemblyId: input.assembly.id,
          expected: input.assembly.chromosomes.map((entry) => ({
            name: entry.chromosome.id,
            length: entry.chromosome.length,
          })),
          actual: opened.referenceExtents,
          formatName: formatId,
        });
        throwIfAborted(lifecycle.signal);
        header = opened;
        return opened;
      } catch (error) {
        await reader.closeSource(workerSourceKey);
        throw error;
      }
    })();
    openPromise = pending;
    void pending.then(
      () => {
        if (openPromise === pending) openPromise = null;
      },
      () => {
        if (openPromise === pending) openPromise = null;
      }
    );
    return pending;
  };

  return {
    async execute<T>(
      signal: AbortSignal,
      operation: (context: TextIntervalQueryContext) => Promise<T>
    ): Promise<T> {
      if (signal.aborted || disposed) throw abortError();
      const opened = await awaitWithAbort(ensureOpen(), signal);
      if (signal.aborted || disposed) throw abortError();
      return operation({ sourceKey: workerSourceKey, header: opened });
    },
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      disposed = true;
      lifecycle.abort();
      const pendingOpen = openPromise;
      disposePromise = (async () => {
        if (pendingOpen) await Promise.allSettled([pendingOpen]);
        await reader.closeSource(workerSourceKey);
        header = null;
        openPromise = null;
      })();
      return disposePromise;
    },
  };
}

function requireTextIntervalSource(source: AdmittedTrackSource): TextIntervalTrackFormatId {
  if (source.readerKind !== 'interval-text' || !isTextIntervalFormatId(source.formatId)) {
    throw new Error('The text interval reader requires an admitted text interval source.');
  }
  return source.formatId;
}

function requireTextScientificKind(
  value: AdmittedTrackSource['scientificKind']
): 'transcript' | 'interval' | 'peak' | 'repeat' {
  if (value === 'transcript' || value === 'interval' || value === 'peak' || value === 'repeat') {
    return value;
  }
  throw new Error(`Text interval scientific kind ${value} is not renderable.`);
}

function assertRuntimeStat(stat: FilesystemStat, source: AdmittedTrackSource): void {
  if (!stat.isFile || stat.size < 1 || stat.size > MAX_TEXT_INTERVAL_SOURCE_BYTES) {
    throw changedSourceError();
  }
  const expectedLength = source.expectedValidators?.contentLength;
  if (expectedLength !== undefined && stat.size !== expectedLength) throw changedSourceError();
}

function assertHeaderMatchesSource(
  source: AdmittedTrackSource,
  header: TextIntervalHeaderSummary
): void {
  if (
    header.formatId !== source.formatId ||
    header.scientificKind !== source.scientificKind ||
    `${header.formatId}:${header.contentSha256}` !== source.fingerprint ||
    (source.expectedValidators?.contentLength !== undefined &&
      header.sourceByteLength !== source.expectedValidators.contentLength)
  ) {
    throw changedSourceError();
  }
}

function sameFileGeneration(left: FilesystemStat, right: FilesystemStat): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

function changedSourceError(): Error {
  return new Error(
    'The local interval source changed since it was added. Remove it and add the current file again.'
  );
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error('Text interval tile request cancelled.');
  error.name = 'AbortError';
  return error;
}

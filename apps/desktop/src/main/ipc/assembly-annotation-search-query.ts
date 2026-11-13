import { open } from 'node:fs/promises';

import {
  openRangeReadablePrepackedAnnotationSearchIndexV1,
  type PrepackedAnnotationSearchMatchV1,
  type PrepackedAnnotationSearchRangeIndexV1,
} from '@waypoint/genome-data';

import {
  payloadIdentityMatchesFileStat,
  type AssemblyAnnotationSearchCacheIndexHit,
  type AssemblyAnnotationSearchPayloadFileStatV2,
} from './assembly-annotation-search-cache';
import type { AssemblyAnnotationSearchQueryResultV1 } from '../../shared/indexed-genome';

const MAX_RESIDENT_QUERY_SESSIONS = 2;

export interface AssemblyAnnotationSearchQueryFileStat extends AssemblyAnnotationSearchPayloadFileStatV2 {}

export interface AssemblyAnnotationSearchQueryFile {
  stat(): Promise<AssemblyAnnotationSearchQueryFileStat>;
  read(
    buffer: Uint8Array,
    byteOffset: number,
    byteLength: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

interface AssemblyAnnotationSearchQueryDeps {
  openFile?: (path: string) => Promise<AssemblyAnnotationSearchQueryFile>;
  signal?: AbortSignal;
}

interface DiskQuerySession {
  readonly file: AssemblyAnnotationSearchQueryFile;
  readonly index: PrepackedAnnotationSearchRangeIndexV1;
}

interface DiskQuerySessionEntry {
  readonly key: string;
  readonly promise: Promise<DiskQuerySession>;
  readonly idleWaiters: Set<() => void>;
  activeQueries: number;
  evicted: boolean;
  closePromise: Promise<void> | null;
}

const querySessions = new Map<string, DiskQuerySessionEntry>();
const allQuerySessionEntries = new Set<DiskQuerySessionEntry>();

export async function queryAssemblyAnnotationSearchIndexHit(
  hit: AssemblyAnnotationSearchCacheIndexHit,
  query: string,
  limit: number,
  deps: AssemblyAnnotationSearchQueryDeps = {}
): Promise<PrepackedAnnotationSearchMatchV1[]> {
  throwIfQueryCancelled(deps.signal);
  const entry = getOrOpenQuerySession(hit, deps);
  entry.activeQueries += 1;
  try {
    const session = await entry.promise;
    throwIfQueryCancelled(deps.signal);
    const currentIdentity = await session.file.stat();
    throwIfQueryCancelled(deps.signal);
    if (!payloadIdentityMatchesFileStat(hit.payloadIdentity, currentIdentity)) {
      throw new Error('annotation search payload changed after validation');
    }
    const matches = await session.index.query(query, limit, { signal: deps.signal });
    throwIfQueryCancelled(deps.signal);
    const finalIdentity = await session.file.stat();
    throwIfQueryCancelled(deps.signal);
    if (!payloadIdentityMatchesFileStat(hit.payloadIdentity, finalIdentity)) {
      throw new Error('annotation search payload changed during query');
    }
    return matches;
  } catch (error) {
    if (!deps.signal?.aborted) evictQuerySession(entry);
    throw error;
  } finally {
    releaseQuerySession(entry);
  }
}

export async function queryAssemblyAnnotationSearchIndexHitOrMiss(
  hit: AssemblyAnnotationSearchCacheIndexHit,
  query: string,
  limit: number,
  deps: AssemblyAnnotationSearchQueryDeps = {}
): Promise<AssemblyAnnotationSearchQueryResultV1> {
  try {
    const candidates = await queryAssemblyAnnotationSearchIndexHit(hit, query, limit + 1, deps);
    return {
      status: 'hit',
      fingerprint: hit.fingerprint,
      featureCount: hit.manifest.featureCount,
      matches: candidates.slice(0, limit),
      truncated: candidates.length > limit,
    };
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    return { status: 'miss', fingerprint: hit.fingerprint };
  }
}

function throwIfQueryCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  const error = new Error('annotation search query was cancelled');
  error.name = 'AbortError';
  throw error;
}

export async function disposeAssemblyAnnotationSearchQuerySessions(): Promise<void> {
  const entries = [...allQuerySessionEntries];
  querySessions.clear();
  for (const entry of entries) entry.evicted = true;
  await Promise.all(
    entries.map(async (entry) => {
      await waitForQuerySessionIdle(entry);
      await closeQuerySession(entry);
    })
  );
}

function getOrOpenQuerySession(
  hit: AssemblyAnnotationSearchCacheIndexHit,
  deps: AssemblyAnnotationSearchQueryDeps
): DiskQuerySessionEntry {
  const key = querySessionKey(hit);
  const incumbent = querySessions.get(key);
  if (incumbent) {
    querySessions.delete(key);
    querySessions.set(key, incumbent);
    return incumbent;
  }

  const entry: DiskQuerySessionEntry = {
    key,
    promise: openQuerySession(hit, deps),
    idleWaiters: new Set(),
    activeQueries: 0,
    evicted: false,
    closePromise: null,
  };
  querySessions.set(key, entry);
  allQuerySessionEntries.add(entry);
  while (querySessions.size > MAX_RESIDENT_QUERY_SESSIONS) {
    const oldestKey = querySessions.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const evicted = querySessions.get(oldestKey);
    if (evicted) evictQuerySession(evicted);
  }
  return entry;
}

async function openQuerySession(
  hit: AssemblyAnnotationSearchCacheIndexHit,
  deps: AssemblyAnnotationSearchQueryDeps
): Promise<DiskQuerySession> {
  const file = await (deps.openFile ?? defaultOpenFile)(hit.payloadPath);
  try {
    const identity = await file.stat();
    if (
      hit.payloadIdentity.size !== String(hit.byteCount) ||
      !payloadIdentityMatchesFileStat(hit.payloadIdentity, identity)
    ) {
      throw new Error('annotation search payload identity changed before validation');
    }

    const index = await openRangeReadablePrepackedAnnotationSearchIndexV1(hit.manifest, {
      byteLength: hit.byteCount,
      read: (byteOffset, byteLength) => readExactFileRange(file, byteOffset, byteLength),
    });
    if (!payloadIdentityMatchesFileStat(hit.payloadIdentity, await file.stat())) {
      throw new Error('annotation search payload changed during directory validation');
    }
    return { file, index };
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function defaultOpenFile(path: string): Promise<AssemblyAnnotationSearchQueryFile> {
  const file = await open(path, 'r');
  return {
    stat: () => file.stat({ bigint: true }),
    read: (buffer, byteOffset, byteLength, position) =>
      file.read(buffer, byteOffset, byteLength, position),
    close: () => file.close(),
  };
}

async function readExactFileRange(
  file: AssemblyAnnotationSearchQueryFile,
  byteOffset: number,
  byteLength: number
): Promise<Uint8Array> {
  const bytes = new Uint8Array(byteLength);
  let readOffset = 0;
  while (readOffset < byteLength) {
    const result = await file.read(
      bytes,
      readOffset,
      byteLength - readOffset,
      byteOffset + readOffset
    );
    if (!Number.isInteger(result.bytesRead) || result.bytesRead <= 0) {
      throw new Error('annotation search payload range read was incomplete');
    }
    readOffset += result.bytesRead;
  }
  return bytes;
}

function evictQuerySession(entry: DiskQuerySessionEntry): void {
  if (querySessions.get(entry.key) === entry) querySessions.delete(entry.key);
  entry.evicted = true;
  if (entry.activeQueries === 0) void closeQuerySession(entry);
}

function releaseQuerySession(entry: DiskQuerySessionEntry): void {
  entry.activeQueries -= 1;
  if (entry.activeQueries < 0) {
    entry.activeQueries = 0;
    throw new Error('annotation search query session lease underflow');
  }
  if (entry.activeQueries !== 0) return;
  for (const resolve of entry.idleWaiters) resolve();
  entry.idleWaiters.clear();
  if (entry.evicted) void closeQuerySession(entry);
}

function waitForQuerySessionIdle(entry: DiskQuerySessionEntry): Promise<void> {
  if (entry.activeQueries === 0) return Promise.resolve();
  return new Promise((resolve) => entry.idleWaiters.add(resolve));
}

function closeQuerySession(entry: DiskQuerySessionEntry): Promise<void> {
  entry.closePromise ??= entry.promise
    .then((session) => session.file.close())
    .catch(() => undefined)
    .finally(() => {
      allQuerySessionEntries.delete(entry);
    });
  return entry.closePromise;
}

function querySessionKey(hit: AssemblyAnnotationSearchCacheIndexHit): string {
  const identity = hit.payloadIdentity;
  return JSON.stringify([
    hit.payloadPath,
    hit.payloadSha256,
    hit.byteCount,
    hit.fingerprint,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
    identity.ino,
    identity.dev,
  ]);
}

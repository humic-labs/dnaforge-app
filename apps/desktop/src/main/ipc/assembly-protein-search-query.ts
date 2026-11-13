import { open } from 'node:fs/promises';

import {
  openRangeReadablePrepackedProteinSearchIndexV1,
  type PrepackedProteinSearchRangeIndexV1,
  type PrepackedProteinSubsequenceFinderV1,
} from '@waypoint/genome-data';

import type { AssemblyProteinSearchQueryResultV1 } from '../../shared/indexed-genome';
import {
  payloadIdentityMatchesFileStat,
  type AssemblyAnnotationSearchPayloadFileStatV2,
} from './assembly-annotation-search-cache';
import type { AssemblyProteinSearchCacheIndexHit } from './assembly-protein-search-cache';

const MAX_RESIDENT_QUERY_SESSIONS = 2;
const nativeSubsequenceFinder: PrepackedProteinSubsequenceFinderV1 = (
  haystack,
  needle,
  fromIndex
) =>
  Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).indexOf(
    Buffer.from(needle.buffer, needle.byteOffset, needle.byteLength),
    fromIndex
  );

export interface AssemblyProteinSearchQueryFile {
  stat(): Promise<AssemblyAnnotationSearchPayloadFileStatV2>;
  read(
    buffer: Uint8Array,
    byteOffset: number,
    byteLength: number,
    position: number
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

interface AssemblyProteinSearchQueryDeps {
  readonly openFile?: (path: string) => Promise<AssemblyProteinSearchQueryFile>;
  readonly signal?: AbortSignal;
}

interface QuerySession {
  readonly file: AssemblyProteinSearchQueryFile;
  readonly index: PrepackedProteinSearchRangeIndexV1;
}

interface QuerySessionEntry {
  readonly key: string;
  readonly promise: Promise<QuerySession>;
  readonly idleWaiters: Set<() => void>;
  activeQueries: number;
  evicted: boolean;
  closePromise: Promise<void> | null;
}

const sessions = new Map<string, QuerySessionEntry>();
const allSessions = new Set<QuerySessionEntry>();

export async function queryAssemblyProteinSearchIndexHitOrMiss(
  hit: AssemblyProteinSearchCacheIndexHit,
  query: string,
  limit: number,
  deps: AssemblyProteinSearchQueryDeps = {}
): Promise<AssemblyProteinSearchQueryResultV1> {
  try {
    throwIfCancelled(deps.signal);
    const entry = getOrOpenSession(hit, deps);
    entry.activeQueries += 1;
    try {
      const session = await entry.promise;
      throwIfCancelled(deps.signal);
      if (!payloadIdentityMatchesFileStat(hit.payloadIdentity, await session.file.stat())) {
        throw new Error('protein search payload changed after validation');
      }
      const result = await session.index.query(query, limit, { signal: deps.signal });
      throwIfCancelled(deps.signal);
      if (!payloadIdentityMatchesFileStat(hit.payloadIdentity, await session.file.stat())) {
        throw new Error('protein search payload changed during query');
      }
      return {
        status: 'hit',
        fingerprint: hit.fingerprint,
        featureCount: hit.manifest.featureCount,
        matches: result.matches,
        truncated: result.truncated,
        limit: result.limit,
      };
    } catch (error) {
      if (!deps.signal?.aborted) evict(entry);
      throw error;
    } finally {
      release(entry);
    }
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    return { status: 'miss', fingerprint: hit.fingerprint };
  }
}

export async function disposeAssemblyProteinSearchQuerySessions(): Promise<void> {
  const entries = [...allSessions];
  sessions.clear();
  for (const entry of entries) entry.evicted = true;
  await Promise.all(
    entries.map(async (entry) => {
      await waitForIdle(entry);
      await closeSession(entry);
    })
  );
}

function getOrOpenSession(
  hit: AssemblyProteinSearchCacheIndexHit,
  deps: AssemblyProteinSearchQueryDeps
): QuerySessionEntry {
  const key = sessionKey(hit);
  const incumbent = sessions.get(key);
  if (incumbent) {
    sessions.delete(key);
    sessions.set(key, incumbent);
    return incumbent;
  }
  const entry: QuerySessionEntry = {
    key,
    promise: openSession(hit, deps),
    idleWaiters: new Set(),
    activeQueries: 0,
    evicted: false,
    closePromise: null,
  };
  sessions.set(key, entry);
  allSessions.add(entry);
  while (sessions.size > MAX_RESIDENT_QUERY_SESSIONS) {
    const oldestKey = sessions.keys().next().value as string | undefined;
    if (!oldestKey) break;
    const oldest = sessions.get(oldestKey);
    if (oldest) evict(oldest);
  }
  return entry;
}

async function openSession(
  hit: AssemblyProteinSearchCacheIndexHit,
  deps: AssemblyProteinSearchQueryDeps
): Promise<QuerySession> {
  const file = await (deps.openFile ?? defaultOpenFile)(hit.payloadPath);
  try {
    if (
      hit.payloadIdentity.size !== String(hit.byteCount) ||
      !payloadIdentityMatchesFileStat(hit.payloadIdentity, await file.stat())
    ) {
      throw new Error('protein search payload identity changed before validation');
    }
    const index = await openRangeReadablePrepackedProteinSearchIndexV1(
      hit.manifest,
      {
        byteLength: hit.byteCount,
        read: (byteOffset, byteLength) => readExactFileRange(file, byteOffset, byteLength),
      },
      { findSubsequence: nativeSubsequenceFinder }
    );
    if (!payloadIdentityMatchesFileStat(hit.payloadIdentity, await file.stat())) {
      throw new Error('protein search payload changed during metadata validation');
    }
    return { file, index };
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function defaultOpenFile(path: string): Promise<AssemblyProteinSearchQueryFile> {
  const file = await open(path, 'r');
  return {
    stat: () => file.stat({ bigint: true }),
    read: (buffer, byteOffset, byteLength, position) =>
      file.read(buffer, byteOffset, byteLength, position),
    close: () => file.close(),
  };
}

async function readExactFileRange(
  file: AssemblyProteinSearchQueryFile,
  byteOffset: number,
  byteLength: number
): Promise<Uint8Array> {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const result = await file.read(bytes, offset, byteLength - offset, byteOffset + offset);
    if (!Number.isInteger(result.bytesRead) || result.bytesRead <= 0) {
      throw new Error('protein search payload range read was incomplete');
    }
    offset += result.bytesRead;
  }
  return bytes;
}

function evict(entry: QuerySessionEntry): void {
  if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
  entry.evicted = true;
  if (entry.activeQueries === 0) void closeSession(entry);
}

function release(entry: QuerySessionEntry): void {
  entry.activeQueries -= 1;
  if (entry.activeQueries < 0) {
    entry.activeQueries = 0;
    throw new Error('protein search query session lease underflow');
  }
  if (entry.activeQueries !== 0) return;
  for (const resolve of entry.idleWaiters) resolve();
  entry.idleWaiters.clear();
  if (entry.evicted) void closeSession(entry);
}

function waitForIdle(entry: QuerySessionEntry): Promise<void> {
  if (entry.activeQueries === 0) return Promise.resolve();
  return new Promise((resolve) => entry.idleWaiters.add(resolve));
}

function closeSession(entry: QuerySessionEntry): Promise<void> {
  entry.closePromise ??= entry.promise
    .then(({ file }) => file.close())
    .catch(() => undefined)
    .finally(() => allSessions.delete(entry));
  return entry.closePromise;
}

function sessionKey(hit: AssemblyProteinSearchCacheIndexHit): string {
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

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('protein search query was cancelled');
  error.name = 'AbortError';
  throw error;
}

import { stat } from 'node:fs/promises';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyProteinSearchQueryResultV1,
} from '../../shared/indexed-genome';
import type { AssemblyAnnotationSearchSourceContinuityEntryV1 } from './assembly-annotation-search-cache';
import {
  readAssemblyProteinSearchCacheIndex,
  type AssemblyProteinSearchCacheIndexHit,
  type AssemblyProteinSearchCacheIndexReadResult,
} from './assembly-protein-search-cache';
import { queryAssemblyProteinSearchIndexHitOrMiss } from './assembly-protein-search-query';

const MAX_RESIDENT_AUTHORITIES = 2;
const MAX_PENDING_AUTHORITIES = 8;
const MAX_AUTHORITY_CLAIMERS = 8;

interface SourceStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs?: number;
}

interface AuthorityDeps {
  readonly assertSafePath: (path: string) => Promise<void>;
  readonly readCacheIndex?: (
    request: AssemblyAnnotationSceneReadRequest,
    deps: { assertSafePath: (path: string) => Promise<void> }
  ) => Promise<AssemblyProteinSearchCacheIndexReadResult | null>;
  readonly queryCacheHit?: (
    hit: AssemblyProteinSearchCacheIndexHit,
    query: string,
    limit: number,
    deps: { signal?: AbortSignal }
  ) => Promise<AssemblyProteinSearchQueryResultV1>;
  readonly statSource?: (path: string) => Promise<SourceStat>;
}

interface AuthorityEntry {
  readonly key: string;
  readonly promise: Promise<AssemblyProteinSearchCacheIndexReadResult | null>;
  claimers: number;
  settled: boolean;
  invalidated: boolean;
}

export class AssemblyProteinSearchAuthority {
  private readonly entries = new Map<string, AuthorityEntry>();

  async query(
    source: AssemblyAnnotationSceneReadRequest,
    query: string,
    limit: number,
    signal: AbortSignal | undefined,
    deps: AuthorityDeps
  ): Promise<AssemblyProteinSearchQueryResultV1 | null> {
    throwIfCancelled(signal);
    const entry = this.getOrLoad(source, deps);
    if (entry.claimers >= MAX_AUTHORITY_CLAIMERS) {
      throw new Error('Protein search authority claimant capacity is full.');
    }
    entry.claimers += 1;
    let cached: AssemblyProteinSearchCacheIndexReadResult | null;
    try {
      cached = await entry.promise;
    } finally {
      entry.claimers -= 1;
    }
    throwIfCancelled(signal);
    if (entry.invalidated) return null;
    if (!cached || cached.status === 'miss') return cached;
    await deps.assertSafePath(cached.payloadPath);
    const result = await (deps.queryCacheHit ?? queryAssemblyProteinSearchIndexHitOrMiss)(
      cached,
      query,
      limit,
      { signal }
    );
    throwIfCancelled(signal);
    if (result.status === 'miss') {
      this.evict(entry);
      return result;
    }
    if (!(await sourceContinuityMatches(cached.sourceContinuity, deps.statSource, signal))) {
      this.evict(entry);
      return { status: 'miss', fingerprint: cached.fingerprint };
    }
    throwIfCancelled(signal);
    return result;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      if (entry.settled) this.entries.delete(entry.key);
      else entry.invalidated = true;
    }
  }

  invalidate(source: AssemblyAnnotationSceneReadRequest): boolean {
    const entry = this.entries.get(authorityKey(source));
    if (!entry) return false;
    if (entry.settled) return this.entries.delete(entry.key);
    entry.invalidated = true;
    return true;
  }

  residentCountForTests(): number {
    return this.entries.size;
  }

  private getOrLoad(
    source: AssemblyAnnotationSceneReadRequest,
    deps: AuthorityDeps
  ): AuthorityEntry {
    const key = authorityKey(source);
    const incumbent = this.entries.get(key);
    if (incumbent) {
      if (incumbent.invalidated) {
        throw new Error('Protein search authority invalidation is still settling.');
      }
      this.entries.delete(key);
      this.entries.set(key, incumbent);
      return incumbent;
    }
    const pendingCount = [...this.entries.values()].filter((entry) => !entry.settled).length;
    if (pendingCount >= MAX_PENDING_AUTHORITIES) {
      throw new Error('Protein search authority preparation capacity is full.');
    }
    const entry: AuthorityEntry = {
      key,
      promise: (deps.readCacheIndex ?? readAssemblyProteinSearchCacheIndex)(source, {
        assertSafePath: deps.assertSafePath,
      }),
      claimers: 0,
      settled: false,
      invalidated: false,
    };
    this.entries.set(key, entry);
    void entry.promise.then(
      (result) => {
        entry.settled = true;
        if (entry.invalidated || !result || result.status === 'miss') this.evict(entry);
        else this.trimResidentAuthorities();
      },
      () => {
        entry.settled = true;
        this.evict(entry);
      }
    );
    return entry;
  }

  private trimResidentAuthorities(): void {
    for (;;) {
      const resident = [...this.entries.values()].filter(
        (entry) => entry.settled && !entry.invalidated
      );
      if (resident.length <= MAX_RESIDENT_AUTHORITIES) return;
      this.entries.delete(resident[0]!.key);
    }
  }

  private evict(entry: AuthorityEntry): void {
    if (!entry.settled) {
      entry.invalidated = true;
      return;
    }
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }
}

async function sourceContinuityMatches(
  expected: readonly AssemblyAnnotationSearchSourceContinuityEntryV1[],
  statSource: ((path: string) => Promise<SourceStat>) | undefined,
  signal: AbortSignal | undefined
): Promise<boolean> {
  try {
    const statImpl = statSource ?? stat;
    const matches = await Promise.all(
      expected.map(async (entry) => {
        const current = await statImpl(entry.sourcePath);
        return (
          current.size === entry.size &&
          current.mtimeMs === entry.mtimeMs &&
          (current.ctimeMs ?? null) === entry.ctimeMs
        );
      })
    );
    throwIfCancelled(signal);
    return matches.every(Boolean);
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

function authorityKey(source: AssemblyAnnotationSceneReadRequest): string {
  return JSON.stringify([
    source.workspaceRoot,
    source.assemblyId,
    source.datasetContract,
    source.scope,
    source.chromosomes.map(({ chrom, length, sourcePath, manifest }) => [
      chrom,
      length,
      sourcePath ?? '',
      manifest?.fastaPath ?? '',
      manifest?.faiPath ?? '',
      manifest?.gffPath ?? '',
      manifest?.tbiPath ?? '',
    ]),
  ]);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error('protein search query was cancelled');
  error.name = 'AbortError';
  throw error;
}

export const assemblyProteinSearchAuthority = new AssemblyProteinSearchAuthority();

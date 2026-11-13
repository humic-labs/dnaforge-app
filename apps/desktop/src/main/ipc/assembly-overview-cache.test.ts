import { describe, expect, it, vi } from 'vitest';

import type { GenomeFeature, IndexedGenomeManifest } from '@waypoint/genome-data';
import type { GenomeTileRequest } from '../../shared/indexed-genome';
import {
  getCachedAnnotationOverviewTile,
  getOrCreateAnnotationOverviewTile,
  type OverviewTileCacheDeps,
} from './genome-overview-tile-cache';
import { buildIndexedGenomePaths } from '../../features/sequence/indexed-genome-paths';
import {
  allMissResult,
  readAssemblyOverviewCaches,
  type AssemblyOverviewChromInput,
  type AssemblyOverviewDeps,
} from './assembly-overview-cache';

function feat(
  o: Partial<GenomeFeature> & Pick<GenomeFeature, 'type' | 'start' | 'end'>
): GenomeFeature {
  return {
    chrom: o.chrom ?? 'chrT',
    source: o.source ?? 'test',
    type: o.type,
    start: o.start,
    end: o.end,
    score: o.score ?? null,
    strand: o.strand ?? '+',
    phase: o.phase ?? null,
    attributes: o.attributes ?? {},
    raw: o.raw ?? `${o.type}\t${o.start}\t${o.end}`,
  };
}

function rows(): GenomeFeature[] {
  return [
    feat({ type: 'gene', start: 100, end: 900, attributes: { ID: ['gene-1'] } }),
    feat({ type: 'mRNA', start: 100, end: 900, attributes: { ID: ['tx-1'], Parent: ['gene-1'] } }),
    feat({ type: 'exon', start: 100, end: 200, attributes: { Parent: ['tx-1'] } }),
    feat({ type: 'exon', start: 700, end: 900, attributes: { Parent: ['tx-1'] } }),
    feat({ type: 'CDS', start: 130, end: 180, attributes: { Parent: ['tx-1'] } }),
  ];
}

const LENGTH = 10_000;

function summaryRequest(chrom: string): GenomeTileRequest {
  return {
    trackId: `${chrom}:annotations`,
    chrom,
    start: 0,
    end: LENGTH,
    lod: 0,
    generation: 1,
    fidelity: 'summary',
    byteBudget: 4_000_000,
  };
}

function createMemDeps(
  man: IndexedGenomeManifest,
  ctimeRef: { value: number }
): OverviewTileCacheDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const indexPaths = [man.fastaPath, man.faiPath, man.gffPath as string, man.tbiPath as string];
  return {
    files,
    async mkdir() {
      return undefined;
    },
    async realpath(p: string) {
      return p;
    },
    async stat(p: string) {
      if (!indexPaths.includes(p)) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return {
        size: p.endsWith('.gff3.gz') ? 500 : 100,
        mtimeMs: 1234,
        ctimeMs: ctimeRef.value,
        dev: 1,
        ino: indexPaths.indexOf(p) + 10,
      };
    },
    async readFile(p: string) {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    async writeFile(p: string, content: string) {
      files.set(p, content);
      return undefined;
    },
    async rename(fromPath: string, toPath: string) {
      const content = files.get(fromPath);
      if (content === undefined) {
        const err = new Error(`ENOENT: ${fromPath}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.set(toPath, content);
      files.delete(fromPath);
    },
    async unlink(path: string) {
      if (!files.delete(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    },
  };
}

const SOURCE_STAT = { size: 4242, mtimeMs: 5000, ctimeMs: 100 };

async function seedChrom(opts: {
  chrom: string;
  sourcePath: string;
  workspaceRoot: string;
  sourceStat?: { size: number; mtimeMs: number; ctimeMs: number };
  ctimeRef?: { value: number };
}) {
  const sourceStat = opts.sourceStat ?? SOURCE_STAT;
  const ctimeRef = opts.ctimeRef ?? { value: 100 };
  const { manifest } = buildIndexedGenomePaths({
    sourcePath: opts.sourcePath,
    workspaceRoot: opts.workspaceRoot,
    sizeBytes: sourceStat.size,
    sourceMtimeMs: sourceStat.mtimeMs,
    sourceCtimeMs: sourceStat.ctimeMs,
  });
  const man: IndexedGenomeManifest = { ...manifest, length: LENGTH };
  const memDeps = createMemDeps(man, ctimeRef);
  const seeded = await getOrCreateAnnotationOverviewTile({
    manifest: man,
    request: summaryRequest(opts.chrom),
    loadRawFeatures: async () => rows(),
    deps: memDeps,
    now: () => 111,
  });
  return { man, memDeps, ctimeRef, sourceStat, seededFeatures: seeded.features };
}

function readDeps(
  memByChrom: Record<string, OverviewTileCacheDeps>,
  statByPath: Record<string, { size: number; mtimeMs: number; ctimeMs: number }>,
  unsafe: Set<string> = new Set()
): AssemblyOverviewDeps {
  return {
    assertSafePath: async (p) => {
      if (unsafe.has(p)) throw new Error(`unsafe: ${p}`);
    },
    statSource: async (p) => {
      const s = statByPath[p];
      if (!s) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return s;
    },
    readCachedOverview: async (m) => {
      for (const deps of Object.values(memByChrom)) {
        const tile = await getCachedAnnotationOverviewTile({ manifest: m, deps }).catch(() => null);
        if (tile) return { features: tile.features, layerTypes: tile.layerTypes };
      }
      return null;
    },
  };
}

const SRC = '/ws/src/chrT.gff3.gz';
const WS = '/ws';

describe('readAssemblyOverviewCaches — hash-chain round trip', () => {
  it('HITS a cache the build path wrote, returning identical features (path hash agrees)', async () => {
    const { man, memDeps, seededFeatures } = await seedChrom({
      chrom: 'chrT',
      sourcePath: SRC,
      workspaceRoot: WS,
    });
    expect(seededFeatures.length).toBeGreaterThan(0);

    const result = await readAssemblyOverviewCaches(
      { chromosomes: [{ chrom: 'chrT', sourcePath: SRC, length: LENGTH }], workspaceRoot: WS },
      readDeps({ chrT: memDeps }, { [SRC]: SOURCE_STAT })
    );

    expect(result.hits).toBe(1);
    expect(result.misses).toBe(0);
    expect(result.byChrom.chrT.cacheState).toBe('hit');
    expect(JSON.parse(JSON.stringify(result.byChrom.chrT.features))).toEqual(
      JSON.parse(JSON.stringify(seededFeatures))
    );
    expect(man.gffPath).toMatch(/\.waypoint\/genome-index\/chrT-[a-z0-9]+\/chrT\.gff3\.gz$/);
  });

  it('uses an exact materialized manifest without re-hashing its indexed GFF as a raw source', async () => {
    const { man, memDeps } = await seedChrom({
      chrom: 'chrT',
      sourcePath: SRC,
      workspaceRoot: WS,
    });
    const statSource = vi.fn(async () => {
      throw new Error('the exact manifest must bypass raw-source path derivation');
    });

    const result = await readAssemblyOverviewCaches(
      {
        chromosomes: [
          {
            chrom: 'chrT',
            sourcePath: man.gffPath,
            manifest: man,
            length: LENGTH,
          },
        ],
        workspaceRoot: WS,
      },
      {
        ...readDeps({ chrT: memDeps }, {}),
        statSource,
      }
    );

    expect(result.hits).toBe(1);
    expect(result.misses).toBe(0);
    expect(statSource).not.toHaveBeenCalled();
  });

  it('MISS on changed source mtime (different index-dir hash → cache not found)', async () => {
    const { memDeps } = await seedChrom({ chrom: 'chrT', sourcePath: SRC, workspaceRoot: WS });
    const result = await readAssemblyOverviewCaches(
      { chromosomes: [{ chrom: 'chrT', sourcePath: SRC, length: LENGTH }], workspaceRoot: WS },
      readDeps({ chrT: memDeps }, { [SRC]: { ...SOURCE_STAT, mtimeMs: SOURCE_STAT.mtimeMs + 1 } })
    );
    expect(result.hits).toBe(0);
    expect(result.byChrom.chrT.cacheState).toBe('miss');
  });

  it('MISS on length mismatch (cache validates parsed.length === requested length)', async () => {
    const { memDeps } = await seedChrom({ chrom: 'chrT', sourcePath: SRC, workspaceRoot: WS });
    const result = await readAssemblyOverviewCaches(
      { chromosomes: [{ chrom: 'chrT', sourcePath: SRC, length: LENGTH + 1 }], workspaceRoot: WS },
      readDeps({ chrT: memDeps }, { [SRC]: SOURCE_STAT })
    );
    expect(result.hits).toBe(0);
    expect(result.byChrom.chrT.cacheState).toBe('miss');
  });

  it('MISS on fingerprint drift (an index file changed since the cache was written)', async () => {
    const ctimeRef = { value: 100 };
    const { memDeps } = await seedChrom({
      chrom: 'chrT',
      sourcePath: SRC,
      workspaceRoot: WS,
      ctimeRef,
    });
    ctimeRef.value = 999;
    const result = await readAssemblyOverviewCaches(
      { chromosomes: [{ chrom: 'chrT', sourcePath: SRC, length: LENGTH }], workspaceRoot: WS },
      readDeps({ chrT: memDeps }, { [SRC]: SOURCE_STAT })
    );
    expect(result.hits).toBe(0);
    expect(result.byChrom.chrT.cacheState).toBe('miss');
  });

  it('MISS on wrong workspaceRoot (different index dir)', async () => {
    const { memDeps } = await seedChrom({ chrom: 'chrT', sourcePath: SRC, workspaceRoot: WS });
    const result = await readAssemblyOverviewCaches(
      {
        chromosomes: [{ chrom: 'chrT', sourcePath: SRC, length: LENGTH }],
        workspaceRoot: '/other-ws',
      },
      readDeps({ chrT: memDeps }, { [SRC]: SOURCE_STAT })
    );
    expect(result.hits).toBe(0);
    expect(result.byChrom.chrT.cacheState).toBe('miss');
  });
});

describe('readAssemblyOverviewCaches — per-chromosome isolation (BLOCKER-2)', () => {
  it('one unsafe path misses ONLY that chromosome — the others still hit', async () => {
    const A = '/ws/src/chrA.gff3.gz';
    const B = '/ws/src/chrB.gff3.gz';
    const C = '/ws/src/chrC.gff3.gz';
    const a = await seedChrom({ chrom: 'chrA', sourcePath: A, workspaceRoot: WS });
    const c = await seedChrom({ chrom: 'chrC', sourcePath: C, workspaceRoot: WS });

    const result = await readAssemblyOverviewCaches(
      {
        chromosomes: [
          { chrom: 'chrA', sourcePath: A, length: LENGTH },
          { chrom: 'chrB', sourcePath: B, length: LENGTH },
          { chrom: 'chrC', sourcePath: C, length: LENGTH },
        ],
        workspaceRoot: WS,
      },
      readDeps(
        { chrA: a.memDeps, chrC: c.memDeps },
        { [A]: SOURCE_STAT, [B]: SOURCE_STAT, [C]: SOURCE_STAT },
        new Set([B])
      )
    );

    expect(result.hits).toBe(2);
    expect(result.misses).toBe(1);
    expect(result.byChrom.chrA.cacheState).toBe('hit');
    expect(result.byChrom.chrB.cacheState).toBe('miss');
    expect(result.byChrom.chrC.cacheState).toBe('hit');
  });

  it('a stat failure for one chromosome does not throw or zero the others', async () => {
    const A = '/ws/src/chrA.gff3.gz';
    const B = '/ws/src/chrB.gff3.gz';
    const a = await seedChrom({ chrom: 'chrA', sourcePath: A, workspaceRoot: WS });
    const result = await readAssemblyOverviewCaches(
      {
        chromosomes: [
          { chrom: 'chrA', sourcePath: A, length: LENGTH },
          { chrom: 'chrB', sourcePath: B, length: LENGTH },
        ],
        workspaceRoot: WS,
      },
      readDeps({ chrA: a.memDeps }, { [A]: SOURCE_STAT })
    );
    expect(result.byChrom.chrA.cacheState).toBe('hit');
    expect(result.byChrom.chrB.cacheState).toBe('miss');
    expect(result.hits).toBe(1);
  });
});

describe('readAssemblyOverviewCaches — trust-boundary guards', () => {
  const noopDeps: AssemblyOverviewDeps = { assertSafePath: async () => undefined };

  it('returns empty (no throw) when chromosomes is undefined', async () => {
    const result = await readAssemblyOverviewCaches(
      { chromosomes: undefined as unknown as AssemblyOverviewChromInput[], workspaceRoot: WS },
      noopDeps
    );
    expect(result).toEqual({ byChrom: {}, hits: 0, misses: 0 });
  });

  it('returns empty for an empty chromosome list', async () => {
    const result = await readAssemblyOverviewCaches(
      { chromosomes: [], workspaceRoot: WS },
      noopDeps
    );
    expect(result).toEqual({ byChrom: {}, hits: 0, misses: 0 });
  });

  it('allMissResult marks every chromosome a miss', () => {
    const chroms: AssemblyOverviewChromInput[] = [
      { chrom: 'chr1', sourcePath: '/a', length: 1 },
      { chrom: 'chr2', sourcePath: '/b', length: 2 },
    ];
    const r = allMissResult(chroms);
    expect(r).toEqual({
      byChrom: {
        chr1: { chrom: 'chr1', features: [], layerTypes: [], cacheState: 'miss' },
        chr2: { chrom: 'chr2', features: [], layerTypes: [], cacheState: 'miss' },
      },
      hits: 0,
      misses: 2,
    });
  });
});

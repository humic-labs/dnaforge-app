import { describe, expect, it } from 'vitest';
import {
  readAssemblyOverviewFeaturesCache,
  writeAssemblyOverviewFeaturesCache,
  writeAssemblyOverviewFeaturesCacheFromFragmentsV1,
  type AssemblyFeaturesCacheDeps,
  type CachedOverviewFeaturesByChrom,
} from './assembly-overview-features-cache';
import type { AssemblyOverviewChromInput } from '../../shared/indexed-genome';

const CHROMS: AssemblyOverviewChromInput[] = [
  { chrom: 'chr1', sourcePath: '/ws/chr1.gff3.gz', length: 248_956_422 },
  { chrom: 'chr2', sourcePath: '/ws/chr2.gff3.gz', length: 242_193_529 },
];

const STATS = {
  '/ws/chr1.gff3.gz': { size: 1000, mtimeMs: 111, ctimeMs: 5 },
  '/ws/chr2.gff3.gz': { size: 2000, mtimeMs: 222, ctimeMs: 6 },
};

const BY_CHROM: CachedOverviewFeaturesByChrom = {
  chr1: [{ id: 1, start: 10, end: 99, type: 'mRNA', exons: [{ start: 10, end: 40 }] }],
  chr2: [{ id: 2, start: 500, end: 900, type: 'gene' }],
};

function makeDeps(
  stats: Record<string, { size: number; mtimeMs: number; ctimeMs?: number }>,
  opts: { unsafe?: ReadonlySet<string> } = {}
): AssemblyFeaturesCacheDeps & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    assertSafePath: async (p) => {
      if (opts.unsafe?.has(p)) throw new Error(`unsafe ${p}`);
    },
    statSource: async (p) => {
      const s = stats[p];
      if (!s) throw new Error(`ENOENT ${p}`);
      return s;
    },
    readFileImpl: async (p) => {
      const f = files.get(p);
      if (!f) throw new Error(`ENOENT ${p}`);
      return f;
    },
    writeFileImpl: async (p, d) => {
      files.set(p, Buffer.isBuffer(d) ? d : Buffer.from(d));
    },
    mkdirImpl: async () => {},
  };
}

describe('assembly overview features cache', () => {
  it('write → read HITS and round-trips the byChrom payload', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewFeaturesCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        mode: 'canonical',
        byChrom: BY_CHROM,
      },
      deps
    );
    expect(written).not.toBeNull();
    expect(written!.featureCount).toBe(2);

    const read = await readAssemblyOverviewFeaturesCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws', mode: 'canonical' },
      deps
    );
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty('byChrom');
    expect(typeof read!.rawFileJson).toBe('string');
    const parsedFromRaw = JSON.parse(read!.rawFileJson!) as { byChrom: typeof BY_CHROM };
    expect(parsedFromRaw.byChrom).toEqual(BY_CHROM);
    expect(read!.manifest.fingerprint).toBe(written!.fingerprint);
  });

  it('writes identical bytes from serialized chromosome entries, integer-like names included', async () => {
    const chromosomes: AssemblyOverviewChromInput[] = [
      { chrom: 'X', sourcePath: '/ws/X.gff3.gz', length: 1_000 },
      { chrom: '10', sourcePath: '/ws/10.gff3.gz', length: 2_000 },
      { chrom: '2', sourcePath: '/ws/2.gff3.gz', length: 3_000 },
    ];
    const stats = Object.fromEntries(
      chromosomes.map((chromosome, index) => [
        chromosome.sourcePath!,
        { size: 10 + index, mtimeMs: 1 },
      ])
    );
    const byChrom: CachedOverviewFeaturesByChrom = {
      X: [{ id: 1, start: 10, end: 99, type: 'mRNA' }],
      '10': [],
      '2': [{ id: 2, start: 500, end: 900, type: 'gene' }],
    };
    const whole = makeDeps(stats);
    const sliced = makeDeps(stats);
    const input = { assemblyId: 'asm', chromosomes, workspaceRoot: '/ws', mode: 'expanded' };
    await writeAssemblyOverviewFeaturesCache({ ...input, byChrom }, whole);
    await writeAssemblyOverviewFeaturesCacheFromFragmentsV1(
      {
        ...input,
        fragments: chromosomes.map(
          (chromosome) => [chromosome.chrom, JSON.stringify(byChrom[chromosome.chrom])] as const
        ),
        featureCount: 2,
      },
      sliced
    );
    expect(whole.files.size).toBeGreaterThan(0);
    expect([...sliced.files.entries()]).toEqual([...whole.files.entries()]);
  });

  it('read MISSES (null) after a source re-index (stat change)', async () => {
    const deps = makeDeps(STATS);
    await writeAssemblyOverviewFeaturesCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        mode: 'canonical',
        byChrom: BY_CHROM,
      },
      deps
    );
    deps.statSource = async (p) =>
      p === '/ws/chr1.gff3.gz'
        ? { size: 9999, mtimeMs: 111, ctimeMs: 5 }
        : STATS[p as keyof typeof STATS];
    const read = await readAssemblyOverviewFeaturesCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws', mode: 'canonical' },
      deps
    );
    expect(read).toBeNull();
  });

  it('read MISSES (null) after the feature-processing/cache contract changes — old JSON stays on disk', async () => {
    const deps = Object.assign(makeDeps(STATS), { cacheContractToken: 'contract-a' });
    await writeAssemblyOverviewFeaturesCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        mode: 'canonical',
        byChrom: BY_CHROM,
      },
      deps
    );

    deps.cacheContractToken = 'contract-b';
    const read = await readAssemblyOverviewFeaturesCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws', mode: 'canonical' },
      deps
    );

    expect(read).toBeNull();
    expect(deps.files.size).toBeGreaterThan(0);
  });

  it('read MISSES (null) for a DIFFERENT isoform mode (mode is part of the key)', async () => {
    const deps = makeDeps(STATS);
    await writeAssemblyOverviewFeaturesCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        mode: 'canonical',
        byChrom: BY_CHROM,
      },
      deps
    );
    const expanded = await readAssemblyOverviewFeaturesCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws', mode: 'expanded' },
      deps
    );
    expect(expanded).toBeNull();
    const canonical = await readAssemblyOverviewFeaturesCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws', mode: 'canonical' },
      deps
    );
    expect(canonical).not.toBeNull();
  });

  it('read MISSES (null) when a chromosome path is unsafe (isolation → full load)', async () => {
    const writeDeps = makeDeps(STATS);
    await writeAssemblyOverviewFeaturesCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        mode: 'canonical',
        byChrom: BY_CHROM,
      },
      writeDeps
    );
    const readDeps: AssemblyFeaturesCacheDeps = {
      ...writeDeps,
      assertSafePath: async (p) => {
        if (p === '/ws/chr2.gff3.gz') throw new Error('unsafe');
      },
    };
    const read = await readAssemblyOverviewFeaturesCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws', mode: 'canonical' },
      readDeps
    );
    expect(read).toBeNull();
  });

  it('write returns null (no throw) when a chromosome is unstattable', async () => {
    const deps = makeDeps({ '/ws/chr1.gff3.gz': STATS['/ws/chr1.gff3.gz'] });
    const written = await writeAssemblyOverviewFeaturesCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        mode: 'canonical',
        byChrom: BY_CHROM,
      },
      deps
    );
    expect(written).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN } from '../../features/sequence/annotation-layer-identity';
import {
  ASSEMBLY_ANNOTATION_SCENE_COMPILER_CONTRACT,
  ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN,
  computeAssemblyTextureFingerprint,
  readAssemblyOverviewTextureCache,
  writeAssemblyOverviewTextureCache,
  type AssemblyTextureCacheDeps,
  type AssemblyTextureLayout,
} from './assembly-overview-texture-cache';
import type { AssemblyOverviewChromInput } from '../../shared/indexed-genome';

const CHROMS: AssemblyOverviewChromInput[] = [
  { chrom: 'chr1', sourcePath: '/ws/chr1.gff3.gz', length: 248_956_422 },
  { chrom: 'chr2', sourcePath: '/ws/chr2.gff3.gz', length: 242_193_529 },
  { chrom: 'chrX', sourcePath: '/ws/chrX.gff3.gz', length: 156_040_895 },
];

const CHROMS_WITH_UNANNOTATED_PLACEMENT: AssemblyOverviewChromInput[] = [
  { chrom: 'chr1', sourcePath: '/ws/chr1.gff3.gz', length: 248_956_422 },
  { chrom: 'chrM', sourcePath: null, length: 16_569 },
  { chrom: 'chr2', sourcePath: '/ws/chr2.gff3.gz', length: 242_193_529 },
];

const CHROMS_TOTAL_LENGTH = CHROMS.reduce((sum, chrom) => sum + chrom.length, 0);

const LAYOUT: AssemblyTextureLayout = {
  widthPx: 8192,
  heightPx: 1059,
  resolution: 2,
  spineOffsetPx: 366,
  genomeLength: CHROMS_TOTAL_LENGTH,
  maxAnnotationLane: 17,
  maxCdsLane: 4,
  layerTypes: ['mRNA', 'CDS', 'gene'],
};

function makeDeps(
  stats: Record<string, { size: number; mtimeMs: number; ctimeMs?: number }>,
  opts: { unsafe?: ReadonlySet<string> } = {}
): AssemblyTextureCacheDeps & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    assertSafePath: async (p) => {
      if (opts.unsafe?.has(p)) throw new Error(`unsafe path ${p}`);
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
    readdirImpl: async (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...files.keys()]
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length))
        .filter((name) => !name.includes('/'))
        .sort((a, b) => a.localeCompare(b));
    },
    statCacheFile: async (p) => {
      if (!files.has(p)) throw new Error(`ENOENT ${p}`);
      return { mtimeMs: 1 };
    },
    writeFileImpl: async (p, d) => {
      files.set(p, Buffer.isBuffer(d) ? d : Buffer.from(d));
    },
    mkdirImpl: async () => {},
  };
}

const STATS = {
  '/ws/chr1.gff3.gz': { size: 1000, mtimeMs: 111, ctimeMs: 5 },
  '/ws/chr2.gff3.gz': { size: 2000, mtimeMs: 222, ctimeMs: 6 },
  '/ws/chrX.gff3.gz': { size: 3000, mtimeMs: 333, ctimeMs: 7 },
};

function pngHeaderBase64(widthPx: number, heightPx: number, resolution: number): string {
  const width = Math.round(widthPx * resolution);
  const height = Math.round(heightPx * resolution);
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  b[24] = 8;
  b[25] = 6;
  return b.toString('base64');
}

const PNG_B64 = pngHeaderBase64(LAYOUT.widthPx, LAYOUT.heightPx, LAYOUT.resolution);

describe('assembly overview texture fingerprint', () => {
  it('binds persisted feature and scene caches to the layer-identity contract', () => {
    expect(ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN).toContain(
      ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN
    );
    expect(ASSEMBLY_ANNOTATION_SCENE_COMPILER_CONTRACT).toContain(
      ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN
    );
  });

  it('invalidates PNGs produced before the runtime texture presenter deletion', () => {
    expect(ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN).toContain('runtime-texture-presenter-deleted');
  });

  it('is deterministic and order-sensitive because the raster encodes chromosome placement', async () => {
    const deps = makeDeps(STATS);
    const a = await computeAssemblyTextureFingerprint(CHROMS, deps);
    const b = await computeAssemblyTextureFingerprint(CHROMS, deps);
    const reordered = await computeAssemblyTextureFingerprint([...CHROMS].reverse(), deps);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(reordered).not.toBe(a);
  });

  it('changes when ANY chromosome source stat changes (auto-stale on re-index)', async () => {
    const base = await computeAssemblyTextureFingerprint(CHROMS, makeDeps(STATS));
    const mtime = await computeAssemblyTextureFingerprint(
      CHROMS,
      makeDeps({ ...STATS, '/ws/chr2.gff3.gz': { size: 2000, mtimeMs: 999, ctimeMs: 6 } })
    );
    const size = await computeAssemblyTextureFingerprint(
      CHROMS,
      makeDeps({ ...STATS, '/ws/chr1.gff3.gz': { size: 9999, mtimeMs: 111, ctimeMs: 5 } })
    );
    expect(mtime).not.toBe(base);
    expect(size).not.toBe(base);
  });

  it('changes when a chromosome length changes (manifest mismatch)', async () => {
    const base = await computeAssemblyTextureFingerprint(CHROMS, makeDeps(STATS));
    const longer = await computeAssemblyTextureFingerprint(
      [{ ...CHROMS[0], length: CHROMS[0].length + 1 }, CHROMS[1], CHROMS[2]],
      makeDeps(STATS)
    );
    expect(longer).not.toBe(base);
  });

  it('changes when an unannotated chromosome changes the assembly placement', async () => {
    const withChrM = await computeAssemblyTextureFingerprint(
      CHROMS_WITH_UNANNOTATED_PLACEMENT,
      makeDeps(STATS)
    );
    const omittedChrM = await computeAssemblyTextureFingerprint(
      [CHROMS_WITH_UNANNOTATED_PLACEMENT[0], CHROMS_WITH_UNANNOTATED_PLACEMENT[2]],
      makeDeps(STATS)
    );

    expect(withChrM).toBeTruthy();
    expect(omittedChrM).toBeTruthy();
    expect(withChrM).not.toBe(omittedChrM);
  });

  it('changes when the renderer/cache contract token changes', async () => {
    const contractA = Object.assign(makeDeps(STATS), { cacheContractToken: 'contract-a' });
    const contractB = Object.assign(makeDeps(STATS), { cacheContractToken: 'contract-b' });

    const base = await computeAssemblyTextureFingerprint(CHROMS, contractA);
    const changed = await computeAssemblyTextureFingerprint(CHROMS, contractB);

    expect(changed).not.toBe(base);
  });

  it('changes when the bundled app source fingerprint changes', async () => {
    const buildA = Object.assign(makeDeps(STATS), { sourceBuildFingerprint: 'build-a' });
    const buildB = Object.assign(makeDeps(STATS), { sourceBuildFingerprint: 'build-b' });

    const base = await computeAssemblyTextureFingerprint(CHROMS, buildA);
    const changed = await computeAssemblyTextureFingerprint(CHROMS, buildB);

    expect(changed).not.toBe(base);
  });

  it('normalizes source paths relative to the workspace so worktree path changes do not stale the artifact', async () => {
    const chromsA: AssemblyOverviewChromInput[] = [
      { chrom: 'chr1', sourcePath: '/worktree-a/sources/chr1.gff3.gz', length: 248_956_422 },
      { chrom: 'chr2', sourcePath: '/worktree-a/sources/chr2.gff3.gz', length: 242_193_529 },
    ];
    const chromsB: AssemblyOverviewChromInput[] = [
      { chrom: 'chr1', sourcePath: '/worktree-b/sources/chr1.gff3.gz', length: 248_956_422 },
      { chrom: 'chr2', sourcePath: '/worktree-b/sources/chr2.gff3.gz', length: 242_193_529 },
    ];
    const statsA = {
      '/worktree-a/sources/chr1.gff3.gz': { size: 1000, mtimeMs: 111, ctimeMs: 5 },
      '/worktree-a/sources/chr2.gff3.gz': { size: 2000, mtimeMs: 222, ctimeMs: 6 },
    };
    const statsB = {
      '/worktree-b/sources/chr1.gff3.gz': { size: 1000, mtimeMs: 111, ctimeMs: 5 },
      '/worktree-b/sources/chr2.gff3.gz': { size: 2000, mtimeMs: 222, ctimeMs: 6 },
    };

    const a = await computeAssemblyTextureFingerprint(
      chromsA,
      Object.assign(makeDeps(statsA), { workspaceRoot: '/worktree-a' })
    );
    const b = await computeAssemblyTextureFingerprint(
      chromsB,
      Object.assign(makeDeps(statsB), { workspaceRoot: '/worktree-b' })
    );

    expect(a).toBeTruthy();
    expect(b).toBe(a);
  });

  it('is null (uncomputable) when any chromosome path is unsafe — isolation, not throw', async () => {
    const deps = makeDeps(STATS, { unsafe: new Set(['/ws/chrX.gff3.gz']) });
    expect(await computeAssemblyTextureFingerprint(CHROMS, deps)).toBeNull();
  });

  it('is null when any chromosome is unstattable (missing source)', async () => {
    const deps = makeDeps({ '/ws/chr1.gff3.gz': STATS['/ws/chr1.gff3.gz'] });
    expect(await computeAssemblyTextureFingerprint(CHROMS, deps)).toBeNull();
  });

  it('is null when no chromosome has an annotation source', async () => {
    const deps = makeDeps(STATS);
    expect(
      await computeAssemblyTextureFingerprint(
        CHROMS.map(({ chrom, length }) => ({ chrom, length, sourcePath: null })),
        deps
      )
    ).toBeNull();
  });
});

describe('assembly overview texture read/write round-trip', () => {
  it('write → read HITS with a byte-exact PNG + layout manifest', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );
    expect(written).not.toBeNull();

    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );
    expect(read).not.toBeNull();
    expect(read!.pngBase64).toBe(PNG_B64);
    expect(read!.manifest.spineOffsetPx).toBe(LAYOUT.spineOffsetPx);
    expect(read!.manifest.genomeLength).toBe(LAYOUT.genomeLength);
    expect(read!.manifest.maxAnnotationLane).toBe(LAYOUT.maxAnnotationLane);
    expect(read!.manifest.maxCdsLane).toBe(LAYOUT.maxCdsLane);
    expect(read!.manifest.layerTypes).toEqual(['CDS', 'gene', 'mRNA']);
    expect(read!.manifest.fingerprint).toBe(written!.fingerprint);
    expect(read!.manifest.placementSignature).toContain(
      'placement:ordered-linear-assembly-placement-v1'
    );
    expect(read!.manifest.placementSignature).toContain('0|chr1|0|248956422|248956422');
    expect(read!.manifest.placementSignature).toContain('1|chr2|248956422|491149951|242193529');
  });

  it('read MISSES (null) after a source re-index — the stale texture is not served', async () => {
    const deps = makeDeps(STATS);
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );
    deps.statSource = async (p) =>
      p === '/ws/chr2.gff3.gz'
        ? { size: 2000, mtimeMs: 999, ctimeMs: 6 }
        : STATS[p as keyof typeof STATS];
    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );
    expect(read).toBeNull();
  });

  it('read MISSES (null) after the renderer/cache contract changes — old PNG stays on disk', async () => {
    const deps = Object.assign(makeDeps(STATS), { cacheContractToken: 'contract-a' });
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );

    deps.cacheContractToken = 'contract-b';
    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );

    expect(read).toBeNull();
    expect(deps.files.size).toBeGreaterThan(0);
  });

  it('read HITS through a verified build-fingerprint alias after bundled app source changes', async () => {
    const deps = Object.assign(makeDeps(STATS), { sourceBuildFingerprint: 'build-a' });
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );

    deps.sourceBuildFingerprint = 'build-b';
    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );

    expect(read).not.toBeNull();
    expect(read!.pngBase64).toBe(PNG_B64);
    expect(read!.manifest.sourceBuildFingerprint).toBe('build-a');
    expect(deps.files.size).toBeGreaterThan(0);
  });

  it('write MISSES (null) when the PNG header does not match the declared layout', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: pngHeaderBase64(LAYOUT.widthPx + 1, LAYOUT.heightPx, LAYOUT.resolution),
        layout: LAYOUT,
      },
      deps
    );
    expect(written).toBeNull();
  });

  it('write MISSES (null) when the layout genome length does not match placement total', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: { ...LAYOUT, genomeLength: LAYOUT.genomeLength + 1 },
      },
      deps
    );
    expect(written).toBeNull();
  });

  it('write MISSES (null) when the texture omits its annotation content contract', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: { ...LAYOUT, layerTypes: [] },
      },
      deps
    );
    expect(written).toBeNull();
  });

  it('read MISSES (null) when the manifest assembly id is hand-corrupted', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );
    const manifest = JSON.parse(deps.files.get(written!.manifestPath)!.toString('utf-8'));
    manifest.assemblyId = 'hg19';
    deps.files.set(written!.manifestPath, Buffer.from(JSON.stringify(manifest)));

    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );
    expect(read).toBeNull();
  });

  it('read MISSES (null) when the manifest genome length is hand-corrupted', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );
    const manifest = JSON.parse(deps.files.get(written!.manifestPath)!.toString('utf-8'));
    manifest.genomeLength = LAYOUT.genomeLength + 1;
    deps.files.set(written!.manifestPath, Buffer.from(JSON.stringify(manifest)));

    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );
    expect(read).toBeNull();
  });

  it('read MISSES (null) when an old manifest lacks annotation layout metadata', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );
    const manifest = JSON.parse(deps.files.get(written!.manifestPath)!.toString('utf-8'));
    delete manifest.maxAnnotationLane;
    deps.files.set(written!.manifestPath, Buffer.from(JSON.stringify(manifest)));

    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );
    expect(read).toBeNull();
  });

  it('read MISSES (null) when the same chromosome sources are requested in a different placement order', async () => {
    const deps = makeDeps(STATS);
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );

    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: [...CHROMS].reverse(), workspaceRoot: '/ws' },
      deps
    );

    expect(read).toBeNull();
  });

  it('read MISSES (null) when the manifest exists but the PNG is absent', async () => {
    const deps = makeDeps(STATS);
    const written = await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );
    deps.files.delete(written!.pngPath);
    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );
    expect(read).toBeNull();
  });

  it('read MISSES (null) when a chromosome path is unsafe (isolation, not throw)', async () => {
    const writeDeps = makeDeps(STATS);
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      writeDeps
    );
    const readDeps: AssemblyTextureCacheDeps = {
      ...writeDeps,
      assertSafePath: async (p) => {
        if (p === '/ws/chr1.gff3.gz') throw new Error('unsafe');
      },
    };
    const read = await readAssemblyOverviewTextureCache(
      { assemblyId: 'grch38', chromosomes: CHROMS, workspaceRoot: '/ws' },
      readDeps
    );
    expect(read).toBeNull();
  });

  it('different assemblies do not collide in the cache', async () => {
    const deps = makeDeps(STATS);
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: 'grch38',
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: PNG_B64,
        layout: LAYOUT,
      },
      deps
    );
    const other = await readAssemblyOverviewTextureCache(
      { assemblyId: 'hg19', chromosomes: CHROMS, workspaceRoot: '/ws' },
      deps
    );
    expect(other).toBeNull();
  });
});

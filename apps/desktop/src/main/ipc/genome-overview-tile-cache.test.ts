import { describe, expect, it, vi } from 'vitest';

import type { GenomeFeature, IndexedGenomeManifest } from '@waypoint/genome-data';
import type { GenomeTileRequest } from '../../shared/indexed-genome';
import { ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN } from '../../features/sequence/annotation-layer-identity';
import {
  OVERVIEW_CACHE_CONTRACT_TOKEN,
  getCachedAnnotationOverviewTile,
  getCachedOrStartAnnotationOverviewTileBuild,
  getOrCreateAnnotationOverviewTile,
  overviewCachePathForManifest,
  type OverviewTileCacheDeps,
} from './genome-overview-tile-cache';

function feat(
  overrides: Partial<GenomeFeature> & Pick<GenomeFeature, 'type' | 'start' | 'end'>
): GenomeFeature {
  return {
    chrom: overrides.chrom ?? 'chr11',
    source: overrides.source ?? 'test',
    type: overrides.type,
    start: overrides.start,
    end: overrides.end,
    score: overrides.score ?? null,
    strand: overrides.strand ?? '+',
    phase: overrides.phase ?? null,
    attributes: overrides.attributes ?? {},
    raw: overrides.raw ?? `${overrides.type}\t${overrides.start}\t${overrides.end}`,
  };
}

function manifest(): IndexedGenomeManifest {
  return {
    chrom: 'chr11',
    fastaPath: '/workspace/.waypoint/genome-index/chr11/chr11.fa',
    faiPath: '/workspace/.waypoint/genome-index/chr11/chr11.fa.fai',
    gffPath: '/workspace/.waypoint/genome-index/chr11/chr11.gff3.gz',
    tbiPath: '/workspace/.waypoint/genome-index/chr11/chr11.gff3.gz.tbi',
    length: 10_000,
  };
}

function summaryRequest(): GenomeTileRequest {
  return {
    trackId: 'chr11:annotations',
    chrom: 'chr11',
    start: 0,
    end: 10_000,
    lod: 0,
    generation: 1,
    fidelity: 'summary',
    byteBudget: 4_000_000,
  };
}

function rawTranscriptRows(): GenomeFeature[] {
  return [
    feat({ type: 'gene', start: 100, end: 900, attributes: { ID: ['gene-1'] } }),
    feat({
      type: 'mRNA',
      start: 100,
      end: 900,
      attributes: { ID: ['tx-1'], Parent: ['gene-1'] },
    }),
    feat({ type: 'exon', start: 100, end: 200, attributes: { Parent: ['tx-1'] } }),
    feat({ type: 'exon', start: 700, end: 900, attributes: { Parent: ['tx-1'] } }),
    feat({ type: 'CDS', start: 130, end: 180, attributes: { Parent: ['tx-1'] } }),
  ];
}

describe('genome overview tile cache', () => {
  it('binds persisted per-chromosome summaries to the layer-identity contract', () => {
    expect(OVERVIEW_CACHE_CONTRACT_TOKEN).toContain(ANNOTATION_LAYER_IDENTITY_CONTRACT_TOKEN);
  });

  it('uses a v8 cache path so generator-unbound old overview files are never reused', () => {
    expect(overviewCachePathForManifest(manifest())).toMatch(/annotation-overview\.v8\.json$/);
  });

  it('persists resolved transcript overview tiles and reuses them without raw GFF3 reads', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    const loadRawFeatures = vi.fn().mockResolvedValue(rawTranscriptRows());

    const first = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures,
      deps,
      now: () => 111,
    });

    expect(first.cacheState).toBe('written');
    expect(first.featureModel).toBe('resolved-transcript-v2');
    expect(first.sourceRecordCount).toBe(5);
    expect(first.sourceRepresentationComplete).toBe(true);
    expect(first.layerTypes).toEqual(['CDS', 'exon', 'gene', 'mRNA']);
    expect(loadRawFeatures).toHaveBeenCalledTimes(1);
    const cacheJson = deps.files.get(overviewCachePathForManifest(man));
    expect(cacheJson).toBeDefined();
    expect(cacheJson).toContain(OVERVIEW_CACHE_CONTRACT_TOKEN);
    expect(cacheJson).not.toContain('exon\t100\t200');

    const gene = first.features.find(
      (feature): feature is GenomeFeature & { transcripts: Array<{ cds: unknown[] }> } =>
        'transcripts' in feature
    );
    expect(gene?.transcripts[0]?.cds).toEqual([{ start: 131, end: 180 }]);
    expect(gene?.raw).toBe('');

    const failIfRawRead = vi.fn().mockRejectedValue(new Error('raw read should not happen'));
    const second = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures: failIfRawRead,
      deps,
      now: () => 222,
    });

    expect(second.cacheState).toBe('hit');
    expect(second.features).toEqual(first.features);
    expect(second.sourceRepresentationComplete).toBe(true);
    expect(second.layerTypes).toEqual(first.layerTypes);
    expect(failIfRawRead).not.toHaveBeenCalled();
  });

  it('can persist worker-built overview payloads without transferring raw features to main', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    const loadRawFeatures = vi.fn().mockRejectedValue(new Error('raw read should stay in worker'));
    const buildOverviewTile = vi.fn().mockResolvedValue({
      features: [
        feat({
          type: 'gene',
          start: 100,
          end: 900,
          attributes: { ID: ['gene-worker'] },
          raw: '',
        }),
      ],
      featureModel: 'resolved-transcript-v2',
      sourceRecordCount: 249_954,
      layerTypes: ['CDS', 'exon', 'gene', 'mRNA'],
    });

    const result = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures,
      buildOverviewTile,
      deps,
      now: () => 111,
    });

    expect(result.cacheState).toBe('written');
    expect(result.sourceRecordCount).toBe(249_954);
    expect(result.features).toHaveLength(1);
    expect(buildOverviewTile).toHaveBeenCalledTimes(1);
    expect(loadRawFeatures).not.toHaveBeenCalled();
    expect(deps.files.get(overviewCachePathForManifest(man))).toContain('gene-worker');
  });

  it('invalidates subtype-stripped v2 overview payloads even when their file fingerprint matches', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    const cachePath = overviewCachePathForManifest(man);
    deps.files.set(
      cachePath,
      JSON.stringify({
        schemaVersion: 2,
        featureModel: 'resolved-transcript-v2',
        chrom: 'chr11',
        length: 10_000,
        sourceFingerprint: await deps.fingerprint(man),
        sourceRecordCount: 1,
        createdAt: 1,
        features: [
          feat({
            type: 'ncRNA',
            start: 100,
            end: 500,
            attributes: { ID: ['lnc-1'] },
          }),
        ],
      })
    );
    const loadRawFeatures = vi.fn().mockResolvedValue([
      feat({
        type: 'ncRNA',
        start: 100,
        end: 500,
        attributes: { ID: ['lnc-1'], ncRNA_class: ['lncRNA'] },
      }),
    ]);

    const result = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures,
      deps,
      now: () => 111,
    });

    expect(result.cacheState).toBe('written');
    expect(loadRawFeatures).toHaveBeenCalledTimes(1);
    expect(result.layerTypes).toEqual(['lncRNA']);
    expect(result.features[0]?.attributes.ncRNA_class).toEqual(['lncRNA']);
    expect(deps.files.get(cachePath)).toContain('"schemaVersion":6');
  });

  it('invalidates overview payloads when the renderer cache contract token is missing', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    const cachePath = overviewCachePathForManifest(man);
    deps.files.set(
      cachePath,
      JSON.stringify({
        schemaVersion: 5,
        featureModel: 'resolved-transcript-v2',
        chrom: 'chr11',
        length: 10_000,
        sourceFingerprint: await deps.fingerprint(man),
        sourceRecordCount: 1,
        layerTypes: ['mRNA'],
        createdAt: 1,
        features: [
          feat({
            type: 'mRNA',
            start: 100,
            end: 500,
            attributes: { ID: ['old-contract'] },
          }),
        ],
      })
    );
    const loadRawFeatures = vi.fn().mockResolvedValue([
      feat({
        type: 'mRNA',
        start: 100,
        end: 500,
        attributes: { ID: ['fresh-contract'] },
      }),
    ]);

    const result = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures,
      deps,
      now: () => 222,
    });

    expect(result.cacheState).toBe('written');
    expect(loadRawFeatures).toHaveBeenCalledTimes(1);
    expect(result.features[0]?.attributes.ID).toEqual(['fresh-contract']);
    expect(deps.files.get(cachePath)).toContain(OVERVIEW_CACHE_CONTRACT_TOKEN);
  });

  it('invalidates overview payloads when the bundled app source fingerprint changes', async () => {
    const man = manifest();
    const deps = Object.assign(createMemoryDeps(man, { ctimeMs: 100 }), {
      sourceBuildFingerprint: 'build-a',
    });
    const firstLoad = vi.fn().mockResolvedValue([
      feat({
        type: 'mRNA',
        start: 100,
        end: 500,
        attributes: { ID: ['old-generator'] },
      }),
    ]);

    await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures: firstLoad,
      deps,
      now: () => 111,
    });

    const cachePath = overviewCachePathForManifest(man);
    expect(deps.files.get(cachePath)).toContain('"sourceBuildFingerprint":"build-a"');

    deps.sourceBuildFingerprint = 'build-b';
    const secondLoad = vi.fn().mockResolvedValue([
      feat({
        type: 'mRNA',
        start: 100,
        end: 500,
        attributes: { ID: ['fresh-generator'] },
      }),
    ]);

    const afterBuildChange = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures: secondLoad,
      deps,
      now: () => 222,
    });

    expect(secondLoad).toHaveBeenCalledTimes(1);
    expect(afterBuildChange.cacheState).toBe('written');
    expect(afterBuildChange.features[0]?.attributes.ID).toEqual(['fresh-generator']);
  });

  it('never replaces a prior complete summary with an interrupted write', async () => {
    const man = manifest();
    const deps = Object.assign(createMemoryDeps(man, { ctimeMs: 100 }), {
      sourceBuildFingerprint: 'build-a',
    });
    const cachePath = overviewCachePathForManifest(man);

    const original = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures: async () => [
        feat({
          type: 'mRNA',
          start: 100,
          end: 500,
          attributes: { ID: ['prior-complete'] },
        }),
      ],
      deps,
      now: () => 111,
    });
    expect(original.cacheState).toBe('written');
    const priorBytes = deps.files.get(cachePath);
    expect(priorBytes).toContain('prior-complete');

    deps.sourceBuildFingerprint = 'build-b';
    deps.writeFile = async (path, content) => {
      expect(path).toContain('.tmp-');
      deps.files.set(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))));
      throw new Error('simulated interrupted write');
    };

    const interrupted = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures: async () => [
        feat({
          type: 'mRNA',
          start: 600,
          end: 900,
          attributes: { ID: ['torn-replacement'] },
        }),
      ],
      deps,
      now: () => 222,
    });

    expect(interrupted.cacheState).toBe('miss');
    expect(deps.files.get(cachePath)).toBe(priorBytes);
    expect([...deps.files.keys()].filter((path) => path.includes('.tmp-'))).toEqual([]);
    expect(await getCachedAnnotationOverviewTile({ manifest: man, deps })).toBeNull();

    deps.sourceBuildFingerprint = 'build-a';
    const restoredPrior = await getCachedAnnotationOverviewTile({ manifest: man, deps });
    expect(restoredPrior?.features[0]?.attributes.ID).toEqual(['prior-complete']);
  });

  it('prunes component-only rows from the overview payload while preserving layer identity', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    const loadRawFeatures = vi.fn().mockResolvedValue([
      ...rawTranscriptRows(),
      feat({
        type: 'exon',
        start: 1200,
        end: 1300,
        attributes: { ID: ['orphan-exon'] },
      }),
      feat({
        type: 'CDS',
        start: 1400,
        end: 1500,
        attributes: { ID: ['orphan-cds'] },
      }),
      feat({
        type: 'misc_feature',
        start: 1600,
        end: 1700,
        attributes: { ID: ['broad-misc'] },
      }),
      feat({
        type: 'regulatory',
        start: 1800,
        end: 1900,
        attributes: { ID: ['regulatory-1'] },
      }),
      feat({
        type: 'centromere',
        start: 2000,
        end: 2100,
        attributes: { ID: ['centromere-1'] },
      }),
      feat({ type: 'source', start: 0, end: 10_000, attributes: { ID: ['source-1'] } }),
    ]);

    const result = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures,
      deps,
      now: () => 111,
    });

    const payloadTypes = result.features.map((feature) => feature.type);
    expect(payloadTypes).toContain('gene');
    expect(payloadTypes).toContain('regulatory');
    expect(payloadTypes).toContain('centromere');
    expect(payloadTypes).not.toContain('exon');
    expect(payloadTypes).not.toContain('CDS');
    expect(payloadTypes).not.toContain('misc_feature');
    expect(payloadTypes).not.toContain('source');
    expect(result.layerTypes).toEqual([
      'CDS',
      'centromere',
      'exon',
      'gene',
      'misc_feature',
      'mRNA',
      'regulatory',
    ]);
  });

  it('invalidates the persistent overview cache when ctime changes at same size and mtime', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    const firstLoad = vi.fn().mockResolvedValue(rawTranscriptRows());

    await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures: firstLoad,
      deps,
      now: () => 111,
    });

    deps.setCtimeMs(200);
    const secondLoad = vi
      .fn()
      .mockResolvedValue([
        feat({ type: 'gene', start: 1000, end: 1200, attributes: { ID: ['gene-2'] } }),
      ]);
    const afterRewrite = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures: secondLoad,
      deps,
      now: () => 222,
    });

    expect(secondLoad).toHaveBeenCalledTimes(1);
    expect(afterRewrite.cacheState).toBe('written');
    expect(afterRewrite.sourceRecordCount).toBe(1);
    expect(afterRewrite.features[0]?.attributes.ID).toEqual(['gene-2']);
  });

  it('preserves ncRNA_class so lncRNA can be exposed as a toolbar layer', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    const loadRawFeatures = vi.fn().mockResolvedValue([
      feat({
        type: 'ncRNA',
        start: 100,
        end: 500,
        attributes: { ID: ['lnc-1'], ncRNA_class: ['lncRNA'], product: ['test lncRNA'] },
      }),
      feat({ type: 'exon', start: 100, end: 250, attributes: { Parent: ['lnc-1'] } }),
      feat({ type: 'exon', start: 400, end: 500, attributes: { Parent: ['lnc-1'] } }),
    ]);

    const result = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures,
      deps,
      now: () => 111,
    });

    expect(result.features[0]?.attributes.ncRNA_class).toEqual(['lncRNA']);
    expect(result.layerTypes).toEqual(['exon', 'lncRNA']);
    expect(deps.files.get(overviewCachePathForManifest(man))).toContain('ncRNA_class');
  });

  it('preserves indexed _lane attributes for stable overview/detail lanes', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    const loadRawFeatures = vi.fn().mockResolvedValue([
      feat({
        type: 'mRNA',
        start: 100,
        end: 500,
        attributes: { ID: ['tx-stable-lane'], _lane: ['12'] },
      }),
    ]);

    const result = await getOrCreateAnnotationOverviewTile({
      manifest: man,
      request: summaryRequest(),
      loadRawFeatures,
      deps,
      now: () => 111,
    });

    expect(result.features[0]?.attributes._lane).toEqual(['12']);
    expect(deps.files.get(overviewCachePathForManifest(man))).toContain('_lane');
  });

  it('starts a missing summary build without awaiting raw GFF3 reads on the caller', async () => {
    const man = manifest();
    const deps = createMemoryDeps(man, { ctimeMs: 100 });
    let resolveRawFeatures: ((features: GenomeFeature[]) => void) | undefined;
    const rawFeaturesPromise = new Promise<GenomeFeature[]>((resolve) => {
      resolveRawFeatures = resolve;
    });
    const loadRawFeatures = vi.fn().mockReturnValue(rawFeaturesPromise);

    const started = await getCachedOrStartAnnotationOverviewTileBuild({
      manifest: man,
      loadRawFeatures,
      deps,
      now: () => 111,
    });

    expect(started.status).toBe('building');
    expect(loadRawFeatures).toHaveBeenCalledTimes(1);
    expect(deps.files.has(overviewCachePathForManifest(man))).toBe(false);

    resolveRawFeatures?.(rawTranscriptRows());
    if (started.status === 'building') await started.completion;
    await waitForMemoryFile(deps.files, overviewCachePathForManifest(man));

    expect(loadRawFeatures).toHaveBeenCalledTimes(1);

    const cached = await getCachedOrStartAnnotationOverviewTileBuild({
      manifest: man,
      loadRawFeatures: vi.fn().mockRejectedValue(new Error('cache hit should not load raw')),
      deps,
      now: () => 333,
    });
    expect(cached.status).toBe('cached');
    if (cached.status !== 'cached') throw new Error('Expected a cached overview tile');
    expect(cached.result.cacheState).toBe('hit');
  });
});

function createMemoryDeps(
  man: IndexedGenomeManifest,
  options: { ctimeMs: number }
): OverviewTileCacheDeps & {
  files: Map<string, string>;
  setCtimeMs(next: number): void;
  fingerprint(manifest: IndexedGenomeManifest): Promise<string>;
} {
  const files = new Map<string, string>();
  let ctimeMs = options.ctimeMs;
  const sourcePaths = [man.fastaPath, man.faiPath, man.gffPath!, man.tbiPath!];

  const deps: OverviewTileCacheDeps & {
    files: Map<string, string>;
    setCtimeMs(next: number): void;
    fingerprint(manifest: IndexedGenomeManifest): Promise<string>;
  } = {
    files,
    setCtimeMs(next) {
      ctimeMs = next;
    },
    async fingerprint(manifest) {
      const parts = await Promise.all(
        [manifest.fastaPath, manifest.faiPath, manifest.gffPath!, manifest.tbiPath!].map(
          async (path) => {
            const [resolvedPath, sourceStat] = await Promise.all([
              deps.realpath(path),
              deps.stat(path),
            ]);
            return [
              resolvedPath,
              sourceStat.size,
              Math.trunc(sourceStat.mtimeMs),
              Math.trunc(sourceStat.ctimeMs ?? 0),
              sourceStat.dev ?? 'dev-unknown',
              sourceStat.ino ?? 'ino-unknown',
            ].join(':');
          }
        )
      );
      return parts.join('|');
    },
    async mkdir() {},
    async realpath(path) {
      return path;
    },
    async stat(path) {
      if (!sourcePaths.includes(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return {
        size: path.endsWith('.gff3.gz') ? 500 : 100,
        mtimeMs: 1234,
        ctimeMs,
        dev: 1,
        ino: sourcePaths.indexOf(path) + 10,
      };
    },
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return value;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async rename(fromPath, toPath) {
      const content = files.get(fromPath);
      if (content === undefined) {
        const err = new Error(`ENOENT: ${fromPath}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.set(toPath, content);
      files.delete(fromPath);
    },
    async unlink(path) {
      if (!files.delete(path)) {
        const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    },
  };

  return deps;
}

async function waitForMemoryFile(files: Map<string, string>, path: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (files.has(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for memory file: ${path}`);
}

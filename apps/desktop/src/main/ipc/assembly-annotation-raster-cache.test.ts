import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  isPrebuiltAnnotationRasterLaneProjectionV1,
  isPrebuiltAnnotationRasterPresentationReceiptV1,
} from '@waypoint/genome-renderer/pure';
import { describe, expect, it } from 'vitest';
import {
  ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN,
  assemblyAnnotationRasterFileNamesV2,
  computeAssemblyAnnotationRasterCacheFingerprintV2,
  computeAssemblyAnnotationSceneSourceFingerprint,
  readAssemblyAnnotationRasterCacheV2,
  validateAssemblyAnnotationRasterProjectionArtifactV2,
  type AssemblyTextureCacheDeps,
} from './assembly-overview-texture-cache';
import {
  ASSEMBLY_ANNOTATION_RASTER_LANE_COMPLETE_SOURCE_V1,
  ASSEMBLY_ANNOTATION_RASTER_MANIFEST_V2,
  ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1,
  assemblyAnnotationRasterLaneProjectionV1,
  assemblyAnnotationRasterVariantKeyV2,
  assemblyAnnotationSceneScopeForRequest,
  createAssemblyAnnotationRasterVariantV2,
  isAssemblyAnnotationRasterVariantV2,
  type AssemblyAnnotationRasterReadRequestV2,
  type AssemblyOverviewChromInput,
} from '../../shared/indexed-genome';
import { areMaterializedFixtureFiles } from '../../test/fixture-availability';

const CHROMOSOMES: AssemblyOverviewChromInput[] = [
  { chrom: 'chr1', sourcePath: '/ws/chr1.gff3.gz', length: 100 },
  { chrom: 'chr2', sourcePath: '/ws/chr2.gff3.gz', length: 200 },
];
const STATS = {
  '/ws/chr1.gff3.gz': { size: 101, mtimeMs: 11, ctimeMs: 1 },
  '/ws/chr2.gff3.gz': { size: 202, mtimeMs: 22, ctimeMs: 2 },
};
const SOURCE_BUILD_FINGERPRINT = 'a'.repeat(64);
const DATASET_CONTRACT = {
  datasetId: 'grch38-refseq',
  datasetVersion: '2026-07',
  sourceSha256: 'd'.repeat(64),
};
const GENOME_IDENTITY = `assembly-annotation-source-sha256.v1:${DATASET_CONTRACT.sourceSha256}`;
const CACHE_DIR = '/ws/.waypoint/genome-index/assembly-overview';
const GENERATED_RASTER_FIXTURE_DIR = resolve(
  __dirname,
  '../../../../../test-fixtures/.waypoint/genome-index/assembly-overview'
);
const GENERATED_VARIANT_MANIFEST_FILES = [
  'grch38-50bab36cd67cf3f9c093560e-b7da634b179f4aa43529.annotation-raster.v2.json',
  'grch38-f364add98d1dae8d4ebfba37-45dfcf8970dca3fe7cfb.annotation-raster.v2.json',
] as const;
const GENERATED_CAP8_SOURCE_STEM =
  'grch38-f364add98d1dae8d4ebfba37-45dfcf8970dca3fe7cfb.annotation-raster.v2';
const GENERATED_CAP8_PROJECTION_STEM =
  'grch38-f364add98d1dae8d4ebfba37-45dfcf8970dca3fe7cfb-9eb917f7e92bb0899db3.annotation-raster.v2';
const GENERATED_VARIANT_MANIFESTS_AVAILABLE = areMaterializedFixtureFiles(
  GENERATED_VARIANT_MANIFEST_FILES.map((file) => resolve(GENERATED_RASTER_FIXTURE_DIR, file))
);
const GENERATED_CAP8_ARTIFACT_AVAILABLE = areMaterializedFixtureFiles(
  [GENERATED_CAP8_SOURCE_STEM, GENERATED_CAP8_PROJECTION_STEM].flatMap((stem) => [
    resolve(GENERATED_RASTER_FIXTURE_DIR, `${stem}.json`),
    resolve(GENERATED_RASTER_FIXTURE_DIR, `${stem}.png`),
  ])
);
const itGeneratedVariant = GENERATED_VARIANT_MANIFESTS_AVAILABLE ? it : it.skip;
const itGeneratedCap8 = GENERATED_CAP8_ARTIFACT_AVAILABLE ? it : it.skip;

function makeDeps(): AssemblyTextureCacheDeps & {
  files: Map<string, Buffer>;
  reads: string[];
} {
  const files = new Map<string, Buffer>();
  const reads: string[] = [];
  return {
    files,
    reads,
    assertSafePath: async () => undefined,
    statSource: async (path) => {
      const value = STATS[path as keyof typeof STATS];
      if (!value) throw new Error(`ENOENT ${path}`);
      return value;
    },
    readFileImpl: async (path) => {
      reads.push(path);
      const value = files.get(path);
      if (!value) throw new Error(`ENOENT ${path}`);
      return value;
    },
    readdirImpl: async (dir) => {
      const prefix = `${dir}/`;
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length))
        .filter((name) => !name.includes('/'));
    },
    statCacheFile: async () => ({ mtimeMs: 1 }),
  };
}

function placementSignature(): string {
  return [
    'placement:ordered-linear-assembly-placement-v1',
    'total:300',
    '0|chr1|0|100|100',
    '1|chr2|100|300|200',
  ].join('\n');
}

function png(widthPx: number, heightPx: number, resolution: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(widthPx * resolution, 16);
  bytes.writeUInt32BE(heightPx * resolution, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalize(record[key])])
  );
}

function request(
  override: Partial<AssemblyAnnotationRasterReadRequestV2> = {}
): AssemblyAnnotationRasterReadRequestV2 {
  return {
    assemblyId: 'grch38',
    chromosomes: CHROMOSOMES,
    workspaceRoot: '/ws',
    datasetContract: DATASET_CONTRACT,
    genomeIdentity: GENOME_IDENTITY,
    trackType: 'mRNA',
    isoformMode: 'expanded',
    themeMode: 'light',
    laneLimit: null,
    ...override,
  };
}

async function seedSource(
  deps: ReturnType<typeof makeDeps>,
  options: { maxAnnotationLane?: number } = {}
) {
  const variant = createAssemblyAnnotationRasterVariantV2({
    isoformMode: 'expanded',
    themeMode: 'light',
  });
  const rasterVariantKey = assemblyAnnotationRasterVariantKeyV2(variant)!;
  const fingerprint = await computeAssemblyAnnotationRasterCacheFingerprintV2(
    CHROMOSOMES,
    {
      workspaceRoot: '/ws',
      cacheContractToken: ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN,
      sourceBuildFingerprint: SOURCE_BUILD_FINGERPRINT,
    },
    deps
  );
  expect(fingerprint).toMatch(/^[0-9a-f]{24}$/);
  const names = assemblyAnnotationRasterFileNamesV2({
    assemblyId: 'grch38',
    fingerprint: fingerprint!,
    rasterVariantKey,
    laneProjection: null,
  })!;
  const maxAnnotationLane = options.maxAnnotationLane ?? 3;
  const heightPx = (maxAnnotationLane + 1) * 16;
  const manifest = {
    version: ASSEMBLY_ANNOTATION_RASTER_MANIFEST_V2,
    assemblyId: 'grch38',
    fingerprint,
    cacheContractToken: ASSEMBLY_OVERVIEW_CACHE_CONTRACT_TOKEN,
    sourceBuildFingerprint: SOURCE_BUILD_FINGERPRINT,
    placementSignature: placementSignature(),
    rasterVariantKey,
    rasterVariant: variant,
    textureFile: names.textureFile,
    widthPx: 64,
    heightPx,
    resolution: 2,
    spineOffsetPx: heightPx - 1,
    annotationTrackBaseOffsetPx: 0,
    genomeLength: 300,
    maxAnnotationLane,
    maxCdsLane: -1,
    layerTypes: ['mRNA'],
  };
  deps.files.set(`${CACHE_DIR}/${names.manifestFile}`, Buffer.from(JSON.stringify(manifest)));
  deps.files.set(`${CACHE_DIR}/${names.textureFile}`, png(64, heightPx, 2));
  return { manifest, names };
}

function seedProjection(
  deps: ReturnType<typeof makeDeps>,
  source: Awaited<ReturnType<typeof seedSource>>,
  laneLimit: number
) {
  const projection = assemblyAnnotationRasterLaneProjectionV1({
    laneLimit,
    sourceHeightPx: source.manifest.heightPx,
    sourceSpineOffsetPx: source.manifest.spineOffsetPx,
    sourceMaxAnnotationLane: source.manifest.maxAnnotationLane,
  });
  const names = assemblyAnnotationRasterFileNamesV2({
    assemblyId: source.manifest.assemblyId,
    fingerprint: source.manifest.fingerprint!,
    rasterVariantKey: source.manifest.rasterVariantKey,
    laneProjection: projection,
  })!;
  const sourceTextureBytes = deps.files.get(`${CACHE_DIR}/${source.names.textureFile}`)!;
  const projectionTextureBytes = png(
    source.manifest.widthPx,
    projection.presentedHeightPx,
    source.manifest.resolution
  );
  const sourceArtifact = {
    contract: ASSEMBLY_ANNOTATION_RASTER_LANE_COMPLETE_SOURCE_V1,
    manifestFile: source.names.manifestFile,
    manifestSha256: sha256(canonicalJson(source.manifest)),
    textureFile: source.names.textureFile,
    textureSha256: sha256(sourceTextureBytes),
    textureByteLength: sourceTextureBytes.byteLength,
    fingerprint: source.manifest.fingerprint,
    sourceBuildFingerprint: source.manifest.sourceBuildFingerprint,
    placementSignatureSha256: sha256(source.manifest.placementSignature),
    rasterVariantKey: source.manifest.rasterVariantKey,
  };
  const textureSha256 = sha256(projectionTextureBytes);
  const projectionIdentity = {
    contract: ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1,
    sourceArtifact,
    laneProjection: projection,
    widthPx: source.manifest.widthPx,
    heightPx: projection.presentedHeightPx,
    resolution: source.manifest.resolution,
    spineOffsetPx: projection.presentedSpineOffsetPx,
    textureSha256,
    textureByteLength: projectionTextureBytes.byteLength,
  };
  const manifest = {
    ...source.manifest,
    projectionContract: ASSEMBLY_ANNOTATION_RASTER_PROJECTION_ARTIFACT_V1,
    projectionArtifactKey: sha256(canonicalJson(projectionIdentity)),
    sourceArtifact,
    laneProjection: projection,
    textureFile: names.textureFile,
    textureSha256,
    textureByteLength: projectionTextureBytes.byteLength,
    heightPx: projection.presentedHeightPx,
    spineOffsetPx: projection.presentedSpineOffsetPx,
  };
  deps.files.set(`${CACHE_DIR}/${names.manifestFile}`, Buffer.from(JSON.stringify(manifest)));
  deps.files.set(`${CACHE_DIR}/${names.textureFile}`, projectionTextureBytes);
  return { manifest, names, projection, sourceTextureBytes, projectionTextureBytes };
}

describe('validated assembly annotation raster V2 reader', () => {
  it('maps an exact lane-complete disk artifact to independently validated semantic authority', async () => {
    const deps = makeDeps();
    const seeded = await seedSource(deps);
    const result = await readAssemblyAnnotationRasterCacheV2(request(), deps);
    const sceneSourceFingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(
      {
        chromosomes: CHROMOSOMES,
        workspaceRoot: '/ws',
        scope: assemblyAnnotationSceneScopeForRequest('complete-assembly', CHROMOSOMES),
        datasetContract: DATASET_CONTRACT,
      },
      deps
    );

    expect(result).not.toBeNull();
    expect(result!.manifest.sourceFingerprint).toBe(sceneSourceFingerprint);
    expect(result!.manifest.sourceFingerprint).not.toBe(seeded.manifest.fingerprint);
    expect(result!.manifest.semanticReceipt.genomeIdentity).toBe(GENOME_IDENTITY);
    expect(result!.manifest.semanticReceipt.laneLimit).toBeNull();
    expect(result!.manifest.semanticReceipt.maxAnnotationLane).toBe(3);
    expect(isPrebuiltAnnotationRasterPresentationReceiptV1(result!.manifest.semanticReceipt)).toBe(
      true
    );
    expect(isPrebuiltAnnotationRasterLaneProjectionV1(result!.manifest.laneProjection)).toBe(true);
    expect(result!.manifest.laneProjection).toMatchObject({
      laneLimit: null,
      sourceHeightPx: 64,
      presentedHeightPx: 64,
    });
  });

  it('authenticates compressed source bytes and serves the persisted finite prefix without decoding or cropping', async () => {
    const deps = makeDeps();
    const source = await seedSource(deps);
    const derived = seedProjection(deps, source, 2);

    const result = await readAssemblyAnnotationRasterCacheV2(request({ laneLimit: 2 }), deps);

    expect(result?.manifest.heightPx).toBe(32);
    expect(result?.manifest.maxAnnotationLane).toBe(3);
    expect(result?.manifest.semanticReceipt.maxAnnotationLane).toBe(3);
    expect(result?.manifest.laneProjection.laneLimit).toBe(2);
    expect(result?.manifest.projectionArtifactKey).toBe(derived.manifest.projectionArtifactKey);
    expect(deps.reads).toContain(`${CACHE_DIR}/${derived.names.textureFile}`);
    expect(deps.reads).toContain(`${CACHE_DIR}/${source.names.textureFile}`);
  });

  it('fails closed for a finite request when no exact persisted projection exists and never reads the source PNG', async () => {
    const deps = makeDeps();
    const source = await seedSource(deps);

    await expect(
      readAssemblyAnnotationRasterCacheV2(request({ laneLimit: 8 }), deps)
    ).resolves.toBeNull();
    expect(deps.reads).not.toContain(`${CACHE_DIR}/${source.names.textureFile}`);
  });

  it('rejects a caller genome identity that is not bound to the dataset SHA', async () => {
    const deps = makeDeps();
    await seedSource(deps);

    await expect(
      readAssemblyAnnotationRasterCacheV2(
        request({ genomeIdentity: 'assembly-annotation-source-sha256.v1:wrong' }),
        deps
      )
    ).resolves.toBeNull();
    expect(deps.reads).toHaveLength(0);
  });

  it('rejects stale source stats and a PNG whose physical dimensions do not match the exact manifest', async () => {
    const staleDeps = makeDeps();
    await seedSource(staleDeps);
    staleDeps.statSource = async (path) => ({
      ...STATS[path as keyof typeof STATS],
      mtimeMs: 999,
    });
    await expect(readAssemblyAnnotationRasterCacheV2(request(), staleDeps)).resolves.toBeNull();

    const dimensionsDeps = makeDeps();
    const source = await seedSource(dimensionsDeps);
    dimensionsDeps.files.set(`${CACHE_DIR}/${source.names.textureFile}`, png(65, 64, 2));
    await expect(
      readAssemblyAnnotationRasterCacheV2(request(), dimensionsDeps)
    ).resolves.toBeNull();
  });

  itGeneratedVariant(
    'recognizes both existing lane-complete V2 manifest variants without weakening exact fields',
    () => {
      for (const file of GENERATED_VARIANT_MANIFEST_FILES) {
        const manifest = JSON.parse(
          readFileSync(resolve(GENERATED_RASTER_FIXTURE_DIR, file), 'utf-8')
        );
        expect(isAssemblyAnnotationRasterVariantV2(manifest.rasterVariant)).toBe(true);
        expect(assemblyAnnotationRasterVariantKeyV2(manifest.rasterVariant)).toBe(
          manifest.rasterVariantKey
        );
      }
    }
  );

  it('fails closed when any compiler integrity-envelope authority is corrupted', async () => {
    const deps = makeDeps();
    const source = await seedSource(deps);
    const derived = seedProjection(deps, source, 2);
    const baseInput = {
      sourceManifestFile: source.names.manifestFile,
      sourceManifest: source.manifest,
      sourceTextureBytes: derived.sourceTextureBytes,
      projectionManifestFile: derived.names.manifestFile,
      projectionManifest: derived.manifest,
      projectionTextureBytes: derived.projectionTextureBytes,
      expectedLaneProjection: derived.projection,
    };
    expect(validateAssemblyAnnotationRasterProjectionArtifactV2(baseInput)).toBe(true);

    for (const projectionManifest of [
      { ...derived.manifest, projectionArtifactKey: '0'.repeat(64) },
      {
        ...derived.manifest,
        sourceArtifact: {
          ...derived.manifest.sourceArtifact,
          manifestSha256: '0'.repeat(64),
        },
      },
      {
        ...derived.manifest,
        sourceArtifact: {
          ...derived.manifest.sourceArtifact,
          textureByteLength: derived.sourceTextureBytes.byteLength + 1,
        },
      },
      { ...derived.manifest, textureSha256: '0'.repeat(64) },
      {
        ...derived.manifest,
        textureByteLength: derived.projectionTextureBytes.byteLength + 1,
      },
    ]) {
      expect(
        validateAssemblyAnnotationRasterProjectionArtifactV2({
          ...baseInput,
          projectionManifest,
        })
      ).toBe(false);
    }
  });

  it('routes the compiler integrity validator through the reader and rejects a tampered projection', async () => {
    const deps = makeDeps();
    const source = await seedSource(deps);
    const derived = seedProjection(deps, source, 2);
    deps.files.set(
      `${CACHE_DIR}/${derived.names.manifestFile}`,
      Buffer.from(
        JSON.stringify({
          ...derived.manifest,
          textureSha256: '0'.repeat(64),
        })
      )
    );

    await expect(
      readAssemblyAnnotationRasterCacheV2(request({ laneLimit: 2 }), deps)
    ).resolves.toBeNull();
  });

  itGeneratedCap8(
    'validates the actual generated GRCh38 expanded cap-8 artifact byte-for-byte',
    () => {
      const sourceManifestFile = `${GENERATED_CAP8_SOURCE_STEM}.json`;
      const projectionManifestFile = `${GENERATED_CAP8_PROJECTION_STEM}.json`;

      expect(
        validateAssemblyAnnotationRasterProjectionArtifactV2({
          sourceManifestFile,
          sourceManifest: JSON.parse(
            readFileSync(resolve(GENERATED_RASTER_FIXTURE_DIR, sourceManifestFile), 'utf-8')
          ),
          sourceTextureBytes: readFileSync(
            resolve(GENERATED_RASTER_FIXTURE_DIR, `${GENERATED_CAP8_SOURCE_STEM}.png`)
          ),
          projectionManifestFile,
          projectionManifest: JSON.parse(
            readFileSync(resolve(GENERATED_RASTER_FIXTURE_DIR, projectionManifestFile), 'utf-8')
          ),
          projectionTextureBytes: readFileSync(
            resolve(GENERATED_RASTER_FIXTURE_DIR, `${GENERATED_CAP8_PROJECTION_STEM}.png`)
          ),
        })
      ).toBe(true);
    }
  );
});

import { parseGff3Line } from '@waypoint/genome-data';
import {
  annotationAliasesForSceneV1,
  annotationDataColorsByFeatureV1,
  compileAnnotationDataAppearanceV1,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  resealPartitionedTranscriptSceneBinaryDatasetContractV4,
} from '@waypoint/genome-renderer/pure';
import { expect, it, vi } from 'vitest';

import { processAssemblyOverviewChromosomeFeatures } from '../../features/sequence/assembly-annotation-feature-pipeline';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  assemblyAnnotationSceneArtifactKey,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import { prepareAssemblyAnnotationAppearanceV1 } from './assembly-annotation-appearance-command';
import type { AssemblyCompiledBroadRasterPreparationOrchestratorV1 } from './assembly-compiled-broad-raster-orchestrator';
import {
  compileExpandedAnnotationSceneEnvelope,
  compileRetainedSourceAnnotationAliasesV1,
  type ExpandedAnnotationSceneWorkerJob,
} from './assembly-expanded-annotation-scene-compiler';
import { ASSEMBLY_FEATURES_CACHE_VERSION } from './assembly-overview-features-cache';
import type { AssemblyAnnotationSceneCacheIndexHit } from './assembly-overview-texture-cache';
import { buildOverviewAnnotationTileFromRawFeatures } from './genome-overview-tile-cache';

const artifact = {
  themeMode: 'light' as const,
  trackType: 'CDS',
  partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  annotationBarHeightPx: 14,
  laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
  mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
  geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
};
const request: AssemblyAnnotationSceneReadRequest = {
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyId: 'fixture',
  workspaceRoot: '/fixture',
  chromosomes: [{ chrom: 'chr1', length: 1_000, sourcePath: '/fixture/source.gff3.gz' }],
  scope: {
    kind: 'complete-assembly',
    placements: [{ chrom: 'chr1', length: 1_000, annotationCoverage: 'sourced' }],
  },
  datasetContract: { datasetId: 'fixture', datasetVersion: '1', sourceSha256: 'a'.repeat(64) },
  artifact: { ...artifact, artifactKey: assemblyAnnotationSceneArtifactKey(artifact) },
  requestedPolicy: { isoformMode: 'expanded', laneLimit: null },
};
const job: ExpandedAnnotationSceneWorkerJob = {
  request,
  authorizedMiss: {
    status: 'miss',
    ipcContractVersion: request.ipcContractVersion,
    fingerprint: 'b'.repeat(24),
    sourceBuildFingerprint: 'c'.repeat(64),
  },
  runtimeSourceBuildFingerprint: 'd'.repeat(64),
  authorizedSourceRealPaths: [
    { inputPath: '/fixture/source.gff3.gz', realPath: '/fixture/source.gff3.gz' },
  ],
};

async function fixture() {
  const raw = [
    'chr1\tfixture\tbiological_region\t101\t250\t.\t+\t.\tID=root%2Cliteral;locus_tag=b1007',
    'chr1\tfixture\tgene\t101\t250\t.\t+\t.\tID=glcF.gene.1;Parent=root%2Cliteral;Name=glcF',
    'chr1\tfixture\tCDS\t101\t150\t.\t+\t0\tID=cds%2Cpart.1;Parent=glcF.gene.1;protein_id=protein.1',
    'chr1\tfixture\tCDS\t201\t250\t.\t+\t0\tID=cds.part.2;Parent=glcF.gene.1;protein_id=protein.1',
    'chr1\tfixture\tgene\t401\t500\t.\t+\t.\tID=other.gene;Name=glcF',
    'chr1\tfixture\tCDS\t401\t500\t.\t+\t0\tID=other.cds;Parent=other.gene;protein_id=protein.2',
  ].map((line) => parseGff3Line(line)!);
  const overview = buildOverviewAnnotationTileFromRawFeatures(raw);
  const features = processAssemblyOverviewChromosomeFeatures({
    chrom: 'chr1',
    chromosomeLengthBp: 1_000,
    globalStartBp: 0,
    rawOrResolvedFeatures: overview.features,
    featureModel: 'resolved-transcript-v2',
    isoformMode: 'expanded',
    glyphV2Enabled: true,
  });
  const manifest = {
    version: ASSEMBLY_FEATURES_CACHE_VERSION,
    assemblyId: 'fixture',
    fingerprint: 'e'.repeat(24),
    cacheContractToken: 'fixture',
    mode: 'expanded' as const,
    featureCount: features.length,
  };
  const compiled = await compileExpandedAnnotationSceneEnvelope(job, {
    manifest,
    rawFileJson: JSON.stringify({ manifest, byChrom: { chr1: features } }),
  });
  const { sourceAnnotationAliases: aliases, ...withoutAliases } = compiled.packed.manifest;
  const oldManifest = await resealPartitionedTranscriptSceneBinaryDatasetContractV4(
    withoutAliases,
    request.datasetContract
  );
  const scene: AssemblyAnnotationSceneCacheIndexHit = {
    status: 'hit',
    ipcContractVersion: request.ipcContractVersion,
    fingerprint: job.authorizedMiss.fingerprint,
    placementFingerprint: `ap1:${'f'.repeat(24)}`,
    sourceBuildFingerprint: job.authorizedMiss.sourceBuildFingerprint,
    scope: request.scope,
    artifact: request.artifact,
    byteCount: compiled.packed.payload.byteLength,
    manifest: oldManifest,
    scenePath: '/fixture/scene.bin',
    payloadSha256: oldManifest.integrity.payloadSha256,
  };
  const readOverviewCaches = vi.fn<
    NonNullable<
      Parameters<typeof compileRetainedSourceAnnotationAliasesV1>[2]['readOverviewCaches']
    >
  >(async () => ({
    byChrom: { chr1: { ...overview, chrom: 'chr1', cacheState: 'hit' as const } },
    hits: 1,
    misses: 0,
  }));
  const prepareSourceAliases = vi.fn(async () => ({
    payloadSha256: scene.payloadSha256,
    contractSha256: scene.manifest.integrity.contractSha256,
    aliases: await compileRetainedSourceAnnotationAliasesV1(job, scene.payloadSha256, {
      assertSafePath: async () => {},
      readOverviewCaches,
    }),
  }));
  const appearance = await compileAnnotationDataAppearanceV1({
    colors: [
      ['glcF.gene.1', 0x440154],
      ['b1007', 0x440154],
      ['other.cds', 0xfde725],
    ],
    themeMode: 'light',
  });
  const ensureSceneHit = vi.fn<
    AssemblyCompiledBroadRasterPreparationOrchestratorV1['ensureSceneHit']
  >(async () => ({
    status: 'published' as const,
    sourceFingerprint: scene.fingerprint,
    surfaceManifestFingerprint: '1'.repeat(64),
    catalogFingerprint: '2'.repeat(64),
    quarantinedCorruptArtifact: false,
  }));
  return {
    scene,
    aliases,
    appearance,
    prepareSourceAliases,
    readOverviewCaches,
    ensureSceneHit,
    deps: {
      cacheRoot: '/appearance-cache',
      readSceneIndex: vi.fn(async () => scene),
      assertSafePath: vi.fn(async () => {}),
      prepareSourceAliases,
      preparation: {
        ensureSceneHit,
      } as unknown as AssemblyCompiledBroadRasterPreparationOrchestratorV1,
    },
  };
}

it('replays retained source into byte-identical packed records and binds actual source ancestry to child glyphs', async () => {
  const f = await fixture();
  const result = await prepareAssemblyAnnotationAppearanceV1(
    { contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1, scene: request, appearance: f.appearance },
    f.deps
  );
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error(result.reason);
  expect(result.sourceBinding.aliases).toEqual(f.aliases);
  expect(result.sourceBinding.aliases).toEqual([
    {
      featureIndex: 0,
      aliases: ['b1007', 'cds,part.1', 'cds.part.2', 'glcF.gene.1', 'protein.1', 'root,literal'],
    },
    { featureIndex: 1, aliases: ['other.cds', 'other.gene', 'protein.2'] },
  ]);
  const fineAliases = annotationAliasesForSceneV1(
    {
      sourceAnnotationIdentity: {
        payloadSha256: f.scene.payloadSha256,
        contractSha256: f.scene.manifest.integrity.contractSha256,
      },
    },
    { colors: new Map(), sourceBindings: [result.sourceBinding] }
  );
  expect(
    annotationDataColorsByFeatureV1(fineAliases!, { colors: new Map(f.appearance.colors) })
  ).toEqual(
    new Map([
      [0, 0x440154],
      [1, 0xfde725],
    ])
  );
  expect(f.scene.manifest.sourceAnnotationAliases).toBeUndefined();
  expect(f.ensureSceneHit.mock.calls[0][0]).toMatchObject({
    payloadSha256: f.scene.payloadSha256,
    appearance: f.appearance,
    sceneManifest: { sourceAnnotationAliases: f.aliases },
  });
  expect(f.ensureSceneHit.mock.calls[0][0].artifactDirectory).toMatch(/^\/appearance-cache\//);
});

it('prepares aliases without producing a broad raster', async () => {
  const f = await fixture();
  const result = await prepareAssemblyAnnotationAppearanceV1(
    {
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      scene: request,
      appearance: f.appearance,
      prepareAliasesOnly: true,
    },
    f.deps
  );
  expect(result).toMatchObject({ status: 'ready', surfaceManifestFingerprint: null });
  expect(f.ensureSceneHit).not.toHaveBeenCalled();
  expect(f.deps.assertSafePath).not.toHaveBeenCalled();
});

it('leaves old scene viewing intact when original source is gone or does not reproduce its packed payload', async () => {
  const f = await fixture();
  const before = structuredClone(f.scene);
  f.readOverviewCaches.mockResolvedValueOnce({ byChrom: {}, hits: 0, misses: 1 });
  expect(
    await prepareAssemblyAnnotationAppearanceV1(
      {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        scene: request,
        appearance: f.appearance,
      },
      f.deps
    )
  ).toEqual({ status: 'unavailable', reason: 'source-aliases-unavailable' });
  await expect(
    compileRetainedSourceAnnotationAliasesV1(job, '0'.repeat(64), {
      assertSafePath: async () => {},
      readOverviewCaches: f.readOverviewCaches,
    })
  ).rejects.toThrow('does not reproduce');
  expect(f.scene).toEqual(before);
  expect(f.ensureSceneHit).not.toHaveBeenCalled();
});

it('rejects changed source generation and malformed appearance before admission', async () => {
  const f = await fixture();
  f.deps.readSceneIndex
    .mockResolvedValueOnce(f.scene)
    .mockResolvedValueOnce({ ...f.scene, fingerprint: '9'.repeat(24) });
  expect(
    await prepareAssemblyAnnotationAppearanceV1(
      {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        scene: request,
        appearance: f.appearance,
        prepareAliasesOnly: true,
      },
      f.deps
    )
  ).toEqual({ status: 'unavailable', reason: 'generation-mismatch' });
  f.deps.readSceneIndex.mockClear();
  expect(
    await prepareAssemblyAnnotationAppearanceV1(
      {
        contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
        scene: request,
        appearance: { ...f.appearance, fingerprint: '0'.repeat(64) },
      },
      f.deps
    )
  ).toEqual({ status: 'unavailable', reason: 'invalid-request' });
  expect(f.deps.readSceneIndex).not.toHaveBeenCalled();
});

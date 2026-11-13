import { admitAnnotationRoleSidecarPayloadV1 } from './assembly-annotation-role-sidecar';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  buildPrepackedAnnotationInteractionIndexV2,
  buildPartitionedTranscriptScene,
  packAnnotationSceneBinaryV1,
  packCompiledBroadAnnotationInteractionBinaryV1,
  packPartitionedTranscriptSceneBinaryV1,
  packGpuReadyPartitionedTranscriptSceneBinaryV4,
  packPartitionedTranscriptSceneBinaryV3,
  projectPrepackedAnnotationFeatureLookupIndexV2,
  unpackPartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/pure';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type {
  AssemblyAnnotationSceneReadRequest,
  AssemblyAnnotationSceneWriteRequest,
  AssemblyOverviewChromInput,
  AssemblyOverviewTextureLayout,
} from '../../shared/indexed-genome';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationSceneArtifactKey,
} from '../../shared/indexed-genome';
import {
  compiledBroadInteractionFileName,
  computeAssemblyAnnotationSceneSourceFingerprint,
  readAssemblyAnnotationSceneCache,
  readAssemblyAnnotationSceneCacheIndex,
  readAssemblyAnnotationSceneCacheResource,
  readAssemblyOverviewTextureCache,
  writeAssemblyAnnotationSceneCache,
  writeAssemblyCompiledBroadInteractionCache,
  writeAssemblyOverviewTextureCache,
  type AssemblyTextureCacheDeps,
} from './assembly-overview-texture-cache';

const CHROMS: AssemblyOverviewChromInput[] = [
  { chrom: 'chrA', sourcePath: '/ws/chrA.gff3.gz', length: 40_000_000_000 },
  { chrom: 'chrB', sourcePath: '/ws/chrB.gff3.gz', length: 3_000_000_000 },
];
const ASSEMBLY_LENGTH = 43_000_000_000;
const DATASET = {
  datasetId: 'large-assembly-annotation-set',
  datasetVersion: '2026.07.12',
  sourceSha256: 'a'.repeat(64),
};
const REQUEST: AssemblyAnnotationSceneReadRequest = {
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyId: 'large-assembly',
  chromosomes: CHROMS,
  scope: {
    kind: 'complete-assembly',
    placements: CHROMS.map((chromosome) => ({
      chrom: chromosome.chrom,
      length: chromosome.length,
      annotationCoverage: 'sourced',
    })),
  },
  workspaceRoot: '/ws',
  datasetContract: DATASET,
  artifact: {
    artifactKey: assemblyAnnotationSceneArtifactKey({
      themeMode: 'light',
      trackType: 'mRNA',
      partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
      annotationBarHeightPx: 14,
      laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
      mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
      geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
      interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
    }),
    themeMode: 'light',
    trackType: 'mRNA',
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    annotationBarHeightPx: 14,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  },
  requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
};

const STATS = {
  '/ws/chrA.gff3.gz': { size: 10_000, mtimeMs: 111, ctimeMs: 5 },
  '/ws/chrB.gff3.gz': { size: 20_000, mtimeMs: 222, ctimeMs: 6 },
};

function makeDeps(): AssemblyTextureCacheDeps & {
  files: Map<string, Buffer>;
  writes: string[];
} {
  const files = new Map<string, Buffer>();
  const writes: string[] = [];
  return {
    files,
    writes,
    sourceBuildFingerprint: 'source-build-a',
    assertSafePath: async () => {},
    statSource: async (path) => {
      const value = STATS[path as keyof typeof STATS];
      if (!value) throw new Error(`ENOENT ${path}`);
      return value;
    },
    readFileImpl: async (path) => {
      const value = files.get(path);
      if (!value) throw new Error(`ENOENT ${path}`);
      return value;
    },
    writeFileImpl: async (path, data) => {
      writes.push(`write:${path}`);
      files.set(path, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data));
    },
    renameImpl: async (from, to) => {
      writes.push(`rename:${from}->${to}`);
      const value = files.get(from);
      if (!value) throw new Error(`ENOENT ${from}`);
      files.set(to, value);
      files.delete(from);
    },
    unlinkImpl: async (path) => {
      writes.push(`unlink:${path}`);
      files.delete(path);
    },
    readdirImpl: async (dir) => {
      const prefix = `${dir.replace(/\/$/, '')}/`;
      return [...files.keys()]
        .filter((path) => path.startsWith(prefix))
        .map((path) => path.slice(prefix.length));
    },
    statCacheFile: async (path) => ({
      mtimeMs: 1,
      size: files.get(path)?.byteLength,
    }),
    mkdirImpl: async () => {},
  };
}

const sceneWriteRequestFixtureTasks = new Map<
  string,
  Promise<AssemblyAnnotationSceneWriteRequest>
>();
const SCENE_CACHE_INTEGRATION_TIMEOUT_MS = 15_000;
const SCENE_CACHE_ATOMIC_REPLACEMENT_TIMEOUT_MS = 30_000;

it('keeps compact interaction filenames within one portable filesystem component', () => {
  const fileName = compiledBroadInteractionFileName(
    `custom-reference-${'a'.repeat(160)}`,
    'b'.repeat(24),
    'c'.repeat(20),
    'd'.repeat(64),
    'e'.repeat(64)
  );

  expect(Buffer.byteLength(fileName)).toBeLessThanOrEqual(255);
});

async function buildSceneWriteRequestFixture(
  datasetContract = DATASET,
  partitionSpanBp = PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  primitiveStartBp = 40_000_000_003
): Promise<AssemblyAnnotationSceneWriteRequest> {
  const revisionDeps = makeDeps();
  const revision = await readAssemblyAnnotationSceneCache(
    { ...REQUEST, datasetContract },
    revisionDeps
  );
  if (!revision) throw new Error('fixture scene revision unavailable');
  const primitives = [
    {
      startBp: primitiveStartBp,
      endBp: primitiveStartBp + 1_000,
      featureIndex: 1,
      offsetCenter: -23,
      halfH: 7,
      color: 0x123456,
      alpha: 0.85,
      cdsFade: 0,
      dirSign: -1 as const,
    },
  ];
  const scene = buildPartitionedTranscriptScene(primitives, partitionSpanBp);
  const packed = await packGpuReadyPartitionedTranscriptSceneBinaryV4({
    datasetContract,
    assemblyContract: {
      assemblyId: REQUEST.assemblyId,
      assemblyLengthBp: ASSEMBLY_LENGTH,
    },
    families: [
      { id: 'transcript', kind: 'transcript', metadata: { glyph: 'directional' } },
      {
        id: 'enhancer',
        kind: 'source-shape',
        metadata: { shape: 'rounded-chevron', arbitrary: { nested: [1, true, null] } },
      },
    ],
    featureFamilyIndices: [0, 1],
    scene,
    interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
      [
        {
          rendererId: 0,
          startBp: 1,
          endBp: 2,
          lane: 0,
          direction: 'none',
          displayName: 'empty feature',
          type: 'mRNA',
          transcriptId: 'tx-empty',
          sourceId: 'source-empty',
          canonicalIdentity: 'canonical-empty',
        },
        {
          rendererId: 1,
          startBp: primitiveStartBp,
          endBp: primitiveStartBp + 1_000,
          lane: 1,
          direction: 'reverse',
          displayName: 'large-coordinate feature',
          type: 'mRNA',
          transcriptId: 'tx-large',
          sourceId: 'source-large',
          canonicalIdentity: `canonical-${primitiveStartBp}`,
        },
      ],
      scene.sortedPrimitives
    ),
    policyProjection: {
      features: [
        {
          annotationType: 'mRNA',
          expandedLane: 0,
          expandedTrackLane: 0,
          canonicalLane: 0,
          canonicalTrackLane: 0,
        },
        {
          annotationType: 'mRNA',
          expandedLane: 1,
          expandedTrackLane: 1,
          canonicalLane: 1,
          canonicalTrackLane: 1,
        },
      ],
      expandedBandOrder: ['mRNA'],
      canonicalBandOrder: ['mRNA'],
    },
  });
  const unpacked = await unpackPartitionedTranscriptSceneBinaryV4(packed.manifest, packed.payload);
  const compiledBroadInteraction = await packCompiledBroadAnnotationInteractionBinaryV1({
    sourceScene: {
      schema: packed.manifest.schema,
      payloadSha256: packed.manifest.integrity.payloadSha256,
      contractSha256: packed.manifest.integrity.contractSha256,
      byteLength: packed.manifest.byteLength,
    },
    datasetContract: packed.manifest.datasetContract,
    assemblyContract: packed.manifest.assemblyContract,
    policyProjection: unpacked.policyProjection,
    featureLookup: projectPrepackedAnnotationFeatureLookupIndexV2(unpacked.interactionIndex),
  });
  return {
    ...REQUEST,
    datasetContract,
    expectedSourceFingerprint: revision.fingerprint,
    expectedSourceBuildFingerprint: revision.sourceBuildFingerprint,
    manifest: packed.manifest,
    payload: packed.payload,
    compiledBroadInteraction,
  };
}

async function sceneWriteRequest(
  datasetContract = DATASET,
  partitionSpanBp = PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  primitiveStartBp = 40_000_000_003
): Promise<AssemblyAnnotationSceneWriteRequest> {
  const fixtureKey = [
    datasetContract.datasetId,
    datasetContract.datasetVersion,
    datasetContract.sourceSha256,
    partitionSpanBp,
    primitiveStartBp,
  ].join('\u0000');
  let task = sceneWriteRequestFixtureTasks.get(fixtureKey);
  if (!task) {
    task = buildSceneWriteRequestFixture(datasetContract, partitionSpanBp, primitiveStartBp);
    sceneWriteRequestFixtureTasks.set(fixtureKey, task);
  }
  const fixture = await task;
  return {
    ...fixture,
    datasetContract: { ...fixture.datasetContract },
  };
}

function pngHeaderBase64(layout: AssemblyOverviewTextureLayout): string {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(Math.round(layout.widthPx * layout.resolution), 16);
  buffer.writeUInt32BE(Math.round(layout.heightPx * layout.resolution), 20);
  return buffer.toString('base64');
}

const PNG_LAYOUT: AssemblyOverviewTextureLayout = {
  widthPx: 512,
  heightPx: 128,
  resolution: 1,
  spineOffsetPx: 64,
  genomeLength: ASSEMBLY_LENGTH,
  maxAnnotationLane: 2,
  maxCdsLane: 1,
  layerTypes: ['mRNA'],
};

async function expectSceneMiss(
  value: Promise<Awaited<ReturnType<typeof readAssemblyAnnotationSceneCache>>>
): Promise<void> {
  expect(await value).toMatchObject({
    status: 'miss',
    fingerprint: expect.stringMatching(/^[0-9a-f]{24}$/),
    sourceBuildFingerprint: expect.any(String),
  });
}

async function expectNoSceneHit(
  value: Promise<Awaited<ReturnType<typeof readAssemblyAnnotationSceneCache>>>
): Promise<void> {
  const result = await value;
  expect(result === null || result.status === 'miss').toBe(true);
}

describe('assembly annotation-scene companion cache', () => {
  it('rejects both legacy IPC contracts instead of interpreting them as v3 artifacts', async () => {
    for (const ipcContractVersion of [
      'assembly-annotation-scene-ipc.v1',
      'assembly-annotation-scene-ipc.v2',
    ]) {
      await expect(
        readAssemblyAnnotationSceneCache(
          { ...REQUEST, ipcContractVersion: ipcContractVersion as never },
          makeDeps()
        )
      ).resolves.toBeNull();
    }
  });

  it('rejects missing, reordered, or source-mismatched placement coverage', async () => {
    const deps = makeDeps();
    const invalidScopes = [
      { ...REQUEST.scope, placements: REQUEST.scope.placements.slice(0, 1) },
      { ...REQUEST.scope, placements: [...REQUEST.scope.placements].reverse() },
      {
        ...REQUEST.scope,
        placements: REQUEST.scope.placements.map((placement, index) =>
          index === 0 ? { ...placement, annotationCoverage: 'unsourced' as const } : placement
        ),
      },
    ];
    for (const scope of invalidScopes) {
      await expect(
        readAssemblyAnnotationSceneCache({ ...REQUEST, scope }, deps)
      ).resolves.toBeNull();
      await expect(
        computeAssemblyAnnotationSceneSourceFingerprint({ ...REQUEST, scope }, deps)
      ).resolves.toBeNull();
    }
  });

  it('returns the exact source revision on a valid cache miss', async () => {
    const deps = makeDeps();
    const expectedFingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(
      REQUEST,
      deps
    );

    const expectedMiss = {
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: expectedFingerprint,
      sourceBuildFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    } as const;
    await expect(readAssemblyAnnotationSceneCacheIndex(REQUEST, deps)).resolves.toEqual(
      expectedMiss
    );
    await expect(readAssemblyAnnotationSceneCache(REQUEST, deps)).resolves.toEqual(expectedMiss);
  });

  it('uses stable source content identity instead of filesystem timestamps across builds', async () => {
    const firstBuild = makeDeps();
    const secondBuild = makeDeps();
    secondBuild.statSource = async (path) => {
      const source = STATS[path as keyof typeof STATS];
      if (!source) throw new Error(`ENOENT ${path}`);
      return {
        ...source,
        mtimeMs: source.mtimeMs + 10_000,
        ctimeMs: (source.ctimeMs ?? 0) + 20_000,
      };
    };

    const firstFingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(
      REQUEST,
      firstBuild
    );
    const secondFingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(
      REQUEST,
      secondBuild
    );
    const changedContentFingerprint = await computeAssemblyAnnotationSceneSourceFingerprint(
      {
        ...REQUEST,
        datasetContract: { ...DATASET, sourceSha256: 'b'.repeat(64) },
      },
      secondBuild
    );

    expect(firstFingerprint).toMatch(/^[0-9a-f]{24}$/);
    expect(secondFingerprint).toBe(firstFingerprint);
    expect(changedContentFingerprint).not.toBe(firstFingerprint);
  });

  it('returns the exact validated bytes for one-use resource serving without a public IPC payload', async () => {
    const deps = makeDeps();
    const written = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    expect(written).not.toBeNull();

    const resource = await readAssemblyAnnotationSceneCacheResource(REQUEST, deps);
    expect(resource).toMatchObject({
      status: 'hit',
      scenePath: written!.scenePath,
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      byteCount: expect.any(Number),
    });
    if (resource?.status === 'hit') {
      expect(ArrayBuffer.isView(resource.validatedPayload)).toBe(true);
      expect(resource.validatedPayload.byteLength).toBe(resource.byteCount);
    }
    expect(resource && 'payload' in resource).toBe(false);
  });

  it('opens a valid index entry without reading or hashing the large scene payload', async () => {
    const deps = makeDeps();
    const written = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    expect(written).not.toBeNull();
    const baseRead = deps.readFileImpl!;
    const payloadReads: string[] = [];
    deps.readFileImpl = async (path) => {
      if (path === written!.scenePath) payloadReads.push(path);
      return baseRead(path);
    };

    const indexed = await readAssemblyAnnotationSceneCacheIndex(REQUEST, deps);

    expect(indexed).toMatchObject({
      status: 'hit',
      scenePath: written!.scenePath,
      payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(payloadReads).toEqual([]);
  });

  it('indexes the cold compact interaction artifact without opening the parent scene', async () => {
    const deps = makeDeps();
    const written = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    expect(written).not.toBeNull();
    const baseRead = deps.readFileImpl!;
    const scenePayloadReads: string[] = [];
    deps.readFileImpl = async (path) => {
      if (path === written!.scenePath) scenePayloadReads.push(path);
      return baseRead(path);
    };

    const indexed = await readAssemblyAnnotationSceneCacheIndex(REQUEST, deps);

    expect(indexed).toMatchObject({
      status: 'hit',
      compiledBroadInteraction: {
        payloadPath: expect.stringContaining('.compiled-broad-interaction.v1.bin'),
        payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        byteCount: expect.any(Number),
      },
    });
    expect(scenePayloadReads).toEqual([]);
    if (!indexed || indexed.status !== 'hit' || !indexed.compiledBroadInteraction) {
      throw new Error('compact fixture was not indexed');
    }
    expect(indexed.compiledBroadInteraction.byteCount).toBeLessThan(written!.byteCount);
  });

  it('continues to admit compact interaction artifacts published with the legacy filename', async () => {
    const deps = makeDeps();
    const written = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    expect(written).not.toBeNull();
    const indexed = await readAssemblyAnnotationSceneCacheIndex(REQUEST, deps);
    if (!indexed || indexed.status !== 'hit' || !indexed.compiledBroadInteraction) {
      throw new Error('compact fixture was not indexed');
    }
    const diskManifest = JSON.parse(deps.files.get(written!.manifestPath)!.toString('utf8'));
    const compactDescriptor = diskManifest.compiledBroadInteraction;
    const legacyFileName = `${REQUEST.assemblyId}-${indexed.fingerprint}-${diskManifest.companionKey}-${indexed.payloadSha256}-${compactDescriptor.payloadSha256}.compiled-broad-interaction.v1.bin`;
    const legacyPath = join(dirname(indexed.compiledBroadInteraction.payloadPath), legacyFileName);
    deps.files.set(legacyPath, deps.files.get(indexed.compiledBroadInteraction.payloadPath)!);
    deps.files.delete(indexed.compiledBroadInteraction.payloadPath);
    compactDescriptor.file = legacyFileName;
    deps.files.set(written!.manifestPath, Buffer.from(JSON.stringify(diskManifest)));

    await expect(readAssemblyAnnotationSceneCacheIndex(REQUEST, deps)).resolves.toMatchObject({
      status: 'hit',
      compiledBroadInteraction: { payloadPath: legacyPath },
    });
  });

  it('backfills a legacy scene once and makes the next cold read compact-only', async () => {
    const deps = makeDeps();
    const prepared = await sceneWriteRequest();
    const { compiledBroadInteraction, ...legacy } = prepared;
    const written = await writeAssemblyAnnotationSceneCache(legacy, deps);
    expect(written).not.toBeNull();
    const initiallyIndexed = await readAssemblyAnnotationSceneCacheIndex(REQUEST, deps);
    if (
      !initiallyIndexed ||
      initiallyIndexed.status !== 'hit' ||
      !initiallyIndexed.detailRangeCatalog
    ) {
      throw new Error('legacy migration fixture is invalid');
    }
    const detailRangeCatalog = initiallyIndexed.detailRangeCatalog;
    const diskManifest = JSON.parse(deps.files.get(written!.manifestPath)!.toString('utf8'));
    delete diskManifest.detailRangeCatalog;
    deps.files.set(written!.manifestPath, Buffer.from(JSON.stringify(diskManifest)));
    await expect(readAssemblyAnnotationSceneCacheIndex(REQUEST, deps)).resolves.toMatchObject({
      status: 'hit',
    });
    await expect(readAssemblyAnnotationSceneCacheIndex(REQUEST, deps)).resolves.not.toHaveProperty(
      'detailRangeCatalog'
    );

    await expect(
      writeAssemblyCompiledBroadInteractionCache(
        REQUEST,
        { ...compiledBroadInteraction!, detailRangeCatalog },
        deps
      )
    ).resolves.toBe(true);
    const baseRead = deps.readFileImpl!;
    const scenePayloadReads: string[] = [];
    deps.readFileImpl = async (path) => {
      if (path === written!.scenePath) scenePayloadReads.push(path);
      return baseRead(path);
    };

    await expect(readAssemblyAnnotationSceneCacheIndex(REQUEST, deps)).resolves.toMatchObject({
      status: 'hit',
      compiledBroadInteraction: {
        payloadSha256: compiledBroadInteraction!.manifest.integrity.payloadSha256,
      },
      detailRangeCatalog: {
        sourceScene: {
          payloadSha256: prepared.manifest.integrity.payloadSha256,
          contractSha256: prepared.manifest.integrity.contractSha256,
        },
      },
    });
    expect(scenePayloadReads).toEqual([]);
  });

  it('publishes colour roles beside the exact scene and indexes them', async () => {
    const deps = makeDeps();
    const request = await sceneWriteRequest();
    const expanded = new Uint8Array(request.manifest.sections.expandedGlyphs.count).fill(1);
    const canonical = new Uint8Array(request.manifest.sections.canonicalGlyphs.count).fill(0);
    const written = await writeAssemblyAnnotationSceneCache(
      {
        ...request,
        roleSidecar: {
          roleTable: ['transcript:intron', 'transcript:cdsThick'],
          expandedRoleIndices: expanded,
          canonicalRoleIndices: canonical,
        },
      },
      deps
    );
    expect(written).not.toBeNull();
    const indexed = await readAssemblyAnnotationSceneCacheIndex(REQUEST, deps);
    if (!indexed || indexed.status !== 'hit' || !indexed.roleSidecar) {
      throw new Error('role sidecar was not indexed');
    }
    expect(indexed.roleSidecar).toMatchObject({
      roleTable: ['transcript:intron', 'transcript:cdsThick'],
      expandedCount: expanded.length,
      canonicalCount: canonical.length,
      payloadPath: expect.stringContaining('.annotation-roles.v1.bin'),
    });
    const bytes = new Uint8Array(deps.files.get(indexed.roleSidecar.payloadPath)!);
    const admitted = admitAnnotationRoleSidecarPayloadV1(indexed.roleSidecar, bytes);
    expect(admitted?.expandedRoleIndices).toEqual(expanded);
    expect(admitted?.canonicalRoleIndices).toEqual(canonical);

    bytes[0] ^= 1;
    expect(admitAnnotationRoleSidecarPayloadV1(indexed.roleSidecar, bytes)).toBeNull();
  });

  it('rejects a scene write whose colour roles do not fit the scene', async () => {
    const request = await sceneWriteRequest();
    const roleSidecar = {
      roleTable: ['transcript:intron' as const],
      expandedRoleIndices: new Uint8Array(request.manifest.sections.expandedGlyphs.count).fill(1),
      canonicalRoleIndices: new Uint8Array(request.manifest.sections.canonicalGlyphs.count),
    };
    await expect(
      writeAssemblyAnnotationSceneCache({ ...request, roleSidecar }, makeDeps())
    ).resolves.toBeNull();
    await expect(
      writeAssemblyAnnotationSceneCache(
        {
          ...request,
          roleSidecar: {
            ...roleSidecar,
            expandedRoleIndices: new Uint8Array(request.manifest.sections.expandedGlyphs.count + 1),
          },
        },
        makeDeps()
      )
    ).resolves.toBeNull();
  });

  it('keeps the exact scene readable when its compact projection is corrupt', async () => {
    const deps = makeDeps();
    await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    const indexed = await readAssemblyAnnotationSceneCacheIndex(REQUEST, deps);
    expect(indexed?.status).toBe('hit');
    if (!indexed || indexed.status !== 'hit' || !indexed.compiledBroadInteraction) {
      throw new Error('compact fixture was not published');
    }
    deps.files.get(indexed.compiledBroadInteraction.payloadPath)![0] ^= 0xff;

    await expect(readAssemblyAnnotationSceneCacheIndex(REQUEST, deps)).resolves.toMatchObject({
      status: 'hit',
      scenePath: indexed.scenePath,
    });
  });

  it(
    'rejects late stale A instead of publishing it under B source provenance',
    async () => {
      const deps = makeDeps();
      const mutableStats = {
        '/ws/chrA.gff3.gz': { ...STATS['/ws/chrA.gff3.gz'] },
        '/ws/chrB.gff3.gz': { ...STATS['/ws/chrB.gff3.gz'] },
      };
      deps.statSource = async (path) => mutableStats[path as keyof typeof mutableStats];
      const fingerprintA = await computeAssemblyAnnotationSceneSourceFingerprint(REQUEST, deps);
      expect(fingerprintA).toMatch(/^[0-9a-f]{24}$/);
      const requestA = {
        ...(await sceneWriteRequest(DATASET, PREPACKED_ANNOTATION_PARTITION_SPAN_BP, 100)),
        expectedSourceFingerprint: fingerprintA!,
      };

      let signalAStatStarted!: () => void;
      const aStatStarted = new Promise<void>((resolve) => (signalAStatStarted = resolve));
      let releaseAStat!: () => void;
      const aStatRelease = new Promise<void>((resolve) => (releaseAStat = resolve));
      let holdFirstStat = true;
      deps.statSource = async (path) => {
        if (holdFirstStat) {
          holdFirstStat = false;
          signalAStatStarted();
          await aStatRelease;
        }
        return mutableStats[path as keyof typeof mutableStats];
      };
      const lateA = writeAssemblyAnnotationSceneCache(requestA, deps);
      await aStatStarted;

      mutableStats['/ws/chrA.gff3.gz'].size += 1;
      const fingerprintB = await computeAssemblyAnnotationSceneSourceFingerprint(REQUEST, deps);
      expect(fingerprintB).toMatch(/^[0-9a-f]{24}$/);
      expect(fingerprintB).not.toBe(fingerprintA);
      const requestB = {
        ...(await sceneWriteRequest(DATASET, PREPACKED_ANNOTATION_PARTITION_SPAN_BP, 200)),
        expectedSourceFingerprint: fingerprintB!,
      };
      const writtenB = await writeAssemblyAnnotationSceneCache(requestB, deps);
      expect(writtenB?.fingerprint).toBe(fingerprintB);

      releaseAStat();
      await expect(lateA).resolves.toBeNull();
      const current = await readAssemblyAnnotationSceneCache(REQUEST, deps);
      expect(current).toMatchObject({ status: 'hit', fingerprint: fingerprintB });
      expect(current && 'payload' in current ? current.payload : null).toEqual(requestB.payload);
    },
    SCENE_CACHE_INTEGRATION_TIMEOUT_MS
  );

  it('retries the probe when sources mutate during payload read instead of returning a stale hit', async () => {
    const deps = makeDeps();
    const mutableStats = {
      '/ws/chrA.gff3.gz': { ...STATS['/ws/chrA.gff3.gz'] },
      '/ws/chrB.gff3.gz': { ...STATS['/ws/chrB.gff3.gz'] },
    };
    deps.statSource = async (path) => mutableStats[path as keyof typeof mutableStats];
    const written = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    expect(written).not.toBeNull();
    const baseRead = deps.readFileImpl!;
    let mutated = false;
    deps.readFileImpl = async (path) => {
      const value = await baseRead(path);
      if (!mutated && path.endsWith('.annotation-scene.v6.bin')) {
        mutated = true;
        mutableStats['/ws/chrA.gff3.gz'].size += 1;
      }
      return value;
    };
    const probe = await readAssemblyAnnotationSceneCache(REQUEST, deps);
    const fingerprintB = await computeAssemblyAnnotationSceneSourceFingerprint(REQUEST, deps);

    expect(mutated).toBe(true);
    expect(probe).toEqual({
      status: 'miss',
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      fingerprint: fingerprintB,
      sourceBuildFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it(
    'keeps the prior committed blob readable when replacement revision changes after temp IO',
    async () => {
      const deps = makeDeps();
      const mutableStats = {
        '/ws/chrA.gff3.gz': { ...STATS['/ws/chrA.gff3.gz'] },
        '/ws/chrB.gff3.gz': { ...STATS['/ws/chrB.gff3.gz'] },
      };
      deps.statSource = async (path) => mutableStats[path as keyof typeof mutableStats];
      const originalRequest = await sceneWriteRequest(
        DATASET,
        PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
        100
      );
      const original = await writeAssemblyAnnotationSceneCache(originalRequest, deps);
      expect(original).not.toBeNull();
      const originalPayload = new Uint8Array(originalRequest.payload as Uint8Array);
      const replacement = await sceneWriteRequest(
        DATASET,
        PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
        200
      );
      const baseRename = deps.renameImpl!;
      let replacementBlobRenamed = false;
      deps.renameImpl = async (from, to) => {
        await baseRename(from, to);
        if (!replacementBlobRenamed && from.includes('.annotation-scene.v6.bin.tmp-')) {
          replacementBlobRenamed = true;
          mutableStats['/ws/chrA.gff3.gz'].size += 1;
        }
      };

      await expect(writeAssemblyAnnotationSceneCache(replacement, deps)).resolves.toBeNull();
      expect(replacementBlobRenamed).toBe(true);
      expect([...deps.files.keys()].some((path) => path.includes('.tmp-'))).toBe(false);

      mutableStats['/ws/chrA.gff3.gz'].size -= 1;
      const stillCommitted = await readAssemblyAnnotationSceneCache(REQUEST, deps);
      expect(stillCommitted?.status).toBe('hit');
      expect(stillCommitted?.status === 'hit' ? stillCommitted.payload : null).toEqual(
        originalPayload
      );
      expect(deps.files.get(original!.scenePath)).toEqual(Buffer.from(originalPayload));
    },
    SCENE_CACHE_ATOMIC_REPLACEMENT_TIMEOUT_MS
  );

  it(
    'writes atomically and reads byte-exact structured-clone binary with explicit byte count',
    async () => {
      const deps = makeDeps();
      const request = await sceneWriteRequest();
      const expected = new Uint8Array(request.payload as Uint8Array);
      const written = await writeAssemblyAnnotationSceneCache(request, deps);
      expect(written).not.toBeNull();
      expect(written!.scenePath).toMatch(/-[0-9a-f]{64}\.annotation-scene\.v6\.bin$/);
      expect(written!.manifestPath).toMatch(/\.annotation-scene\.v6\.json$/);
      expect(written!.byteCount).toBe(expected.byteLength);
      expect(deps.files.has(written!.scenePath)).toBe(true);
      expect(deps.files.has(written!.manifestPath)).toBe(true);
      expect([...deps.files.keys()].some((path) => path.includes('.tmp-'))).toBe(false);
      expect(deps.writes[deps.writes.length - 1]).toContain(`->${written!.manifestPath}`);
      const diskManifest = JSON.parse(deps.files.get(written!.manifestPath)!.toString('utf8'));
      expect(diskManifest.detailRangeCatalog).toMatchObject({
        schema: 'partitioned-transcript-scene-range-catalog.v1',
        sourceScene: {
          byteLength: expected.byteLength,
          payloadSha256: request.manifest.integrity.payloadSha256,
          contractSha256: request.manifest.integrity.contractSha256,
        },
      });
      expect(diskManifest.detailRangeCatalog.expanded.partitions).toHaveLength(1);

      const texture = await writeAssemblyOverviewTextureCache(
        {
          assemblyId: REQUEST.assemblyId,
          chromosomes: CHROMS,
          workspaceRoot: '/ws',
          pngBase64: pngHeaderBase64(PNG_LAYOUT),
          layout: PNG_LAYOUT,
        },
        deps
      );
      expect(texture?.fingerprint).toMatch(/^[0-9a-f]{24}$/);
      expect(texture?.fingerprint).not.toBe(written!.fingerprint);

      const read = await readAssemblyAnnotationSceneCache(REQUEST, deps);
      expect(read?.status).toBe('hit');
      if (!read || read.status !== 'hit') throw new Error('expected scene hit');
      expect(read.payload).toBeInstanceOf(Uint8Array);
      expect(read.payload).not.toBeInstanceOf(Buffer);
      expect(read.byteCount).toBe(expected.byteLength);
      expect(read.payload).toEqual(expected);
      expect(read.manifest.datasetContract).toEqual(DATASET);
      expect(read.manifest.assemblyContract.assemblyLengthBp).toBe(ASSEMBLY_LENGTH);
      expect(read.sourceBuildFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(read.scope).toEqual(REQUEST.scope);
      expect(read.artifact).toEqual(REQUEST.artifact);
      expect(read).toMatchObject({
        detailRangeCatalog: {
          sourceScene: { payloadSha256: request.manifest.integrity.payloadSha256 },
        },
      });
    },
    SCENE_CACHE_INTEGRATION_TIMEOUT_MS
  );

  it(
    'accepts ArrayBuffer over the write wire without base64 expansion',
    async () => {
      const deps = makeDeps();
      const request = await sceneWriteRequest();
      const bytes = request.payload as Uint8Array;
      const result = await writeAssemblyAnnotationSceneCache(
        {
          ...request,
          payload: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        },
        deps
      );
      expect(result?.byteCount).toBe(bytes.byteLength);
      expect(deps.files.get(result!.scenePath)).toEqual(Buffer.from(bytes));
    },
    SCENE_CACHE_INTEGRATION_TIMEOUT_MS
  );

  it('keeps dataset versions in separate companion paths and reads both exactly', async () => {
    const deps = makeDeps();
    const datasetV2 = { ...DATASET, datasetVersion: '2026.07.13', sourceSha256: 'b'.repeat(64) };
    const v1 = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    const v2 = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(datasetV2), deps);
    expect(v1).not.toBeNull();
    expect(v2).not.toBeNull();
    expect(v2!.scenePath).not.toBe(v1!.scenePath);
    await expect(readAssemblyAnnotationSceneCache(REQUEST, deps)).resolves.not.toBeNull();
    await expect(
      readAssemblyAnnotationSceneCache({ ...REQUEST, datasetContract: datasetV2 }, deps)
    ).resolves.not.toBeNull();
  });

  it('returns null independently for missing/stale scene while a valid PNG remains a hit', async () => {
    const deps = makeDeps();
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: REQUEST.assemblyId,
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: pngHeaderBase64(PNG_LAYOUT),
        layout: PNG_LAYOUT,
      },
      deps
    );
    await expectSceneMiss(readAssemblyAnnotationSceneCache(REQUEST, deps));
    expect(
      await readAssemblyOverviewTextureCache(
        { assemblyId: REQUEST.assemblyId, chromosomes: CHROMS, workspaceRoot: '/ws' },
        deps
      )
    ).not.toBeNull();
  });

  it('rejects invalid scene hash before writing any companion files', async () => {
    const deps = makeDeps();
    const request = await sceneWriteRequest();
    const corrupt = new Uint8Array(request.payload as Uint8Array);
    corrupt[0] ^= 0xff;
    expect(
      await writeAssemblyAnnotationSceneCache({ ...request, payload: corrupt }, deps)
    ).toBeNull();
    expect(deps.files.size).toBe(0);
  });

  it('rejects the former source-primitive schema as stale instead of decoding it on a cold hit', async () => {
    const deps = makeDeps();
    const old = await packAnnotationSceneBinaryV1({
      datasetContract: DATASET,
      assemblyContract: {
        assemblyId: REQUEST.assemblyId,
        assemblyLengthBp: ASSEMBLY_LENGTH,
      },
      families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: [0],
      primitives: [
        {
          startBp: 1,
          endBp: 2,
          featureIndex: 0,
          offsetCenter: 0,
          halfH: 7,
          color: 0x123456,
          alpha: 1,
          cdsFade: 0,
          dirSign: 1,
        },
      ],
    });
    const request = await sceneWriteRequest();
    const result = await writeAssemblyAnnotationSceneCache(
      {
        ...request,
        manifest: old.manifest as unknown as typeof request.manifest,
        payload: old.payload,
      },
      deps
    );
    expect(result).toBeNull();
    expect(deps.writes).toEqual([]);
  });

  it('treats a visual-only partitioned v1 disk companion as an exact cache miss', async () => {
    const deps = makeDeps();
    const current = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    expect(current).not.toBeNull();
    const old = await packPartitionedTranscriptSceneBinaryV1({
      datasetContract: DATASET,
      assemblyContract: {
        assemblyId: REQUEST.assemblyId,
        assemblyLengthBp: ASSEMBLY_LENGTH,
      },
      families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: [0],
      primitives: [
        {
          startBp: 40_000_000_003,
          endBp: 40_000_001_003,
          featureIndex: 0,
          offsetCenter: 0,
          halfH: 7,
          color: 0x123456,
          alpha: 1,
          cdsFade: 0,
          dirSign: 1,
        },
      ],
      partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    });
    const diskManifest = JSON.parse(deps.files.get(current!.manifestPath)!.toString('utf8'));
    diskManifest.sceneManifest = old.manifest;
    diskManifest.byteCount = old.payload.byteLength;
    deps.files.set(current!.manifestPath, Buffer.from(JSON.stringify(diskManifest)));
    deps.files.set(current!.scenePath, Buffer.from(old.payload));

    await expectSceneMiss(readAssemblyAnnotationSceneCache(REQUEST, deps));
  });

  it('treats a fully valid partitioned v3 disk companion as stale after the v4 cutover', async () => {
    const deps = makeDeps();
    const current = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    expect(current).not.toBeNull();
    const legacyPrimitive = {
      startBp: 40_000_000_003,
      endBp: 40_000_001_003,
      featureIndex: 0,
      offsetCenter: -7,
      halfH: 7,
      color: 0x123456,
      alpha: 1,
      cdsFade: 0,
      dirSign: 1 as const,
    };
    const legacy = await packPartitionedTranscriptSceneBinaryV3({
      datasetContract: DATASET,
      assemblyContract: { assemblyId: REQUEST.assemblyId, assemblyLengthBp: ASSEMBLY_LENGTH },
      families: [{ id: 'transcript', kind: 'transcript', metadata: {} }],
      featureFamilyIndices: [0],
      primitives: [legacyPrimitive],
      partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
      interactionIndex: buildPrepackedAnnotationInteractionIndexV2(
        [
          {
            rendererId: 0,
            startBp: legacyPrimitive.startBp,
            endBp: legacyPrimitive.endBp,
            lane: 0,
            direction: 'forward',
            displayName: 'legacy-v3',
            type: 'mRNA',
            transcriptId: 'legacy-v3',
            sourceId: 'legacy-v3',
            canonicalIdentity: 'legacy-v3',
          },
        ],
        [legacyPrimitive]
      ),
      policyProjection: {
        features: [
          {
            annotationType: 'mRNA',
            expandedLane: 0,
            expandedTrackLane: 0,
            canonicalLane: 0,
            canonicalTrackLane: 0,
          },
        ],
        expandedBandOrder: ['mRNA'],
        canonicalBandOrder: ['mRNA'],
      },
    });
    const diskManifest = JSON.parse(deps.files.get(current!.manifestPath)!.toString('utf8'));
    diskManifest.sceneManifest = legacy.manifest;
    diskManifest.byteCount = legacy.payload.byteLength;
    deps.files.set(current!.manifestPath, Buffer.from(JSON.stringify(diskManifest)));
    deps.files.set(current!.scenePath, Buffer.from(legacy.payload));

    await expectSceneMiss(readAssemblyAnnotationSceneCache(REQUEST, deps));
  });

  it('misses on exact dataset, assembly, and placement mismatch', async () => {
    const deps = makeDeps();
    await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);

    await expectSceneMiss(
      readAssemblyAnnotationSceneCache(
        { ...REQUEST, datasetContract: { ...DATASET, datasetVersion: 'other' } },
        deps
      )
    );
    await expectSceneMiss(
      readAssemblyAnnotationSceneCache({ ...REQUEST, assemblyId: 'other-assembly' }, deps)
    );
    await expect(
      readAssemblyAnnotationSceneCache({ ...REQUEST, chromosomes: [...CHROMS].reverse() }, deps)
    ).resolves.toBeNull();
    await expectSceneMiss(
      readAssemblyAnnotationSceneCache(
        {
          ...REQUEST,
          chromosomes: [...CHROMS].reverse(),
          scope: {
            ...REQUEST.scope,
            placements: [...REQUEST.scope.placements].reverse(),
          },
        },
        deps
      )
    );
  });

  it('keeps an exact scene hit across unrelated app-build and PNG-contract changes', async () => {
    const deps = makeDeps();
    const written = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: REQUEST.assemblyId,
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: pngHeaderBase64(PNG_LAYOUT),
        layout: PNG_LAYOUT,
      },
      deps
    );

    deps.sourceBuildFingerprint = 'unrelated-application-build-b';
    deps.cacheContractToken = 'unrelated-png-visual-contract-b';
    const scene = await readAssemblyAnnotationSceneCache(REQUEST, deps);
    expect(scene).toMatchObject({
      status: 'hit',
      fingerprint: written?.fingerprint,
      sourceBuildFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(
      await readAssemblyOverviewTextureCache(
        { assemblyId: REQUEST.assemblyId, chromosomes: CHROMS, workspaceRoot: '/ws' },
        deps
      )
    ).toBeNull();
  });

  it('shares one artifact revision and cache hit across all eight runtime policies', async () => {
    const deps = makeDeps();
    const writeRequest = await sceneWriteRequest();
    const written = await writeAssemblyAnnotationSceneCache(writeRequest, deps);
    expect(written).not.toBeNull();
    const writesAfterPublication = deps.writes.length;
    const revisions = new Set<string>();
    const payloadHashes = new Set<string>();
    for (const isoformMode of ['canonical', 'expanded'] as const) {
      for (const laneLimit of [8, 12, 24, null] as const) {
        const hit = await readAssemblyAnnotationSceneCache(
          { ...REQUEST, requestedPolicy: { isoformMode, laneLimit } },
          deps
        );
        expect(hit).toMatchObject({ status: 'hit', artifact: REQUEST.artifact });
        if (!hit || hit.status !== 'hit') throw new Error('expected policy-neutral hit');
        revisions.add(hit.sourceBuildFingerprint);
        payloadHashes.add(hit.manifest.integrity.payloadSha256);
      }
    }
    expect(revisions.size).toBe(1);
    expect([...revisions][0]).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHashes).toEqual(new Set([writeRequest.manifest.integrity.payloadSha256]));
    expect(deps.writes).toHaveLength(writesAfterPublication);
  });

  it('still misses when a biological source revision changes', async () => {
    const deps = makeDeps();
    const mutableStats = {
      '/ws/chrA.gff3.gz': { ...STATS['/ws/chrA.gff3.gz'] },
      '/ws/chrB.gff3.gz': { ...STATS['/ws/chrB.gff3.gz'] },
    };
    deps.statSource = async (path) => mutableStats[path as keyof typeof mutableStats];
    await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    mutableStats['/ws/chrA.gff3.gz'].size += 1;
    await expectSceneMiss(readAssemblyAnnotationSceneCache(REQUEST, deps));
  });

  it('misses every baked artifact mismatch and keeps valid artifacts in separate paths', async () => {
    const deps = makeDeps();
    const light = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    expect(light).not.toBeNull();

    for (const artifact of [
      { ...REQUEST.artifact, artifactKey: 'other-key' },
      { ...REQUEST.artifact, themeMode: 'dark' as const },
      { ...REQUEST.artifact, trackType: 'gene' },
      { ...REQUEST.artifact, partitionSpanBp: 50_000_000 },
      { ...REQUEST.artifact, annotationBarHeightPx: 16 },
    ]) {
      await expectNoSceneHit(readAssemblyAnnotationSceneCache({ ...REQUEST, artifact }, deps));
    }
    for (const [field, bakedToken] of [
      ['laneAlgorithmToken', 'other-lanes'],
      ['mapperContractToken', 'other-mapper'],
      ['geometryContractToken', 'other-geometry'],
      ['interactionContractToken', 'other-interaction'],
    ] as const) {
      const currentManifest = deps.files.get(light!.manifestPath)!;
      const bakedManifest = JSON.parse(currentManifest.toString('utf8'));
      bakedManifest.artifact[field] = bakedToken;
      deps.files.set(light!.manifestPath, Buffer.from(JSON.stringify(bakedManifest)));
      await expectNoSceneHit(readAssemblyAnnotationSceneCache(REQUEST, deps));
      deps.files.set(light!.manifestPath, currentManifest);
    }

    const darkArtifactWithoutKey = { ...REQUEST.artifact, themeMode: 'dark' as const };
    const darkRequest = {
      ...(await sceneWriteRequest()),
      artifact: {
        ...darkArtifactWithoutKey,
        artifactKey: assemblyAnnotationSceneArtifactKey({
          themeMode: darkArtifactWithoutKey.themeMode,
          trackType: darkArtifactWithoutKey.trackType,
          partitionSpanBp: darkArtifactWithoutKey.partitionSpanBp,
          annotationBarHeightPx: darkArtifactWithoutKey.annotationBarHeightPx,
          laneAlgorithmToken: darkArtifactWithoutKey.laneAlgorithmToken,
          mapperContractToken: darkArtifactWithoutKey.mapperContractToken,
          geometryContractToken: darkArtifactWithoutKey.geometryContractToken,
          interactionContractToken: darkArtifactWithoutKey.interactionContractToken,
        }),
      },
    };
    const darkRevision = await readAssemblyAnnotationSceneCache(
      { ...REQUEST, artifact: darkRequest.artifact },
      deps
    );
    if (!darkRevision) throw new Error('expected dark scene revision');
    darkRequest.expectedSourceFingerprint = darkRevision.fingerprint;
    darkRequest.expectedSourceBuildFingerprint = darkRevision.sourceBuildFingerprint;
    const dark = await writeAssemblyAnnotationSceneCache(darkRequest, deps);
    expect(dark).not.toBeNull();
    expect(dark!.scenePath).not.toBe(light!.scenePath);
    await expect(readAssemblyAnnotationSceneCache(REQUEST, deps)).resolves.not.toBeNull();
    await expect(
      readAssemblyAnnotationSceneCache({ ...REQUEST, artifact: darkRequest.artifact }, deps)
    ).resolves.not.toBeNull();
  });

  it('does not create a second artifact when lane policy changes', async () => {
    const deps = makeDeps();
    const lane12Request = await sceneWriteRequest();
    const lane12 = await writeAssemblyAnnotationSceneCache(lane12Request, deps);
    expect(lane12).not.toBeNull();
    const lane16 = await readAssemblyAnnotationSceneCache(
      { ...REQUEST, requestedPolicy: { isoformMode: 'canonical', laneLimit: 16 } },
      deps
    );
    expect(lane16).toMatchObject({
      status: 'hit',
      artifact: REQUEST.artifact,
      sourceBuildFingerprint: lane12Request.expectedSourceBuildFingerprint,
    });
  });

  it('fails closed on malformed artifact and runtime-policy contracts', async () => {
    const deps = makeDeps();
    await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    for (const field of ['trackType', 'mapperContractToken', 'interactionContractToken'] as const) {
      const artifact = { ...REQUEST.artifact } as Record<string, unknown>;
      delete artifact[field];
      await expect(
        readAssemblyAnnotationSceneCache({ ...REQUEST, artifact: artifact as never }, deps)
      ).resolves.toBeNull();
    }
    await expect(
      readAssemblyAnnotationSceneCache(
        { ...REQUEST, requestedPolicy: { isoformMode: 'expanded', laneLimit: -1 } },
        deps
      )
    ).resolves.toBeNull();
  });

  it('rejects scene manifest identity that does not match the write request', async () => {
    const deps = makeDeps();
    const request = await sceneWriteRequest();
    expect(
      await writeAssemblyAnnotationSceneCache(
        {
          ...request,
          datasetContract: { ...DATASET, sourceSha256: 'b'.repeat(64) },
        },
        deps
      )
    ).toBeNull();
    expect(
      await writeAssemblyAnnotationSceneCache(
        {
          ...request,
          assemblyId: 'other',
        },
        deps
      )
    ).toBeNull();
    expect(deps.files.size).toBe(0);
  });

  it('rejects a binary whose partition span contradicts the scene variant on write and read', async () => {
    const writeDeps = makeDeps();
    const wrongPartition = await sceneWriteRequest(DATASET, 50_000_000);
    await expect(writeAssemblyAnnotationSceneCache(wrongPartition, writeDeps)).resolves.toBeNull();
    expect(writeDeps.files.size).toBe(0);
    expect(writeDeps.writes).toEqual([]);

    const readDeps = makeDeps();
    const current = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), readDeps);
    expect(current).not.toBeNull();
    const diskManifest = JSON.parse(readDeps.files.get(current!.manifestPath)!.toString('utf8'));
    diskManifest.sceneManifest = wrongPartition.manifest;
    diskManifest.byteCount = (wrongPartition.payload as Uint8Array).byteLength;
    readDeps.files.set(current!.manifestPath, Buffer.from(JSON.stringify(diskManifest)));
    readDeps.files.set(current!.scenePath, Buffer.from(wrongPartition.payload as Uint8Array));

    await expectSceneMiss(readAssemblyAnnotationSceneCache(REQUEST, readDeps));
  });

  it('returns null for corrupt disk bytes without deleting or invalidating the PNG', async () => {
    const deps = makeDeps();
    const scene = await writeAssemblyAnnotationSceneCache(await sceneWriteRequest(), deps);
    await writeAssemblyOverviewTextureCache(
      {
        assemblyId: REQUEST.assemblyId,
        chromosomes: CHROMS,
        workspaceRoot: '/ws',
        pngBase64: pngHeaderBase64(PNG_LAYOUT),
        layout: PNG_LAYOUT,
      },
      deps
    );
    deps.files.get(scene!.scenePath)![0] ^= 0xff;

    await expectSceneMiss(readAssemblyAnnotationSceneCache(REQUEST, deps));
    expect(deps.files.has(scene!.scenePath)).toBe(true);
    expect(
      await readAssemblyOverviewTextureCache(
        { assemblyId: REQUEST.assemblyId, chromosomes: CHROMS, workspaceRoot: '/ws' },
        deps
      )
    ).not.toBeNull();
  });
});

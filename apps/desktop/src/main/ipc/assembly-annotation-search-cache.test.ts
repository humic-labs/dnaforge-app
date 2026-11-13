import { createHash } from 'crypto';
import { mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
  PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
  packPrepackedAnnotationSearchIndexV1,
  unpackPrepackedAnnotationSearchIndexV1,
} from '@waypoint/genome-data';
import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
} from '@waypoint/genome-renderer/pure';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
  assemblyAnnotationSceneArtifactKey,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import type { AssemblyTextureCacheDeps } from './assembly-overview-texture-cache';
import {
  ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1,
  ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2,
  ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
  type AssemblyAnnotationSearchCacheDeps,
  type AssemblyAnnotationSearchPayloadFileV2,
  migrateLegacyAssemblyAnnotationSearchCacheIndexV1,
  packAssemblyAnnotationSearchCachePayload,
  readAssemblyAnnotationSearchCacheIndex,
  readAssemblyAnnotationSearchCacheResource,
  resolveAssemblyAnnotationSearchSourceRevisionV2,
  writeAssemblyAnnotationSearchCache,
  writePackedAssemblyAnnotationSearchCache,
} from './assembly-annotation-search-cache';
import { sha256BoundedNodeV1 } from './bounded-binary-sha256';

const cleanupRoots: string[] = [];

function searchIdentity(type: string, key: string) {
  return {
    annotationTrackId: type,
    canonicalIdentity: `annotation.v2:test-${key}`,
    direction: 'none' as const,
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function requestFor(workspaceRoot: string): AssemblyAnnotationSceneReadRequest {
  const chromosomes = [
    {
      chrom: 'chr1',
      length: 1_000,
      sourcePath: join(workspaceRoot, 'chr1.gff3'),
      manifest: {
        chrom: 'chr1',
        length: 1_000,
        fastaPath: join(workspaceRoot, 'chr1.fa'),
        faiPath: join(workspaceRoot, 'chr1.fa.fai'),
        gffPath: join(workspaceRoot, 'chr1.gff3'),
        tbiPath: join(workspaceRoot, 'chr1.gff3.tbi'),
      },
    },
    {
      chrom: 'chr2',
      length: 2_000,
      sourcePath: join(workspaceRoot, 'chr2.gff3'),
      manifest: {
        chrom: 'chr2',
        length: 2_000,
        fastaPath: join(workspaceRoot, 'chr2.fa'),
        faiPath: join(workspaceRoot, 'chr2.fa.fai'),
        gffPath: join(workspaceRoot, 'chr2.gff3'),
        tbiPath: join(workspaceRoot, 'chr2.gff3.tbi'),
      },
    },
  ];
  const artifact = {
    themeMode: 'light' as const,
    trackType: 'mRNA',
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    annotationBarHeightPx: 14,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  };
  return {
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    assemblyId: 'GRCh38-search-test',
    chromosomes,
    scope: {
      kind: 'complete-assembly',
      placements: chromosomes.map(({ chrom, length }) => ({
        chrom,
        length,
        annotationCoverage: 'sourced' as const,
      })),
    },
    workspaceRoot,
    datasetContract: {
      datasetId: 'gencode-search-test',
      datasetVersion: 'v44',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {
      ...artifact,
      artifactKey: assemblyAnnotationSceneArtifactKey(artifact),
    },
    requestedPolicy: { isoformMode: 'expanded', laneLimit: 2 },
  };
}

function preManifestOnlyCompanionKey(
  request: AssemblyAnnotationSceneReadRequest,
  sourceFingerprint: string,
  assemblyLengthBp: number,
  placementSignature: string,
  cacheVersion:
    | typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1
    | typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        cacheVersion,
        PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
        PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
        request.assemblyId,
        assemblyLengthBp,
        placementSignature,
        sourceFingerprint,
        request.datasetContract.datasetId,
        request.datasetContract.datasetVersion,
        request.datasetContract.sourceSha256,
        ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
      ])
    )
    .digest('hex');
}

function explicitManifestCompanionKey(
  request: AssemblyAnnotationSceneReadRequest,
  sourceFingerprint: string,
  assemblyLengthBp: number,
  placementSignature: string,
  cacheVersion:
    | typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1
    | typeof ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        cacheVersion,
        PREPACKED_ANNOTATION_SEARCH_INDEX_V1,
        PREPACKED_ANNOTATION_SEARCH_CONTRACT_TOKEN,
        ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2,
        request.assemblyId,
        assemblyLengthBp,
        placementSignature,
        sourceFingerprint,
        request.datasetContract.datasetId,
        request.datasetContract.datasetVersion,
        request.datasetContract.sourceSha256,
        ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
      ])
    )
    .digest('hex');
}

async function createLegacyFixture(options?: { explicitManifestSemantics?: boolean }) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'waypoint-annotation-search-v1-migration-'));
  cleanupRoots.push(workspaceRoot);
  const request = requestFor(workspaceRoot);
  const revision = { value: 10 };
  const deps: AssemblyAnnotationSearchCacheDeps = {
    assertSafePath: async () => {},
    statSource: async (sourcePath) => ({
      size: sourcePath.endsWith('chr1.gff3') ? 1_001 : 2_002,
      mtimeMs: revision.value,
      ctimeMs: 1,
    }),
  };
  const sourceFingerprint = (await resolveAssemblyAnnotationSearchSourceRevisionV2(request, deps))
    ?.fingerprint;
  if (!sourceFingerprint) throw new Error('legacy fixture source fingerprint unavailable');
  const placementSignature = JSON.stringify([
    'ordered-linear-assembly-placement-v1',
    3_000,
    [
      [0, 'chr1', 0, 1_000, 1_000],
      [1, 'chr2', 1_000, 3_000, 2_000],
    ],
  ]);
  const packed = await packPrepackedAnnotationSearchIndexV1({
    datasetContract: request.datasetContract,
    assemblyContract: {
      assemblyId: request.assemblyId,
      assemblyLengthBp: 3_000,
      placementSignature,
      sourceFingerprint,
    },
    trackType: ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
    features: [
      {
        sourceOrdinal: 0,
        type: 'gene',
        ...searchIdentity('gene', 'legacy-brca1'),
        start: 100,
        end: 200,
        displayName: 'BRCA1',
        attributes: { gene_name: ['BRCA1'], gene_id: ['ENSG00000012048'] },
      },
    ],
    payloadSha256: sha256BoundedNodeV1,
  });
  const written = await writeAssemblyAnnotationSearchCache(
    {
      request,
      expectedSourceFingerprint: sourceFingerprint,
      manifest: packed.manifest,
      payload: packed.payload,
    },
    deps
  );
  if (!written) throw new Error('legacy fixture cache publication failed');

  const companionKey = (
    options?.explicitManifestSemantics ? explicitManifestCompanionKey : preManifestOnlyCompanionKey
  )(request, sourceFingerprint, 3_000, placementSignature, ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1);
  const legacyManifestPath = join(
    workspaceRoot,
    '.waypoint',
    'genome-index',
    'assembly-overview',
    `annotation-search-${companionKey}.v1.json`
  );
  await writeFile(
    legacyManifestPath,
    JSON.stringify({
      version: ASSEMBLY_ANNOTATION_SEARCH_CACHE_V1,
      assemblyId: request.assemblyId,
      fingerprint: sourceFingerprint,
      companionKey,
      placementSignature,
      payloadFile: `annotation-search-${packed.manifest.integrity.payloadSha256}.v1.bin`,
      byteCount: packed.payload.byteLength,
      searchManifest: packed.manifest,
    })
  );
  await rm(written.manifestPath);
  return {
    request,
    revision,
    deps,
    sourceFingerprint,
    packed,
    payloadPath: written.payloadPath,
    v1ManifestPath: legacyManifestPath,
    v2ManifestPath: written.manifestPath,
  };
}

async function openInstrumentedPayload(
  path: string,
  readLengths: number[],
  onFirstRead?: () => Promise<void> | void
): Promise<AssemblyAnnotationSearchPayloadFileV2> {
  const file = await open(path, 'r');
  let firstRead = true;
  return {
    stat: () => file.stat({ bigint: true }),
    read: async (buffer, byteOffset, byteLength, position) => {
      readLengths.push(byteLength);
      if (firstRead) {
        firstRead = false;
        await onFirstRead?.();
      }
      return file.read(buffer, byteOffset, byteLength, position);
    },
    close: () => file.close(),
  };
}

describe('assembly annotation search cache', () => {
  it('publishes compiler-owned packed bytes without a second wire copy or validation boundary', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'waypoint-annotation-search-packed-'));
    cleanupRoots.push(workspaceRoot);
    const request = requestFor(workspaceRoot);
    const deps: AssemblyAnnotationSearchCacheDeps = {
      assertSafePath: async () => {},
      statSource: async (sourcePath) => ({
        size: sourcePath.endsWith('chr1.gff3') ? 1_001 : 2_002,
        mtimeMs: 10,
        ctimeMs: 1,
      }),
    };
    const sourceFingerprint = (await resolveAssemblyAnnotationSearchSourceRevisionV2(request, deps))
      ?.fingerprint;
    if (!sourceFingerprint) throw new Error('packed publication source fingerprint unavailable');

    const packed = await packAssemblyAnnotationSearchCachePayload({
      request,
      expectedSourceFingerprint: sourceFingerprint,
      features: [
        {
          sourceOrdinal: 0,
          type: 'gene',
          ...searchIdentity('gene', 'packed-path'),
          start: 100,
          end: 200,
          displayName: 'PACKED_PATH',
        },
      ],
    });
    if (!packed) throw new Error('compiler-owned packed fixture was rejected');
    const written = await writePackedAssemblyAnnotationSearchCache(
      { request, expectedSourceFingerprint: sourceFingerprint, packed },
      deps
    );

    expect(written).toMatchObject({
      fingerprint: sourceFingerprint,
      byteCount: packed.payload.byteLength,
    });
    await expect(readAssemblyAnnotationSearchCacheResource(request, deps)).resolves.toMatchObject({
      status: 'hit',
      manifest: { featureCount: 1 },
    });
  });

  it('is independently source-bound across miss, write, validated query, and source change', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'waypoint-annotation-search-cache-'));
    cleanupRoots.push(workspaceRoot);
    const request = requestFor(workspaceRoot);
    let sourceRevision = 10;
    const deps: AssemblyTextureCacheDeps = {
      assertSafePath: async () => {},
      statSource: async (sourcePath) => ({
        size: sourcePath.endsWith('chr1.gff3') ? 1_001 : 2_002,
        mtimeMs: sourceRevision,
        ctimeMs: 1,
      }),
    };

    const sourceFingerprint = (await resolveAssemblyAnnotationSearchSourceRevisionV2(request, deps))
      ?.fingerprint;
    expect(sourceFingerprint).toMatch(/^[0-9a-f]{24}$/);
    if (!sourceFingerprint) throw new Error('search fixture source fingerprint unavailable');

    await expect(readAssemblyAnnotationSearchCacheIndex(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: sourceFingerprint,
    });

    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: request.datasetContract,
      assemblyContract: {
        assemblyId: request.assemblyId,
        assemblyLengthBp: 3_000,
        placementSignature: JSON.stringify([
          'ordered-linear-assembly-placement-v1',
          3_000,
          [
            [0, 'chr1', 0, 1_000, 1_000],
            [1, 'chr2', 1_000, 3_000, 2_000],
          ],
        ]),
        sourceFingerprint,
      },
      trackType: ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
      features: [
        {
          sourceOrdinal: 0,
          type: 'gene',
          ...searchIdentity('gene', 'brca1'),
          start: 100,
          end: 200,
          displayName: 'BRCA1',
          attributes: { gene_name: ['BRCA1'], gene_id: ['ENSG00000012048'] },
        },
        {
          sourceOrdinal: 4,
          type: 'lncRNA',
          ...searchIdentity('lncRNA', 'malat1'),
          start: 1_500,
          end: 1_900,
          displayName: 'MALAT1',
        },
      ],
      payloadSha256: sha256BoundedNodeV1,
    });

    const written = await writeAssemblyAnnotationSearchCache(
      {
        request,
        expectedSourceFingerprint: sourceFingerprint,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      deps
    );
    expect(written).toMatchObject({
      fingerprint: sourceFingerprint,
      byteCount: packed.payload.byteLength,
    });
    expect(written?.manifestPath).toMatch(/\.v2\.json$/);
    expect(written?.payloadIdentity).toMatchObject({
      size: String(packed.payload.byteLength),
    });
    if (!written) throw new Error('expected sealed search cache publication');

    const indexHit = await readAssemblyAnnotationSearchCacheIndex(request, deps);
    expect(indexHit).toMatchObject({
      status: 'hit',
      fingerprint: sourceFingerprint,
      byteCount: packed.payload.byteLength,
      payloadSha256: packed.manifest.integrity.payloadSha256,
    });
    if (!indexHit || indexHit.status !== 'hit') throw new Error('expected search index hit');
    expect(indexHit.sourceContinuity).toHaveLength(8);
    expect(indexHit.sourceContinuity).toContainEqual({
      sourcePath: request.chromosomes[0].manifest?.tbiPath,
      size: 2_002,
      mtimeMs: sourceRevision,
      ctimeMs: 1,
    });

    const resourceHit = await readAssemblyAnnotationSearchCacheResource(request, deps);
    expect(resourceHit?.status).toBe('hit');
    if (!resourceHit || resourceHit.status !== 'hit') {
      throw new Error('expected a validated search resource hit');
    }
    const search = await unpackPrepackedAnnotationSearchIndexV1(
      resourceHit.manifest,
      resourceHit.validatedPayload,
      sha256BoundedNodeV1
    );
    expect(search.query('brca1')).toEqual([
      {
        featureIndex: 0,
        start: 100,
        end: 200,
        label: 'BRCA1',
        featureType: 'gene',
        annotationTrackId: 'gene',
        canonicalIdentity: 'annotation.v2:test-brca1',
        direction: 'none',
      },
    ]);

    const sealedManifestBytes = await readFile(written.manifestPath);
    const unsealedManifest = JSON.parse(sealedManifestBytes.toString('utf8')) as Record<
      string,
      unknown
    >;
    delete unsealedManifest.payloadIdentity;
    await writeFile(written.manifestPath, JSON.stringify(unsealedManifest));
    await expect(readAssemblyAnnotationSearchCacheIndex(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: sourceFingerprint,
    });
    await writeFile(written.manifestPath, sealedManifestBytes);

    const beforeMutation = await stat(written.payloadPath, { bigint: true });
    const corruptPayload = new Uint8Array(packed.payload);
    corruptPayload[corruptPayload.byteLength - 1] ^= 0xff;
    await writeFile(written.payloadPath, corruptPayload);
    const afterMutation = await stat(written.payloadPath, { bigint: true });
    expect(afterMutation.ino).toBe(beforeMutation.ino);
    expect(
      afterMutation.mtimeNs !== beforeMutation.mtimeNs ||
        afterMutation.ctimeNs !== beforeMutation.ctimeNs
    ).toBe(true);
    await expect(readAssemblyAnnotationSearchCacheIndex(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: sourceFingerprint,
    });
    await expect(readAssemblyAnnotationSearchCacheResource(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: sourceFingerprint,
    });

    const restored = await writeAssemblyAnnotationSearchCache(
      {
        request,
        expectedSourceFingerprint: sourceFingerprint,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      deps
    );
    if (!restored) throw new Error('expected restored search cache publication');
    await expect(readAssemblyAnnotationSearchCacheIndex(request, deps)).resolves.toMatchObject({
      status: 'hit',
      payloadIdentity: restored.payloadIdentity,
    });

    const replacementPath = `${restored.payloadPath}.replacement`;
    await writeFile(replacementPath, packed.payload);
    const beforeReplacement = await stat(restored.payloadPath, { bigint: true });
    await rename(replacementPath, restored.payloadPath);
    const afterReplacement = await stat(restored.payloadPath, { bigint: true });
    expect(afterReplacement.ino).not.toBe(beforeReplacement.ino);
    await expect(readAssemblyAnnotationSearchCacheIndex(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: sourceFingerprint,
    });

    sourceRevision += 1;
    const changedSourceFingerprint = (
      await resolveAssemblyAnnotationSearchSourceRevisionV2(request, deps)
    )?.fingerprint;
    expect(changedSourceFingerprint).not.toBe(sourceFingerprint);
    await expect(readAssemblyAnnotationSearchCacheIndex(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: changedSourceFingerprint,
    });
  });

  it('rejects guessed-sidecar-era artifacts and admits only explicit-manifest compiler semantics', async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), 'waypoint-annotation-search-compiler-provenance-')
    );
    cleanupRoots.push(workspaceRoot);
    const request = requestFor(workspaceRoot);
    const deps: AssemblyAnnotationSearchCacheDeps = {
      assertSafePath: async () => {},
      statSource: async (sourcePath) => ({
        size: sourcePath.endsWith('chr1.gff3') ? 1_001 : 2_002,
        mtimeMs: 10,
        ctimeMs: 1,
      }),
    };
    const sourceFingerprint = (await resolveAssemblyAnnotationSearchSourceRevisionV2(request, deps))
      ?.fingerprint;
    if (!sourceFingerprint) throw new Error('search fixture source fingerprint unavailable');
    const placementSignature = JSON.stringify([
      'ordered-linear-assembly-placement-v1',
      3_000,
      [
        [0, 'chr1', 0, 1_000, 1_000],
        [1, 'chr2', 1_000, 3_000, 2_000],
      ],
    ]);
    const packed = await packPrepackedAnnotationSearchIndexV1({
      datasetContract: request.datasetContract,
      assemblyContract: {
        assemblyId: request.assemblyId,
        assemblyLengthBp: 3_000,
        placementSignature,
        sourceFingerprint,
      },
      trackType: ASSEMBLY_ANNOTATION_SEARCH_TRACK_TYPE,
      features: [],
      payloadSha256: sha256BoundedNodeV1,
    });
    const written = await writeAssemblyAnnotationSearchCache(
      {
        request,
        expectedSourceFingerprint: sourceFingerprint,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      deps
    );
    if (!written) throw new Error('expected explicit-manifest cache publication');

    const currentDisk = JSON.parse(
      (await readFile(written.manifestPath)).toString('utf8')
    ) as Record<string, unknown>;
    expect(currentDisk.compilerSemantics).toBe(ASSEMBLY_ANNOTATION_SEARCH_COMPILER_SEMANTICS_V2);

    const guessedEraCompanionKey = preManifestOnlyCompanionKey(
      request,
      sourceFingerprint,
      3_000,
      placementSignature,
      ASSEMBLY_ANNOTATION_SEARCH_CACHE_V2
    );
    const guessedEraManifestPath = join(
      workspaceRoot,
      '.waypoint',
      'genome-index',
      'assembly-overview',
      `annotation-search-${guessedEraCompanionKey}.v2.json`
    );
    delete currentDisk.compilerSemantics;
    currentDisk.companionKey = guessedEraCompanionKey;
    await writeFile(guessedEraManifestPath, JSON.stringify(currentDisk));
    await rm(written.manifestPath);

    await expect(readAssemblyAnnotationSearchCacheIndex(request, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: sourceFingerprint,
    });

    const rebuilt = await writeAssemblyAnnotationSearchCache(
      {
        request,
        expectedSourceFingerprint: sourceFingerprint,
        manifest: packed.manifest,
        payload: packed.payload,
      },
      deps
    );
    expect(rebuilt).not.toBeNull();
    await expect(readAssemblyAnnotationSearchCacheIndex(request, deps)).resolves.toMatchObject({
      status: 'hit',
      fingerprint: sourceFingerprint,
    });

    const changedTbiRequest: AssemblyAnnotationSceneReadRequest = {
      ...request,
      chromosomes: request.chromosomes.map((chromosome, index) =>
        index === 0
          ? {
              ...chromosome,
              manifest: {
                ...chromosome.manifest!,
                tbiPath: join(workspaceRoot, 'chr1.explicit-replacement.gff3.tbi'),
              },
            }
          : chromosome
      ),
    };
    const changedRevision = await resolveAssemblyAnnotationSearchSourceRevisionV2(
      changedTbiRequest,
      deps
    );
    expect(changedRevision?.fingerprint).not.toBe(sourceFingerprint);
    await expect(readAssemblyAnnotationSearchCacheIndex(changedTbiRequest, deps)).resolves.toEqual({
      status: 'miss',
      fingerprint: changedRevision?.fingerprint,
    });
  });

  it('returns a read-only miss for a legacy v1 artifact', async () => {
    const fixture = await createLegacyFixture();
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    const directories: string[] = [];
    const payloadOpens: string[] = [];
    const result = await readAssemblyAnnotationSearchCacheIndex(fixture.request, {
      ...fixture.deps,
      writeFileImpl: async (path) => {
        writes.push(path);
      },
      renameImpl: async (from, to) => {
        renames.push([from, to]);
      },
      mkdirImpl: async (path) => {
        directories.push(path);
      },
      openSearchPayload: async (path) => {
        payloadOpens.push(path);
        return openInstrumentedPayload(path, []);
      },
    });

    expect(result).toEqual({ status: 'miss', fingerprint: fixture.sourceFingerprint });
    expect(writes).toEqual([]);
    expect(renames).toEqual([]);
    expect(directories).toEqual([]);
    expect(payloadOpens).toEqual([]);
    await expect(readFile(fixture.v2ManifestPath)).rejects.toThrow();
  });

  it('explicitly migrates an exact v1 manifest to sealed v2 without rewriting its payload', async () => {
    const fixture = await createLegacyFixture({ explicitManifestSemantics: true });
    const payloadBefore = await stat(fixture.payloadPath, { bigint: true });
    const readLengths: number[] = [];
    const writes: string[] = [];
    const renames: Array<[string, string]> = [];
    let closes = 0;
    const deps: AssemblyAnnotationSearchCacheDeps = {
      ...fixture.deps,
      readFileImpl: async (path) => {
        expect(path.endsWith('.bin')).toBe(false);
        return readFile(path);
      },
      writeFileImpl: async (path, data) => {
        writes.push(path);
        await writeFile(path, data);
      },
      renameImpl: async (from, to) => {
        renames.push([from, to]);
        await rename(from, to);
      },
      openSearchPayload: async (path) => {
        const file = await openInstrumentedPayload(path, readLengths);
        return {
          ...file,
          close: async () => {
            closes += 1;
            await file.close();
          },
        };
      },
    };

    await expect(
      migrateLegacyAssemblyAnnotationSearchCacheIndexV1(fixture.request, deps)
    ).resolves.toMatchObject({
      status: 'hit',
      fingerprint: fixture.sourceFingerprint,
      payloadPath: fixture.payloadPath,
      byteCount: fixture.packed.payload.byteLength,
    });
    const payloadAfter = await stat(fixture.payloadPath, { bigint: true });
    expect({
      size: payloadAfter.size,
      mtimeNs: payloadAfter.mtimeNs,
      ctimeNs: payloadAfter.ctimeNs,
      ino: payloadAfter.ino,
      dev: payloadAfter.dev,
    }).toEqual({
      size: payloadBefore.size,
      mtimeNs: payloadBefore.mtimeNs,
      ctimeNs: payloadBefore.ctimeNs,
      ino: payloadBefore.ino,
      dev: payloadBefore.dev,
    });
    await expect(readFile(fixture.v1ManifestPath)).resolves.toBeInstanceOf(Buffer);
    await expect(readFile(fixture.v2ManifestPath)).resolves.toBeInstanceOf(Buffer);
    expect(readLengths.length).toBeGreaterThan(0);
    expect(Math.max(...readLengths)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(closes).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('.v2.json.tmp-');
    expect(writes.some((path) => path.endsWith('.bin'))).toBe(false);
    expect(renames).toHaveLength(1);
    expect(renames[0]?.[0]).toContain('.v2.json.tmp-');
    expect(renames[0]?.[1]).toBe(fixture.v2ManifestPath);
  });

  it('refuses to migrate a corrupt v1 payload', async () => {
    const fixture = await createLegacyFixture({ explicitManifestSemantics: true });
    const corrupt = new Uint8Array(fixture.packed.payload);
    corrupt[corrupt.byteLength - 1] ^= 0xff;
    await writeFile(fixture.payloadPath, corrupt);

    await expect(
      migrateLegacyAssemblyAnnotationSearchCacheIndexV1(fixture.request, fixture.deps)
    ).resolves.toEqual({ status: 'miss', fingerprint: fixture.sourceFingerprint });
    await expect(readFile(fixture.v2ManifestPath)).rejects.toThrow();
    await expect(readFile(fixture.v1ManifestPath)).resolves.toBeInstanceOf(Buffer);
  });

  it('refuses to migrate when payload identity mutates during authentication', async () => {
    const fixture = await createLegacyFixture({ explicitManifestSemantics: true });
    const readLengths: number[] = [];
    let closes = 0;
    const deps: AssemblyAnnotationSearchCacheDeps = {
      ...fixture.deps,
      openSearchPayload: async (path) => {
        const file = await openInstrumentedPayload(path, readLengths, async () => {
          await writeFile(path, fixture.packed.payload);
        });
        return {
          ...file,
          close: async () => {
            closes += 1;
            await file.close();
          },
        };
      },
    };

    await expect(
      migrateLegacyAssemblyAnnotationSearchCacheIndexV1(fixture.request, deps)
    ).resolves.toEqual({
      status: 'miss',
      fingerprint: fixture.sourceFingerprint,
    });
    expect(readLengths.length).toBeGreaterThan(0);
    expect(closes).toBe(1);
    await expect(readFile(fixture.v2ManifestPath)).rejects.toThrow();
  });

  it('refuses to migrate when annotation sources drift during authentication', async () => {
    const fixture = await createLegacyFixture({ explicitManifestSemantics: true });
    const readLengths: number[] = [];
    const deps: AssemblyAnnotationSearchCacheDeps = {
      ...fixture.deps,
      openSearchPayload: (path) =>
        openInstrumentedPayload(path, readLengths, () => {
          fixture.revision.value += 1;
        }),
    };

    const result = await migrateLegacyAssemblyAnnotationSearchCacheIndexV1(fixture.request, deps);
    expect(result?.status).toBe('miss');
    expect(result?.fingerprint).not.toBe(fixture.sourceFingerprint);
    expect(readLengths.length).toBeGreaterThan(0);
    await expect(readFile(fixture.v2ManifestPath)).rejects.toThrow();
    await expect(readFile(fixture.v1ManifestPath)).resolves.toBeInstanceOf(Buffer);
  });
});

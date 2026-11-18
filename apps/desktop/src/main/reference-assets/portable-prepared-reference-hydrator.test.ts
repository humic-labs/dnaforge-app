// @vitest-environment node

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ANNOTATION_POLICY_PROJECTION_V1,
  PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
  buildPrepackedAnnotationInteractionIndexV2,
  buildCompiledBroadSurfaceManifestV2,
  packCompiledBroadAnnotationInteractionBinaryV1,
  projectPrepackedAnnotationFeatureLookupIndexV2,
  validateCompiledBroadAnnotationInteractionBinaryV1,
  type CompiledBroadSurfaceManifestV2,
  type validatePartitionedTranscriptSceneBinaryV4,
} from '@waypoint/genome-renderer/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveAssemblyPrepackedAnnotationSceneDescriptor } from '../../features/sequence/assembly-annotation-product-descriptor';
import { ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN } from '../../features/sequence/annotation-layer-identity';
import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
  assemblyAnnotationSceneArtifactKey,
  type AssemblyAnnotationSceneArtifactContract,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import {
  COMPILED_BROAD_RASTER_MANIFEST_FILE_V1,
  publishCompiledBroadRasterArtifactV1,
  type CompiledBroadRasterCellAddressV1,
  type CompiledBroadRasterSourceCellV1,
} from '../ipc/compiled-broad-raster-artifact';
import { AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1 } from '../ipc/assembly-compiled-broad-raster-catalog';
import { annotationSceneCompilerContractFingerprint } from '../ipc/assembly-overview-texture-cache';
import type { HostedReferenceCatalogDefinitionV1 } from './hosted-reference-catalog';
import {
  createPortablePreparedReferenceHydrator,
  type PortablePreparedReferenceTransferEvent,
  writeFileHandleCompletely,
} from './portable-prepared-reference-hydrator';
import {
  buildPortablePreparedReferenceBundleV1,
  portablePreparedReferenceContentObjectKeyV1,
  type PortablePreparedReferenceObjectRoleV1,
  type PortablePreparedReferenceReadinessTierV1,
} from './portable-prepared-reference-bundle';
import {
  buildPortablePreparedReferenceFirstViewPackV1,
  MAX_FIRST_VIEW_PACK_UNCOMPRESSED_BYTES_V1,
} from './portable-prepared-reference-first-view-pack';
import {
  buildPortablePreparedReferenceFullTierShardV1,
  buildPortablePreparedReferenceFullTierShardsDescriptorV1,
  portablePreparedReferenceFullTierShardPlanV1,
} from './portable-prepared-reference-full-tier-shards';
import { PortablePreparedReferenceViewAuthorityV1 } from './portable-prepared-reference-view-authority';
import { REFERENCE_PREPARATION_PIPELINE_REVISION_V3 } from './reference-preparation-manifest';

const roots: string[] = [];
const SCENE_VALIDATION_WORK: Awaited<
  ReturnType<typeof validatePartitionedTranscriptSceneBinaryV4>
> = {
  interactionIndexValidationCount: 1,
  interactionFeatureScanCardinality: 0,
  couplingPrimitiveScanCardinality: 0,
  directFineIndexValidationCount: 2,
  directFineIndexRecordScanCardinality: 0,
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitForAttemptCount(readAttempts: () => number, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (readAttempts() === expected) return;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(`Expected ${expected} transfer attempt(s), observed ${readAttempts()}.`);
}

async function waitForPendingRetryTimer(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (vi.getTimerCount() === 1) return;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error(`Expected one pending retry timer, observed ${vi.getTimerCount()}.`);
}

function requestHeader(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (Array.isArray(headers)) {
    return (
      headers.find(([headerName]) => headerName.toLowerCase() === name.toLowerCase())?.[1] ?? null
    );
  }
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  const match = Object.entries(headers).find(
    ([headerName]) => headerName.toLowerCase() === name.toLowerCase()
  );
  return match?.[1] ?? null;
}

describe('portable prepared reference hydrator', () => {
  it('hydrates a current revision-3 prepared publication', async () => {
    const fixture = await publicationFixture({
      preparationPipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION_V3,
    });
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });

    const hydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['shell', 'view'],
    });

    expect(hydration.bundle.assembly.preparationPipelineRevision).toBe(
      REFERENCE_PREPARATION_PIPELINE_REVISION_V3
    );
    expect(hydration.hydratedTiers).toEqual(['shell', 'view']);
  });

  it('rejects a prepared publication from an unknown future pipeline revision', async () => {
    const fixture = await publicationFixture({
      preparationPipelineRevision: REFERENCE_PREPARATION_PIPELINE_REVISION_V3 + 1,
    });
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });

    await expect(
      hydrator.hydrate({
        definition: fixture.definition,
        tiers: ['shell', 'view'],
      })
    ).rejects.toThrow('pipeline revision is incompatible');
  });

  it('inspects admitted cache tiers without downloading, writing, or trusting changed members', async () => {
    const fixture = await publicationFixture();
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const makeHydrator = () =>
      createPortablePreparedReferenceHydrator({
        cacheRoot: fixture.cacheRoot,
        assetBaseUrl: new URL('https://assets.example.test/'),
        fetchAsset,
      });
    const cold = makeHydrator();
    expect(
      await cold.inspectCached({ definition: fixture.definition, tiers: ['detail', 'search'] })
    ).toBeNull();
    expect(existsSync(fixture.cacheRoot)).toBe(false);
    expect(fetchAsset).not.toHaveBeenCalled();
    const detail = await cold.hydrate({
      definition: fixture.definition,
      tiers: ['view', 'detail'],
    });
    fetchAsset.mockClear();
    const restarted = makeHydrator();
    expect(
      await restarted.inspectCached({ definition: fixture.definition, tiers: ['detail', 'search'] })
    ).toMatchObject({
      hydratedTiers: ['detail'],
      generationRoot: detail.generationRoot,
    });
    const warm = await restarted.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
      includeCachedTiers: ['detail', 'search'],
    });
    expect(warm.hydratedTiers).toEqual(['view', 'detail']);
    expect(fetchAsset).not.toHaveBeenCalled();
    const member = fixture.bundle.objects.find(
      (object) => object.role === 'annotation-scene-payload'
    )!;
    await chmod(detail.objectPaths.get(member.id)!, 0o600);
    await writeFile(detail.objectPaths.get(member.id)!, Buffer.alloc(member.byteLength, 120));
    expect(
      await restarted.inspectCached({ definition: fixture.definition, tiers: ['detail', 'search'] })
    ).toBeNull();
    const degraded = await restarted.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
      includeCachedTiers: ['detail', 'search'],
    });
    expect(degraded.hydratedTiers).toEqual(['view']);
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it('reopens the full cached tier family offline after a hydrator restart', async () => {
    const fixture = await publicationFixture();
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const options = {
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    };
    await createPortablePreparedReferenceHydrator(options).hydrate({
      definition: fixture.definition,
      tiers: ['detail', 'search'],
    });
    fetchAsset.mockClear();
    fetchAsset.mockRejectedValue(new Error('offline'));
    const cached = await createPortablePreparedReferenceHydrator(options).inspectCached({
      definition: fixture.definition,
      tiers: ['view', 'detail', 'search'],
    });
    expect(cached?.hydratedTiers).toEqual(['view', 'detail', 'search']);
    const reopened = await createPortablePreparedReferenceHydrator(options).hydrate({
      definition: fixture.definition,
      tiers: ['view'],
      includeCachedTiers: ['detail', 'search'],
    });
    expect(reopened.hydratedTiers).toEqual(['view', 'detail', 'search']);
    expect(reopened.objectPaths.size).toBe(fixture.bundle.objects.length);
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it('hydrates a cold shell + view closure with one manifest GET and one pack GET', async () => {
    const fixture = await publicationFixture({ firstViewPack: true });
    const requests: string[] = [];
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      requests.push(key);
      const bytes = fixture.assets.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const phases: string[] = [];
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });
    const hydrated = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
      onProgress: ({ phase }) => phases.push(phase),
    });

    expect(requests).toEqual([
      fixture.definition.preparedBundle!.manifest.relativePath,
      fixture.definition.preparedBundle!.firstViewPack!.relativePath,
    ]);
    expect(hydrated.objectPaths.size).toBe(3);
    for (const [id, path] of hydrated.objectPaths) {
      expect(await readFile(path)).toEqual(fixture.objectBytes.get(id));
    }
    expect(phases).toContain('transport');
    expect(phases).toContain('expanding');
    expect(phases[phases.length - 1]).toBe('ready');
  });

  it('atomically admits a 142-member packed view without per-member CAS or materialization', async () => {
    const fixture = await publicationFixture({ firstViewPack: true, extraViewObjects: 139 });
    const requests: string[] = [];
    const individualMaterializations: string[] = [];
    const packedGenerationCommits: Array<{ generationRoot: string; memberCount: number }> = [];
    const payloadHashReads: string[] = [];
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (input) => {
        const key = new URL(input).pathname.slice(1);
        requests.push(key);
        const bytes = fixture.assets.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
      instrumentation: {
        onPayloadHashRead: (path) => payloadHashReads.push(path),
        onIndividualObjectMaterialization: (path) => individualMaterializations.push(path),
        onPackedFirstViewGenerationCommit: (event) => packedGenerationCommits.push(event),
      },
    });

    const hydrated = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
    });

    expect(hydrated.objectPaths.size).toBe(142);
    expect(hydrated.generationRoot).toBe(
      join(
        await realpath(fixture.cacheRoot),
        'fixture',
        'generations',
        fixture.bundle.bundleFingerprint
      )
    );
    expect(requests).toEqual([
      fixture.definition.preparedBundle!.manifest.relativePath,
      fixture.definition.preparedBundle!.firstViewPack!.relativePath,
    ]);
    expect(individualMaterializations).toEqual([]);
    expect(packedGenerationCommits).toEqual([
      { generationRoot: hydrated.generationRoot, memberCount: 142 },
    ]);
    for (const objectId of hydrated.objectPaths.keys()) {
      const object = fixture.bundle.objects.find(({ id }) => id === objectId)!;
      expect(
        existsSync(
          join(
            fixture.cacheRoot,
            '.portable-reference-objects',
            'sha256',
            object.sha256.slice(0, 2),
            object.sha256
          )
        )
      ).toBe(false);
    }

    const warm = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
    });
    expect(warm.generationRoot).toBe(hydrated.generationRoot);
    expect(requests).toHaveLength(2);
    expect(payloadHashReads).toEqual([]);
    expect(individualMaterializations).toEqual([]);
    expect(packedGenerationCommits).toHaveLength(1);
  });

  it('collapses a 371-object cold detail + search fan-out into one bounded shard request', async () => {
    const fixture = await publicationFixture({
      firstViewPack: true,
      fullTierShards: true,
      extraSearchObjects: 361,
    });
    const plan = portablePreparedReferenceFullTierShardPlanV1(fixture.bundle);
    expect(plan.roster).toHaveLength(371);
    expect(plan.shards).toHaveLength(1);
    const requests: string[] = [];
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (input) => {
        const key = new URL(input).pathname.slice(1);
        requests.push(key);
        const bytes = fixture.assets.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
    });

    const hydrated = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail', 'search'],
    });

    expect(requests).toEqual([
      fixture.definition.preparedBundle!.manifest.relativePath,
      fixture.definition.preparedBundle!.firstViewPack!.relativePath,
      fixture.definition.preparedBundle!.fullTierShards!.shards[0]!.relativePath,
    ]);
    expect(hydrated.objectPaths.size).toBe(374);
    expect(plan.roster.some(({ objectKey }) => requests.includes(objectKey))).toBe(false);
    expect(
      plan.roster.some(({ sha256 }) =>
        existsSync(
          join(
            fixture.cacheRoot,
            '.portable-reference-objects',
            'sha256',
            sha256.slice(0, 2),
            sha256
          )
        )
      )
    ).toBe(false);

    const warm = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail', 'search'],
    });
    expect(warm.objectPaths.size).toBe(374);
    expect(requests).toHaveLength(3);
  });

  it('projects a warm sealed full tier into detail without rehashing member payloads', async () => {
    const fixture = await publicationFixture({
      firstViewPack: true,
      fullTierShards: true,
    });
    const requests: string[] = [];
    let payloadHashReads = 0;
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (input) => {
        const key = new URL(input).pathname.slice(1);
        requests.push(key);
        const bytes = fixture.assets.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
      instrumentation: {
        onPayloadHashRead: () => {
          payloadHashReads += 1;
        },
      },
    });

    await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail', 'search'],
    });
    const requestsAfterColdAdmission = requests.length;
    payloadHashReads = 0;

    const detail = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });

    expect(detail.hydratedTiers).toEqual(['detail']);
    expect(detail.objectPaths.size).toBe(9);
    expect(requests).toHaveLength(requestsAfterColdAdmission);
    expect(payloadHashReads).toBe(0);
  });

  it('seals an independently materialized detail tier for constant-work process restarts', async () => {
    const fixture = await publicationFixture({ firstViewPack: true });
    const requests: string[] = [];
    const payloadHashReads: string[] = [];
    const individualMaterializations: string[] = [];
    const createHydrator = () =>
      createPortablePreparedReferenceHydrator({
        cacheRoot: fixture.cacheRoot,
        assetBaseUrl: new URL('https://assets.example.test/'),
        fetchAsset: async (input) => {
          const key = new URL(input).pathname.slice(1);
          requests.push(key);
          const bytes = fixture.assets.get(key);
          return bytes ? new Response(bytes) : new Response(null, { status: 404 });
        },
        instrumentation: {
          onPayloadHashRead: (path) => payloadHashReads.push(path),
          onIndividualObjectMaterialization: (path) => individualMaterializations.push(path),
        },
      });

    const cold = await createHydrator().hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });
    const requestsAfterColdAdmission = requests.length;
    expect(cold.objectPaths.size).toBe(9);
    expect(existsSync(join(cold.generationRoot, '.readiness', 'detail.v2.json'))).toBe(true);

    await Promise.all(
      [...cold.objectPaths].flatMap(([id, path]) => {
        const object = fixture.bundle.objects.find((candidate) => candidate.id === id)!;
        return [
          rm(`${path}.verified.v1.json`, { force: true }),
          rm(
            join(
              fixture.cacheRoot,
              '.portable-reference-objects',
              'sha256',
              object.sha256.slice(0, 2),
              `${object.sha256}.verified.v1.json`
            ),
            { force: true }
          ),
        ];
      })
    );
    payloadHashReads.length = 0;
    individualMaterializations.length = 0;

    const warm = await createHydrator().hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });

    expect(warm.objectPaths.size).toBe(cold.objectPaths.size);
    expect(requests).toHaveLength(requestsAfterColdAdmission);
    expect(payloadHashReads).toEqual([]);
    expect(individualMaterializations).toEqual([]);
  });

  it('resumes an interrupted full-tier shard without falling through to member requests', async () => {
    const fixture = await publicationFixture({
      firstViewPack: true,
      fullTierShards: true,
    });
    const shard = fixture.definition.preparedBundle!.fullTierShards!.shards[0]!;
    const shardBytes = fixture.assets.get(shard.relativePath)!;
    const observedRanges: Array<string | null> = [];
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (input, init) => {
        const key = new URL(input).pathname.slice(1);
        const bytes = fixture.assets.get(key);
        if (!bytes) return new Response(null, { status: 404 });
        if (key !== shard.relativePath) return new Response(bytes);
        const range = requestHeader(init, 'range');
        observedRanges.push(range);
        if (observedRanges.length === 1) {
          let pulls = 0;
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls += 1;
                if (pulls === 1) {
                  controller.enqueue(shardBytes.subarray(0, 4));
                } else {
                  controller.error(new TypeError('socket reset'));
                }
              },
            })
          );
        }
        expect(range).toBe('bytes=4-');
        return new Response(shardBytes.subarray(4), {
          status: 206,
          headers: {
            'Content-Range': `bytes 4-${shardBytes.byteLength - 1}/${shardBytes.byteLength}`,
          },
        });
      },
    });

    const hydrated = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail', 'search'],
    });

    expect(observedRanges).toEqual([null, 'bytes=4-']);
    expect(hydrated.objectPaths.size).toBe(13);
  });

  it.each(['checksum', 'admission'] as const)(
    'falls back to exact member objects for a full-tier shard %s failure',
    async (failure) => {
      const fixture = await publicationFixture({
        firstViewPack: true,
        fullTierShards: true,
      });
      const collection = fixture.definition.preparedBundle!.fullTierShards!;
      const shard = collection.shards[0]!;
      let definition = fixture.definition;
      if (failure === 'checksum') {
        const corrupted = Buffer.from(fixture.assets.get(shard.relativePath)!);
        corrupted[Math.floor(corrupted.byteLength / 2)]! ^= 0xff;
        fixture.assets.set(shard.relativePath, corrupted);
      } else {
        definition = {
          ...fixture.definition,
          preparedBundle: {
            ...fixture.definition.preparedBundle!,
            fullTierShards: {
              ...collection,
              rosterSha256: 'f'.repeat(64),
            },
          },
        };
      }
      const requests: string[] = [];
      const hydrator = createPortablePreparedReferenceHydrator({
        cacheRoot: fixture.cacheRoot,
        assetBaseUrl: new URL('https://assets.example.test/'),
        fetchAsset: async (input) => {
          const key = new URL(input).pathname.slice(1);
          requests.push(key);
          const bytes = fixture.assets.get(key);
          return bytes ? new Response(bytes) : new Response(null, { status: 404 });
        },
      });

      const hydrated = await hydrator.hydrate({
        definition,
        tiers: ['detail', 'search'],
      });

      const plan = portablePreparedReferenceFullTierShardPlanV1(fixture.bundle);
      expect(hydrated.objectPaths.size).toBe(13);
      expect(requests.filter((key) => key === shard.relativePath)).toHaveLength(
        failure === 'checksum' ? 1 : 0
      );
      expect(plan.roster.every(({ objectKey }) => requests.includes(objectKey))).toBe(true);
      expect(requests).not.toContain(definition.sources.fasta.relativePath);
      expect(requests).not.toContain(definition.sources.annotations.relativePath);
    }
  );

  it.each(['corrupt', 'truncated', 'oversize', 'roster-mismatch'] as const)(
    'falls back internally to individual bundle objects for a %s first-view pack',
    async (failure) => {
      const fixture = await publicationFixture({ firstViewPack: true });
      const descriptor = fixture.definition.preparedBundle!.firstViewPack!;
      let definition = fixture.definition;
      if (failure === 'corrupt') {
        const corrupted = Buffer.from(fixture.firstViewPackBytes!);
        corrupted[Math.floor(corrupted.byteLength / 2)]! ^= 0xff;
        fixture.assets.set(descriptor.relativePath, corrupted);
      } else if (failure === 'truncated') {
        fixture.assets.set(
          descriptor.relativePath,
          fixture.firstViewPackBytes!.subarray(0, fixture.firstViewPackBytes!.byteLength - 1)
        );
      } else {
        definition = {
          ...fixture.definition,
          preparedBundle: {
            ...fixture.definition.preparedBundle!,
            firstViewPack: {
              ...descriptor,
              ...(failure === 'oversize'
                ? {
                    uncompressedByteLength: MAX_FIRST_VIEW_PACK_UNCOMPRESSED_BYTES_V1 + 1,
                  }
                : { rosterSha256: 'f'.repeat(64) }),
            },
          },
        };
      }
      const requests: string[] = [];
      const readyRequestCounts: number[] = [];
      const fetchAsset = vi.fn(async (input: string | URL) => {
        const key = new URL(input).pathname.slice(1);
        requests.push(key);
        const bytes = fixture.assets.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      });
      const hydrator = createPortablePreparedReferenceHydrator({
        cacheRoot: fixture.cacheRoot,
        assetBaseUrl: new URL('https://assets.example.test/'),
        fetchAsset,
      });

      const hydrated = await hydrator.hydrate({
        definition,
        tiers: ['view'],
        onProgress: ({ phase }) => {
          if (phase === 'ready') readyRequestCounts.push(requests.length);
        },
      });

      expect(hydrated.objectPaths.size).toBe(3);
      const packWasAdmittedForDownload = failure === 'corrupt' || failure === 'truncated';
      const expectedRequestCount = failure === 'truncated' ? 6 : packWasAdmittedForDownload ? 5 : 4;
      expect(requests).toHaveLength(expectedRequestCount);
      if (packWasAdmittedForDownload) {
        expect(requests).toContain(descriptor.relativePath);
      } else {
        expect(requests).not.toContain(descriptor.relativePath);
      }
      expect(requests).not.toContain(definition.sources.fasta.relativePath);
      expect(requests).not.toContain(definition.sources.annotations.relativePath);
      expect(readyRequestCounts).toEqual([expectedRequestCount]);
    }
  );

  it('propagates local resource failures instead of hiding them behind object fallback', async () => {
    const fixture = await publicationFixture({ firstViewPack: true });
    const requests: string[] = [];
    const localFailure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      requests.push(key);
      if (key === fixture.definition.preparedBundle!.firstViewPack!.relativePath) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(localFailure);
            },
          })
        );
      }
      const bytes = fixture.assets.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });

    await expect(
      hydrator.hydrate({ definition: fixture.definition, tiers: ['view'] })
    ).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(requests).toEqual([
      fixture.definition.preparedBundle!.manifest.relativePath,
      fixture.definition.preparedBundle!.firstViewPack!.relativePath,
    ]);
  });

  it('admits the catalog-bound manifest, bounds object concurrency, and warm-reuses one cache', async () => {
    const fixture = await publicationFixture();
    let active = 0;
    let maximumActive = 0;
    let payloadHashReads = 0;
    const requests: string[] = [];
    let releaseObjectFetches = () => {};
    const objectFetchesMayFinish = new Promise<void>((resolve) => {
      releaseObjectFetches = resolve;
    });
    let confirmTwoObjectFetchesStarted = () => {};
    const twoObjectFetchesStarted = new Promise<void>((resolve) => {
      confirmTwoObjectFetchesStarted = resolve;
    });
    const manifestKey = fixture.definition.preparedBundle!.manifest.relativePath;
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      requests.push(key);
      const bytes = fixture.assets.get(key);
      if (!bytes) return new Response(null, { status: 404 });
      if (key === manifestKey) return new Response(bytes, { status: 200 });
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (active === 2) confirmTwoObjectFetchesStarted();
      try {
        await objectFetchesMayFinish;
        return new Response(bytes, { status: 200 });
      } finally {
        active -= 1;
      }
    });
    const progress: Array<{ phase: string; completedObjects: number }> = [];
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
      concurrency: 2,
      instrumentation: {
        onPayloadHashRead: () => {
          payloadHashReads += 1;
        },
      },
    });

    const hydration = hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
      onProgress: (update) =>
        progress.push({ phase: update.phase, completedObjects: update.completedObjects }),
    });

    await twoObjectFetchesStarted;
    expect(maximumActive).toBe(2);
    releaseObjectFetches();
    const hydrated = await hydration;
    expect(hydrated.hydratedTiers).toEqual(['detail']);
    expect(hydrated.objectPaths.size).toBe(9);
    for (const [id, path] of hydrated.objectPaths) {
      expect(await readFile(path)).toEqual(fixture.objectBytes.get(id));
    }
    expect(progress.at(-1)).toEqual({ phase: 'ready', completedObjects: 9 });
    const coldRequestCount = requests.length;
    payloadHashReads = 0;

    const warm = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });
    expect(warm.generationRoot).toBe(hydrated.generationRoot);
    expect(requests).toHaveLength(coldRequestCount);
    expect(payloadHashReads).toBe(0);
    const definitionObject = fixture.bundle.objects.find(({ id }) => id === 'definition')!;
    const cachedDefinition = join(
      fixture.cacheRoot,
      '.portable-reference-objects',
      'sha256',
      definitionObject.sha256.slice(0, 2),
      definitionObject.sha256
    );
    const [cacheStat, installedStat] = await Promise.all([
      stat(cachedDefinition),
      stat(hydrated.objectPaths.get('definition')!),
    ]);
    expect({ dev: installedStat.dev, ino: installedStat.ino }).toEqual({
      dev: cacheStat.dev,
      ino: cacheStat.ino,
    });
  });

  it('loops short FileHandle writes until every byte is written', async () => {
    const written: number[] = [];
    const handle = {
      async write(bytes: Uint8Array, offset: number, length: number) {
        const bytesWritten = Math.min(2, length);
        written.push(...bytes.subarray(offset, offset + bytesWritten));
        return { bytesWritten, buffer: bytes };
      },
    };

    await writeFileHandleCompletely(
      handle as Parameters<typeof writeFileHandleCompletely>[0],
      Uint8Array.from([1, 2, 3, 4, 5])
    );

    expect(written).toEqual([1, 2, 3, 4, 5]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked generation ancestor before touching external files',
    async () => {
      const fixture = await publicationFixture();
      const externalRoot = `${fixture.cacheRoot}-external-generation`;
      roots.push(externalRoot);
      const generationsPath = join(fixture.cacheRoot, 'fixture', 'generations');
      await mkdir(dirname(generationsPath), { recursive: true });
      await mkdir(externalRoot, { recursive: true });
      await symlink(externalRoot, generationsPath, 'dir');
      const definitionObject = fixture.bundle.objects.find(({ id }) => id === 'definition')!;
      const victimPath = join(
        externalRoot,
        fixture.bundle.bundleFingerprint,
        definitionObject.installPath
      );
      await mkdir(dirname(victimPath), { recursive: true });
      await writeFile(victimPath, 'external sentinel\n');
      const hydrator = createPortablePreparedReferenceHydrator({
        cacheRoot: fixture.cacheRoot,
        assetBaseUrl: new URL('https://assets.example.test/'),
        fetchAsset: async (input) => {
          const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
          return bytes ? new Response(bytes) : new Response(null, { status: 404 });
        },
      });

      await expect(
        hydrator.hydrate({ definition: fixture.definition, tiers: ['view'] })
      ).rejects.toThrow(/symbolic link|plain directory/i);
      expect(await readFile(victimPath, 'utf8')).toBe('external sentinel\n');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'rejects readiness marker publication through a symlinked cache ancestor',
    async () => {
      const fixture = await publicationFixture();
      const hydrator = createPortablePreparedReferenceHydrator({
        cacheRoot: fixture.cacheRoot,
        assetBaseUrl: new URL('https://assets.example.test/'),
        fetchAsset: async (input) => {
          const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
          return bytes ? new Response(bytes) : new Response(null, { status: 404 });
        },
      });
      const hydrated = await hydrator.hydrate({
        definition: fixture.definition,
        tiers: ['view'],
      });
      const readinessPath = join(hydrated.generationRoot, '.readiness');
      const externalRoot = `${fixture.cacheRoot}-external-readiness`;
      roots.push(externalRoot);
      await rm(readinessPath, { recursive: true });
      await mkdir(externalRoot, { recursive: true });
      const sentinelPath = join(externalRoot, 'sentinel.txt');
      await writeFile(sentinelPath, 'external sentinel\n');
      await symlink(externalRoot, readinessPath, 'dir');

      await expect(
        hydrator.hydrate({ definition: fixture.definition, tiers: ['view'] })
      ).rejects.toThrow(/symbolic link|plain directory/i);
      expect(await readFile(sentinelPath, 'utf8')).toBe('external sentinel\n');
      await expect(readFile(join(externalRoot, 'view.v1.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it('resumes an admitted partial object with Range and atomically completes it', async () => {
    const fixture = await publicationFixture();
    const definitionObject = fixture.bundle.objects.find(({ id }) => id === 'definition')!;
    const bytes = fixture.objectBytes.get(definitionObject.id)!;
    const partialPath = join(
      fixture.cacheRoot,
      '.portable-reference-objects',
      'sha256',
      definitionObject.sha256.slice(0, 2),
      `${definitionObject.sha256}.partial`
    );
    await mkdir(dirname(partialPath), { recursive: true });
    await writeFile(partialPath, bytes.subarray(0, 4));
    expect((await stat(partialPath)).size).toBe(4);
    const observedRanges: Array<string | null> = [];
    const fetchAsset = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const key = new URL(input).pathname.slice(1);
      const asset = fixture.assets.get(key);
      if (!asset) return new Response(null, { status: 404 });
      const range = requestHeader(init, 'range');
      observedRanges.push(range);
      if (key === definitionObject.objectKey && range === 'bytes=4-') {
        return new Response(asset.subarray(4), {
          status: 206,
          headers: {
            'Content-Range': `bytes 4-${asset.byteLength - 1}/${asset.byteLength}`,
          },
        });
      }
      return new Response(asset, { status: 200 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });
    const hydrated = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['shell'],
    });

    expect(observedRanges).toContain('bytes=4-');
    expect(await readFile(hydrated.objectPaths.get('definition')!)).toEqual(bytes);
    await expect(readFile(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries a failed object stream from its verified partial byte range', async () => {
    const fixture = await publicationFixture();
    const manifestAdmission = fixture.definition.preparedBundle!.manifest;
    const manifestBytes = fixture.assets.get(manifestAdmission.relativePath)!;
    const observedManifestRanges: Array<string | null> = [];
    const transferEvents: PortablePreparedReferenceTransferEvent[] = [];
    const fetchAsset = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const key = new URL(input).pathname.slice(1);
      const asset = fixture.assets.get(key);
      if (!asset) return new Response(null, { status: 404 });
      const range = requestHeader(init, 'range');
      if (key !== manifestAdmission.relativePath) return new Response(asset);
      observedManifestRanges.push(range);
      if (observedManifestRanges.length === 1) {
        let pullCount = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pullCount += 1;
              if (pullCount === 1) {
                controller.enqueue(manifestBytes.subarray(0, 4));
                return;
              }
              controller.error(new TypeError('socket reset'));
            },
          })
        );
      }
      expect(range).toBe('bytes=4-');
      return new Response(manifestBytes.subarray(4), {
        status: 206,
        headers: {
          'Content-Range': `bytes 4-${manifestBytes.byteLength - 1}/${manifestBytes.byteLength}`,
        },
      });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
      instrumentation: {
        onContentObjectTransfer: (event) => transferEvents.push(event),
      },
    });

    const hydrated = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['shell'],
    });

    expect(observedManifestRanges).toEqual([null, 'bytes=4-']);
    expect(
      transferEvents
        .filter(({ objectKey }) => objectKey === manifestAdmission.relativePath)
        .map((event) => ({
          referenceId: event.referenceId,
          objectKey: event.objectKey,
          attempt: event.attempt,
          resumedFromBytes: event.resumedFromBytes,
          bytesTransferred: event.bytesTransferred,
          expectedBytes: event.expectedBytes,
          responseStatus: event.responseStatus,
          contentRange: event.contentRange,
          outcome: event.outcome,
          errorClass: event.errorClass,
        }))
    ).toEqual([
      {
        referenceId: fixture.definition.id,
        objectKey: manifestAdmission.relativePath,
        attempt: 1,
        resumedFromBytes: 0,
        bytesTransferred: 4,
        expectedBytes: manifestBytes.byteLength,
        responseStatus: 200,
        contentRange: null,
        outcome: 'retryable-failure',
        errorClass: 'transport',
      },
      {
        referenceId: fixture.definition.id,
        objectKey: manifestAdmission.relativePath,
        attempt: 2,
        resumedFromBytes: 4,
        bytesTransferred: manifestBytes.byteLength - 4,
        expectedBytes: manifestBytes.byteLength,
        responseStatus: 206,
        contentRange: `bytes 4-${manifestBytes.byteLength - 1}/${manifestBytes.byteLength}`,
        outcome: 'success',
        errorClass: null,
      },
    ]);
    for (const event of transferEvents) {
      expect(event).not.toHaveProperty('url');
      expect(event).not.toHaveProperty('path');
      expect(event).not.toHaveProperty('token');
    }
    expect(await readFile(hydrated.objectPaths.get('definition')!)).toEqual(
      fixture.objectBytes.get('definition')
    );
  });

  it('records retryable HTTP status and the eventual object outcome', async () => {
    const fixture = await publicationFixture();
    const manifestAdmission = fixture.definition.preparedBundle!.manifest;
    const transferEvents: PortablePreparedReferenceTransferEvent[] = [];
    const manifestAttemptStartedAt: number[] = [];
    let manifestAttempts = 0;
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (input) => {
        const key = new URL(input).pathname.slice(1);
        const asset = fixture.assets.get(key);
        if (!asset) return new Response(null, { status: 404 });
        if (key === manifestAdmission.relativePath) {
          manifestAttempts += 1;
          manifestAttemptStartedAt.push(Date.now());
          if (manifestAttempts === 1) return new Response(null, { status: 429 });
        }
        return new Response(asset);
      },
      instrumentation: {
        onContentObjectTransfer: (event) => transferEvents.push(event),
      },
    });

    await hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] });
    expect(manifestAttemptStartedAt).toHaveLength(2);
    expect(manifestAttemptStartedAt[1]! - manifestAttemptStartedAt[0]!).toBeGreaterThanOrEqual(900);

    expect(
      transferEvents
        .filter(({ objectKey }) => objectKey === manifestAdmission.relativePath)
        .map(({ attempt, outcome, responseStatus, errorClass }) => ({
          attempt,
          outcome,
          responseStatus,
          errorClass,
        }))
    ).toEqual([
      {
        attempt: 1,
        outcome: 'retryable-failure',
        responseStatus: 429,
        errorClass: 'transport',
      },
      { attempt: 2, outcome: 'success', responseStatus: 200, errorClass: null },
    ]);
  });

  it('survives three consecutive hosted rate limits before the object becomes available', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = await publicationFixture();
    const manifestAdmission = fixture.definition.preparedBundle!.manifest;
    const transferEvents: PortablePreparedReferenceTransferEvent[] = [];
    let manifestAttempts = 0;
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (input) => {
        const key = new URL(input).pathname.slice(1);
        const asset = fixture.assets.get(key);
        if (!asset) return new Response(null, { status: 404 });
        if (key === manifestAdmission.relativePath) {
          manifestAttempts += 1;
          if (manifestAttempts <= 3) return new Response(null, { status: 429 });
        }
        return new Response(asset);
      },
      instrumentation: {
        onContentObjectTransfer: (event) => transferEvents.push(event),
      },
    });

    const hydration = hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] });
    await waitForAttemptCount(() => manifestAttempts, 1);
    await waitForPendingRetryTimer();
    await vi.advanceTimersByTimeAsync(1_000);
    await waitForAttemptCount(() => manifestAttempts, 2);
    await waitForPendingRetryTimer();
    await vi.advanceTimersByTimeAsync(2_000);
    await waitForAttemptCount(() => manifestAttempts, 3);
    await waitForPendingRetryTimer();
    await vi.advanceTimersByTimeAsync(4_000);
    await waitForAttemptCount(() => manifestAttempts, 4);
    await hydration;

    expect(manifestAttempts).toBe(4);
    expect(
      transferEvents
        .filter(({ objectKey }) => objectKey === manifestAdmission.relativePath)
        .map(({ attempt, outcome, responseStatus }) => ({ attempt, outcome, responseStatus }))
    ).toEqual([
      { attempt: 1, outcome: 'retryable-failure', responseStatus: 429 },
      { attempt: 2, outcome: 'retryable-failure', responseStatus: 429 },
      { attempt: 3, outcome: 'retryable-failure', responseStatus: 429 },
      { attempt: 4, outcome: 'success', responseStatus: 200 },
    ]);
  });

  it('records AbortError as a terminal transfer cancellation', async () => {
    const fixture = await publicationFixture();
    const transferEvents: PortablePreparedReferenceTransferEvent[] = [];
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async () => {
        throw new DOMException('cancelled', 'AbortError');
      },
      instrumentation: {
        onContentObjectTransfer: (event) => transferEvents.push(event),
      },
    });

    await expect(
      hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] })
    ).rejects.toThrow('download was cancelled');
    expect(transferEvents).toHaveLength(1);
    expect(transferEvents[0]).toMatchObject({
      attempt: 1,
      outcome: 'terminal-failure',
      responseStatus: null,
      errorClass: 'abort',
    });
  });

  it('retries a clean premature EOF from its verified partial byte range', async () => {
    const fixture = await publicationFixture();
    const manifestAdmission = fixture.definition.preparedBundle!.manifest;
    const manifestBytes = fixture.assets.get(manifestAdmission.relativePath)!;
    const observedManifestRanges: Array<string | null> = [];
    const fetchAsset = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const key = new URL(input).pathname.slice(1);
      const asset = fixture.assets.get(key);
      if (!asset) return new Response(null, { status: 404 });
      const range = requestHeader(init, 'range');
      if (key !== manifestAdmission.relativePath) return new Response(asset);
      observedManifestRanges.push(range);
      if (observedManifestRanges.length === 1) {
        return new Response(manifestBytes.subarray(0, 4));
      }
      expect(range).toBe('bytes=4-');
      return new Response(manifestBytes.subarray(4), {
        status: 206,
        headers: {
          'Content-Range': `bytes 4-${manifestBytes.byteLength - 1}/${manifestBytes.byteLength}`,
        },
      });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });

    const hydrated = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['shell'],
    });

    expect(observedManifestRanges).toEqual([null, 'bytes=4-']);
    expect(await readFile(hydrated.objectPaths.get('definition')!)).toEqual(
      fixture.objectBytes.get('definition')
    );
  });

  it('settles after the retry budget and permits a later clean hydration attempt', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fixture = await publicationFixture();
    const manifestKey = fixture.definition.preparedBundle!.manifest.relativePath;
    let failManifest = true;
    let manifestAttempts = 0;
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      if (key === manifestKey) {
        manifestAttempts += 1;
        if (failManifest) throw new TypeError('temporary network failure');
      }
      const asset = fixture.assets.get(key);
      return asset ? new Response(asset) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });

    const failedHydration = expect(
      hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] })
    ).rejects.toMatchObject({ retryable: true });
    await waitForAttemptCount(() => manifestAttempts, 1);
    for (const [delayMs, expectedAttempts] of [
      [1_000, 2],
      [2_000, 3],
      [4_000, 4],
      [8_000, 5],
      [16_000, 6],
      [30_000, 7],
    ] as const) {
      await waitForPendingRetryTimer();
      await vi.advanceTimersByTimeAsync(delayMs);
      await waitForAttemptCount(() => manifestAttempts, expectedAttempts);
    }
    await failedHydration;
    expect(manifestAttempts).toBe(7);

    failManifest = false;
    await expect(
      hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] })
    ).resolves.toMatchObject({ hydratedTiers: ['shell'] });
    expect(manifestAttempts).toBe(8);
  });

  it('reuses admitted sequence files and bypasses sequence-bearing packs for annotation-only updates', async () => {
    const previous = await publicationFixture({ firstViewPack: true, fullTierShards: true });
    const revision = await publicationFixture({
      firstViewPack: true,
      fullTierShards: true,
      annotationRevision: true,
    });
    const assets = new Map([...previous.assets, ...revision.assets]);
    const requests: string[] = [];
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: previous.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (url) => {
        const key = new URL(url).pathname.slice(1);
        requests.push(key);
        const bytes = assets.get(key);
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
    });
    const old = await hydrator.hydrate({
      definition: previous.definition,
      tiers: ['detail', 'search'],
    });
    const oldSequence = await readFile(old.objectPaths.get('fasta')!);
    requests.length = 0;
    const updated = await hydrator.hydrate({
      definition: revision.definition,
      tiers: ['detail', 'search'],
      reuseSequenceFrom: old,
    });
    expect(updated.bundle.bundleFingerprint).not.toBe(old.bundle.bundleFingerprint);
    expect(await readFile(updated.objectPaths.get('fasta')!)).toEqual(oldSequence);
    expect(await readFile(old.objectPaths.get('fasta')!)).toEqual(oldSequence);
    const forbidden = [
      ...revision.bundle.objects
        .filter(({ role }) => role === 'fasta' || role === 'fasta-index')
        .map(({ objectKey }) => objectKey),
      revision.definition.preparedBundle!.firstViewPack!.relativePath,
      ...revision.definition.preparedBundle!.fullTierShards!.shards.map(
        ({ relativePath }) => relativePath
      ),
    ];
    expect(requests.some((key) => forbidden.includes(key))).toBe(false);
    expect(await readFile(updated.objectPaths.get('gff')!)).not.toEqual(
      await readFile(old.objectPaths.get('gff')!)
    );
  });

  it('rehashes and repairs a cached object when its stable stat receipt drifts', async () => {
    const fixture = await publicationFixture();
    let payloadHashReads = 0;
    const requests: string[] = [];
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      requests.push(key);
      const bytes = fixture.assets.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
      instrumentation: {
        onPayloadHashRead: () => {
          payloadHashReads += 1;
        },
      },
    });
    await hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] });
    const definitionObject = fixture.bundle.objects.find(({ id }) => id === 'definition')!;
    const cachePath = join(
      fixture.cacheRoot,
      '.portable-reference-objects',
      'sha256',
      definitionObject.sha256.slice(0, 2),
      definitionObject.sha256
    );
    await chmod(cachePath, 0o600);
    await writeFile(cachePath, Buffer.alloc(definitionObject.byteLength, 0x78));
    payloadHashReads = 0;
    const requestsBeforeRepair = requests.length;

    await hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] });

    expect(payloadHashReads).toBeGreaterThan(0);
    expect(requests.length).toBeGreaterThan(requestsBeforeRepair);
    expect(await readFile(cachePath)).toEqual(fixture.objectBytes.get('definition'));
  });

  it('closes and removes an oversized partial object before rejecting it', async () => {
    const fixture = await publicationFixture();
    const definitionObject = fixture.bundle.objects.find(({ id }) => id === 'definition')!;
    const oversizedAssets = new Map(fixture.assets);
    oversizedAssets.set(
      definitionObject.objectKey,
      Buffer.concat([fixture.objectBytes.get('definition')!, Buffer.from([0xff])])
    );
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (input) => {
        const bytes = oversizedAssets.get(new URL(input).pathname.slice(1));
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
    });

    await expect(
      hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] })
    ).rejects.toThrow('exceeds its admitted byte length');
    const partialPath = join(
      fixture.cacheRoot,
      '.portable-reference-objects',
      'sha256',
      definitionObject.sha256.slice(0, 2),
      `${definitionObject.sha256}.partial`
    );
    await expect(readFile(partialPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a validly hashed manifest whose assembly identity is not the catalog identity', async () => {
    const fixture = await publicationFixture({ assemblyId: 'different-assembly' });
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });

    await expect(
      hydrator.hydrate({ definition: fixture.definition, tiers: ['shell'] })
    ).rejects.toThrow('assembly ID does not match its catalog');
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it('rejects a catalog manifest pointer that is not the digest-addressed key', async () => {
    const fixture = await publicationFixture();
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: vi.fn(),
    });

    await expect(
      hydrator.hydrate({
        definition: {
          ...fixture.definition,
          preparedBundle: {
            manifest: {
              ...fixture.definition.preparedBundle!.manifest,
              relativePath: 'prepared/current.json',
            },
          },
        },
        tiers: ['shell'],
      })
    ).rejects.toThrow('canonical content-addressed key');
  });

  it('hydrates an authenticated lazy raster cell and returns its decoded pixels', async () => {
    const fixture = await publicationFixture({ realRaster: true });
    const requests: string[] = [];
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      requests.push(key);
      const bytes = fixture.assets.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
      concurrency: 2,
    });
    const hydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
    });

    const payloads = await hydrator.hydrateBroadRasterCells({
      definition: fixture.definition,
      hydration,
      manifestObjectId: 'raster-manifest',
      expectedSurfaceManifestFingerprint: fixture.raster!.surfaceManifestFingerprint,
      addresses: [fixture.raster!.occupiedAddress],
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.record.encodedSha256).toBe(fixture.raster!.encodedSha256);
    expect(payloads[0]!.premultipliedRgba).toEqual(fixture.raster!.decoded);
    expect(requests).toContain(
      portablePreparedReferenceContentObjectKeyV1(fixture.raster!.encodedSha256)
    );
  });

  it('materializes the same requested raster cell once for overlapping readers', async () => {
    const fixture = await publicationFixture({ realRaster: true, rasterOccupiedCellCount: 1 });
    const onIndividualObjectMaterialization = vi.fn();
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset: async (input) => {
        const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
        return bytes ? new Response(bytes) : new Response(null, { status: 404 });
      },
      instrumentation: { onIndividualObjectMaterialization },
    });
    const hydration = await hydrator.hydrate({ definition: fixture.definition, tiers: ['view'] });
    onIndividualObjectMaterialization.mockClear();
    const address = fixture.raster!.occupiedCells[0].occupiedAddress;
    const cells = await Promise.all(
      Array.from({ length: 12 }, () =>
        hydrator.hydrateBroadRasterCells({
          definition: fixture.definition,
          hydration,
          manifestObjectId: 'raster-manifest',
          expectedSurfaceManifestFingerprint: fixture.raster!.surfaceManifestFingerprint,
          addresses: [address],
        })
      )
    );
    for (const result of cells) expect(result).toEqual(cells[0]);
    expect(cells[0]).toHaveLength(1);
    expect(onIndividualObjectMaterialization).toHaveBeenCalledTimes(1);
  });

  it('shares the configured transfer limit across concurrent lazy raster-cell calls', async () => {
    const fixture = await publicationFixture({ realRaster: true, rasterOccupiedCellCount: 3 });
    const cellKeys = new Set(
      fixture.raster!.occupiedCells.map(({ encodedSha256 }) =>
        portablePreparedReferenceContentObjectKeyV1(encodedSha256)
      )
    );
    let activeCellTransfers = 0;
    let maximumActiveCellTransfers = 0;
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      const bytes = fixture.assets.get(key);
      if (!bytes) return new Response(null, { status: 404 });
      if (cellKeys.has(key)) {
        activeCellTransfers += 1;
        maximumActiveCellTransfers = Math.max(maximumActiveCellTransfers, activeCellTransfers);
        await new Promise((resolve) => setTimeout(resolve, 25));
        activeCellTransfers -= 1;
      }
      return new Response(bytes);
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
      concurrency: 2,
    });
    const hydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
    });

    await Promise.all(
      fixture.raster!.occupiedCells.map(({ occupiedAddress }) =>
        hydrator.hydrateBroadRasterCells({
          definition: fixture.definition,
          hydration,
          manifestObjectId: 'raster-manifest',
          expectedSurfaceManifestFingerprint: fixture.raster!.surfaceManifestFingerprint,
          addresses: [occupiedAddress],
        })
      )
    );

    expect(maximumActiveCellTransfers).toBe(2);
  });

  it('admits the portable view catalog and resolves broad cells lazily without local pointer state', async () => {
    const fixture = await publicationFixture({
      realRaster: true,
      completeThemeCatalog: true,
      exactScene: true,
      exactSceneTier: 'detail',
    });
    const requests: string[] = [];
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      requests.push(key);
      const bytes = fixture.assets.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });
    const hydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['shell', 'view'],
    });
    const cellKey = portablePreparedReferenceContentObjectKeyV1(fixture.raster!.encodedSha256);
    expect(requests).not.toContain(cellKey);
    const authority = new PortablePreparedReferenceViewAuthorityV1();
    const familyRoot = join(fixture.cacheRoot, 'fixture');
    const admission = await authority.admit({
      definition: fixture.definition,
      familyRoot,
      hydration,
      hydrator,
      runtimeSourceFingerprint: 'focused-runtime-a',
    });
    expect(admission).toEqual({ trackTypes: ['mRNA'] });
    const sceneRequest: AssemblyAnnotationSceneReadRequest = {
      ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
      assemblyId: 'fixture',
      workspaceRoot: familyRoot,
      datasetContract: {
        datasetId: 'waypoint:assembly-annotation:fixture',
        datasetVersion: 'fixture',
        sourceSha256: 'f'.repeat(64),
      },
      scope: {
        kind: 'complete-assembly',
        placements: [{ chrom: 'chr1', length: 100, annotationCoverage: 'sourced' }],
      },
      chromosomes: [
        {
          chrom: 'chr1',
          length: 100,
          sourcePath: `${hydration.generationRoot}/prepared/chr1/chr1.gff3.gz`,
          manifest: null,
        },
      ],
      artifact: {
        artifactKey: fixture.raster!.artifactKey,
        themeMode: 'light',
        trackType: 'mRNA',
        partitionSpanBp: 100_000_000,
        annotationBarHeightPx: 14,
        laneAlgorithmToken: 'source-lanes.v1',
        mapperContractToken: 'annotation-isoform-mapper.v2',
        geometryContractToken: 'retained-linear-directional-block.track-local.theme-final.v3',
        interactionContractToken: 'annotation-feature-hit-index.v3',
      },
      requestedPolicy: { isoformMode: 'canonical', laneLimit: null },
    };
    const opening = await authority.open({
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      scene: sceneRequest,
    });

    expect(opening?.surfaceManifest.manifestFingerprint).toBe(
      fixture.raster!.surfaceManifestFingerprint
    );
    const beforeDetailReceipt = new AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1({
      idFactory: () => 'focused-portable-opening',
    }).issue(1, opening!)?.catalogReceipt;
    expect(beforeDetailReceipt).toBeDefined();

    const detailHydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });
    await authority.admit({
      definition: fixture.definition,
      familyRoot,
      hydration: detailHydration,
      hydrator,
      runtimeSourceFingerprint: 'focused-runtime-a',
    });
    const afterDetailOpening = await authority.open({
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      scene: sceneRequest,
    });
    const afterDetailReceipt = new AssemblyCompiledBroadRasterCatalogCapabilityRegistryV1({
      idFactory: () => 'focused-portable-opening-after-detail',
    }).issue(1, afterDetailOpening!)?.catalogReceipt;
    expect(afterDetailReceipt).toEqual(beforeDetailReceipt);
    expect(afterDetailReceipt?.expectedInteractionOwnerKey).toBe(
      beforeDetailReceipt?.expectedInteractionOwnerKey
    );
    expect(afterDetailReceipt?.sceneContractSha256).toBe(beforeDetailReceipt?.sceneContractSha256);
    expect(afterDetailReceipt?.sceneSourceBuildFingerprint).toBe(
      beforeDetailReceipt?.sceneSourceBuildFingerprint
    );
    expect(requests).not.toContain(cellKey);
    await rm(hydration.objectPaths.get('raster-manifest')!);
    const payloads = await opening!.readCells!([fixture.raster!.occupiedAddress]);
    expect(payloads[0].premultipliedRgba).toEqual(fixture.raster!.decoded);
    expect(requests).toContain(cellKey);
  });

  it('serves a first-view exact scene only for its exact dataset, scope, and artifact contract', async () => {
    const fixture = await publicationFixture({
      realRaster: true,
      exactScene: true,
      firstViewPack: true,
      completeThemeCatalog: true,
      persistedCompact: true,
    });
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });
    const hydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
    });
    const admitScene = vi.fn(async (job) => {
      if (job.projection === 'admit-persisted-compiled-broad-interaction') {
        return {
          contract: job.contract,
          projection: 'persisted-compiled-broad-interaction' as const,
          byteCount: fixture.persistedCompact!.payload.byteLength,
          payloadSha256: fixture.persistedCompact!.manifest.integrity.payloadSha256,
          manifest: job.manifest,
          validatedPayload: fixture.persistedCompact!.payload,
        };
      }
      if (job.projection === 'compiled-broad-interaction') {
        const compact = await packCompiledBroadAnnotationInteractionBinaryV1({
          sourceScene: {
            schema: PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
            payloadSha256: job.manifest.integrity.payloadSha256,
            contractSha256: job.expectedProjectionContractSha256,
            byteLength: job.manifest.byteLength,
          },
          datasetContract: job.projectionDatasetContract,
          assemblyContract: job.manifest.assemblyContract,
          policyProjection: {
            schema: ANNOTATION_POLICY_PROJECTION_V1,
            featureCount: 0,
            annotationTypes: [],
            expandedBandTypeIndices: [],
            canonicalBandTypeIndices: [],
            featureRecordBytes: new Uint8Array(),
          },
          featureLookup: projectPrepackedAnnotationFeatureLookupIndexV2(
            buildPrepackedAnnotationInteractionIndexV2([], [])
          ),
          payloadSha256: async (bytes) => digest(bytes),
        });
        return {
          contract: job.contract,
          projection: 'compiled-broad-interaction' as const,
          sourceByteCount: job.manifest.byteLength,
          sourcePayloadSha256: job.expectedPayloadSha256,
          byteCount: compact.payload.byteLength,
          payloadSha256: compact.manifest.integrity.payloadSha256,
          manifest: compact.manifest,
          validatedPayload: compact.payload,
        };
      }
      return {
        contract: job.contract,
        byteCount: fixture.scenePayloadBytes!.byteLength,
        payloadSha256: digest(fixture.scenePayloadBytes!),
        validatedPayload: fixture.scenePayloadBytes!,
      };
    });
    const authority = new PortablePreparedReferenceViewAuthorityV1({ admitScene });
    const familyRoot = join(fixture.cacheRoot, 'fixture');
    await authority.admit({
      definition: fixture.definition,
      familyRoot,
      hydration,
      hydrator,
      runtimeSourceFingerprint: 'focused-runtime-a',
    });
    const request = await portableExactSceneRequest({
      familyRoot,
      generationRoot: hydration.generationRoot,
      artifactKey: fixture.raster!.artifactKey,
    });

    const localCompilerContractFingerprint = annotationSceneCompilerContractFingerprint(
      request.datasetContract,
      request.artifact,
      request.scope
    );
    expect(request.datasetContract).toMatchObject({
      datasetId: portableExactScenePublisherDatasetContract().datasetId,
      datasetVersion: portableExactScenePublisherDatasetContract().datasetVersion,
    });
    expect(request.datasetContract.sourceSha256).not.toBe(
      portableExactScenePublisherDatasetContract().sourceSha256
    );
    expect(localCompilerContractFingerprint).not.toBe(fixture.sceneCompilerContractFingerprint);
    const index = await authority.readSceneIndex(request);
    expect(index).toMatchObject({
      status: 'hit',
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: localCompilerContractFingerprint,
      scope: request.scope,
      artifact: request.artifact,
      byteCount: fixture.scenePayloadBytes!.byteLength,
      payloadSha256: digest(fixture.scenePayloadBytes!),
      placementFingerprint: expect.stringMatching(/^ap1:[0-9a-f]{24}$/),
      manifest: { datasetContract: request.datasetContract },
    });
    expect(index).not.toHaveProperty('detailRangeCatalog');
    expect(admitScene).not.toHaveBeenCalled();
    const compact = await authority.readCompiledBroadInteraction(request);
    expect(admitScene).toHaveBeenCalledTimes(1);
    await expect(admitScene.mock.results[0]!.value).resolves.toMatchObject({
      projection: 'persisted-compiled-broad-interaction',
    });
    expect(admitScene).toHaveBeenCalledWith(
      expect.objectContaining({
        projection: 'admit-persisted-compiled-broad-interaction',
        payloadPath: expect.stringContaining('compiled-broad-interaction'),
      })
    );
    expect(compact).toMatchObject({
      status: 'hit',
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: localCompilerContractFingerprint,
      scope: request.scope,
      artifact: request.artifact,
      sourceScene: {
        byteCount: fixture.scenePayloadBytes!.byteLength,
        payloadSha256: digest(fixture.scenePayloadBytes!),
      },
      manifest: {
        sourceScene: {
          byteLength: fixture.scenePayloadBytes!.byteLength,
          payloadSha256: digest(fixture.scenePayloadBytes!),
        },
      },
    });
    expect(compact!.byteCount).toBeLessThan(fixture.scenePayloadBytes!.byteLength);
    await expect(
      validateCompiledBroadAnnotationInteractionBinaryV1(
        compact!.manifest,
        compact!.validatedPayload
      )
    ).resolves.toBeUndefined();
    const repeatedCompact = await authority.readCompiledBroadInteraction(request);
    expect(repeatedCompact?.validatedPayload).toBe(compact?.validatedPayload);
    expect(admitScene).toHaveBeenCalledTimes(1);
    const hit = await authority.readScene(request);
    expect(hit).toMatchObject({
      status: 'hit',
      fingerprint: 'a'.repeat(24),
      sourceBuildFingerprint: localCompilerContractFingerprint,
      scope: request.scope,
      artifact: request.artifact,
      byteCount: fixture.scenePayloadBytes!.byteLength,
      validatedPayload: fixture.scenePayloadBytes,
      payloadSha256: digest(fixture.scenePayloadBytes!),
      manifest: {
        datasetContract: request.datasetContract,
        integrity: {
          payloadSha256: digest(fixture.scenePayloadBytes!),
        },
      },
    });
    expect(hit?.manifest.integrity.contractSha256).not.toBe('b'.repeat(64));
    expect(admitScene).toHaveBeenCalledTimes(2);
    expect(admitScene).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projection: 'full-scene',
        manifest: expect.objectContaining({
          datasetContract: portableExactScenePublisherDatasetContract(),
        }),
      })
    );
    const repeatedHit = await authority.readScene(request);
    expect(repeatedHit?.validatedPayload).toBe(hit?.validatedPayload);
    expect(admitScene).toHaveBeenCalledTimes(2);
    await authority.admit({
      definition: fixture.definition,
      familyRoot,
      hydration,
      hydrator,
      runtimeSourceFingerprint: 'focused-runtime-a',
    });
    await expect(authority.readScene(request)).resolves.toMatchObject({ status: 'hit' });
    await expect(authority.readCompiledBroadInteraction(request)).resolves.toMatchObject({
      status: 'hit',
    });
    expect(admitScene).toHaveBeenCalledTimes(2);
    await expect(
      authority.readScene({
        ...request,
        datasetContract: { ...request.datasetContract, datasetId: 'wrong-dataset' },
      })
    ).resolves.toBeNull();
    await expect(
      authority.readScene({
        ...request,
        datasetContract: { ...request.datasetContract, datasetVersion: 'wrong-version' },
      })
    ).resolves.toBeNull();
    await expect(
      authority.readScene({
        ...request,
        scope: {
          ...request.scope,
          placements: [{ ...request.scope.placements[0]!, annotationCoverage: 'unsourced' }],
        },
      })
    ).resolves.toBeNull();
    await expect(
      authority.readScene({
        ...request,
        artifact: { ...request.artifact, annotationBarHeightPx: 15 },
      })
    ).resolves.toBeNull();
    expect(admitScene).toHaveBeenCalledTimes(2);
    expect(admitScene.mock.calls.map(([job]) => job.projection)).toEqual([
      'admit-persisted-compiled-broad-interaction',
      'full-scene',
    ]);
  });

  it('publishes exact scene authority from detail hydration without search hydration', async () => {
    const fixture = await publicationFixture({
      realRaster: true,
      exactScene: true,
      exactSceneTier: 'detail',
      completeThemeCatalog: true,
      persistedCompact: true,
    });
    const requestedObjectKeys: string[] = [];
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const key = new URL(input).pathname.slice(1);
      requestedObjectKeys.push(key);
      const bytes = fixture.assets.get(key);
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });
    const hydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['detail'],
    });
    const familyRoot = join(fixture.cacheRoot, 'fixture');
    const authority = new PortablePreparedReferenceViewAuthorityV1();

    await authority.admit({
      definition: fixture.definition,
      familyRoot,
      hydration,
      hydrator,
      runtimeSourceFingerprint: 'focused-runtime-a',
    });
    const request = await portableExactSceneRequest({
      familyRoot,
      generationRoot: hydration.generationRoot,
      artifactKey: fixture.raster!.artifactKey,
    });

    await expect(authority.readSceneIndex(request)).resolves.toMatchObject({
      status: 'hit',
      byteCount: fixture.scenePayloadBytes!.byteLength,
      payloadSha256: digest(fixture.scenePayloadBytes!),
    });
    expect(hydration.hydratedTiers).toEqual(['detail']);
    const searchObjectIds = new Set(fixture.bundle.readiness.search.objectIds);
    const searchObjectKeys = fixture.bundle.objects
      .filter(({ id }) => searchObjectIds.has(id))
      .map(({ objectKey }) => objectKey);
    expect(searchObjectKeys.length).toBeGreaterThan(0);
    expect(requestedObjectKeys).not.toEqual(expect.arrayContaining(searchObjectKeys));
  });

  it('admits an exact legacy scene only when its immutable catalog bundle declares compatibility', async () => {
    const fixture = await publicationFixture({
      realRaster: true,
      exactScene: true,
      legacyExactScene: true,
      firstViewPack: true,
      completeThemeCatalog: true,
    });
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });
    const hydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
    });
    const familyRoot = join(fixture.cacheRoot, 'fixture');
    const request = await portableExactSceneRequest({
      familyRoot,
      generationRoot: hydration.generationRoot,
      artifactKey: fixture.raster!.artifactKey,
    });
    const authority = new PortablePreparedReferenceViewAuthorityV1({
      validateScene: vi.fn(async () => SCENE_VALIDATION_WORK),
    });
    await authority.admit({
      definition: fixture.definition,
      familyRoot,
      hydration,
      hydrator,
      runtimeSourceFingerprint: 'focused-runtime-a',
    });
    await expect(authority.readScene(request)).resolves.toMatchObject({
      status: 'hit',
      sourceBuildFingerprint: annotationSceneCompilerContractFingerprint(
        request.datasetContract,
        request.artifact,
        request.scope
      ),
    });
    const { legacyLayerIdentityContract: _legacy, ...preparedBundleWithoutCompatibility } =
      fixture.definition.preparedBundle!;
    const strictAuthority = new PortablePreparedReferenceViewAuthorityV1({
      validateScene: vi.fn(async () => SCENE_VALIDATION_WORK),
    });
    await strictAuthority.admit({
      definition: {
        ...fixture.definition,
        preparedBundle: preparedBundleWithoutCompatibility,
      },
      familyRoot,
      hydration,
      hydrator,
      runtimeSourceFingerprint: 'focused-runtime-a',
    });
    await expect(strictAuthority.readScene(request)).resolves.toBeNull();
  });

  it('requires explicit surface-bound selection when a bundle contains multiple raster manifests', async () => {
    const fixture = await publicationFixture({ realRaster: true, multipleRasters: true });
    const fetchAsset = vi.fn(async (input: string | URL) => {
      const bytes = fixture.assets.get(new URL(input).pathname.slice(1));
      return bytes ? new Response(bytes) : new Response(null, { status: 404 });
    });
    const hydrator = createPortablePreparedReferenceHydrator({
      cacheRoot: fixture.cacheRoot,
      assetBaseUrl: new URL('https://assets.example.test/'),
      fetchAsset,
    });
    const hydration = await hydrator.hydrate({
      definition: fixture.definition,
      tiers: ['view'],
    });

    await expect(
      hydrator.hydrateBroadRasterCells({
        definition: fixture.definition,
        hydration,
        manifestObjectId: 'raster-manifest-2',
        expectedSurfaceManifestFingerprint: 'f'.repeat(64),
        addresses: [fixture.raster!.occupiedAddress],
      })
    ).rejects.toThrow(/manifest fingerprint|surface manifest/i);

    const selected = await hydrator.hydrateBroadRasterCells({
      definition: fixture.definition,
      hydration,
      manifestObjectId: 'raster-manifest-2',
      expectedSurfaceManifestFingerprint: fixture.raster!.surfaceManifestFingerprint,
      addresses: [fixture.raster!.occupiedAddress],
    });
    expect(selected[0]!.record.encodedSha256).toBe(fixture.raster!.encodedSha256);
    expect(hydration.objectPaths.get('raster-manifest-2')).toContain('/raster-2/');
  });
});

async function publicationFixture(options?: {
  assemblyId?: string;
  preparationPipelineRevision?: number;
  annotationRevision?: boolean;
  realRaster?: boolean;
  rasterOccupiedCellCount?: number;
  exactScene?: boolean;
  exactSceneTier?: 'view' | 'detail';
  legacyExactScene?: boolean;
  multipleRasters?: boolean;
  firstViewPack?: boolean;
  fullTierShards?: boolean;
  extraViewObjects?: number;
  extraSearchObjects?: number;
  completeThemeCatalog?: boolean;
  persistedCompact?: boolean;
}) {
  const cacheRoot = join(
    tmpdir(),
    `portable-hydrator-${process.pid}-${Date.now()}-${roots.length}`
  );
  roots.push(cacheRoot);
  const raster = options?.realRaster
    ? await realRasterFixture(cacheRoot, options.rasterOccupiedCellCount ?? 1)
    : null;
  const scenePayloadBytes = Buffer.from('scene-payload-portable-object\n');
  const scenePayloadSha256 = digest(scenePayloadBytes);
  const exactScene =
    options?.exactScene && raster
      ? portableExactSceneFixture(raster.artifactKey, options.legacyExactScene ?? false)
      : null;
  const persistedCompact =
    options?.persistedCompact && exactScene
      ? await packCompiledBroadAnnotationInteractionBinaryV1({
          sourceScene: {
            schema: PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
            payloadSha256: scenePayloadSha256,
            contractSha256: 'b'.repeat(64),
            byteLength: scenePayloadBytes.byteLength,
          },
          datasetContract: portableExactScenePublisherDatasetContract(),
          assemblyContract: { assemblyId: 'fixture', assemblyLengthBp: 100 },
          policyProjection: {
            schema: ANNOTATION_POLICY_PROJECTION_V1,
            featureCount: 0,
            annotationTypes: [],
            expandedBandTypeIndices: [],
            canonicalBandTypeIndices: [],
            featureRecordBytes: new Uint8Array(),
          },
          featureLookup: projectPrepackedAnnotationFeatureLookupIndexV2(
            buildPrepackedAnnotationInteractionIndexV2([], [])
          ),
          payloadSha256: async (bytes) => digest(bytes),
        })
      : null;
  const viewCatalogBytes = raster
    ? portableViewCatalogBytes({
        surfaceManifestFingerprint: raster.surfaceManifestFingerprint,
        catalogFingerprint: raster.catalogFingerprint,
        artifactKey: raster.artifactKey,
        scenePayloadSha256,
        sceneCompilerContractFingerprint:
          exactScene?.sceneCompilerContractFingerprint ?? 'c'.repeat(64),
        completeThemeCatalog: options?.completeThemeCatalog ?? false,
        persistedCompact,
      })
    : null;
  const objectBytes = new Map<string, Buffer>();
  const objectDrafts = [
    object('definition', 'prepared-reference-definition', 'shell'),
    object('view-catalog', 'view-catalog', 'view', ['definition']),
    object('raster-manifest', 'broad-raster-manifest', 'view', ['view-catalog']),
    ...(options?.completeThemeCatalog
      ? [
          {
            ...object('raster-manifest-dark', 'broad-raster-manifest', 'view', ['view-catalog']),
            installPath: `view/raster-dark/${COMPILED_BROAD_RASTER_MANIFEST_FILE_V1}`,
          },
        ]
      : []),
    object('fasta', 'fasta', 'detail', ['definition']),
    object('fai', 'fasta-index', 'detail', ['fasta']),
    object('gff', 'gff3-bgzf', 'detail', ['definition']),
    object('tbi', 'gff3-tabix', 'detail', ['gff']),
    object(
      'scene-manifest',
      'annotation-scene-manifest',
      exactScene ? (options?.exactSceneTier ?? 'view') : 'detail',
      ['raster-manifest']
    ),
    object(
      'scene-payload',
      'annotation-scene-payload',
      exactScene ? (options?.exactSceneTier ?? 'view') : 'detail',
      ['scene-manifest']
    ),
    ...(persistedCompact
      ? [
          object('compiled-broad-interaction', 'compiled-broad-interaction-payload', 'view', [
            'view-catalog',
          ]),
        ]
      : []),
    object('annotation-search-manifest', 'annotation-search-manifest', 'search', ['definition']),
    object('annotation-search-payload', 'annotation-search-payload', 'search', [
      'annotation-search-manifest',
    ]),
    object('protein-search-manifest', 'protein-search-manifest', 'search', ['definition']),
    object('protein-search-payload', 'protein-search-payload', 'search', [
      'protein-search-manifest',
    ]),
  ];
  const extraViewObjectIds = Array.from(
    { length: options?.extraViewObjects ?? 0 },
    (_, index) => `view-overview-${index}`
  );
  objectDrafts.push(
    ...extraViewObjectIds.map((id) => object(id, 'annotation-overview', 'view', ['view-catalog']))
  );
  const extraSearchObjectIds = Array.from(
    { length: options?.extraSearchObjects ?? 0 },
    (_, index) => `extra-search-${index}`
  );
  objectDrafts.push(
    ...extraSearchObjectIds.map((id) =>
      object(id, 'protein-search-payload', 'search', ['protein-search-manifest'])
    )
  );
  if (options?.multipleRasters) {
    objectDrafts.push({
      ...object('raster-manifest-2', 'broad-raster-manifest', 'view', ['view-catalog']),
      installPath: `view/raster-2/${COMPILED_BROAD_RASTER_MANIFEST_FILE_V1}`,
    });
  }
  const objects = objectDrafts.map((entry) => {
    const bytes =
      entry.id === 'view-catalog' && viewCatalogBytes
        ? viewCatalogBytes
        : entry.id === 'scene-manifest' && exactScene
          ? exactScene.sceneManifestBytes
          : entry.id === 'scene-payload' && raster
            ? scenePayloadBytes
            : entry.id === 'compiled-broad-interaction' && persistedCompact
              ? Buffer.from(persistedCompact.payload)
              : entry.role === 'broad-raster-manifest' && raster
                ? raster.manifestBytes
                : Buffer.from(
                    `${entry.id}-portable-object${options?.annotationRevision && entry.id === 'gff' ? '-updated' : ''}\n`
                  );
    objectBytes.set(entry.id, bytes);
    const sha256 = digest(bytes);
    return {
      ...entry,
      objectKey: portablePreparedReferenceContentObjectKeyV1(sha256),
      byteLength: bytes.byteLength,
      sha256,
    };
  });
  const bundle = buildPortablePreparedReferenceBundleV1({
    assembly: {
      id: options?.assemblyId ?? 'fixture',
      assetCacheKey: 'fixture',
      preparationPipelineRevision: options?.preparationPipelineRevision ?? 1,
      assemblyLengthBp: 100,
      contigCount: 1,
      source: {
        fastaSha256: '1'.repeat(64),
        gffSha256: (options?.annotationRevision ? '3' : '2').repeat(64),
      },
    },
    objects,
    readiness: {
      shell: { dependsOn: [], objectIds: ['definition'] },
      view: {
        dependsOn: ['shell'],
        objectIds: [
          'view-catalog',
          'raster-manifest',
          ...(options?.completeThemeCatalog ? ['raster-manifest-dark'] : []),
          ...(exactScene && (options?.exactSceneTier ?? 'view') === 'view'
            ? ['scene-manifest', 'scene-payload']
            : []),
          ...(persistedCompact ? ['compiled-broad-interaction'] : []),
          ...extraViewObjectIds,
          ...(options?.multipleRasters ? ['raster-manifest-2'] : []),
        ],
      },
      detail: {
        dependsOn: ['view'],
        objectIds: [
          'fasta',
          'fai',
          'gff',
          'tbi',
          ...(!exactScene || options?.exactSceneTier === 'detail'
            ? ['scene-manifest', 'scene-payload']
            : []),
        ],
      },
      search: {
        dependsOn: ['shell'],
        objectIds: [
          'annotation-search-manifest',
          'annotation-search-payload',
          'protein-search-manifest',
          'protein-search-payload',
          ...extraSearchObjectIds,
        ],
      },
    },
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(bundle)}\n`);
  const manifestSha256 = digest(manifestBytes);
  const manifestKey = portablePreparedReferenceContentObjectKeyV1(manifestSha256);
  const assets = new Map<string, Buffer>([[manifestKey, manifestBytes]]);
  for (const object of objects) assets.set(object.objectKey, objectBytes.get(object.id)!);
  const firstViewPack = options?.firstViewPack
    ? buildPortablePreparedReferenceFirstViewPackV1({
        bundleManifestSha256: manifestSha256,
        bundle,
        memberBytes: objectBytes,
      })
    : null;
  const firstViewPackSha256 = firstViewPack ? digest(firstViewPack.bytes) : null;
  const firstViewPackKey = firstViewPackSha256
    ? portablePreparedReferenceContentObjectKeyV1(firstViewPackSha256)
    : null;
  if (firstViewPack && firstViewPackKey) assets.set(firstViewPackKey, firstViewPack.bytes);
  const fullTierShardPlan = options?.fullTierShards
    ? portablePreparedReferenceFullTierShardPlanV1(bundle)
    : null;
  const builtFullTierShards = fullTierShardPlan
    ? fullTierShardPlan.shards.map(({ shardIndex }) =>
        buildPortablePreparedReferenceFullTierShardV1({
          bundleManifestSha256: manifestSha256,
          bundle,
          shardIndex,
          memberBytes: objectBytes,
        })
      )
    : [];
  const fullTierShards =
    builtFullTierShards.length > 0
      ? buildPortablePreparedReferenceFullTierShardsDescriptorV1({
          bundleManifestSha256: manifestSha256,
          bundle,
          shards: builtFullTierShards.map(({ descriptor }) => descriptor),
        })
      : null;
  for (const { bytes, descriptor } of builtFullTierShards) {
    assets.set(descriptor.relativePath, bytes);
  }
  if (raster) {
    for (const cell of raster.occupiedCells) {
      assets.set(portablePreparedReferenceContentObjectKeyV1(cell.encodedSha256), cell.encoded);
    }
  }
  const definition: HostedReferenceCatalogDefinitionV1 = {
    id: 'fixture',
    name: 'Fixture',
    organism: 'Test organism',
    description: 'Focused portable reference fixture.',
    sources: {
      fasta: { relativePath: 'raw.fa', sha256: '1'.repeat(64), byteLength: 1 },
      annotations: {
        relativePath: 'raw.gff3',
        sha256: (options?.annotationRevision ? '3' : '2').repeat(64),
        byteLength: 1,
      },
    },
    preparedBundle: {
      ...(options?.legacyExactScene
        ? {
            legacyLayerIdentityContract:
              ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN,
          }
        : {}),
      manifest: {
        relativePath: manifestKey,
        sha256: manifestSha256,
        byteLength: manifestBytes.byteLength,
      },
      ...(firstViewPack && firstViewPackSha256 && firstViewPackKey
        ? {
            firstViewPack: {
              format: firstViewPack.format,
              relativePath: firstViewPackKey,
              sha256: firstViewPackSha256,
              byteLength: firstViewPack.bytes.byteLength,
              bundleManifestSha256: firstViewPack.bundleManifestSha256,
              bundleFingerprint: firstViewPack.bundleFingerprint,
              tiers: firstViewPack.tiers,
              rosterSha256: firstViewPack.rosterSha256,
              memberCount: firstViewPack.memberCount,
              uncompressedByteLength: firstViewPack.uncompressedByteLength,
            },
          }
        : {}),
      ...(fullTierShards ? { fullTierShards } : {}),
    },
    provenance: {
      provider: 'test',
      datasetId: 'test',
      datasetVersion: '1',
    },
    contigs: [
      {
        chrom: 'chr1',
        sourceSeqId: 'chr1',
        displayName: 'chr1',
        lengthBp: 100,
        role: 'assembled-molecule',
        circular: false,
      },
    ],
  };
  return {
    assets,
    bundle,
    cacheRoot,
    definition,
    objectBytes,
    raster,
    sceneCompilerContractFingerprint: exactScene?.sceneCompilerContractFingerprint ?? null,
    scenePayloadBytes: exactScene ? scenePayloadBytes : null,
    persistedCompact,
    firstViewPackBytes: firstViewPack?.bytes,
    fullTierShardBytes: new Map(
      builtFullTierShards.map(({ bytes, descriptor }) => [descriptor.relativePath, bytes])
    ),
  };
}

function object(
  id: string,
  role: PortablePreparedReferenceObjectRoleV1,
  tier: PortablePreparedReferenceReadinessTierV1,
  dependsOn: readonly string[] = []
) {
  return {
    id,
    role,
    installPath:
      role === 'broad-raster-manifest'
        ? `${tier}/raster/${COMPILED_BROAD_RASTER_MANIFEST_FILE_V1}`
        : `${tier}/${id}.bin`,
    contractToken: `${role}.v1`,
    dependsOn,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function realRasterFixture(root: string, occupiedCellCount: number) {
  const artifactDirectory = join(root, 'publisher-raster');
  const artifactKey = assemblyAnnotationSceneArtifactKey(portableExactSceneArtifactContract());
  const surfaceManifest = await buildCompiledBroadSurfaceManifestV2({
    artifactKey,
    trackId: 'mRNA',
    genomeLengthBp: 100,
    broadCorridorFinestSpanBp: 100,
    broadTilePhysicalWidthPx: 512,
    broadTileXGuardPhysicalPx: 1,
    prefetchRing: 1,
    maxQualifiedRasterMagnificationX: 1.75,
    rasterDevicePixelRatio: 1,
    laneSlabRowCount: 8,
    laneRowCssHeightPx: 16,
    laneRowTextureStridePx: 16,
    laneRowTransparentTailGutterPx: 2,
    laneRowCounts: { canonical: 8, expanded: 16 },
  });
  const decodedByteLength =
    (surfaceManifest.broadTilePhysicalWidthPx + surfaceManifest.broadTileXGuardPhysicalPx * 2) *
    surfaceManifest.laneSlabRowCount *
    surfaceManifest.laneRowTextureStridePx *
    4;
  const decodedCells = Array.from({ length: occupiedCellCount }, (_, index) => {
    const decoded = new Uint8Array(decodedByteLength);
    decoded[0] = index + 1;
    decoded[3] = index + 1;
    return decoded;
  });
  const manifest = await publishCompiledBroadRasterArtifactV1({
    artifactDirectory,
    surfaceManifest,
    cells: rasterCells(surfaceManifest, decodedCells),
  });
  const occupiedRecords = manifest.cells.filter((record) => record.occupancy === 'rgba8');
  if (occupiedRecords.length !== occupiedCellCount) {
    throw new Error(
      `Raster fixture requested ${occupiedCellCount} occupied cells but published ${occupiedRecords.length}.`
    );
  }
  const occupiedCells = await Promise.all(
    occupiedRecords.map(async (occupied, index) => ({
      encoded: await readFile(join(artifactDirectory, occupied.fileName!)),
      encodedSha256: occupied.encodedSha256!,
      occupiedAddress: {
        isoformMode: occupied.isoformMode,
        level: occupied.level,
        tileX: occupied.tileX,
        laneSlabIndex: occupied.laneSlabIndex,
      } satisfies CompiledBroadRasterCellAddressV1,
      decoded: decodedCells[index]!,
    }))
  );
  const firstOccupied = occupiedCells[0]!;
  return {
    manifestBytes: await readFile(join(artifactDirectory, COMPILED_BROAD_RASTER_MANIFEST_FILE_V1)),
    encoded: firstOccupied.encoded,
    encodedSha256: firstOccupied.encodedSha256,
    catalogFingerprint: manifest.catalogFingerprint,
    artifactKey: surfaceManifest.artifactKey,
    surfaceManifestFingerprint: surfaceManifest.manifestFingerprint,
    occupiedAddress: firstOccupied.occupiedAddress,
    decoded: firstOccupied.decoded,
    occupiedCells,
  };
}

function portableViewCatalogBytes(input: {
  surfaceManifestFingerprint: string;
  catalogFingerprint: string;
  artifactKey: string;
  scenePayloadSha256: string;
  sceneCompilerContractFingerprint: string;
  completeThemeCatalog: boolean;
  persistedCompact: Awaited<
    ReturnType<typeof packCompiledBroadAnnotationInteractionBinaryV1>
  > | null;
}): Buffer {
  const entry = (themeMode: 'dark' | 'light', broadManifestObjectId: string) => ({
    themeMode,
    trackType: 'mRNA',
    sourceFingerprint: 'a'.repeat(24),
    surfaceManifestFingerprint: input.surfaceManifestFingerprint,
    catalogFingerprint: input.catalogFingerprint,
    placementFingerprint: `ap1:${createHash('sha256')
      .update(
        ['placement:ordered-linear-assembly-placement-v1', 'total:100', '0|chr1|0|100|100'].join(
          '\n'
        )
      )
      .digest('hex')
      .slice(0, 24)}`,
    scenePayloadSha256: input.scenePayloadSha256,
    sceneContractSha256: 'b'.repeat(64),
    sceneCompilerContractFingerprint: input.sceneCompilerContractFingerprint,
    sceneArtifactKey: input.artifactKey,
    sceneManifestObjectId: 'scene-manifest',
    scenePayloadObjectId: 'scene-payload',
    ...(input.persistedCompact
      ? {
          compiledBroadInteractionPayloadSha256:
            input.persistedCompact.manifest.integrity.payloadSha256,
          compiledBroadInteractionPayloadObjectId: 'compiled-broad-interaction',
          compiledBroadInteractionManifest: input.persistedCompact.manifest,
        }
      : {}),
    broadManifestObjectId,
  });
  const body = {
    contract: 'dnaforge-portable-prepared-reference-view-catalog.v1',
    assemblyId: 'fixture',
    sourceFingerprint: 'a'.repeat(24),
    entries: input.completeThemeCatalog
      ? [entry('dark', 'raster-manifest-dark'), entry('light', 'raster-manifest')]
      : [entry('light', 'raster-manifest')],
  };
  return Buffer.from(
    `${JSON.stringify({
      ...body,
      catalogFingerprint: createHash('sha256').update(canonicalJson(body)).digest('hex'),
    })}\n`
  );
}

function portableExactSceneFixture(artifactKey: string, legacyLayerIdentity: boolean) {
  const datasetContract = portableExactScenePublisherDatasetContract();
  const scope = portableExactSceneScope();
  const artifact = portableExactSceneArtifact(artifactKey);
  const sceneCompilerContractFingerprint = legacyLayerIdentity
    ? annotationSceneCompilerContractFingerprint(
        datasetContract,
        artifact,
        scope,
        ANNOTATION_LAYER_IDENTITY_LEGACY_RAW_QUALIFIER_CONTRACT_TOKEN
      )
    : annotationSceneCompilerContractFingerprint(datasetContract, artifact, scope);
  if (!sceneCompilerContractFingerprint) throw new Error('Exact scene fixture is invalid.');
  const byteCount = Buffer.byteLength('scene-payload-portable-object\n');
  return {
    sceneCompilerContractFingerprint,
    sceneManifestBytes: Buffer.from(
      `${JSON.stringify({
        version: 6,
        assemblyId: 'fixture',
        fingerprint: 'a'.repeat(24),
        companionKey: sceneCompilerContractFingerprint.slice(0, 20),
        compilerContractFingerprint: sceneCompilerContractFingerprint,
        placementSignature: [
          'placement:ordered-linear-assembly-placement-v1',
          'total:100',
          '0|chr1|0|100|100',
        ].join('\n'),
        sceneFile: 'portable-scene.bin',
        byteCount,
        scope,
        artifact,
        sceneManifest: {
          schema: PARTITIONED_TRANSCRIPT_SCENE_BINARY_V4,
          byteLength: byteCount,
          datasetContract,
          assemblyContract: { assemblyId: 'fixture', assemblyLengthBp: 100 },
          partitionSpanBp: artifact.partitionSpanBp,
          integrity: {
            algorithm: 'sha256',
            payloadSha256: digest(Buffer.from('scene-payload-portable-object\n')),
            contractSha256: 'b'.repeat(64),
          },
        },
      })}\n`
    ),
  };
}

async function portableExactSceneRequest(input: {
  familyRoot: string;
  generationRoot: string;
  artifactKey: string;
}): Promise<AssemblyAnnotationSceneReadRequest> {
  const descriptor = await deriveAssemblyPrepackedAnnotationSceneDescriptor({
    themeMode: 'light',
    policy: { trackType: 'mRNA', isoformMode: 'canonical', laneLimit: null },
    request: {
      assemblyId: 'fixture',
      datasetVersion: portableExactScenePublisherDatasetContract().datasetVersion,
      workspaceRoot: input.familyRoot,
      scope: portableExactSceneScope(),
      chromosomes: [
        {
          chrom: 'chr1',
          length: 100,
          sourcePath: `${input.generationRoot}/prepared/chr1/chr1.gff3.gz`,
          manifest: null,
        },
      ],
    },
  });
  if (descriptor.artifact.artifactKey !== input.artifactKey) {
    throw new Error('Portable exact-scene fixture artifact does not match production identity.');
  }
  return descriptor.request;
}

function portableExactSceneDatasetContract() {
  return {
    datasetId: 'waypoint:assembly-annotation:fixture',
    datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
    sourceSha256: 'f'.repeat(64),
  };
}

function portableExactScenePublisherDatasetContract() {
  return {
    ...portableExactSceneDatasetContract(),
    sourceSha256: 'd'.repeat(64),
  };
}

function portableExactSceneScope() {
  return {
    kind: 'complete-assembly' as const,
    placements: [{ chrom: 'chr1', length: 100, annotationCoverage: 'sourced' as const }],
  };
}

function portableExactSceneArtifact(artifactKey: string) {
  return {
    artifactKey,
    ...portableExactSceneArtifactContract(),
  };
}

function portableExactSceneArtifactContract(): Omit<
  AssemblyAnnotationSceneArtifactContract,
  'artifactKey'
> {
  return {
    themeMode: 'light' as const,
    trackType: 'mRNA',
    partitionSpanBp: 100_000_000,
    annotationBarHeightPx: 14,
    laneAlgorithmToken: 'source-lanes.v1',
    mapperContractToken: 'annotation-isoform-mapper.v2',
    geometryContractToken: 'retained-linear-directional-block.track-local.theme-final.v3',
    interactionContractToken: 'annotation-feature-hit-index.v3',
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function* rasterCells(
  manifest: CompiledBroadSurfaceManifestV2,
  decodedCells: readonly Uint8Array[]
): AsyncGenerator<CompiledBroadRasterSourceCellV1> {
  let index = 0;
  for (const isoformMode of ['canonical', 'expanded'] as const) {
    for (const level of manifest.levels) {
      for (let tileX = 0; tileX < level.tileCount; tileX += 1) {
        for (const slab of manifest.laneSlabs[isoformMode]) {
          const address = {
            isoformMode,
            level: level.level,
            tileX,
            laneSlabIndex: slab.slabIndex,
          };
          const decoded = decodedCells[index];
          yield decoded
            ? { ...address, occupancy: 'rgba8', premultipliedRgba: decoded }
            : { ...address, occupancy: 'transparent' };
          index += 1;
        }
      }
    }
  }
}

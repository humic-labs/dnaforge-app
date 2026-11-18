import {
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
} from '@waypoint/genome-renderer/pure';
import { describe, expect, it, vi } from 'vitest';

import {
  ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  assemblyAnnotationSceneArtifactKey,
  type AssemblyAnnotationSceneReadRequest,
} from '../../shared/indexed-genome';
import type { AssemblyAnnotationSceneCacheIndexHit } from './assembly-overview-texture-cache';
import {
  AssemblyAnnotationProductIndexCoordinatorV1,
  type AssemblyAnnotationProductIndexCoordinatorDepsV1,
} from './assembly-annotation-product-index-coordinator';

type CoordinatorDeps = AssemblyAnnotationProductIndexCoordinatorDepsV1;

const MISS = {
  status: 'miss' as const,
  ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
  fingerprint: 'b'.repeat(24),
  sourceBuildFingerprint: 'c'.repeat(64),
};
const BROAD_RESULT = {
  status: 'published',
  sourceFingerprint: MISS.fingerprint,
  surfaceManifestFingerprint: 'f'.repeat(64),
  catalogFingerprint: '9'.repeat(64),
  quarantinedCorruptArtifact: false,
} as const;
const SEARCH_INDEXES = {
  annotationSearch: {
    fingerprint: '1'.repeat(24),
    byteCount: 101,
    featureCount: 11,
    payloadSha256: '2'.repeat(64),
    contractSha256: '3'.repeat(64),
    schema: 'prepacked-annotation-search-index.v1',
    contractToken: 'annotation-search-contract.v1',
  },
  proteinSearch: {
    fingerprint: '4'.repeat(24),
    byteCount: 202,
    featureCount: 22,
    payloadSha256: '5'.repeat(64),
    contractSha256: '6'.repeat(64),
    schema: 'prepacked-protein-search-index.v1',
    contractToken: 'protein-search-contract.v1',
  },
} as const;

function request(
  themeMode: 'light' | 'dark' = 'light',
  trackType = 'mRNA'
): AssemblyAnnotationSceneReadRequest {
  const chromosomes = [
    { chrom: 'chr1', sourcePath: '/ws/chr1.gff3.gz', length: 1_000 },
    { chrom: 'chrX', sourcePath: '/ws/chrX.gff3.gz', length: 500 },
  ];
  const artifactWithoutKey = {
    themeMode,
    trackType,
    partitionSpanBp: 1_000,
    annotationBarHeightPx: 9,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  } as const;
  return {
    assemblyId: 'grch38',
    workspaceRoot: '/ws',
    chromosomes,
    scope: {
      kind: 'complete-assembly',
      placements: chromosomes.map((chromosome) => ({
        chrom: chromosome.chrom,
        length: chromosome.length,
        annotationCoverage: 'sourced' as const,
      })),
    },
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    datasetContract: {
      datasetId: 'waypoint:assembly-annotation:grch38',
      datasetVersion: 'resolved-annotation-v3:mapped-track-input.v1',
      sourceSha256: 'a'.repeat(64),
    },
    artifact: {
      artifactKey: assemblyAnnotationSceneArtifactKey(artifactWithoutKey),
      ...artifactWithoutKey,
    },
    requestedPolicy: { isoformMode: 'canonical', laneLimit: 12 },
  };
}

function hit(input = request()): AssemblyAnnotationSceneCacheIndexHit {
  return {
    status: 'hit',
    ipcContractVersion: ASSEMBLY_ANNOTATION_SCENE_IPC_CONTRACT,
    fingerprint: MISS.fingerprint,
    placementFingerprint: `ap1:${'f'.repeat(24)}`,
    sourceBuildFingerprint: MISS.sourceBuildFingerprint,
    scope: input.scope,
    artifact: input.artifact,
    byteCount: 3,
    manifest: {
      datasetContract: input.datasetContract,
      assemblyContract: { assemblyId: input.assemblyId, assemblyLengthBp: 1_500 },
      integrity: {
        payloadSha256: 'd'.repeat(64),
        contractSha256: 'e'.repeat(64),
      },
    } as AssemblyAnnotationSceneCacheIndexHit['manifest'],
    scenePath: '/ws/.waypoint/genome-index/assembly-overview/grch38.scene.bin',
    payloadSha256: 'd'.repeat(64),
  };
}

describe('assembly annotation product index coordinator', () => {
  it('coalesces exact source aliases while separating artifact and generation and evicting completed entries', async () => {
    const prepare = vi.fn(async () => [{ featureIndex: 0, aliases: ['glcF.gene.1', 'b1007'] }]);
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: async (input) => hit(input),
      prepareScene: vi.fn(),
      prepareBroadCompanion: async () => BROAD_RESULT,
      prepareSourceAnnotationAliases: prepare,
    });
    const source = (input = request()) => {
      const scene = hit(input);
      return {
        request: input,
        sourceFingerprint: scene.fingerprint,
        scenePath: scene.scenePath,
        sceneManifest: scene.manifest,
        payloadSha256: scene.payloadSha256,
      };
    };
    const first = source();
    const pending = coordinator.prepareSourceAnnotationAliases(first);
    expect(coordinator.prepareSourceAnnotationAliases(first)).toBe(pending);
    expect(await pending).toMatchObject({
      payloadSha256: first.payloadSha256,
      contractSha256: first.sceneManifest.integrity.contractSha256,
    });
    await coordinator.prepareSourceAnnotationAliases(source(request('dark')));
    await coordinator.prepareSourceAnnotationAliases(
      source({
        ...request(),
        expectedAssetGeneration: {
          contract: 'assembly-reference-asset-generation.v1',
          sourceFingerprint: 'b'.repeat(24),
          inventoryFingerprint: 'a'.repeat(64),
          themeMode: 'light',
        },
      })
    );
    expect(prepare).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 16; index++)
      await coordinator.prepareSourceAnnotationAliases(source(request('light', `track-${index}`)));
    expect(coordinator.readSourceAnnotationAliases(first)).toBeUndefined();
    await coordinator.prepareSourceAnnotationAliases(first);
    expect(prepare).toHaveBeenCalledTimes(20);
  });

  it('prepares every enumerated track serially and commits one complete inventory last', async () => {
    const requests = [
      request('light', 'mRNA'),
      request('light', 'lnc_RNA'),
      request('light', 'enhancer'),
    ];
    const activeTracks: string[] = [];
    const transactionOrder: string[] = [];
    let active = 0;
    let peakActive = 0;
    const commitProductSet = vi.fn<NonNullable<CoordinatorDeps['commitProductSet']>>(
      async (input) => {
        expect(active).toBe(0);
        transactionOrder.push('commit');
        expect(input.searchIndexes).toEqual(SEARCH_INDEXES);
        expect(input.products.map((product) => product.trackType)).toEqual([
          'enhancer',
          'lnc_RNA',
          'mRNA',
        ]);
        return { inventoryFingerprint: '7'.repeat(64) };
      }
    );
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: async (input) => hit(input),
      prepareScene: vi.fn(),
      prepareBroadCompanion: async (scene) => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        activeTracks.push(scene.request.artifact.trackType);
        await Promise.resolve();
        active -= 1;
        return {
          ...BROAD_RESULT,
          surfaceManifestFingerprint: scene.request.artifact.trackType.padEnd(64, '0').slice(0, 64),
        };
      },
      prepareSearchIndexes: async () => {
        transactionOrder.push('search');
        return SEARCH_INDEXES;
      },
      commitProductSet,
    });

    await expect(coordinator.prepareSet(requests)).resolves.toEqual({
      status: 'ready',
      inventoryFingerprint: '7'.repeat(64),
      trackTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
    });
    expect(activeTracks).toEqual(['enhancer', 'lnc_RNA', 'mRNA']);
    expect(transactionOrder).toEqual(['search', 'search', 'commit']);
    expect(peakActive).toBe(1);
    expect(commitProductSet).toHaveBeenCalledTimes(1);
  });

  it('carries fused broad receipts for N cold tracks with zero follow-up worker launches or scene reads', async () => {
    const requests = [
      request('light', 'mRNA'),
      request('light', 'lnc_RNA'),
      request('light', 'enhancer'),
    ];
    const committed = new Set<string>();
    const prepareScene = vi.fn();
    const prepareSceneSet = vi.fn<NonNullable<CoordinatorDeps['prepareSceneSet']>>(
      async (entries) => {
        expect(entries.map(({ request: input }) => input.artifact.trackType)).toEqual([
          'enhancer',
          'lnc_RNA',
          'mRNA',
        ]);
        for (const { request: input } of entries) committed.add(input.artifact.trackType);
        return entries.map(({ miss }, index) => ({
          ...miss,
          status: 'committed' as const,
          broadCompanion: {
            ...BROAD_RESULT,
            surfaceManifestFingerprint: `${index + 1}`.repeat(64),
            catalogFingerprint: `${index + 4}`.repeat(64),
          },
        }));
      }
    );
    const prepareBroadCompanion = vi.fn(async () => BROAD_RESULT);
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: async (input) => (committed.has(input.artifact.trackType) ? hit(input) : MISS),
      prepareScene,
      prepareSceneSet,
      prepareBroadCompanion,
      prepareSearchIndexes: async () => SEARCH_INDEXES,
      commitProductSet: async () => ({ inventoryFingerprint: '8'.repeat(64) }),
    });

    await expect(coordinator.prepareSet(requests)).resolves.toMatchObject({
      status: 'ready',
      trackTypes: ['enhancer', 'lnc_RNA', 'mRNA'],
    });
    expect(prepareSceneSet).toHaveBeenCalledTimes(1);
    expect(prepareScene).not.toHaveBeenCalled();
    expect(prepareBroadCompanion).not.toHaveBeenCalled();
  });

  it('rejects duplicate or source-mismatched product-set inventories before compiling', async () => {
    const prepareBroadCompanion = vi.fn(async () => BROAD_RESULT);
    const commitProductSet = vi.fn();
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: async (input) => hit(input),
      prepareScene: vi.fn(),
      prepareBroadCompanion,
      prepareSearchIndexes: async () => SEARCH_INDEXES,
      commitProductSet,
    });
    const mrna = request('light', 'mRNA');

    await expect(coordinator.prepareSet([mrna, mrna])).rejects.toThrow('duplicate');
    await expect(
      coordinator.prepareSet([mrna, { ...request('light', 'lnc_RNA'), assemblyId: 'not-grch38' }])
    ).rejects.toThrow('same complete assembly');
    expect(prepareBroadCompanion).not.toHaveBeenCalled();
    expect(commitProductSet).not.toHaveBeenCalled();
  });

  it('does not publish the completeness manifest when either search index cannot verify', async () => {
    const commitProductSet = vi.fn();
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: vi.fn(async (input) => hit(input)),
      prepareScene: vi.fn(),
      prepareBroadCompanion: vi.fn(async () => BROAD_RESULT),
      prepareSearchIndexes: async () => {
        throw new Error('Protein search index was not verified.');
      },
      commitProductSet,
    });

    await expect(coordinator.prepareSet([request()])).rejects.toThrow('Protein search index');
    expect(commitProductSet).not.toHaveBeenCalled();
  });

  it('does not publish when the search-index receipts change during visual preparation', async () => {
    const commitProductSet = vi.fn();
    const prepareSearchIndexes = vi
      .fn()
      .mockResolvedValueOnce(SEARCH_INDEXES)
      .mockResolvedValueOnce({
        ...SEARCH_INDEXES,
        proteinSearch: {
          ...SEARCH_INDEXES.proteinSearch,
          payloadSha256: '8'.repeat(64),
        },
      });
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: async (input) => hit(input),
      prepareScene: vi.fn(),
      prepareBroadCompanion: async () => BROAD_RESULT,
      prepareSearchIndexes,
      commitProductSet,
    });

    await expect(coordinator.prepareSet([request()])).rejects.toThrow(
      'search-index receipts changed'
    );
    expect(prepareSearchIndexes).toHaveBeenCalledTimes(2);
    expect(commitProductSet).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'source fingerprint',
      mutate: (scene: AssemblyAnnotationSceneCacheIndexHit) => ({
        ...scene,
        fingerprint: '8'.repeat(24),
      }),
    },
    {
      label: 'exact scene receipt',
      mutate: (scene: AssemblyAnnotationSceneCacheIndexHit) => ({
        ...scene,
        scenePath: `${scene.scenePath}.replacement`,
        payloadSha256: '8'.repeat(64),
        manifest: {
          ...scene.manifest,
          integrity: {
            ...scene.manifest.integrity,
            payloadSha256: '8'.repeat(64),
          },
        },
      }),
    },
  ])(
    'does not publish when an exact $label changes after broad preparation',
    async ({ mutate }) => {
      const requests = [request('light', 'mRNA'), request('light', 'lnc_RNA')];
      const readCountByTrack = new Map<string, number>();
      const readScene = vi.fn(async (input: AssemblyAnnotationSceneReadRequest) => {
        const trackType = input.artifact.trackType;
        const readCount = readCountByTrack.get(trackType) ?? 0;
        readCountByTrack.set(trackType, readCount + 1);
        const scene = hit(input);
        return trackType === 'lnc_RNA' && readCount > 0 ? mutate(scene) : scene;
      });
      const commitProductSet = vi.fn();
      const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
        readScene,
        prepareScene: vi.fn(),
        prepareBroadCompanion: async () => BROAD_RESULT,
        prepareSearchIndexes: async () => SEARCH_INDEXES,
        commitProductSet,
      });

      await expect(coordinator.prepareSet(requests)).rejects.toThrow('exact scene receipt changed');
      expect(readCountByTrack).toEqual(
        new Map([
          ['lnc_RNA', 2],
          ['mRNA', 2],
        ])
      );
      expect(commitProductSet).not.toHaveBeenCalled();
    }
  );

  it('prepares a cold V4 scene and resolves only after the broad artifact is published', async () => {
    const input = request();
    let sceneCommitted = false;
    const readScene = vi.fn(async () => (sceneCommitted ? hit(input) : MISS));
    const prepareScene = vi.fn(async () => {
      sceneCommitted = true;
      return { ...MISS, status: 'committed' as const };
    });
    const prepareBroadCompanion = vi.fn(async () => {
      expect(sceneCommitted).toBe(true);
      return BROAD_RESULT;
    });
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene,
      prepareScene,
      prepareBroadCompanion,
    });

    const prepared = coordinator.prepare(input);
    expect(prepareScene).not.toHaveBeenCalled();
    await expect(prepared).resolves.toMatchObject({
      status: 'ready',
      artifactStatus: 'published',
      surfaceManifestFingerprint: BROAD_RESULT.surfaceManifestFingerprint,
    });

    expect(readScene).toHaveBeenCalledTimes(2);
    expect(prepareScene).toHaveBeenCalledTimes(1);
    expect(prepareBroadCompanion).toHaveBeenCalledWith(
      expect.objectContaining({
        request: input,
        scenePath: expect.stringContaining('grch38.scene.bin'),
        payloadSha256: 'd'.repeat(64),
      })
    );
  });

  it('coalesces duplicate schedules and serializes light/dark products', async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let peakActive = 0;
    const readScene = vi.fn(
      (input: AssemblyAnnotationSceneReadRequest) =>
        new Promise<AssemblyAnnotationSceneCacheIndexHit>((resolve) => {
          active += 1;
          peakActive = Math.max(peakActive, active);
          releases.push(() => {
            active -= 1;
            resolve(hit(input));
          });
        })
    );
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene,
      prepareScene: vi.fn(),
      prepareBroadCompanion: vi.fn(async () => BROAD_RESULT),
    });
    const light = request('light');
    const dark = request('dark');

    expect(coordinator.schedule(light)).toEqual({ status: 'scheduled' });
    expect(
      coordinator.schedule({
        ...light,
        requestedPolicy: { isoformMode: 'expanded', laneLimit: 64 },
      })
    ).toEqual({ status: 'coalesced' });
    expect(coordinator.schedule(dark)).toEqual({ status: 'scheduled' });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(peakActive).toBe(1);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(peakActive).toBe(1);
    releases.shift()?.();
    await coordinator.waitForIdleForTests();
    expect(readScene).toHaveBeenCalledTimes(2);
  });

  it('uses a validated built-in/reopen hit as fingerprint-based backfill without rebuilding V4', async () => {
    const input = request();
    const prepareScene = vi.fn();
    const prepareBroadCompanion = vi.fn(async () => ({
      ...BROAD_RESULT,
      status: 'already-present' as const,
    }));
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: async () => hit(input),
      prepareScene,
      prepareBroadCompanion,
    });

    await expect(coordinator.prepare(input)).resolves.toMatchObject({
      status: 'ready',
      artifactStatus: 'already-present',
    });

    expect(prepareScene).not.toHaveBeenCalled();
    expect(prepareBroadCompanion).toHaveBeenCalledTimes(1);
  });

  it('preserves the committed scene when companion registration fails terminally', async () => {
    const input = request();
    const durableScene = hit(input);
    const reportFailure = vi.fn();
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: async () => durableScene,
      prepareScene: vi.fn(),
      prepareBroadCompanion: async () => {
        throw new Error('worker unavailable');
      },
      reportFailure,
    });

    coordinator.schedule(input);
    await coordinator.waitForIdleForTests();

    expect(durableScene.status).toBe('hit');
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'worker unavailable' }),
      input
    );
  });

  it('does not schedule a companion for a terminal scene-worker outcome', async () => {
    const input = request();
    const prepareBroadCompanion = vi.fn(async () => BROAD_RESULT);
    const reportFailure = vi.fn();
    const coordinator = new AssemblyAnnotationProductIndexCoordinatorV1({
      readScene: async () => MISS,
      prepareScene: async () => ({ ...MISS, status: 'unavailable', reason: 'source-unavailable' }),
      prepareBroadCompanion,
      reportFailure,
    });

    coordinator.schedule(input);
    await coordinator.waitForIdleForTests();

    expect(prepareBroadCompanion).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledTimes(1);
  });
});

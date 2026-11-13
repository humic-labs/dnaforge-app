import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1 } from '../overview/compiled-broad-annotation-interaction-binary-v1';
import type { CompiledBroadSurfaceAdmissionProvenanceV1 } from '../overview/bounded-annotation-broad-surface';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  prepackedAnnotationSceneArtifactKey,
} from '../overview/prepacked-annotation-scene';
import type { CompiledBroadSurfaceTrackOwnerV2 } from './indexed-compiled-broad-frame';
import {
  admitCompiledBroadSurfaceSourcePlacementAuthority,
  compiledBroadSurfaceCandidateOwnerForTrack,
  compiledBroadSurfaceOwnerForTrack,
  compiledBroadSurfacePresentingLayerTypes,
  evictCompiledBroadAnnotationInteractionResidentsToLimit,
  isCompiledBroadSurfaceDemandRefreshRequired,
  loadCompiledBroadAnnotationInteraction,
  PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT,
  recordCompiledBroadSurfaceCameraRequest,
  type CompiledBroadAnnotationInteractionLoadV1,
  type CompiledBroadInteractionResidentHost,
  type ResidentCompiledBroadAnnotationInteraction,
} from './indexed-compiled-broad-interaction-residents';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

const SHA24 = 'ab'.repeat(12);
const PLACEMENT = `ap1:${SHA24}`;

function authority() {
  return {
    genomeIdentity: 'hg38',
    genomeLengthBp: 1000,
    sourceFingerprint: SHA24,
    placementFingerprint: PLACEMENT,
  };
}

function metadata(trackType = 'mRNA') {
  return {
    genomeIdentity: 'hg38',
    genomeLengthBp: 1000,
    trackType,
    artifactKey: 'art-a',
  };
}

function validMetadata(trackType: string) {
  return {
    genomeIdentity: 'hg38',
    genomeLengthBp: 1000,
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    artifactKey: prepackedAnnotationSceneArtifactKey({ themeMode: 'light', trackType }),
    themeMode: 'light' as const,
    trackType,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  };
}

function compact(ownerKey = 'owner-a'): CompiledBroadAnnotationInteractionLoadV1 {
  return {
    validationMarker: TRUSTED_MAIN_COMPILED_BROAD_ANNOTATION_INTERACTION_VALIDATION_V1,
    ownerKey,
    sourceFingerprint: SHA24,
    interactionPayloadSha256: 'cd'.repeat(32),
    sourceScene: {
      byteCount: 64,
      payloadSha256: 'cd'.repeat(32),
      contractSha256: 'cd'.repeat(32),
    },
    metadata: metadata() as never,
    policyProjection: { featureCount: 1 },
    featureLookup: { featureCount: 1 },
  };
}

function presenter(presenting = true) {
  return {
    isPresenting: presenting,
    activeTopologyCoversLastCamera: true,
    activePresentationPlan: {
      manifestFingerprint: 'mf-a',
      isoformMode: 'canonical',
      laneLimit: 12,
    },
  };
}

function host(
  overrides: Partial<CompiledBroadInteractionResidentHost> = {}
): CompiledBroadInteractionResidentHost {
  const next: CompiledBroadInteractionResidentHost = {
    currentGenomeIdentity: 'hg38',
    genomeLength: 1000,
    currentGenomeAnnotationSourcePlacementProvenance: null,
    compiledBroadSurfaceSourcePlacementAuthority: null,
    compiledBroadSurfaceProvenance: null,
    compiledBroadSurfaceCandidateProvenance: null,
    compiledBroadSurfaceTrackOwners: new Map(),
    compiledBroadSurfaceTrackCandidateOwners: new Map(),
    compiledBroadSurfaceManifest: null,
    compiledBroadSurfacePresenter: null,
    compiledBroadSurfaceCandidateManifest: null,
    compiledBroadSurfaceCandidatePresenter: null,
    currentAnnotationSourceFingerprint: null,
    currentAnnotationPlacementFingerprint: null,
    compiledBroadAnnotationInteractionResidents: new Map(),
    prepackedAnnotationSceneResidentClock: 0,
    compiledBroadAnnotationInteractionResidentGeneration: 0,
    prepackedAnnotationSceneOwnerKey: null,
    prepackedAnnotationSceneResidents: new Map(),
    prepackedAnnotationSceneLayer: null,
    prepackedAnnotationSceneReplacementCandidates: new Map(),
    compiledBroadSurfaceLastCameraRequest: null,
    compiledBroadSurfaceLastPresentationCamera: null,
    compiledBroadSurfaceLinearContract: { update() {} },
    compiledBroadSurfaceRequirement: null,
    compiledBroadSurfacePlanStatus: 'broad-presenting',
    compiledBroadSurfaceReadyDetailDemands: new Map(),
    compiledBroadSurfaceDemandLeases: new Map(),
    compiledBroadSurfaceCameraEpoch: 0,
    compiledBroadSurfaceLastCompleteTrackIds: Object.freeze(['mRNA']),
    compiledBroadSurfaceProvenanceIsCurrent: (manifest, provenance) =>
      Boolean(manifest && provenance),
    compiledBroadSurfaceAdmissionOwner: () => null,
    compiledBroadSurfaceOwnerForTrack: (trackId) =>
      compiledBroadSurfaceOwnerForTrack(next, trackId),
    compiledBroadSurfaceCandidateOwnerForTrack: (trackId) =>
      compiledBroadSurfaceCandidateOwnerForTrack(next, trackId),
    annotationLayerTypesForPresentation: () => ['mRNA'],
    ...overrides,
  };
  return next;
}

describe('compiled-broad interaction residents', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function admitCompiledBroadSurfaceSourcePlacementAuthority(');
    expect(source).not.toContain('function loadCompiledBroadAnnotationInteraction(');
    expect(source).not.toContain('function compiledBroadSurfaceInteractionResidentForTrack(');
    expect(source).not.toContain('function compiledBroadAnnotationInteractionResidentForTrack(');
    expect(source).not.toContain('function prepackedAnnotationSceneResidentForTrack(');
    expect(source).not.toContain('function requestedPrepackedAnnotationSceneResidentForTrack(');
    expect(source).not.toContain('function compiledBroadSurfaceOwnerRosterForTheme(');
    expect(source).not.toContain('function isCompiledBroadSurfaceDemandRefreshRequired(');
    expect(source).not.toContain('function recordCompiledBroadSurfaceCameraRequest(');
    expect(source).not.toContain('function compiledBroadSurfaceOwnerForTrack(');
    expect(source).not.toContain('function compiledBroadSurfaceCandidateOwnerForTrack(');
    expect(source).not.toContain('function compiledBroadSurfacePresentingLayerTypes(');
    expect(source).not.toContain(
      'function evictCompiledBroadAnnotationInteractionResidentsToLimit('
    );
  });

  it('admits matching source/placement authority and rejects a digest mismatch', () => {
    const live = host();
    expect(admitCompiledBroadSurfaceSourcePlacementAuthority(live, authority())).toBe(true);
    expect(live.currentAnnotationSourceFingerprint).toBe(SHA24);
    expect(
      admitCompiledBroadSurfaceSourcePlacementAuthority(live, {
        ...authority(),
        sourceFingerprint: 'ef'.repeat(12),
      })
    ).toBe(false);
  });

  it('rejects a compact interaction whose metadata fails the scene validator', () => {
    const live = host();
    expect(loadCompiledBroadAnnotationInteraction(live, compact())).toBeNull();
    expect(live.compiledBroadAnnotationInteractionResidents.size).toBe(0);
  });

  it('resolves the presenting owner for an exact track id', () => {
    const live = host();
    const owner = {
      manifest: { trackId: 'mRNA', manifestFingerprint: 'mf-a' },
      provenance: {
        genomeIdentity: 'hg38',
        genomeLengthBp: 1000,
        sourceFingerprint: SHA24,
        placementFingerprint: PLACEMENT,
        prepackedOwnerKey: 'owner-a',
        prepackedArtifactKey: 'art-a',
      } as CompiledBroadSurfaceAdmissionProvenanceV1,
      presenter: presenter(),
    } as CompiledBroadSurfaceTrackOwnerV2;
    live.compiledBroadSurfaceManifest = owner.manifest;
    live.compiledBroadSurfaceProvenance = owner.provenance;
    live.compiledBroadSurfacePresenter = owner.presenter;
    expect(compiledBroadSurfaceOwnerForTrack(live, 'mrna')?.manifest.trackId).toBe('mRNA');
    expect(compiledBroadSurfacePresentingLayerTypes(live)).toEqual(['mRNA']);
  });

  it('preserves case-distinct scientific owners and rejects an ambiguous alias', () => {
    const lower = {
      manifest: { trackId: 'transposon:Dm88', manifestFingerprint: 'mf-lower' },
      provenance: { prepackedOwnerKey: 'owner-lower' },
      presenter: presenter(),
    } as unknown as CompiledBroadSurfaceTrackOwnerV2;
    const upper = {
      manifest: { trackId: 'transposon:DM88', manifestFingerprint: 'mf-upper' },
      provenance: { prepackedOwnerKey: 'owner-upper' },
      presenter: presenter(),
    } as unknown as CompiledBroadSurfaceTrackOwnerV2;
    const live = host({
      compiledBroadSurfaceTrackOwners: new Map([
        [lower.manifest.trackId, lower],
        [upper.manifest.trackId, upper],
      ]),
      compiledBroadSurfaceLastCompleteTrackIds: Object.freeze([
        lower.manifest.trackId,
        upper.manifest.trackId,
      ]),
      annotationLayerTypesForPresentation: () => [lower.manifest.trackId, upper.manifest.trackId],
    });

    expect(compiledBroadSurfaceOwnerForTrack(live, lower.manifest.trackId)).toBe(lower);
    expect(compiledBroadSurfaceOwnerForTrack(live, upper.manifest.trackId)).toBe(upper);
    expect(compiledBroadSurfaceOwnerForTrack(live, 'transposon:dm88')).toBeNull();
    expect(compiledBroadSurfacePresentingLayerTypes(live)).toEqual([
      lower.manifest.trackId,
      upper.manifest.trackId,
    ]);
  });

  it('evicts disposable compact residents down to the owner cap', () => {
    const live = host({
      annotationLayerTypesForPresentation: () => [],
    });
    for (
      let index = 0;
      index < PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT + 3;
      index += 1
    ) {
      live.compiledBroadAnnotationInteractionResidents.set(`owner-${index}`, {
        ...compact(`owner-${index}`),
        lastUsed: index,
      } as ResidentCompiledBroadAnnotationInteraction);
    }
    evictCompiledBroadAnnotationInteractionResidentsToLimit(live);
    expect(live.compiledBroadAnnotationInteractionResidents.size).toBe(
      PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT
    );
  });

  it('does not report a newly admitted selected owner as loaded after evicting it', () => {
    const residentTrackTypes = Array.from(
      { length: PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT },
      (_, index) => `track-${index}`
    );
    const live = host({
      annotationLayerTypesForPresentation: () => residentTrackTypes,
    });
    for (const [index, trackType] of residentTrackTypes.entries()) {
      const ownerKey = `owner-${index}`;
      live.compiledBroadAnnotationInteractionResidents.set(ownerKey, {
        ...compact(ownerKey),
        metadata: validMetadata(trackType),
        lastUsed: index + 1,
      });
    }

    const nextTrackType = `track-${PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT}`;
    const nextOwnerKey = `owner-${PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT}`;
    const admitted = loadCompiledBroadAnnotationInteraction(live, {
      ...compact(nextOwnerKey),
      metadata: validMetadata(nextTrackType),
    });

    expect(admitted).not.toBeNull();
    expect(live.compiledBroadAnnotationInteractionResidents.get(nextOwnerKey)).toBe(admitted);

    for (
      let index = PREPACKED_ANNOTATION_INTERACTION_RESIDENT_OWNER_LIMIT + 1;
      index < 144;
      index += 1
    ) {
      const ownerKey = `owner-${index}`;
      expect(
        loadCompiledBroadAnnotationInteraction(live, {
          ...compact(ownerKey),
          metadata: validMetadata(`track-${index}`),
        })
      ).toBe(live.compiledBroadAnnotationInteractionResidents.get(ownerKey));
    }
    expect(live.compiledBroadAnnotationInteractionResidents.size).toBe(144);
  });

  it('records a new camera epoch only when the viewport changes', () => {
    const live = host();
    const camera = { path: { fwdStrandTop: 12 }, state: { themeMode: 'dark' as const } };
    recordCompiledBroadSurfaceCameraRequest(live, camera, 0, 100, 800, 2, 400);
    expect(live.compiledBroadSurfaceCameraEpoch).toBe(1);
    recordCompiledBroadSurfaceCameraRequest(live, camera, 0, 100, 800, 2, 400);
    expect(live.compiledBroadSurfaceCameraEpoch).toBe(1);
    recordCompiledBroadSurfaceCameraRequest(live, camera, 10, 110, 800, 2, 400);
    expect(live.compiledBroadSurfaceCameraEpoch).toBe(2);
    expect(live.compiledBroadSurfaceDemandLeases.size).toBe(0);
  });

  it('fails closed for demand refresh when no current owner exists', () => {
    expect(
      isCompiledBroadSurfaceDemandRefreshRequired(
        host(),
        {
          isoformMode: 'canonical',
          laneLimit: 12,
        } as never,
        'mf-a'
      )
    ).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
  PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
  PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  PREPACKED_ANNOTATION_LANE_TOKEN,
  PREPACKED_ANNOTATION_MAPPER_TOKEN,
  PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
  prepackedAnnotationSceneArtifactKey,
  type PrepackedAnnotationSceneLoadInput,
  type PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import {
  materializePrepackedAnnotationScene,
  type PrepackedMaterializeHost,
  type PrepackedMaterializeResident,
} from './indexed-prepacked-materialize';

function overlaySource(): string {
  const metaUrl = import.meta.url;
  const dir = metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
  return readFileSync(join(dir, 'annotation-overlay.ts'), 'utf8');
}

function metadata(trackType = 'mRNA'): PrepackedAnnotationSceneLoadInput['metadata'] {
  return {
    genomeIdentity: 'assembly-1',
    genomeLengthBp: 5000,
    partitionSpanBp: PREPACKED_ANNOTATION_PARTITION_SPAN_BP,
    artifactKey: prepackedAnnotationSceneArtifactKey({
      themeMode: 'light',
      trackType,
    }),
    themeMode: 'light',
    trackType,
    annotationBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    laneAlgorithmToken: PREPACKED_ANNOTATION_LANE_TOKEN,
    mapperContractToken: PREPACKED_ANNOTATION_MAPPER_TOKEN,
    geometryContractToken: PREPACKED_ANNOTATION_GEOMETRY_TOKEN,
    interactionContractToken: PREPACKED_ANNOTATION_INTERACTION_TOKEN,
  };
}

function loadInput(
  partial: Partial<PrepackedAnnotationSceneLoadInput> &
    Pick<PrepackedAnnotationSceneLoadInput, 'ownerKey'> = { ownerKey: 'mrna' }
): PrepackedAnnotationSceneLoadInput {
  const trackType = partial.metadata?.trackType ?? 'mRNA';
  return {
    scene: {
      primitives: [{ kind: 'block' }],
      families: [{ kind: 'transcript' }],
      featureFamilyIndices: new Uint32Array([0]),
    } as unknown as PrepackedAnnotationSceneLoadInput['scene'],
    interactionIndex: {
      featureCount: 1,
      primitiveCount: 1,
    } as unknown as PrepackedAnnotationSceneLoadInput['interactionIndex'],
    metadata: metadata(trackType),
    ...partial,
  };
}

function resident(
  partial: Partial<PrepackedMaterializeResident> & { ownerKey: string }
): PrepackedMaterializeResident {
  const input = partial.input ?? loadInput({ ownerKey: partial.ownerKey });
  return {
    lastUsed: 1,
    policyGeneration: 1,
    viewportDetailPresentationAdmitted: true,
    visiblePartitionCount: 0,
    visibleInstanceCount: 0,
    metadata: input.metadata,
    input,
    sourceInput: input,
    layer: {
      hide: () => undefined,
      destroy: () => undefined,
      isPresenting: false,
      isGpuPrepared: true,
      getAnnotationPolicyTrackLaneMaxima: () => null,
      container: {},
    } as unknown as PrepackedMaterializeResident['layer'],
    policyTrackLaneMaxima: null,
    ...partial,
  };
}

function host(
  overrides: Partial<PrepackedMaterializeHost> & {
    bank?: PrepackedMaterializeResident[];
    replacements?: PrepackedMaterializeResident[];
  } = {}
): PrepackedMaterializeHost & {
  status: PrepackedAnnotationSceneStatus | null;
  disposed: PrepackedAnnotationSceneStatus | null;
  destroyed: string[];
  clock: number;
} {
  const bank = overrides.bank ?? [];
  const replacements = overrides.replacements ?? [];
  const residents = new Map(bank.map((entry) => [entry.ownerKey, entry]));
  const candidates = new Map(replacements.map((entry) => [entry.ownerKey, entry]));
  const frame: PrepackedMaterializeHost & {
    status: PrepackedAnnotationSceneStatus | null;
    disposed: PrepackedAnnotationSceneStatus | null;
    destroyed: string[];
    clock: number;
  } = {
    requestedLayerTypes: ['mRNA'],
    scaledBarHeightPx: PREPACKED_ANNOTATION_BAR_HEIGHT_PX,
    currentGenomeIdentity: 'assembly-1',
    genomeLength: 5000,
    isWebgl: true,
    policyGeneration: 1,
    runtimePolicy: null,
    gpuRenderer: null,
    hasActiveOwner: bank.length > 0,
    hasActiveLayer: false,
    lastCompleteOwnerKeys: [],
    activeLayer: null,
    activeOwnerKey: null,
    activeOwnerMetadata: null,
    status: null,
    disposed: null,
    destroyed: [],
    clock: 1,
    getResident(ownerKey) {
      return residents.get(ownerKey);
    },
    getReplacementCandidate(ownerKey) {
      return candidates.get(ownerKey);
    },
    compiledInteractionForOwner: () => null,
    compiledOwnerForTrack: () => null,
    setStatus(status) {
      frame.status = status;
    },
    disposeScene(status) {
      frame.disposed = status;
      frame.status = status;
    },
    destroyResident(ownerKey) {
      frame.destroyed.push(ownerKey);
      residents.delete(ownerKey);
    },
    noteInteractionCouplingValidation: () => undefined,
    noteTrustedV4Admission: () => undefined,
    bumpResidentClock() {
      frame.clock += 1;
      return frame.clock;
    },
    bumpResidentGeneration: () => undefined,
    bumpOwnerGeneration: () => undefined,
    clearIdentityCaches: () => undefined,
    invalidateLastCompleteIfContains: () => undefined,
    retargetActiveOwnerFromResident: () => undefined,
    retractStaleActiveOwner: () => undefined,
    setRuntimePolicyIfEmpty: () => undefined,
    setGpuPrepareFailedStatus() {
      frame.status = 'gpu-prepare-failed';
    },
    putReplacementCandidate(item) {
      candidates.set(item.ownerKey, item);
    },
    putResident(item) {
      residents.set(item.ownerKey, item);
    },
    disposeLayer: () => undefined,
    installLayer: () => undefined,
    primeInactiveResident: () => undefined,
    evictResidentsToLimit: () => undefined,
    reconcileLaneEnvelope: () => undefined,
    ...overrides,
    residents: overrides.residents ?? residents.values(),
    replacementCandidates: overrides.replacementCandidates ?? candidates.values(),
  };
  return frame;
}

describe('materializePrepackedAnnotationScene', () => {
  it('lives outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('function materializePrepackedAnnotationScene');
    expect(source).not.toContain('const firstReject = firstPrepackedMaterializeRejectReason');
    expect(source).not.toContain('constructPrepackedMaterializeLayer');
    expect(source).not.toContain('preparePrepackedMaterializeLayerGpu');
  });

  it('exports the materialize entry point for the overlay façade', () => {
    expect(typeof materializePrepackedAnnotationScene).toBe('function');
  });

  it('rejects a dark-basis candidate without touching the GPU install path', () => {
    const frame = host();
    expect(
      materializePrepackedAnnotationScene(
        frame,
        loadInput({
          ownerKey: 'dark',
          metadata: { ...metadata(), themeMode: 'dark' },
        }),
        false,
        false
      )
    ).toBe(false);
    expect(frame.status).toBe('variant-mismatch');
    expect(frame.disposed).toBeNull();
  });

  it('holds an already-resident exact input as an idempotent prepare', () => {
    const input = loadInput({ ownerKey: 'mrna' });
    const existing = resident({ ownerKey: 'mrna', input, sourceInput: input });
    const frame = host({ bank: [existing], hasActiveOwner: true });
    expect(materializePrepackedAnnotationScene(frame, input, true, true)).toBe(true);
    expect(existing.lastUsed).toBe(2);
    expect(frame.status).toBeNull();
  });
});

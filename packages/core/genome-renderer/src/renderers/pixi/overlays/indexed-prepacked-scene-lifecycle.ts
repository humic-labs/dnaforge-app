import { RendererType } from 'pixi.js';
import type { Feature } from '../../../types';
import { INDEXED_ANNOTATION_COLOR_BASIS_THEME } from '../shared/annotation-runtime-theme';
import { prepackedAnnotationSceneMetadataEqual } from './annotation-prepacked-metadata';
import {
  clampPrepackedFinePrewarmViewport,
  countPrepackedFinePreparationPending,
  nextPrepackedFinePreparationAction,
} from './indexed-prepacked-fine-prewarm';
import { selectAnnotationPresentationResident } from './indexed-prepacked-resident-selection';
import { selectAdmissiblePrepackedViewportDetailRoster } from './indexed-prepacked-viewport-detail';
import { compilePrepackedAnnotationScene } from '../overview/compile-prepacked-annotation-scene';
import {
  validatePrepackedAnnotationSceneMetadata,
  type PrepackedAnnotationSceneBuildOptions,
  type PrepackedAnnotationSceneLoadInput,
  type PrepackedAnnotationSceneStatus,
} from '../overview/prepacked-annotation-scene';
import type { PartitionedTranscriptGpuPreparationRenderer } from '../overview/partitioned-instanced-transcript-layer';

export type PrepackedAnnotationFinePreparationResult = Readonly<{
  status: 'outside-prewarm-corridor' | 'waiting-residents' | 'prepared' | 'complete';
  preparedOwnerKey: string | null;
  pendingOwnerCount: number;
}>;

export type PrepackedSceneLifecycleResident = {
  ownerKey: string;
  lastUsed: number;
  policyGeneration: number;
  viewportDetailPresentationAdmitted: boolean;
  metadata: {
    trackType: string;
    themeMode: string;
  };
  input: {
    viewportDetail?: {
      coverageStartBp: number;
      coverageEndBp: number;
    };
  };
  layer: {
    isGpuPrepared: boolean;
    isCoarseFallbackPrepared: boolean;
    areFineViewsPrewarmed(startBp: number, endBp: number): boolean;
    prepareGpuResources(renderer: PartitionedTranscriptGpuPreparationRenderer): void;
    prewarmFineViews(
      startBp: number,
      endBp: number,
      renderer: PartitionedTranscriptGpuPreparationRenderer
    ): void;
    prepareNextCoarseFallbackView(renderer: PartitionedTranscriptGpuPreparationRenderer): void;
  };
};

export type PrepackedSceneLifecycleHost = {
  genomeLength: number;
  currentGenomeIdentity: string;
  prepackedAnnotationPolicyGeneration: number;
  prepackedAnnotationSceneGpuPreparations: number;
  prepackedAnnotationSceneStartupBuilds: number;
  prepackedAnnotationSceneStatus: PrepackedAnnotationSceneStatus;
  prepackedAnnotationSceneOwnerKey: string | null;
  readonly prepackedAnnotationSceneLayer: unknown | null;
  prepackedAnnotationSceneInput: PrepackedAnnotationSceneLoadInput | null;
  prepackedAnnotationSceneResidents: { values(): Iterable<PrepackedSceneLifecycleResident> };
  prepackedAnnotationSceneReplacementCandidates: {
    values(): Iterable<PrepackedSceneLifecycleResident>;
  };
  features: Feature[];
  _layout: unknown | null;
  _contract: unknown | null;
  pixiRenderer: { type?: number } | null;
  annotationLayerTypesForPresentation(): readonly string[];
  scaledBarHeight(): number;
  loadPrepackedAnnotationScene(input: PrepackedAnnotationSceneLoadInput): boolean;
};

function preparedResidents(host: PrepackedSceneLifecycleHost): PrepackedSceneLifecycleResident[] {
  return [
    ...host.prepackedAnnotationSceneReplacementCandidates.values(),
    ...host.prepackedAnnotationSceneResidents.values(),
  ];
}

function selectedRoster(
  host: PrepackedSceneLifecycleHost,
  startBp: number,
  endBp: number
): Array<PrepackedSceneLifecycleResident | undefined> {
  const residents = preparedResidents(host);
  return host.annotationLayerTypesForPresentation().map((trackType) =>
    selectAnnotationPresentationResident({
      residents,
      trackType,
      themeMode: INDEXED_ANNOTATION_COLOR_BASIS_THEME,
      policyGeneration: host.prepackedAnnotationPolicyGeneration,
      viewportStartBp: startBp,
      viewportEndBp: endBp,
    })
  );
}

export function preparePrepackedAnnotationFineViews(
  host: PrepackedSceneLifecycleHost,
  viewportStartBp: number,
  viewportEndBp: number,
  _themeMode: 'light' | 'dark'
): PrepackedAnnotationFinePreparationResult {
  const viewport = clampPrepackedFinePrewarmViewport({
    viewportStartBp,
    viewportEndBp,
    genomeLengthBp: host.genomeLength,
  });
  if (!viewport) {
    return {
      status: 'outside-prewarm-corridor',
      preparedOwnerKey: null,
      pendingOwnerCount: 0,
    };
  }
  const { startBp, endBp } = viewport;
  const residents = selectedRoster(host, startBp, endBp);
  const action = nextPrepackedFinePreparationAction({
    hasWebglRenderer: host.pixiRenderer?.type === RendererType.WEBGL,
    residents,
    startBp,
    endBp,
  });
  if (action.kind === 'waiting-residents') {
    return { status: 'waiting-residents', preparedOwnerKey: null, pendingOwnerCount: 0 };
  }
  if (action.kind === 'complete') {
    return { status: 'complete', preparedOwnerKey: null, pendingOwnerCount: 0 };
  }
  const renderer = host.pixiRenderer as PartitionedTranscriptGpuPreparationRenderer;
  if (action.kind === 'prepare-gpu') {
    action.resident.layer.prepareGpuResources(renderer);
    host.prepackedAnnotationSceneGpuPreparations += 1;
  } else if (action.kind === 'prewarm-fine') {
    action.resident.layer.prewarmFineViews(startBp, endBp, renderer);
  } else {
    action.resident.layer.prepareNextCoarseFallbackView(renderer);
  }
  const pendingOwnerCount = countPrepackedFinePreparationPending({
    residents: residents as PrepackedSceneLifecycleResident[],
    startBp,
    endBp,
    includeGpu: action.kind === 'prepare-gpu',
  });
  return {
    status: action.kind === 'prepare-gpu' || pendingOwnerCount > 0 ? 'prepared' : 'complete',
    preparedOwnerKey: action.resident.ownerKey,
    pendingOwnerCount,
  };
}

export function admitPrepackedAnnotationViewportDetailRoster(
  host: PrepackedSceneLifecycleHost,
  viewportStartBp: number,
  viewportEndBp: number,
  _themeMode: 'light' | 'dark'
): boolean {
  const startBp = Math.max(0, Math.floor(viewportStartBp));
  const endBp = Math.min(host.genomeLength, Math.ceil(viewportEndBp));
  const roster = selectedRoster(host, startBp, endBp);
  const admitted = selectAdmissiblePrepackedViewportDetailRoster({
    viewportStartBp,
    viewportEndBp,
    genomeLengthBp: host.genomeLength,
    roster,
  });
  if (!admitted) return false;
  for (const resident of admitted.residents) {
    resident.viewportDetailPresentationAdmitted = true;
  }
  return true;
}

export function buildAndLoadPrepackedAnnotationScene(
  host: PrepackedSceneLifecycleHost,
  options: PrepackedAnnotationSceneBuildOptions
): PrepackedAnnotationSceneLoadInput | null {
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  if (requestedLayerTypes.length !== 1) {
    host.prepackedAnnotationSceneStatus = 'mixed-layer-fallback';
    return null;
  }
  if (host.pixiRenderer?.type !== RendererType.WEBGL) {
    host.prepackedAnnotationSceneStatus = 'unsupported-renderer';
    return null;
  }
  if (
    !host._layout ||
    !host._contract ||
    options.trackType !== requestedLayerTypes[0] ||
    options.annotationBarHeightPx !== host.scaledBarHeight()
  ) {
    host.prepackedAnnotationSceneStatus = 'variant-mismatch';
    return null;
  }

  const { ownerKey, ...metadataOptions } = options;
  const metadata = {
    ...metadataOptions,
    genomeIdentity: host.currentGenomeIdentity,
    genomeLengthBp: host.genomeLength,
  };
  if (!validatePrepackedAnnotationSceneMetadata(metadata)) {
    host.prepackedAnnotationSceneStatus = 'variant-mismatch';
    return null;
  }
  const existing = host.prepackedAnnotationSceneInput;
  if (
    existing &&
    host.prepackedAnnotationSceneLayer &&
    host.prepackedAnnotationSceneOwnerKey === ownerKey &&
    prepackedAnnotationSceneMetadataEqual(existing.metadata, metadata)
  ) {
    host.prepackedAnnotationSceneStatus = 'eligible';
    return existing;
  }

  let input: PrepackedAnnotationSceneLoadInput;
  try {
    input = compilePrepackedAnnotationScene({
      ownerKey,
      features: host.features.filter(
        (feature) => (feature.annotationTrackId ?? feature.type) === options.trackType
      ),
      metadata,
    });
  } catch {
    host.prepackedAnnotationSceneStatus = 'variant-mismatch';
    return null;
  }
  if (!host.loadPrepackedAnnotationScene(input)) return null;
  host.prepackedAnnotationSceneStartupBuilds += 1;
  return host.prepackedAnnotationSceneInput;
}

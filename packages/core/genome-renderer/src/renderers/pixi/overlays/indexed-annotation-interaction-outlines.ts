import type { Graphics } from 'pixi.js';
import type { Feature, RenderState } from '../../../types';
import { isTranscript } from './annotation-feature-semantics';
import type { PathMapper } from '../shared/path-mapper';
import { ANNOTATION_LANE_TOTAL } from '../shared/lane-contracts';
import { interactionOutlineStyle } from '../shared/interaction-outline';
import type { OutlineCommand } from './annotation-feature-geometry';
import { compoundCdsOutlineCommands } from './compound-cds-outline';
import { interactionOutlineStrokeStyle } from './indexed-annotation-draft-outlines';
import { retainedAnnotationSectorOutline } from './annotation-mutation-sectors';
import {
  decodePrepackedAnnotationInteractionFeatureV2,
  findPrepackedAnnotationFeatureByCanonicalIdentityV2,
  type PrepackedAnnotationFeatureLookupIndexV2,
} from '../overview/prepacked-annotation-interaction-index-v2';
import type { AnnotationPolicyGpuRuntimeV1 } from '../overview/annotation-policy-gpu-instances-v1';
import type { AnnotationPolicyProjectionTableV1 } from '../overview/annotation-policy-projection-v1';

export type InteractionOutlineCompactResident = {
  metadata: { trackType: string; annotationBarHeightPx?: number };
  featureLookup: PrepackedAnnotationFeatureLookupIndexV2;
  policyProjection?: AnnotationPolicyProjectionTableV1;
};

export type InteractionOutlinePrepackedResident = {
  ownerKey: string;
  metadata: { trackType: string };
  layer: { isPresenting: boolean };
};

export type InteractionOutlineHost = {
  interactionGraphics: Graphics;
  lastInteractionOutlineCommandCount: number;
  prepackedAnnotationRuntimePolicy: AnnotationPolicyGpuRuntimeV1 | null;
  maxAnnotationLane: number;
  prepackedAnnotationLastHitOwnerKey: string | null;
  prepackedAnnotationSceneResidents: {
    values(): Iterable<InteractionOutlinePrepackedResident>;
    get(ownerKey: string): InteractionOutlinePrepackedResident | undefined;
  };
  compiledBroadAnnotationInteractionResidents: {
    get(ownerKey: string): InteractionOutlineCompactResident | undefined;
  };
  outlineCache: Map<number, OutlineCommand[]>;
  renderAnnotationSearchFocus(path: PathMapper, state: RenderState): void;
  annotationLayerTypesForPresentation(): string[];
  compiledBroadSurfaceInteractionResidentForTrack(
    trackType: string
  ): InteractionOutlinePrepackedResident | null;
  compiledBroadSurfaceOwnerForTrack(trackType: string): {
    presenter: { isPresenting: boolean };
    manifest: { laneRowCssHeightPx?: number };
  } | null;
  compiledBroadAnnotationInteractionResidentForTrack(
    trackType: string
  ): InteractionOutlineCompactResident | null;
  strokeCompiledBroadInteractionFeature(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    resident: InteractionOutlineCompactResident,
    rendererId: number,
    forceSelected: boolean,
    laneOffsetPx: number
  ): number;
  compiledBroadSurfaceLaneStart(
    trackType: string,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  strokePrepackedInteractionFeature(
    graphics: Graphics,
    path: PathMapper,
    state: RenderState,
    resident: InteractionOutlinePrepackedResident,
    rendererId: number,
    forceSelected: boolean,
    laneOffsetPx: number
  ): number;
  prepackedResidentTrackOffsetPx(
    resident: InteractionOutlinePrepackedResident,
    requestedLayerTypes: readonly string[],
    policy: AnnotationPolicyGpuRuntimeV1
  ): number;
  prepackedRendererIdForCanonicalIdentity(
    canonicalIdentity: string
  ): { ownerKey: string; rendererId: number } | null;
  invalidateCameraDependentInteractionOutline(featureId: number): void;
  ensureInteractionOutline(path: PathMapper, featureId: number, state?: RenderState): void;
  strokeOutlineCommand(graphics: Graphics, command: OutlineCommand): void;
};

function collectPresentingInteractionOutlineResidents(
  host: InteractionOutlineHost,
  requestedLayerTypes: readonly string[]
): InteractionOutlinePrepackedResident[] {
  return [...host.prepackedAnnotationSceneResidents.values()].filter((resident) => {
    if (!requestedLayerTypes.includes(resident.metadata.trackType)) return false;
    if (resident.layer.isPresenting) return true;
    return (
      host.compiledBroadSurfaceInteractionResidentForTrack(resident.metadata.trackType) === resident
    );
  });
}

function strokeCompactRasterInteractionOutlines(
  host: InteractionOutlineHost,
  path: PathMapper,
  state: RenderState,
  compactResidents: InteractionOutlineCompactResident[],
  requestedLayerTypes: readonly string[],
  runtimePolicy: AnnotationPolicyGpuRuntimeV1,
  g: Graphics
): void {
  const stroke = (
    resident: InteractionOutlineCompactResident,
    rendererId: number,
    forceSelected = false
  ): number =>
    host.strokeCompiledBroadInteractionFeature(
      g,
      path,
      state,
      resident,
      rendererId,
      forceSelected,
      -host.compiledBroadSurfaceLaneStart(
        resident.metadata.trackType,
        requestedLayerTypes,
        runtimePolicy
      ) *
        (host.compiledBroadSurfaceOwnerForTrack(resident.metadata.trackType)?.manifest
          .laneRowCssHeightPx ?? ANNOTATION_LANE_TOTAL)
    );
  if (state.hoveredId !== null) {
    const preferred = host.prepackedAnnotationLastHitOwnerKey
      ? host.compiledBroadAnnotationInteractionResidents.get(
          host.prepackedAnnotationLastHitOwnerKey
        )
      : null;
    const ordered = preferred
      ? [preferred, ...compactResidents.filter((resident) => resident !== preferred)]
      : compactResidents;
    for (const resident of ordered) {
      const commandCount = stroke(resident, state.hoveredId);
      host.lastInteractionOutlineCommandCount += commandCount;
      if (commandCount > 0) break;
    }
  }
  const selectedCanonicalIdentities = state.selectedCanonicalIdentities;
  if (selectedCanonicalIdentities && selectedCanonicalIdentities.size > 0) {
    for (const canonicalIdentity of selectedCanonicalIdentities) {
      for (const resident of compactResidents) {
        const featureIndex = findPrepackedAnnotationFeatureByCanonicalIdentityV2(
          resident.featureLookup,
          canonicalIdentity
        );
        if (featureIndex === null) continue;
        const rendererId = decodePrepackedAnnotationInteractionFeatureV2(
          resident.featureLookup,
          featureIndex
        ).rendererId;
        host.lastInteractionOutlineCommandCount += stroke(resident, rendererId, true);
        break;
      }
    }
    return;
  }
  for (const featureId of state.selectedIds) {
    if (featureId === state.hoveredId) continue;
    for (const resident of compactResidents) {
      const commandCount = stroke(resident, featureId);
      host.lastInteractionOutlineCommandCount += commandCount;
      if (commandCount > 0) break;
    }
  }
}

function strokePrepackedVectorInteractionOutlines(
  host: InteractionOutlineHost,
  path: PathMapper,
  state: RenderState,
  residents: InteractionOutlinePrepackedResident[],
  requestedLayerTypes: readonly string[],
  runtimePolicy: AnnotationPolicyGpuRuntimeV1,
  g: Graphics
): void {
  if (state.hoveredId !== null) {
    const preferred = host.prepackedAnnotationLastHitOwnerKey
      ? host.prepackedAnnotationSceneResidents.get(host.prepackedAnnotationLastHitOwnerKey)
      : null;
    const orderedResidents = preferred
      ? [preferred, ...residents.filter((resident) => resident !== preferred)]
      : residents;
    for (const resident of orderedResidents) {
      const commandCount = host.strokePrepackedInteractionFeature(
        g,
        path,
        state,
        resident,
        state.hoveredId,
        false,
        host.prepackedResidentTrackOffsetPx(resident, requestedLayerTypes, runtimePolicy)
      );
      host.lastInteractionOutlineCommandCount += commandCount;
      if (commandCount > 0) break;
    }
  }
  const selectedCanonicalIdentities = state.selectedCanonicalIdentities;
  if (selectedCanonicalIdentities && selectedCanonicalIdentities.size > 0) {
    for (const canonicalIdentity of selectedCanonicalIdentities) {
      const resolved = host.prepackedRendererIdForCanonicalIdentity(canonicalIdentity);
      if (!resolved) continue;
      const resident = host.prepackedAnnotationSceneResidents.get(resolved.ownerKey);
      if (!resident || !residents.includes(resident)) continue;
      host.lastInteractionOutlineCommandCount += host.strokePrepackedInteractionFeature(
        g,
        path,
        state,
        resident,
        resolved.rendererId,
        true,
        host.prepackedResidentTrackOffsetPx(resident, requestedLayerTypes, runtimePolicy)
      );
    }
    return;
  }
  for (const featureId of state.selectedIds) {
    if (featureId === state.hoveredId) continue;
    for (const resident of residents) {
      const commandCount = host.strokePrepackedInteractionFeature(
        g,
        path,
        state,
        resident,
        featureId,
        false,
        host.prepackedResidentTrackOffsetPx(resident, requestedLayerTypes, runtimePolicy)
      );
      host.lastInteractionOutlineCommandCount += commandCount;
      if (commandCount > 0) break;
    }
  }
}

export function renderInteractionOutlines(
  host: InteractionOutlineHost,
  path: PathMapper,
  state: RenderState,
  codonContours?: ReadonlyMap<number, readonly number[][]>
): void {
  if (!codonContours) host.renderAnnotationSearchFocus(path, state);
  const g = host.interactionGraphics;
  g.clear();
  g.visible = false;
  host.lastInteractionOutlineCommandCount = 0;
  const selectedCanonicalIdentities = state.selectedCanonicalIdentities;
  if (
    state.hoveredId === null &&
    state.selectedIds.size === 0 &&
    (!selectedCanonicalIdentities || selectedCanonicalIdentities.size === 0)
  ) {
    return;
  }
  const requestedLayerTypes = host.annotationLayerTypesForPresentation();
  const runtimePolicy = host.prepackedAnnotationRuntimePolicy ?? {
    isoformMode: 'canonical' as const,
    laneLimit: Math.max(1, host.maxAnnotationLane + 1),
  };
  const residents = collectPresentingInteractionOutlineResidents(host, requestedLayerTypes);
  const compiledBroadRasterPresenting = requestedLayerTypes.some(
    (trackType) => host.compiledBroadSurfaceOwnerForTrack(trackType)?.presenter.isPresenting
  );
  const compactResidents = compiledBroadRasterPresenting
    ? requestedLayerTypes.flatMap((trackType) => {
        const resident = host.compiledBroadAnnotationInteractionResidentForTrack(trackType);
        return resident ? [resident] : [];
      })
    : [];

  if (compiledBroadRasterPresenting && compactResidents.length === 0 && residents.length === 0) {
    return;
  }
  g.visible = true;

  if (compactResidents.length > 0 && !path.isArcMode) {
    strokeCompactRasterInteractionOutlines(
      host,
      path,
      state,
      compactResidents,
      requestedLayerTypes,
      runtimePolicy,
      g
    );
    g.visible = host.lastInteractionOutlineCommandCount > 0;
    return;
  }

  if (residents.length > 0 && !path.isArcMode) {
    strokePrepackedVectorInteractionOutlines(
      host,
      path,
      state,
      residents,
      requestedLayerTypes,
      runtimePolicy,
      g
    );
    g.visible = host.lastInteractionOutlineCommandCount > 0;
    return;
  }

  if (compiledBroadRasterPresenting) return;

  if (state.hoveredId !== null) {
    host.invalidateCameraDependentInteractionOutline(state.hoveredId);
    host.ensureInteractionOutline(path, state.hoveredId, state);
  }
  for (const featureId of state.selectedIds) {
    host.invalidateCameraDependentInteractionOutline(featureId);
    host.ensureInteractionOutline(path, featureId, state);
  }

  for (const featureId of codonContours?.keys() ?? []) {
    if (!host.outlineCache.has(featureId)) host.outlineCache.set(featureId, []);
  }
  for (const [featureId, featureCommands] of host.outlineCache) {
    const style = interactionOutlineStyle(state, featureId);
    if (!style) continue;
    const codons = codonContours?.get(featureId);
    const commands = codons ? compoundCdsOutlineCommands(featureCommands, codons) : featureCommands;
    host.lastInteractionOutlineCommandCount += commands.length;

    for (const command of commands) {
      g.setStrokeStyle(interactionOutlineStrokeStyle(command, style));
      host.strokeOutlineCommand(g, command);
    }
  }
}

export type EnsureInteractionOutlineHost = {
  genomeLength: number;
  outlineCache: Map<number, OutlineCommand[]>;
  featureById: Map<number, Feature>;
  retainedLinearTranscriptFeatureSet?: ReadonlySet<Feature> | null;
  cdsDetailProgress?(): number;
  featureOffset(feature: Feature): number;
  scaledBarHeight(): number;
  standardFeatureDrawPoints(
    feature: Feature,
    endBp: number,
    pixelWidth: number,
    path: PathMapper,
    hitPts: number[]
  ): number[];
  setFeatureOutline(featureId: number, commands: OutlineCommand[]): void;
  transcriptGlyphOutlineCommands(feature: Feature, path: PathMapper): OutlineCommand[];
};

export function ensureInteractionOutline(
  host: EnsureInteractionOutlineHost,
  path: PathMapper,
  featureId: number,
  state?: RenderState
): void {
  if (host.outlineCache.has(featureId)) return;
  const feature = host.featureById.get(featureId);
  if (!feature) return;

  const featureLen =
    feature.end > feature.start
      ? feature.end - feature.start
      : host.genomeLength - feature.start + feature.end;
  if (featureLen <= 0) return;

  const offset = host.featureOffset(feature);
  const halfHeight = host.scaledBarHeight() / 2;
  if (!path.isFeatureVisible(feature.start, featureLen, offset, halfHeight)) return;

  if (state && !path.isArcMode && host.retainedLinearTranscriptFeatureSet?.has(feature)) {
    host.setFeatureOutline(featureId, [
      ...retainedAnnotationSectorOutline(
        feature,
        path,
        state,
        offset,
        halfHeight,
        host.cdsDetailProgress?.() ?? 0
      ),
      ...host
        .transcriptGlyphOutlineCommands(feature, path)
        .filter((command) => command.kind === 'polyline'),
    ]);
    return;
  }

  const endBp = feature.end > feature.start ? feature.end : feature.end + host.genomeLength;
  const pixelWidth = featureLen * path.pixelsPerBp;
  const hitPts = path.featurePolygonAt(feature.start, endBp, offset, halfHeight);
  const drawPts = host.standardFeatureDrawPoints(feature, endBp, pixelWidth, path, hitPts);
  if (isTranscript(feature)) {
    host.setFeatureOutline(feature.id, host.transcriptGlyphOutlineCommands(feature, path));
  } else {
    host.setFeatureOutline(feature.id, [{ kind: 'poly', pts: drawPts }]);
  }
}

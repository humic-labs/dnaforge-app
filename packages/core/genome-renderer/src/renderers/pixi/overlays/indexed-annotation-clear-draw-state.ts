import type { Graphics, Text } from 'pixi.js';
import { emptyAnnotationBodyPresenterEligibility } from './annotation-body-presentation-authority';
import type { AnnotationBodyFrameOwnerKind } from './annotation-body-presentation-authority';
import type { AnnotationBodyPresenterEligibility } from './annotation-body-presentation-authority';

export type ClearDrawStateHost = {
  graphics: Graphics;
  retainedTranscriptDecorationGraphics: Graphics;
  annotationSearchFocusGraphics: Graphics;
  interactionGraphics: Graphics;
  labelIndex: number;
  curvedLabels: { reset(): void };
  labelPool: Text[];
  hitCache: unknown[];
  outlineCache: { clear(): void };
  labelOccupancyCache: unknown[];
  overviewBinDrawCount: number;
  lastInteractionOutlineCommandCount: number;
  annotationSearchFocusMaskDrawCount: number;
  annotationSearchFocusPrimitiveDrawCount: number;
  annotationSearchFocusResolvedTrackId: string | null;
  annotationSearchFocusResolvedCanonicalIdentity: string | null;
  annotationSearchFocusPresentationLane: number | null;
  clearDecorationCache(): void;
};

export function clearDrawState(host: ClearDrawStateHost): void {
  host.graphics.clear();
  host.graphics.visible = false;
  host.clearDecorationCache();
  host.retainedTranscriptDecorationGraphics.visible = false;
  host.annotationSearchFocusGraphics.clear();
  host.annotationSearchFocusGraphics.visible = false;
  host.interactionGraphics.clear();
  host.interactionGraphics.visible = false;
  host.labelIndex = 0;
  host.curvedLabels.reset();
  for (const label of host.labelPool) {
    label.visible = false;
  }
  host.hitCache.length = 0;
  host.outlineCache.clear();
  host.labelOccupancyCache = [];
  host.overviewBinDrawCount = 0;
  host.lastInteractionOutlineCommandCount = 0;
  host.annotationSearchFocusMaskDrawCount = 0;
  host.annotationSearchFocusPrimitiveDrawCount = 0;
  host.annotationSearchFocusResolvedTrackId = null;
  host.annotationSearchFocusResolvedCanonicalIdentity = null;
  host.annotationSearchFocusPresentationLane = null;
}

export type ResetPresentersHost = {
  compiledBroadSurfacePresenter: { hide(): void } | null;
  compiledBroadSurfaceCandidatePresenter: { hide(): void } | null;
  compiledBroadSurfaceTrackOwners: Map<string, { presenter: { hide(): void } }>;
  compiledBroadSurfaceTrackCandidateOwners: Map<string, { presenter: { hide(): void } }>;
  genomeWideTextureCacheLayer: { hide(): void } | null;
  tilePyramid: { hide(): void };
  sidecarRaster: { hide(): void };
  retainedOverviewLayer: { hide(): void } | null;
  retainedLinearFeatureLayer: { hide(): void } | null;
  retainedLinearTranscriptLayer: { hide(): void } | null;
  prepackedAnnotationSceneResidents: Map<string, { layer: { hide(): void } }>;
  prepackedAnnotationSceneReplacementCandidates: Map<string, { layer: { hide(): void } }>;
  retainedTranscriptDecorationGraphics: { visible: boolean };
  annotationBodyFrameOwner: AnnotationBodyFrameOwnerKind;
  annotationBodyFrameEligibility: AnnotationBodyPresenterEligibility;
};

export function hideCompiledBroadPresenters(host: ResetPresentersHost): void {
  host.compiledBroadSurfacePresenter?.hide();
  host.compiledBroadSurfaceCandidatePresenter?.hide();
  for (const owner of host.compiledBroadSurfaceTrackOwners.values()) {
    owner.presenter.hide();
  }
  for (const owner of host.compiledBroadSurfaceTrackCandidateOwners.values()) {
    owner.presenter.hide();
  }
}

export function resetAllPresentersToHidden(
  host: ResetPresentersHost,
  options: { preserveCommittedCompiledBroadSurface?: boolean } = {}
): void {
  if (options.preserveCommittedCompiledBroadSurface !== true) {
    hideCompiledBroadPresenters(host);
  } else {
    host.compiledBroadSurfaceCandidatePresenter?.hide();
    for (const owner of host.compiledBroadSurfaceTrackCandidateOwners.values()) {
      owner.presenter.hide();
    }
  }
  host.genomeWideTextureCacheLayer?.hide();
  host.tilePyramid.hide();
  host.sidecarRaster.hide();
  host.retainedOverviewLayer?.hide();
  host.retainedLinearFeatureLayer?.hide();
  host.retainedLinearTranscriptLayer?.hide();
  for (const resident of host.prepackedAnnotationSceneResidents.values()) {
    resident.layer.hide();
  }
  for (const resident of host.prepackedAnnotationSceneReplacementCandidates.values()) {
    resident.layer.hide();
  }
  host.retainedTranscriptDecorationGraphics.visible = false;
  host.annotationBodyFrameOwner = 'none';
  host.annotationBodyFrameEligibility = emptyAnnotationBodyPresenterEligibility();
}

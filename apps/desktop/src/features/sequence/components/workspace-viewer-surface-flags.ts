import { workspaceViewerMapSurfaceVisible } from './workspace-viewer-sequence-surface';

export function workspaceViewerViewportIndicatorVisible(
  sequenceSurfaceVisible: boolean,
  mapSurfaceVisible: boolean
): boolean {
  return sequenceSurfaceVisible && mapSurfaceVisible;
}

export function workspaceViewerDrawerSurfaceOpen(
  drawerSlot: unknown,
  isRestrictionEnzymeDrawerOpen: boolean | undefined
): boolean {
  return Boolean(drawerSlot) || Boolean(isRestrictionEnzymeDrawerOpen);
}

export function workspaceViewerAskAiDisabled(args: {
  isGapped: boolean;
  inAlignmentMode: boolean;
  onAskAI: unknown;
  sequenceCommandIsActive: boolean;
}): boolean {
  return args.isGapped || args.inAlignmentMode || !args.onAskAI || !args.sequenceCommandIsActive;
}

export function workspaceViewerCanEditSequence(
  readOnly: boolean,
  editorSession: unknown,
  onEditCommit: unknown
): boolean {
  return !readOnly && Boolean(editorSession && onEditCommit);
}

export function workspaceViewerLiveSequence(
  isEditMode: boolean,
  draft: { sequence: string } | null,
  workingSequence: string
): string {
  return isEditMode && draft ? draft.sequence : workingSequence;
}

export function workspaceViewerLiveAnnotations<T>(
  isEditMode: boolean,
  draft: { annotations: T[] } | null,
  workingAnnotations: T[] | undefined
): T[] {
  if (isEditMode && draft) return draft.annotations;
  return workingAnnotations ?? [];
}

export function workspaceViewerEmptySequenceEntryVisible(
  emptySequenceEditing: boolean,
  liveSequence: string
): boolean {
  return emptySequenceEditing && liveSequence.length === 0;
}

export function workspaceViewerFallbackName(
  plasmidName: string | undefined,
  fallback: string
): string {
  return plasmidName || fallback;
}

export function workspaceViewerOrLocal<T>(controlled: T | undefined, local: T): T {
  return controlled ?? local;
}

export function workspaceViewerSequenceEditable(readOnly: boolean, isEditMode: boolean): boolean {
  return !readOnly && isEditMode;
}

export function workspaceViewerHighlightRange<T>(
  isEditMode: boolean,
  highlightedRange: T | undefined
): T | null {
  return isEditMode ? null : (highlightedRange ?? null);
}

export function workspaceViewerRequestedSideMapPaneWidth(
  draft: number | null | undefined,
  persisted: number | null | undefined,
  fallback: number
): number {
  return draft ?? persisted ?? fallback;
}

export function workspaceViewerMaybeFrozenCenter<T>(
  previousMode: string,
  nextMode: string,
  lastViewportCenter: T,
  currentFrozen: T
): T {
  return previousMode !== nextMode && currentFrozen == null ? lastViewportCenter : currentFrozen;
}

export function workspaceViewerMapCollapseHold(
  previousMapSurfaceVisible: boolean,
  mapSurfaceVisible: boolean,
  sequenceSurfaceVisible: boolean
): boolean {
  return previousMapSurfaceVisible && !mapSurfaceVisible && sequenceSurfaceVisible;
}

export function workspaceViewerRenderMapSurfaceVisible(
  mapSurfaceVisible: boolean,
  holdMapCollapseForThisRender: boolean
): boolean {
  return mapSurfaceVisible || holdMapCollapseForThisRender;
}

export function workspaceViewerActualWebGLMapVisible(
  renderMapSurfaceVisible: boolean,
  hideMinimap: boolean
): boolean {
  return renderMapSurfaceVisible && !hideMinimap;
}

export function workspaceViewerSurfaceFlags(args: {
  isEditMode: boolean;
  sourceSequenceLength: number;
  sequenceSurfaceVisibleFromView: boolean;
  mapVisibleFromView: boolean;
  rendererVisibility: string;
  mapPlacement: string;
  circular: boolean;
  effectiveMapShape: string;
  viewerLodLevel: string;
}): {
  emptySequenceEditing: boolean;
  sequenceSurfaceVisible: boolean;
  mapSurfaceVisible: boolean;
  mapOnlyVisible: boolean;
  mapPlacedBeforeSequence: boolean;
  mapTopologyCircular: boolean;
  isFeatureOrDetailLod: boolean;
} {
  const emptySequenceEditing = args.isEditMode && args.sourceSequenceLength === 0;
  const sequenceSurfaceVisible = emptySequenceEditing || args.sequenceSurfaceVisibleFromView;
  const mapSurfaceVisible = workspaceViewerMapSurfaceVisible(
    emptySequenceEditing,
    args.mapVisibleFromView
  );
  const mapOnlyVisible = !emptySequenceEditing && args.rendererVisibility === 'map';
  const mapPlacedBeforeSequence = args.mapPlacement === 'left' || args.mapPlacement === 'top';
  const mapTopologyCircular = args.circular && args.effectiveMapShape === 'circular';
  const isFeatureOrDetailLod =
    args.viewerLodLevel === 'detail' || args.viewerLodLevel === 'feature';
  return {
    emptySequenceEditing,
    sequenceSurfaceVisible,
    mapSurfaceVisible,
    mapOnlyVisible,
    mapPlacedBeforeSequence,
    mapTopologyCircular,
    isFeatureOrDetailLod,
  };
}

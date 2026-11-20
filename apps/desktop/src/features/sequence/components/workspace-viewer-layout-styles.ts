import type { CSSProperties } from 'react';
import type { SequenceMapPlacement } from '../view-state/sequence-view-state';

const BORDER = '1px solid hsl(var(--color-border))';
const MAP_BG = 'hsl(var(--color-bg-subtle))';

export function workspaceViewerLayoutFlags(args: {
  hideMinimap: boolean;
  renderMapSurfaceVisible: boolean;
  sequenceSurfaceVisible: boolean;
  mapOnlyVisible: boolean;
  activeMapLayout: 'horizontal' | 'vertical';
  minimapContainerHeight: number;
  minimapHeight: number;
  minMinimapPane: number;
}): {
  mapPaneVisible: boolean;
  bothSequenceMapVisible: boolean;
  horizontalSequenceMapLayout: boolean;
  mapFillsAvailableSpace: boolean;
  minimapRenderHeight: number;
  showResizeHandle: boolean;
  showSideResizeHandle: boolean;
} {
  const mapPaneVisible = args.hideMinimap || args.renderMapSurfaceVisible;
  const bothSequenceMapVisible =
    args.sequenceSurfaceVisible &&
    args.renderMapSurfaceVisible &&
    !args.hideMinimap &&
    !args.mapOnlyVisible;
  const horizontalSequenceMapLayout =
    bothSequenceMapVisible && args.activeMapLayout === 'horizontal';
  const mapFillsAvailableSpace = args.mapOnlyVisible || horizontalSequenceMapLayout;
  const minimapRenderHeight = mapFillsAvailableSpace
    ? Math.max(args.minMinimapPane, args.minimapContainerHeight || args.minimapHeight)
    : args.minimapHeight;
  const splitVisible = args.sequenceSurfaceVisible && mapPaneVisible && !args.mapOnlyVisible;
  const showResizeHandle = splitVisible && !horizontalSequenceMapLayout;
  const showSideResizeHandle = splitVisible && horizontalSequenceMapLayout;
  return {
    mapPaneVisible,
    bothSequenceMapVisible,
    horizontalSequenceMapLayout,
    mapFillsAvailableSpace,
    minimapRenderHeight,
    showResizeHandle,
    showSideResizeHandle,
  };
}

export function workspaceViewerMinimapType(
  renderMapSurfaceVisible: boolean,
  hideMinimap: boolean
): 'hidden' | 'webgl' {
  return !renderMapSurfaceVisible || hideMinimap ? 'hidden' : 'webgl';
}

export function workspaceViewerSurfaceLayoutStyle(
  horizontalSequenceMapLayout: boolean
): CSSProperties {
  return {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: horizontalSequenceMapLayout ? 'row' : 'column',
    position: 'relative',
  };
}

export function workspaceViewerSequenceContainerStyle(args: {
  sequenceSurfaceOrder: number;
  sequenceSurfaceVisible: boolean;
  horizontalSequenceMapLayout: boolean;
}): CSSProperties {
  const { sequenceSurfaceOrder, sequenceSurfaceVisible, horizontalSequenceMapLayout } = args;
  return {
    display: sequenceSurfaceVisible ? undefined : 'none',
    order: sequenceSurfaceOrder,
    flex: sequenceSurfaceVisible ? (horizontalSequenceMapLayout ? '1 1 0' : 1) : '0 0 0px',
    width: sequenceSurfaceVisible ? undefined : 0,
    height: sequenceSurfaceVisible ? (horizontalSequenceMapLayout ? 'auto' : undefined) : 0,
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
    position: 'relative',
    contain: 'layout',
  };
}

export function workspaceViewerSequenceViewportHeightHint(args: {
  mapPaneResizePreviewActive: boolean;
  mapSurfaceVisible: boolean;
  sequenceSurfaceVisible: boolean;
  sequenceLayoutViewportHeight: number;
}): number | undefined {
  const {
    mapPaneResizePreviewActive,
    mapSurfaceVisible,
    sequenceSurfaceVisible,
    sequenceLayoutViewportHeight,
  } = args;
  if (mapPaneResizePreviewActive || mapSurfaceVisible) return undefined;
  if (sequenceSurfaceVisible && sequenceLayoutViewportHeight > 0) {
    return sequenceLayoutViewportHeight;
  }
  return undefined;
}

function horizontalMapDividerStyle(
  horizontalSequenceMapLayout: boolean,
  mapPlacement: SequenceMapPlacement
): CSSProperties {
  if (!horizontalSequenceMapLayout) return {};
  return mapPlacement === 'left' ? { borderRight: BORDER } : { borderLeft: BORDER };
}

export function workspaceViewerMinimapContainerStyle(args: {
  mapPaneVisible: boolean;
  mapOnlyVisible: boolean;
  horizontalSequenceMapLayout: boolean;
  mapSurfaceOrder: number;
  mapPlacement: SequenceMapPlacement;
  sideMapPaneWidth: number;
  minimapHeight: number;
  minMinimapPane: number;
}): CSSProperties {
  const {
    mapPaneVisible,
    mapOnlyVisible,
    horizontalSequenceMapLayout,
    mapSurfaceOrder,
    mapPlacement,
    sideMapPaneWidth,
    minimapHeight,
    minMinimapPane,
  } = args;
  const divider = horizontalMapDividerStyle(horizontalSequenceMapLayout, mapPlacement);
  const shared = {
    order: mapSurfaceOrder,
    backgroundColor: MAP_BG,
    position: 'relative' as const,
    contain: 'layout' as const,
  };
  if (!mapPaneVisible) {
    return {
      ...shared,
      display: 'none',
      height: 0,
      minHeight: 0,
      minWidth: 0,
      flexShrink: 0,
      overflow: 'hidden',
    };
  }
  if (mapOnlyVisible) {
    return {
      ...shared,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minHeight: 0,
      minWidth: 0,
      height: 'auto',
      ...divider,
    };
  }
  if (horizontalSequenceMapLayout) {
    return {
      ...shared,
      flexGrow: 0,
      flexShrink: 0,
      flexBasis: sideMapPaneWidth,
      width: sideMapPaneWidth,
      minHeight: 0,
      minWidth: 0,
      height: 'auto',
      ...divider,
    };
  }
  return {
    ...shared,
    height: minimapHeight,
    minHeight: minMinimapPane,
    flexShrink: 0,
  };
}

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { workspaceViewerLayoutFlags } from './workspace-viewer-layout-styles';

function flags(overrides: Partial<Parameters<typeof workspaceViewerLayoutFlags>[0]> = {}) {
  return workspaceViewerLayoutFlags({
    hideMinimap: false,
    renderMapSurfaceVisible: true,
    sequenceSurfaceVisible: true,
    mapOnlyVisible: false,
    activeMapLayout: 'vertical',
    minimapContainerHeight: 0,
    minimapHeight: 240,
    minMinimapPane: 180,
    ...overrides,
  });
}

describe('workspaceViewerLayoutFlags', () => {
  it('hides the map pane only when the minimap is shown and the map surface is not rendering', () => {
    expect(flags({ hideMinimap: false, renderMapSurfaceVisible: false }).mapPaneVisible).toBe(
      false
    );
    expect(flags({ hideMinimap: true, renderMapSurfaceVisible: false }).mapPaneVisible).toBe(true);
    expect(flags({ hideMinimap: false, renderMapSurfaceVisible: true }).mapPaneVisible).toBe(true);
  });

  it('treats a dual-pane split as both surfaces visible, map shown, not map-only', () => {
    expect(flags().bothSequenceMapVisible).toBe(true);
    expect(flags({ hideMinimap: true }).bothSequenceMapVisible).toBe(false);
    expect(flags({ mapOnlyVisible: true }).bothSequenceMapVisible).toBe(false);
    expect(flags({ sequenceSurfaceVisible: false }).bothSequenceMapVisible).toBe(false);
  });

  it('uses a side-by-side split only for a dual-pane horizontal layout', () => {
    expect(flags({ activeMapLayout: 'horizontal' }).horizontalSequenceMapLayout).toBe(true);
    expect(flags({ activeMapLayout: 'vertical' }).horizontalSequenceMapLayout).toBe(false);
    expect(
      flags({ activeMapLayout: 'horizontal', sequenceSurfaceVisible: false })
        .horizontalSequenceMapLayout
    ).toBe(false);
  });

  it('fills available space for map-only or a horizontal split, and sizes height from that', () => {
    const mapOnly = flags({ mapOnlyVisible: true, minimapContainerHeight: 50 });
    expect(mapOnly.mapFillsAvailableSpace).toBe(true);
    expect(mapOnly.minimapRenderHeight).toBe(180);

    const horizontal = flags({
      activeMapLayout: 'horizontal',
      minimapContainerHeight: 400,
    });
    expect(horizontal.mapFillsAvailableSpace).toBe(true);
    expect(horizontal.minimapRenderHeight).toBe(400);

    const stacked = flags({ minimapContainerHeight: 400 });
    expect(stacked.mapFillsAvailableSpace).toBe(false);
    expect(stacked.minimapRenderHeight).toBe(240);
  });

  it('shows the vertical handle for a stacked split and the side handle for a horizontal split', () => {
    const stacked = flags({ activeMapLayout: 'vertical' });
    expect(stacked.showResizeHandle).toBe(true);
    expect(stacked.showSideResizeHandle).toBe(false);

    const horizontal = flags({ activeMapLayout: 'horizontal' });
    expect(horizontal.showResizeHandle).toBe(false);
    expect(horizontal.showSideResizeHandle).toBe(true);

    const mapOnly = flags({ mapOnlyVisible: true, activeMapLayout: 'horizontal' });
    expect(mapOnly.showResizeHandle).toBe(false);
    expect(mapOnly.showSideResizeHandle).toBe(false);
  });
});

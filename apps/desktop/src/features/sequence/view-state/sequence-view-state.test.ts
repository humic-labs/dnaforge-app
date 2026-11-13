import { beforeEach, describe, expect, it } from 'vitest';
import type { TabViewState } from '../../canvas/types';
import {
  DEFAULT_SEQUENCE_VIEW_STATE,
  applicableViewStatePatch,
  clearSequenceViewMemory,
  effectiveSequenceMapShape,
  isMapSurfaceVisible,
  isSequenceSurfaceVisible,
  defaultMapPlacementForLayout,
  defaultMapPlacementForTopology,
  defaultRendererVisibilityForSurface,
  mapLayoutForPlacement,
  mergeSequenceViewStatePatch,
  modelPatchToTabViewState,
  normalizeSequenceViewStatePatch,
  readSequenceViewMemory,
  resolveSeededViewState,
  sequenceViewCapabilities,
  sequenceViewMemoryKey,
  sequenceViewPatchMissingFrom,
  tabViewStateToModelPatch,
  writeSequenceViewMemory,
  type SequenceViewState,
} from './sequence-view-state';

describe('SequenceViewState model', () => {
  it('defaults to Sequence+Map, Wrap sequence format, and WebGL map renderer', () => {
    expect(DEFAULT_SEQUENCE_VIEW_STATE).toEqual({
      rendererVisibility: 'both',
      canvasMode: '2d',
      mapShape: 'circular',
      mapLayout: 'vertical',
      mapPlacement: 'bottom',
      mapPaneWidth: null,
      orientation: 'forward',
      originOffset: 0,
      zoom: 100,
      centerBp: null,
      sequenceRanges: [],
      selection: null,
      webglRenderer: 'retained',
      webglPerformancePreference: 'auto',
      scrollSynced: false,
      webglZoom: null,
      webglCenterBp: null,
      webglMorph: null,
      minimapHeight: null,
      minimapGeometryHeight: null,
      annotationColorMode: 'auto-type',
      display: {
        showAnnotations: true,
        showTranslation: true,
        showReverseComplement: true,
        showPrimers: true,
        showResidueNumbers: false,
      },
    } satisfies SequenceViewState);
  });

  it('uses rendererVisibility as the sole Sequence/Map visibility field', () => {
    expect(isSequenceSurfaceVisible(DEFAULT_SEQUENCE_VIEW_STATE)).toBe(true);
    expect(isMapSurfaceVisible(DEFAULT_SEQUENCE_VIEW_STATE)).toBe(true);
    expect(
      isSequenceSurfaceVisible({ ...DEFAULT_SEQUENCE_VIEW_STATE, rendererVisibility: 'map' })
    ).toBe(false);
    expect(
      isMapSurfaceVisible({ ...DEFAULT_SEQUENCE_VIEW_STATE, rendererVisibility: 'sequence' })
    ).toBe(false);
  });

  it('defaults map shape effectively by topology', () => {
    expect(effectiveSequenceMapShape(DEFAULT_SEQUENCE_VIEW_STATE, { circular: true })).toBe(
      'circular'
    );
    expect(effectiveSequenceMapShape(DEFAULT_SEQUENCE_VIEW_STATE, { circular: false })).toBe(
      'linear'
    );
  });
});

describe('map placement helpers', () => {
  it('maps placement to layout and migrates legacy layout defaults predictably', () => {
    expect(mapLayoutForPlacement('left')).toBe('horizontal');
    expect(mapLayoutForPlacement('right')).toBe('horizontal');
    expect(mapLayoutForPlacement('top')).toBe('vertical');
    expect(mapLayoutForPlacement('bottom')).toBe('vertical');
    expect(defaultMapPlacementForLayout('horizontal')).toBe('right');
    expect(defaultMapPlacementForLayout('vertical')).toBe('bottom');
  });

  it('defaults circular files to side-by-side and linear/unknown to stacked', () => {
    expect(defaultMapPlacementForTopology(true)).toBe('right');
    expect(defaultMapPlacementForTopology(false)).toBe('bottom');
    expect(resolveSeededViewState({ circular: true }).mapPlacement).toBe('right');
    expect(resolveSeededViewState({ circular: true }).mapLayout).toBe('horizontal');
    expect(resolveSeededViewState({ circular: false }).mapPlacement).toBe('bottom');
    expect(resolveSeededViewState({ circular: false }).mapLayout).toBe('vertical');
    expect(resolveSeededViewState({}).mapPlacement).toBe('bottom');
    expect(
      resolveSeededViewState({ circular: true, tab: { mapPlacement: 'top' } }).mapPlacement
    ).toBe('top');
  });
});

describe('normalizeSequenceViewStatePatch', () => {
  it('keeps valid fields and maps them through, dropping absent keys', () => {
    expect(
      normalizeSequenceViewStatePatch({
        rendererVisibility: 'map',
        canvasMode: 'tracks',
        mapShape: 'linear',
        mapLayout: 'horizontal',
        mapPlacement: 'left',
        mapPaneWidth: 480,
        zoom: 75,
        orientation: 'reverse-complement',
        originOffset: 37,
      })
    ).toEqual({
      rendererVisibility: 'map',
      canvasMode: 'tracks',
      mapShape: 'linear',
      mapLayout: 'horizontal',
      mapPlacement: 'left',
      mapPaneWidth: 480,
      zoom: 75,
      orientation: 'reverse-complement',
      originOffset: 37,
    });
  });

  it("migrates legacy persisted canvasMode '1d' to Wrap ('2d')", () => {
    expect(normalizeSequenceViewStatePatch({ canvasMode: '1d' })).toEqual({
      canvasMode: '2d',
    });
  });

  it('clamps zoom into the extended toolbar-supported range', () => {
    expect(normalizeSequenceViewStatePatch({ zoom: 0 })).toEqual({ zoom: 0.2 });
    expect(normalizeSequenceViewStatePatch({ zoom: 117.5 })).toEqual({ zoom: 117.5 });
    expect(normalizeSequenceViewStatePatch({ zoom: 5000 })).toEqual({ zoom: 120 });
  });

  it('rejects an invalid canvas mode rather than coercing it', () => {
    expect(normalizeSequenceViewStatePatch({ canvasMode: 'isometric' as never })).toEqual({});
  });

  it('accepts only known Sequence+Map layouts', () => {
    expect(normalizeSequenceViewStatePatch({ mapLayout: 'horizontal' })).toEqual({
      mapLayout: 'horizontal',
    });
    expect(normalizeSequenceViewStatePatch({ mapLayout: 'diagonal' as never })).toEqual({});
  });

  it('accepts only known explicit Map placements', () => {
    expect(normalizeSequenceViewStatePatch({ mapPlacement: 'left' })).toEqual({
      mapPlacement: 'left',
    });
    expect(normalizeSequenceViewStatePatch({ mapPlacement: 'diagonal' as never })).toEqual({});
  });

  it('accepts finite side-by-side map pane widths and null', () => {
    expect(normalizeSequenceViewStatePatch({ mapPaneWidth: 512.5 })).toEqual({
      mapPaneWidth: 512.5,
    });
    expect(normalizeSequenceViewStatePatch({ mapPaneWidth: null })).toEqual({
      mapPaneWidth: null,
    });
    expect(normalizeSequenceViewStatePatch({ mapPaneWidth: Number.NaN })).toEqual({});
    expect(normalizeSequenceViewStatePatch({ mapPaneWidth: -1 })).toEqual({});
  });

  it('rejects invalid orientation and origin offset values', () => {
    expect(normalizeSequenceViewStatePatch({ orientation: 'reverse-complement' })).toEqual({
      orientation: 'reverse-complement',
    });
    expect(normalizeSequenceViewStatePatch({ orientation: 'flipped' as never })).toEqual({});
    expect(normalizeSequenceViewStatePatch({ originOffset: -1 })).toEqual({});
    expect(normalizeSequenceViewStatePatch({ originOffset: Number.NaN })).toEqual({});
    expect(normalizeSequenceViewStatePatch({ originOffset: 12.8 })).toEqual({ originOffset: 12 });
  });

  it('accepts a finite centerBp and null, but drops NaN / non-numbers', () => {
    expect(normalizeSequenceViewStatePatch({ centerBp: 42 })).toEqual({ centerBp: 42 });
    expect(normalizeSequenceViewStatePatch({ centerBp: null })).toEqual({ centerBp: null });
    expect(normalizeSequenceViewStatePatch({ centerBp: Number.NaN })).toEqual({});
    expect(normalizeSequenceViewStatePatch({ centerBp: '42' as never })).toEqual({});
  });

  it('drops the removed legacy map-renderer switch', () => {
    expect(normalizeSequenceViewStatePatch({ surfaces: { webgl: false } })).toEqual({});
  });

  it('normalizes known display toggles as booleans', () => {
    expect(normalizeSequenceViewStatePatch({ display: { showTranslation: false } })).toEqual({
      display: { showTranslation: false },
    });
    expect(
      normalizeSequenceViewStatePatch({ display: { showTranslation: 'no' as never } })
    ).toEqual({});
  });

  it('normalizes annotation color mode and drops invalid values to the default lens', () => {
    expect(normalizeSequenceViewStatePatch({ annotationColorMode: 'manual' })).toEqual({
      annotationColorMode: 'manual',
    });
    expect(normalizeSequenceViewStatePatch({ annotationColorMode: 'future-mode' })).toEqual({
      annotationColorMode: 'auto-type',
    });
  });

  it('returns an empty patch for non-object input', () => {
    expect(normalizeSequenceViewStatePatch(null)).toEqual({});
    expect(normalizeSequenceViewStatePatch(42)).toEqual({});
    expect(normalizeSequenceViewStatePatch('x')).toEqual({});
  });
});

describe('resolveSeededViewState — default <- memory <- tab (later wins)', () => {
  it('returns defaults when no layers are present', () => {
    expect(resolveSeededViewState({})).toEqual(DEFAULT_SEQUENCE_VIEW_STATE);
  });

  it('seeds from per-file memory when the tab has no live state (reopen case)', () => {
    const seeded = resolveSeededViewState({
      memory: {
        zoom: 60,
        rendererVisibility: 'map',
        orientation: 'reverse-complement',
        originOffset: 42,
        mapShape: 'linear',
        mapLayout: 'horizontal',
        mapPaneWidth: 540,
        centerBp: 1234,
      },
    });
    expect(seeded.zoom).toBe(60);
    expect(seeded.rendererVisibility).toBe('map');
    expect(seeded.orientation).toBe('reverse-complement');
    expect(seeded.originOffset).toBe(42);
    expect(seeded.mapShape).toBe('linear');
    expect(seeded.mapLayout).toBe('horizontal');
    expect(seeded.mapPlacement).toBe('right');
    expect(seeded.mapPaneWidth).toBe(540);
    expect(seeded.centerBp).toBe(1234);
    expect(seeded.canvasMode).toBe('2d');
    expect(seeded.annotationColorMode).toBe('auto-type');
  });

  it('layers annotation color mode through memory and tab state', () => {
    expect(
      resolveSeededViewState({
        memory: { annotationColorMode: 'manual' },
      }).annotationColorMode
    ).toBe('manual');

    expect(
      resolveSeededViewState({
        memory: { annotationColorMode: 'manual' },
        tab: { annotationColorMode: 'imported' },
      }).annotationColorMode
    ).toBe('imported');
  });

  it('lets live tab state win over per-file memory (tab-switch case)', () => {
    const seeded = resolveSeededViewState({
      memory: {
        zoom: 60,
        rendererVisibility: 'sequence',
        orientation: 'reverse-complement',
        originOffset: 12,
        mapShape: 'linear',
        mapLayout: 'horizontal',
        mapPlacement: 'left',
        mapPaneWidth: 540,
      },
      tab: {
        zoom: 150,
        rendererVisibility: 'both',
        orientation: 'forward',
        originOffset: 0,
        mapShape: 'circular',
        mapLayout: 'vertical',
        mapPlacement: 'top',
        mapPaneWidth: 360,
      },
    });
    expect(seeded.zoom).toBe(150);
    expect(seeded.rendererVisibility).toBe('both');
    expect(seeded.orientation).toBe('forward');
    expect(seeded.originOffset).toBe(0);
    expect(seeded.mapShape).toBe('circular');
    expect(seeded.mapLayout).toBe('vertical');
    expect(seeded.mapPlacement).toBe('top');
    expect(seeded.mapPaneWidth).toBe(360);
  });

  it('lets explicit placement drive layout when both are present', () => {
    const seeded = resolveSeededViewState({
      memory: { mapLayout: 'horizontal', mapPlacement: 'top' },
      tab: { mapPlacement: 'left' },
    });
    expect(seeded.mapPlacement).toBe('left');
    expect(seeded.mapLayout).toBe('horizontal');
  });

  it('deep-merges display so a partial layer never erases siblings', () => {
    const seeded = resolveSeededViewState({
      memory: { display: { showTranslation: false } },
      tab: { display: { showPrimers: false } },
    });
    expect(seeded.display.showTranslation).toBe(false);
    expect(seeded.display.showPrimers).toBe(false);
    expect(seeded.display.showAnnotations).toBe(true);
  });
});

describe('TabViewState <-> model mapping', () => {
  it('extracts only the present sequence-view fields from a tab view state', () => {
    const tab: TabViewState = {
      sequenceViewMode: '1d',
      sequenceRendererVisibility: 'map',
      sequenceMapShape: 'linear',
      sequenceMapLayout: 'horizontal',
      sequenceMapPlacement: 'left',
      sequenceMapPaneWidth: 512,
      sequenceOrientation: 'reverse-complement',
      sequenceOriginOffset: 12,
      sequenceViewportZoomLevel: 80,
      sequenceViewportCenterBp: 500,
      sequenceUseWebGLMap: false,
      sequenceAnnotationColorMode: 'manual',
      sequenceShowTranslation: false,
      digestPanelExpanded: true,
    };
    expect(tabViewStateToModelPatch(tab)).toEqual({
      canvasMode: '2d',
      rendererVisibility: 'map',
      mapShape: 'linear',
      mapLayout: 'horizontal',
      mapPlacement: 'left',
      mapPaneWidth: 512,
      orientation: 'reverse-complement',
      originOffset: 12,
      zoom: 80,
      centerBp: 500,
      annotationColorMode: 'manual',
      display: { showTranslation: false },
    });
  });

  it('returns an empty patch for a tab with no sequence-view fields (fresh reopen)', () => {
    expect(tabViewStateToModelPatch({ digestPanelExpanded: true })).toEqual({});
    expect(tabViewStateToModelPatch(undefined)).toEqual({});
  });

  it('maps a model patch back onto the flat TabViewState storage keys', () => {
    expect(
      modelPatchToTabViewState({
        canvasMode: '2d',
        rendererVisibility: 'sequence',
        mapShape: 'linear',
        mapLayout: 'horizontal',
        mapPlacement: 'left',
        mapPaneWidth: 512,
        orientation: 'reverse-complement',
        originOffset: 100,
        zoom: 120,
        centerBp: 9,
        annotationColorMode: 'imported',
        display: { showAnnotations: false, showResidueNumbers: true },
      })
    ).toEqual({
      sequenceViewMode: '2d',
      sequenceRendererVisibility: 'sequence',
      sequenceMapShape: 'linear',
      sequenceMapLayout: 'horizontal',
      sequenceMapPlacement: 'left',
      sequenceMapPaneWidth: 512,
      sequenceOrientation: 'reverse-complement',
      sequenceOriginOffset: 100,
      sequenceViewportZoomLevel: 120,
      sequenceViewportCenterBp: 9,
      sequenceAnnotationColorMode: 'imported',
      sequenceShowAnnotations: false,
      sequenceShowResidueNumbers: true,
    });
  });

  it('round-trips a tab view state through model and back', () => {
    const tab: TabViewState = {
      sequenceViewMode: 'tracks',
      sequenceRendererVisibility: 'map',
      sequenceMapShape: 'linear',
      sequenceMapLayout: 'horizontal',
      sequenceMapPlacement: 'left',
      sequenceMapPaneWidth: 512,
      sequenceOrientation: 'reverse-complement',
      sequenceOriginOffset: 5,
      sequenceViewportZoomLevel: 50,
      sequenceViewportCenterBp: 77,
    };
    expect(modelPatchToTabViewState(tabViewStateToModelPatch(tab))).toEqual(tab);
  });
});

describe('WebGL view settings (renderer picker + scroll-sync lock) — ', () => {
  it('normalizes a valid webglRenderer and rejects an unknown one', () => {
    expect(normalizeSequenceViewStatePatch({ webglRenderer: 'full-shapes' })).toEqual({
      webglRenderer: 'full-shapes',
    });
    expect(normalizeSequenceViewStatePatch({ webglRenderer: 'retained' })).toEqual({
      webglRenderer: 'retained',
    });
    expect(normalizeSequenceViewStatePatch({ webglRenderer: 'bogus' as never })).toEqual({});
  });

  it('normalizes scrollSynced as a boolean', () => {
    expect(normalizeSequenceViewStatePatch({ scrollSynced: false })).toEqual({
      scrollSynced: false,
    });
    expect(normalizeSequenceViewStatePatch({ scrollSynced: 'no' as never })).toEqual({});
  });

  it('seeds the renderer + scroll-sync from per-file memory (reopen)', () => {
    const seeded = resolveSeededViewState({
      memory: { webglRenderer: 'full-shapes', scrollSynced: false },
    });
    expect(seeded.webglRenderer).toBe('full-shapes');
    expect(seeded.scrollSynced).toBe(false);
  });

  it('lets live tab state win over memory for the renderer', () => {
    const seeded = resolveSeededViewState({
      memory: { webglRenderer: 'full-shapes' },
      tab: { webglRenderer: 'retained' },
    });
    expect(seeded.webglRenderer).toBe('retained');
  });

  it('round-trips the WebGL settings through the TabViewState keys', () => {
    const tab: TabViewState = {
      sequenceWebglRenderer: 'full-shapes',
      sequenceWebglScrollSynced: false,
    };
    expect(tabViewStateToModelPatch(tab)).toEqual({
      webglRenderer: 'full-shapes',
      scrollSynced: false,
    });
    expect(modelPatchToTabViewState(tabViewStateToModelPatch(tab))).toEqual(tab);
  });

  it('persists the WebGL minimap camera (its OWN zoom + pan, not the canvas)', () => {
    expect(normalizeSequenceViewStatePatch({ webglZoom: 2.5, webglCenterBp: 800 })).toEqual({
      webglZoom: 2.5,
      webglCenterBp: 800,
    });
    expect(normalizeSequenceViewStatePatch({ webglZoom: 'big' as never })).toEqual({});

    const seeded = resolveSeededViewState({ memory: { webglZoom: 3, webglCenterBp: 1200 } });
    expect(seeded.webglZoom).toBe(3);
    expect(seeded.webglCenterBp).toBe(1200);

    const tab: TabViewState = { sequenceWebglZoom: 2.5, sequenceWebglCenterBp: 800 };
    expect(tabViewStateToModelPatch(tab)).toEqual({ webglZoom: 2.5, webglCenterBp: 800 });
    expect(modelPatchToTabViewState(tabViewStateToModelPatch(tab))).toEqual(tab);
  });
});

describe('seed/merge pure helpers (load-bearing for reopen correctness)', () => {
  it('lets an explicit null in a higher layer win over a lower layer value', () => {
    expect(
      resolveSeededViewState({ memory: { centerBp: 500 }, tab: { centerBp: null } }).centerBp
    ).toBe(null);
    expect(
      resolveSeededViewState({ memory: { webglZoom: 3 }, tab: { webglZoom: null } }).webglZoom
    ).toBe(null);
    expect(resolveSeededViewState({ memory: { centerBp: 500 }, tab: {} }).centerBp).toBe(500);
  });

  it('sequenceViewPatchMissingFrom returns only fields absent from `present` (deep)', () => {
    const source = {
      canvasMode: 'tracks' as const,
      rendererVisibility: 'map' as const,
      mapShape: 'linear' as const,
      mapPaneWidth: 512,
      annotationColorMode: 'manual' as const,
      display: { showTranslation: false, showPrimers: false },
    };
    const present = { canvasMode: '2d' as const, display: { showTranslation: true } };
    expect(sequenceViewPatchMissingFrom(source, present)).toEqual({
      rendererVisibility: 'map',
      mapShape: 'linear',
      mapPaneWidth: 512,
      annotationColorMode: 'manual',
      display: { showPrimers: false },
    });
  });

  it('mergeSequenceViewStatePatch deep-merges display and override wins scalars', () => {
    expect(
      mergeSequenceViewStatePatch(
        { zoom: 100, display: { showAnnotations: true } },
        { zoom: 60, display: { showPrimers: false } }
      )
    ).toEqual({
      zoom: 60,
      display: { showAnnotations: true, showPrimers: false },
    });
  });
});

describe('capability schema — what a file CAN save ', () => {
  it('allows the WebGL morph (shape) only for circular sequences', () => {
    expect(sequenceViewCapabilities({ circular: true }).webglMorph).toBe(true);
    expect(sequenceViewCapabilities({ circular: false }).webglMorph).toBe(false);
    expect(sequenceViewCapabilities({ circular: true }).mapShape).toBe(true);
    expect(sequenceViewCapabilities({ circular: false }).mapShape).toBe(false);
  });

  it('drops circular-only fields from a patch for a linear file', () => {
    const patch = { webglMorph: 0.7, originOffset: 10, mapShape: 'linear' as const, zoom: 120 };
    expect(applicableViewStatePatch(patch, { circular: false })).toEqual({ zoom: 120 });
    expect(applicableViewStatePatch(patch, { circular: true })).toEqual({
      webglMorph: 0.7,
      originOffset: 10,
      mapShape: 'linear',
      zoom: 120,
    });
  });

  it('normalizes + round-trips the morph (0..1, clamped) through the tab key', () => {
    expect(normalizeSequenceViewStatePatch({ webglMorph: 0.4 })).toEqual({ webglMorph: 0.4 });
    expect(normalizeSequenceViewStatePatch({ webglMorph: 5 })).toEqual({ webglMorph: 1 });
    expect(normalizeSequenceViewStatePatch({ webglMorph: -2 })).toEqual({ webglMorph: 0 });
    expect(normalizeSequenceViewStatePatch({ webglMorph: 'x' as never })).toEqual({});

    const seeded = resolveSeededViewState({ memory: { webglMorph: 0.6 } });
    expect(seeded.webglMorph).toBe(0.6);

    const tab = { sequenceWebglMorph: 0.6 };
    expect(tabViewStateToModelPatch(tab)).toEqual({ webglMorph: 0.6 });
    expect(modelPatchToTabViewState(tabViewStateToModelPatch(tab))).toEqual(tab);
  });

  it('persists the minimap pane + geometry heights (renderer size/shape)', () => {
    expect(
      normalizeSequenceViewStatePatch({ minimapHeight: 420, minimapGeometryHeight: 360 })
    ).toEqual({ minimapHeight: 420, minimapGeometryHeight: 360 });
    expect(normalizeSequenceViewStatePatch({ minimapHeight: 'tall' as never })).toEqual({});

    const seeded = resolveSeededViewState({
      memory: { minimapHeight: 420, minimapGeometryHeight: 360 },
    });
    expect(seeded.minimapHeight).toBe(420);
    expect(seeded.minimapGeometryHeight).toBe(360);

    const tab = { sequenceMinimapHeight: 420, sequenceMinimapGeometryHeight: 360 };
    expect(tabViewStateToModelPatch(tab)).toEqual({
      minimapHeight: 420,
      minimapGeometryHeight: 360,
    });
    expect(modelPatchToTabViewState(tabViewStateToModelPatch(tab))).toEqual(tab);
  });
});

describe('per-file view memory (localStorage, reopen seed)', () => {
  const path = '/work/pUC19.gb';

  beforeEach(() => {
    localStorage.clear();
  });

  it('namespaces the key by path', () => {
    expect(sequenceViewMemoryKey(path)).toBe(`waypoint:sequence-view-state:${path}`);
    expect(sequenceViewMemoryKey('/other.gb')).not.toBe(sequenceViewMemoryKey(path));
  });

  it('round-trips a written patch', () => {
    writeSequenceViewMemory(path, {
      zoom: 65,
      centerBp: 321,
      annotationColorMode: 'manual',
    });
    expect(readSequenceViewMemory(path)).toEqual({
      zoom: 65,
      centerBp: 321,
      annotationColorMode: 'manual',
    });
  });

  it('merges successive writes instead of replacing (never erases a sibling field)', () => {
    writeSequenceViewMemory(path, { zoom: 65 });
    writeSequenceViewMemory(path, { centerBp: 321 });
    writeSequenceViewMemory(path, { display: { showTranslation: false } });
    expect(readSequenceViewMemory(path)).toEqual({
      zoom: 65,
      centerBp: 321,
      display: { showTranslation: false },
    });
  });

  it('deep-merges display across writes', () => {
    writeSequenceViewMemory(path, { display: { showTranslation: false } });
    writeSequenceViewMemory(path, { display: { showPrimers: false } });
    expect(readSequenceViewMemory(path).display).toEqual({
      showTranslation: false,
      showPrimers: false,
    });
  });

  it('keys memory by path so two files never cross-contaminate', () => {
    writeSequenceViewMemory(path, { zoom: 65 });
    writeSequenceViewMemory('/other.gb', { zoom: 90 });
    expect(readSequenceViewMemory(path)).toEqual({ zoom: 65 });
    expect(readSequenceViewMemory('/other.gb')).toEqual({ zoom: 90 });
  });

  it('returns an empty patch for missing / corrupt entries (defensive)', () => {
    expect(readSequenceViewMemory('/never-seen.gb')).toEqual({});
    localStorage.setItem(sequenceViewMemoryKey(path), '{not json');
    expect(readSequenceViewMemory(path)).toEqual({});
  });

  it('normalizes on read so a tampered value cannot poison the model', () => {
    localStorage.setItem(
      sequenceViewMemoryKey(path),
      JSON.stringify({ zoom: 999999, canvasMode: 'bogus', surfaces: { webgl: false } })
    );
    expect(readSequenceViewMemory(path)).toEqual({ zoom: 120 });
  });

  it('restores a saved wrapped zoom above the former 100% ceiling', () => {
    writeSequenceViewMemory(path, { zoom: 117.5 });
    expect(readSequenceViewMemory(path)).toEqual({ zoom: 117.5 });
  });

  it('restores selection from per-file memory when the tab has none', () => {
    writeSequenceViewMemory(path, { selection: { start: 4, end: 12 } });
    expect(readSequenceViewMemory(path)).toEqual({ selection: { start: 4, end: 12 } });
    expect(
      resolveSeededViewState({
        memory: readSequenceViewMemory(path),
        tab: {},
      }).selection
    ).toEqual({ start: 4, end: 12 });
    expect(tabViewStateToModelPatch({ selection: { start: 20, end: 24 } })).toEqual({
      selection: { start: 20, end: 24 },
    });
    expect(modelPatchToTabViewState({ selection: { start: 20, end: 24 } }).selection).toEqual({
      start: 20,
      end: 24,
    });
  });

  it('restores sequenceRanges from per-file memory when the tab has none', () => {
    writeSequenceViewMemory(path, { sequenceRanges: [{ start: 1, end: 8 }] });
    expect(readSequenceViewMemory(path)).toEqual({ sequenceRanges: [{ start: 1, end: 8 }] });
    expect(
      resolveSeededViewState({
        memory: readSequenceViewMemory(path),
        tab: {},
      }).sequenceRanges
    ).toEqual([{ start: 1, end: 8 }]);
    expect(tabViewStateToModelPatch({ sequenceRanges: [{ start: 9, end: 16 }] })).toEqual({
      sequenceRanges: [{ start: 9, end: 16 }],
    });
    expect(
      modelPatchToTabViewState({ sequenceRanges: [{ start: 9, end: 16 }] }).sequenceRanges
    ).toEqual([{ start: 9, end: 16 }]);
  });

  it('clears a path entry', () => {
    writeSequenceViewMemory(path, { zoom: 65 });
    clearSequenceViewMemory(path);
    expect(readSequenceViewMemory(path)).toEqual({});
  });
});

describe(' default visible surfaces by hosting surface', () => {
  it('opens an assembly on the map alone', () => {
    expect(defaultRendererVisibilityForSurface('assembly')).toBe('map');
    expect(resolveSeededViewState({ surface: 'assembly' }).rendererVisibility).toBe('map');
  });

  it('leaves an ordinary sequence file side by side', () => {
    expect(defaultRendererVisibilityForSurface('sequence')).toBe('both');
    expect(resolveSeededViewState({ surface: 'sequence' }).rendererVisibility).toBe('both');
  });

  it('is the pre- behaviour when no surface is given', () => {
    expect(resolveSeededViewState({}).rendererVisibility).toBe(
      DEFAULT_SEQUENCE_VIEW_STATE.rendererVisibility
    );
  });

  it('loses to a choice saved in the per-file reopen memory', () => {
    for (const chosen of ['both', 'sequence', 'map'] as const) {
      expect(
        resolveSeededViewState({ surface: 'assembly', memory: { rendererVisibility: chosen } })
          .rendererVisibility
      ).toBe(chosen);
    }
  });

  it('loses to the live tab state', () => {
    for (const chosen of ['both', 'sequence', 'map'] as const) {
      expect(
        resolveSeededViewState({ surface: 'assembly', tab: { rendererVisibility: chosen } })
          .rendererVisibility
      ).toBe(chosen);
    }
  });

  it('keeps the live tab ahead of memory, as for every other field', () => {
    expect(
      resolveSeededViewState({
        surface: 'assembly',
        memory: { rendererVisibility: 'sequence' },
        tab: { rendererVisibility: 'both' },
      }).rendererVisibility
    ).toBe('both');
  });

  it('does not disturb any other default', () => {
    const assembly = resolveSeededViewState({ surface: 'assembly', circular: true });
    const sequence = resolveSeededViewState({ surface: 'sequence', circular: true });
    expect({ ...assembly, rendererVisibility: null }).toEqual({
      ...sequence,
      rendererVisibility: null,
    });
  });
});

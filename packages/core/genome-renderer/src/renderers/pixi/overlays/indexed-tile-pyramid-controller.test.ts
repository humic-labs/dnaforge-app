import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Feature } from '../../../types';
import { buildTranscriptGlyphBlocks } from '../overview/transcript-glyph-vertices';
import {
  IndexedTilePyramidController,
  OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP,
  type TilePyramidCompositeHost,
} from './indexed-tile-pyramid-controller';

type PyramidFlagGlobal = typeof globalThis & {
  __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean;
  __WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES?: boolean;
  __WAYPOINT_RTT_MATCH_SCREEN_DENSITY?: boolean;
};

function clearPyramidFlags(): void {
  const g = globalThis as PyramidFlagGlobal;
  delete g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID;
  delete g.__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES;
  delete g.__WAYPOINT_RTT_MATCH_SCREEN_DENSITY;
}

function overlayDir(): string {
  const metaUrl = import.meta.url;
  return metaUrl.startsWith('file:')
    ? dirname(fileURLToPath(metaUrl))
    : join(process.cwd(), 'src/renderers/pixi/overlays');
}

function overlaySource(): string {
  return readFileSync(join(overlayDir(), 'annotation-overlay.ts'), 'utf8');
}

function controllerSource(): string {
  return readFileSync(join(overlayDir(), 'indexed-tile-pyramid-controller.ts'), 'utf8');
}

function feature(overrides: Partial<Feature> = {}): Feature {
  return {
    id: 1,
    type: 'mRNA',
    start: 10,
    end: 40,
    direction: 'forward',
    color: 0x3366ff,
    lane: 0,
    displayName: 'gene',
    exons: [{ start: 10, end: 40 }],
    qualifiers: { _lane: '0' },
    ...overrides,
  };
}

function host(
  features: Feature[] = [],
  overrides: Partial<TilePyramidCompositeHost> = {}
): TilePyramidCompositeHost {
  return {
    pixiRenderer: null,
    genomeLength: 1_000,
    features,
    genomeWideTextureCacheLayer: null,
    container: { addChildAt() {}, children: [] } as never,
    annotationLayerTypesForPresentation: () => ['mRNA'],
    cdsDetailProgress: () => 0,
    featuresInRange: (startBp, endBp) =>
      features.filter((item) => item.start < endBp && item.end > startBp),
    featureEnvelope: (item) => ({ centerOffset: (item.lane ?? 0) * -14 }),
    scaledBarHeight: () => 14,
    ...overrides,
  };
}

describe('IndexedTilePyramidController', () => {
  afterEach(clearPyramidFlags);

  it('does not construct compositors without a Pixi renderer', () => {
    const pyramid = new IndexedTilePyramidController();
    expect(
      pyramid.ensureVector({
        pixiRenderer: null,
        container: { addChildAt() {}, children: [] } as never,
      })
    ).toBeNull();
    expect(
      pyramid.ensureRtt({
        pixiRenderer: null,
        container: { addChildAt() {}, children: [] } as never,
      })
    ).toBeNull();
  });

  it('hide and destroy are safe before construction', () => {
    const pyramid = new IndexedTilePyramidController();
    pyramid.hide();
    pyramid.destroy();
    expect(pyramid.vector).toBeNull();
    expect(pyramid.rtt).toBeNull();
    expect(pyramid.bakeLayer).toBeNull();
  });

  it('keeps remaining tile-pyramid methods outside annotation-overlay.ts', () => {
    const source = overlaySource();
    expect(source).not.toContain('private tilePyramidBlocksForRange(');
    expect(source).not.toContain('private tryPresentTilePyramidBody(');
    expect(source).not.toContain('private ensureTilePyramidVectorCompositor(');
    expect(source).not.toContain('private ensureRttGlyphTilePyramidCompositor(');
    expect(source).not.toContain('private makeRetainedTranscriptLayerForTile(');
    expect(source).not.toContain('private tryCompositeTilePyramid(');
    expect(source).not.toContain('private tilePyramidCompositeHost(');
    expect(source).not.toContain('createTilePyramidCompositeHost');
    expect(source).not.toContain('Two independently-gated bands: the DETAIL vector tier');
    expect(source).not.toContain('OVERVIEW REAL-GLYPH RTT TIER');
    expect(source).not.toContain('force a synchronous whole-genome (z=0) re-bake');
  });

  it('does not advertise overview glyph tiles as default on', () => {
    const source = controllerSource();
    expect(source).not.toMatch(/default ON/i);
    expect(source).not.toContain('Default-ON');
    expect(source).not.toContain('OVERVIEW REAL-GLYPH RTT TIER');
  });

  it('refuses overview composite when both tile flags are unset', () => {
    clearPyramidFlags();
    const pyramid = new IndexedTilePyramidController();
    expect(
      pyramid.tryComposite(host([feature()]), {
        path: {
          viewStartBp: 0,
          viewEndBp: OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP + 1,
        },
        state: { width: 800, height: 40 },
      } as never)
    ).toBe(false);
    expect(pyramid.rtt).toBeNull();
  });

  it('yields overview span to the live mesh until glyph tiles are opted in', () => {
    clearPyramidFlags();
    (globalThis as PyramidFlagGlobal).__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID = true;
    const pyramid = new IndexedTilePyramidController();
    const dummyRenderer = { resolution: 1 };
    expect(
      pyramid.tryComposite(
        host([feature()], {
          pixiRenderer: dummyRenderer as never,
          genomeLength: 10_000_000,
        }),
        {
          path: {
            viewStartBp: 0,
            viewEndBp: OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP + 1,
            bpLeftX: () => 0,
            fwdStrandTop: 0,
            pixelsPerBp: 0.001,
          },
          state: { width: 800, height: 40 },
        } as never
      )
    ).toBe(false);
    expect(pyramid.rtt).toBeNull();
  });

  it('hides overview RTT at the detail span when the vector flag is unset', () => {
    const g = globalThis as PyramidFlagGlobal;
    g.__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES = true;
    const pyramid = new IndexedTilePyramidController();
    let hidden = 0;
    pyramid.rtt = {
      hide() {
        hidden += 1;
      },
    } as never;
    expect(
      pyramid.tryComposite(
        host([feature()], {
          pixiRenderer: { resolution: 1 } as never,
          genomeLength: 10_000_000,
        }),
        {
          path: {
            viewStartBp: 0,
            viewEndBp: OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP,
            bpLeftX: () => 0,
            fwdStrandTop: 0,
            pixelsPerBp: 0.001,
          },
          state: { width: 800, height: 40 },
        } as never
      )
    ).toBe(false);
    expect(hidden).toBe(1);
  });

  it('does not narrate a DETAIL VECTOR TIER banner', () => {
    const source = controllerSource();
    expect(source).not.toContain('DETAIL VECTOR TIER');
    expect(source).not.toContain(
      'Pixel-scale detail. The overview RTT tiles are out of their band'
    );
  });

  it('yields the detail vector path when requested layers include source-shapes', () => {
    const g = globalThis as PyramidFlagGlobal;
    g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID = true;
    const pyramid = new IndexedTilePyramidController();
    let reset = 0;
    pyramid.vector = {
      resetData() {
        reset += 1;
      },
      hide() {},
    } as never;
    pyramid.rtt = { hide() {} } as never;
    expect(
      pyramid.tryComposite(
        host([feature()], {
          pixiRenderer: { resolution: 1 } as never,
          genomeLength: 10_000_000,
          annotationLayerTypesForPresentation: () => ['mRNA', 'enhancer'],
        }),
        {
          path: {
            viewStartBp: 0,
            viewEndBp: OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP,
            bpLeftX: () => 0,
            fwdStrandTop: 0,
            pixelsPerBp: 0.001,
          },
          state: { width: 800, height: 40 },
        } as never
      )
    ).toBe(false);
    expect(reset).toBe(1);
  });

  it('does not narrate the transcript-only vector yield', () => {
    const source = controllerSource();
    expect(source).not.toContain('The vector tiles build transcript glyphs only');
    expect(source).not.toContain('source-shape layers it cannot draw');
  });

  it('builds local transcript blocks and skips outline-only and non-transcripts', () => {
    const pyramid = new IndexedTilePyramidController();
    const gene = feature({ id: 1, type: 'gene', exons: undefined });
    const outline = feature({ id: 2, start: 50, end: 80, outlineOnly: true });
    const transcript = feature({ id: 3, start: 100, end: 140, exons: [{ start: 100, end: 140 }] });
    const rangeHost = host([gene, outline, transcript], {
      featureEnvelope: () => ({ centerOffset: 0 }),
    });
    const blocks = pyramid.buildBlocksForRange(rangeHost, 0, 200, {
      themeMode: 'light',
    } as never);
    const expected = buildTranscriptGlyphBlocks([transcript], {
      getOffset: () => 0,
      halfHeight: 7,
      themeMode: 'light',
      cdsDetail: 0,
    });
    expect(blocks).toEqual(expected);
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('includes a seamed transcript in both adjacent tile windows', () => {
    const pyramid = new IndexedTilePyramidController();
    const seamed = feature({
      id: 9,
      start: 90,
      end: 110,
      exons: [{ start: 90, end: 110 }],
    });
    const rangeHost = host([seamed], {
      featureEnvelope: () => ({ centerOffset: 0 }),
    });
    const left = pyramid.buildBlocksForRange(rangeHost, 0, 100, {
      themeMode: 'light',
    } as never);
    const right = pyramid.buildBlocksForRange(rangeHost, 100, 200, {
      themeMode: 'light',
    } as never);
    expect(left.length).toBeGreaterThan(0);
    expect(right.length).toBeGreaterThan(0);
  });

  it('does not narrate the local-tile block-builder JSDoc', () => {
    const source = controllerSource();
    expect(source).not.toContain('Directional blocks for one tile window');
    expect(source).not.toContain('A transcript on a seam appears in both adjacent tiles');
  });

  it('returns false from tryPresent without finalizing when composite is refused', () => {
    const pyramid = new IndexedTilePyramidController();
    let finalized = 0;
    const g = globalThis as { __WAYPOINT_WEBGL_GENOME_TILE_PYRAMID?: boolean };
    const previous = g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID;
    g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID = false;
    try {
      expect(
        pyramid.tryPresent(
          host([feature()]),
          {
            path: { viewStartBp: 0, viewEndBp: 100 },
            state: { width: 800, height: 40 },
          } as never,
          () => {
            finalized += 1;
          }
        )
      ).toBe(false);
    } finally {
      g.__WAYPOINT_WEBGL_GENOME_TILE_PYRAMID = previous;
    }
    expect(finalized).toBe(0);
  });

  it('reset without retainRtt is safe before construction', () => {
    const pyramid = new IndexedTilePyramidController();
    pyramid.reset();
    pyramid.reset({ retainRtt: true });
    expect(pyramid.vector).toBeNull();
    expect(pyramid.rtt).toBeNull();
  });

  it('keeps RTT and bake layer on streaming retain, and still destroys the vector pool', () => {
    const pyramid = new IndexedTilePyramidController();
    const bakeLayer = { id: 'bake' };
    let vectorDestroyed = 0;
    let rttDestroyed = 0;
    let marked = 0;
    pyramid.vector = {
      destroy() {
        vectorDestroyed += 1;
      },
    } as never;
    pyramid.rtt = {
      destroy() {
        rttDestroyed += 1;
      },
      markDataChanged() {
        marked += 1;
      },
    } as never;
    pyramid.bakeLayer = bakeLayer as never;

    pyramid.reset({ retainRtt: true });

    expect(pyramid.vector).toBeNull();
    expect(vectorDestroyed).toBe(1);
    expect(pyramid.rtt).not.toBeNull();
    expect(marked).toBe(1);
    expect(rttDestroyed).toBe(0);
    expect(pyramid.bakeLayer).toBe(bakeLayer);
  });

  it('returns an unparented layer with pointer events off', () => {
    const pyramid = new IndexedTilePyramidController();
    const layer = pyramid.makeLayer();
    expect(layer.container.parent).toBeNull();
    expect(layer.container.eventMode).toBe('none');
  });

  it('defaults matchScreenDensity on and honors an explicit false', () => {
    const g = globalThis as PyramidFlagGlobal;
    g.__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES = true;
    const pyramid = new IndexedTilePyramidController();
    const captured: boolean[] = [];
    pyramid.bakeLayer = { container: { eventMode: 'none' } } as never;
    pyramid.rtt = {
      hide() {},
      compositeCoarse(_camera: unknown, _contract: unknown, deps: { matchScreenDensity: boolean }) {
        captured.push(deps.matchScreenDensity);
        return false;
      },
    } as never;
    const camera = {
      path: {
        viewStartBp: 0,
        viewEndBp: OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP + 1,
        bpLeftX: () => 0,
        fwdStrandTop: 0,
        pixelsPerBp: 0.001,
      },
      state: { width: 800, height: 40 },
    } as never;
    const rangeHost = host([feature()], {
      pixiRenderer: { resolution: 1 } as never,
      genomeLength: 10_000_000,
    });

    pyramid.tryComposite(rangeHost, camera);
    expect(captured).toEqual([true]);

    captured.length = 0;
    g.__WAYPOINT_RTT_MATCH_SCREEN_DENSITY = false;
    pyramid.tryComposite(rangeHost, camera);
    expect(captured).toEqual([false]);
  });

  it('does not narrate the matchScreenDensity pan-cache sermon', () => {
    const source = controllerSource();
    expect(source).not.toContain('CACHEABLE ACROSS A PAN');
    expect(source).not.toContain('floors at ~5% frac_diff');
    expect(source).not.toContain('Overridable only for oracle A/B');
  });

  it('caps pyramid addressing at maxLevel 24', () => {
    const g = globalThis as PyramidFlagGlobal;
    g.__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES = true;
    const pyramid = new IndexedTilePyramidController();
    const captured: number[] = [];
    pyramid.bakeLayer = { container: { eventMode: 'none' } } as never;
    pyramid.rtt = {
      hide() {},
      compositeCoarse(camera: { maxLevel: number }) {
        captured.push(camera.maxLevel);
        return false;
      },
    } as never;
    pyramid.tryComposite(
      host([feature()], {
        pixiRenderer: { resolution: 1 } as never,
        genomeLength: 10_000_000,
      }),
      {
        path: {
          viewStartBp: 0,
          viewEndBp: OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP + 1,
          bpLeftX: () => 0,
          fwdStrandTop: 0,
          pixelsPerBp: 0.001,
        },
        state: { width: 800, height: 40 },
      } as never
    );
    expect(captured).toEqual([24]);
  });

  it('does not narrate the maxLevel addressing bound', () => {
    const source = controllerSource();
    expect(source).not.toContain('Deepest level the pyramid addresses');
    expect(source).not.toContain('addressing doubles stay exact');
  });

  it('passes the controller block builder to overview RTT', () => {
    const g = globalThis as PyramidFlagGlobal;
    g.__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES = true;
    const pyramid = new IndexedTilePyramidController();
    let viaRtt: unknown;
    pyramid.bakeLayer = { container: { eventMode: 'none' } } as never;
    pyramid.rtt = {
      hide() {},
      compositeCoarse(
        _camera: unknown,
        _contract: unknown,
        deps: { buildBlocksForRange: (startBp: number, endBp: number) => unknown }
      ) {
        viaRtt = deps.buildBlocksForRange(0, 200);
        return false;
      },
    } as never;
    const transcript = feature({
      id: 3,
      start: 100,
      end: 140,
      exons: [{ start: 100, end: 140 }],
    });
    const cameraState = { width: 800, height: 40, themeMode: 'light' };
    const rangeHost = host([transcript], {
      pixiRenderer: { resolution: 1 } as never,
      genomeLength: 10_000_000,
      featureEnvelope: () => ({ centerOffset: 0 }),
    });
    pyramid.tryComposite(rangeHost, {
      path: {
        viewStartBp: 0,
        viewEndBp: OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP + 1,
        bpLeftX: () => 0,
        fwdStrandTop: 0,
        pixelsPerBp: 0.001,
      },
      state: cameraState,
    } as never);
    const viaController = pyramid.buildBlocksForRange(rangeHost, 0, 200, cameraState as never);
    expect(viaRtt).toEqual(viaController);
    expect((viaRtt as unknown[]).length).toBeGreaterThan(0);
  });

  it('does not narrate the SAME-block-builder sermon', () => {
    const source = controllerSource();
    expect(source).not.toContain('SAME block builder');
    expect(source).not.toContain('full-canvas-height column');
  });

  it('hides the genome-wide PNG only after overview RTT owns the span', () => {
    const g = globalThis as PyramidFlagGlobal;
    g.__WAYPOINT_WEBGL_OVERVIEW_GLYPH_TILES = true;
    const pyramid = new IndexedTilePyramidController();
    let pngHidden = 0;
    let rttOwned = false;
    pyramid.bakeLayer = { container: { eventMode: 'none' } } as never;
    pyramid.rtt = {
      hide() {},
      compositeCoarse() {
        return rttOwned;
      },
    } as never;
    const camera = {
      path: {
        viewStartBp: 0,
        viewEndBp: OVERVIEW_GLYPH_TILE_MIN_VISIBLE_BP + 1,
        bpLeftX: () => 0,
        fwdStrandTop: 0,
        pixelsPerBp: 0.001,
      },
      state: { width: 800, height: 40 },
    } as never;
    const rangeHost = host([feature()], {
      pixiRenderer: { resolution: 1 } as never,
      genomeLength: 10_000_000,
      genomeWideTextureCacheLayer: {
        hide() {
          pngHidden += 1;
        },
      } as never,
    });

    expect(pyramid.tryComposite(rangeHost, camera)).toBe(false);
    expect(pngHidden).toBe(0);

    rttOwned = true;
    expect(pyramid.tryComposite(rangeHost, camera)).toBe(true);
    expect(pngHidden).toBe(1);
  });

  it('does not narrate RTT-owns-PNG or never-blank bake yield', () => {
    const source = controllerSource();
    expect(source).not.toContain('stale blurry pixels cannot');
    expect(source).not.toContain('Still baking the first covering level');
  });

  it('destroys RTT on identity reset but leaves the bake layer', () => {
    const pyramid = new IndexedTilePyramidController();
    const bakeLayer = { id: 'bake' };
    let rttDestroyed = 0;
    pyramid.rtt = {
      destroy() {
        rttDestroyed += 1;
      },
      markDataChanged() {
        throw new Error('identity reset must not mark RTT data changed');
      },
    } as never;
    pyramid.bakeLayer = bakeLayer as never;

    pyramid.reset();

    expect(pyramid.rtt).toBeNull();
    expect(rttDestroyed).toBe(1);
    expect(pyramid.bakeLayer).toBe(bakeLayer);
  });
});

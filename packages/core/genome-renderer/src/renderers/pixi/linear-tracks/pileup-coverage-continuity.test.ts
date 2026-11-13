// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import type { PileupTrackData } from '@waypoint/genome-data';
import { webglThemeForMode, type WebGLRenderTheme } from '../shared/theme';
import type { TrackMountArgs, TrackPaintArgs } from './types';
import { DENSITY_COLUMN_VERTS, PixiPileupTrackRenderer } from './pileup-track-renderer';

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = ((id: string) =>
    id !== '2d'
      ? null
      : ({
          font: '',
          fillStyle: '',
          textBaseline: '',
          scale: () => undefined,
          measureText: (t: string) => ({ width: t.length * 6 }),
          fillText: () => undefined,
          clearRect: () => undefined,
        } as unknown as CanvasRenderingContext2D)) as typeof HTMLCanvasElement.prototype.getContext;
});

const CHROM = { id: 'chr11', displayName: 'chr11', length: 135_086_622, cytobands: [] };
const mountArgs: TrackMountArgs = { chromosome: CHROM, theme: webglThemeForMode('light') };
const W = 800;
const SPAN = 100_000;

function paint(container: object, bins: number[]): TrackPaintArgs<PileupTrackData> {
  const theme: WebGLRenderTheme = webglThemeForMode('light');
  const data: PileupTrackData = {
    dataAuthority: 'static',
    coverage: {
      startBp: 0,
      binSize: SPAN / bins.length,
      bins,
      maxDepth: Math.max(...bins),
      depthPercentiles: { p50: 100, p90: 200, p95: 220, p99: 40, max: 250 },
    },
  } as unknown as PileupTrackData;
  return {
    container,
    data,
    chromosome: CHROM,
    pathMapper: { pixelsPerBp: W / SPAN, bpLeftX: (bp: number) => (bp * W) / SPAN },
    viewportBpRange: { start: 0, end: SPAN },
    viewportWidthPx: W,
    viewportHeightPx: 400,
    layoutEntry: { id: 'pileup-test', top: 50, height: 160, contentClipped: false, hidden: false },
    containerTopPx: 50,
    renderer: undefined,
    theme,
  } as unknown as TrackPaintArgs<PileupTrackData>;
}

function densityOffset(renderer: unknown, container: object): Float32Array {
  const state = (
    renderer as {
      containerState: WeakMap<
        object,
        { densityRows: { buffers: Array<{ data: Float32Array }> } | null }
      >;
    }
  ).containerState.get(container);
  const off = state?.densityRows?.buffers[4]?.data;
  expect(off, 'density offsetCenter buffer').toBeInstanceOf(Float32Array);
  return off!;
}

function densitySubpixelUniforms(
  renderer: unknown,
  container: object
): {
  uSubpixelMinWidthPx: number;
  uSubpixelAlphaGamma: number;
  uSubpixelMinAlphaScale: number;
} {
  const state = (
    renderer as {
      containerState: WeakMap<
        object,
        {
          densityRows: {
            shader: {
              resources: {
                annotationUniforms: {
                  uniforms: {
                    uSubpixelMinWidthPx: number;
                    uSubpixelAlphaGamma: number;
                    uSubpixelMinAlphaScale: number;
                  };
                };
              };
            };
          } | null;
        }
      >;
    }
  ).containerState.get(container);
  const uniforms = state?.densityRows?.shader.resources.annotationUniforms.uniforms;
  expect(uniforms, 'density subpixel uniforms').toBeDefined();
  return uniforms!;
}

const baselineL = (off: Float32Array, c: number) => off[c * DENSITY_COLUMN_VERTS];
const hL = (off: Float32Array, c: number) => off[c * DENSITY_COLUMN_VERTS + 1];
const hR = (off: Float32Array, c: number) => off[c * DENSITY_COLUMN_VERTS + 2];

describe('coverage histogram — one continuous painted shape (L1, vertex-level)', () => {
  const N = Math.min(Math.round(W * 2), 8192);

  function render(bins: number[]) {
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      label: 'P',
      rowHeightPx: 3,
      maxRows: 96,
    } as never);
    const c = r.mount(mountArgs);
    r.paint(paint(c, bins));
    return densityOffset(r, c);
  }

  it('is ONE trapezoid (6 verts) per column', () => {
    expect(DENSITY_COLUMN_VERTS).toBe(6);
  });

  it('anchors partial-height summary coverage at the top of the read band', () => {
    const off = render(Array.from({ length: 120 }, (_, i) => 20 + (i % 17)));
    const column = Math.floor(N / 2);

    expect(baselineL(off, column)).toBeLessThan(hL(off, column));
    expect(baselineL(off, column)).toBeLessThan(hR(off, column));
  });

  it('adjacent columns share the exact boundary height — continuous, no vertical step', () => {
    const off = render(Array.from({ length: 120 }, (_, i) => 10 + Math.round((i / 119) * 240)));
    let maxGap = 0;
    for (let c = 0; c < N - 1; c++)
      maxGap = Math.max(maxGap, Math.abs(hR(off, c) - hL(off, c + 1)));
    expect(maxGap).toBeLessThan(1e-3);
  });

  it('the top actually slopes (a trapezoid, not a flat rectangle) where depth changes', () => {
    const off = render(Array.from({ length: 120 }, (_, i) => 10 + Math.round((i / 119) * 240)));
    let sloped = 0;
    for (let c = 1; c < N - 1; c++) if (Math.abs(hR(off, c) - hL(off, c)) > 0.05) sloped++;
    expect(sloped).toBeGreaterThan(100);
  });

  it('heights track depth (not uniform) — regression guard', () => {
    const off = render(Array.from({ length: 120 }, (_, i) => 10 + Math.round((i / 119) * 240)));
    const at = (f: number) => {
      const column = Math.round(N * f);
      return hR(off, column) - baselineL(off, column);
    };
    const lo = at(0.15),
      hi = at(0.85);
    expect(hi).toBeGreaterThan(lo * 1.6);
  });

  it('keeps the joined density surface at true width and full source alpha across zoom', () => {
    const r = new PixiPileupTrackRenderer({
      type: 'pileup-test',
      label: 'P',
      rowHeightPx: 3,
      maxRows: 96,
    } as never);
    const c = r.mount(mountArgs);
    r.paint(
      paint(
        c,
        Array.from({ length: 2_440 }, () => 100)
      )
    );

    const uniforms = densitySubpixelUniforms(r, c);
    expect(uniforms.uSubpixelMinWidthPx).toBe(0);
    expect(uniforms.uSubpixelMinAlphaScale).toBe(1);

    for (const projectedWidthPx of [1, 0.75, 0.5, 0.32768]) {
      const stableWidthPx = Math.max(projectedWidthPx, uniforms.uSubpixelMinWidthPx);
      const minWidthPx = Math.max(0.001, uniforms.uSubpixelMinWidthPx);
      const coverageRatio = Math.max(0, Math.min(1, projectedWidthPx / minWidthPx));
      const alphaScale = Math.max(
        uniforms.uSubpixelMinAlphaScale,
        coverageRatio ** uniforms.uSubpixelAlphaGamma
      );

      expect(stableWidthPx).toBeCloseTo(projectedWidthPx, 8);
      expect(alphaScale).toBeCloseTo(1, 8);
    }
  });
});

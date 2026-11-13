import { describe, it, expect } from 'vitest';
import { cdsReplacementZoomPresentation } from '@waypoint/platform';
import { computeSequenceRevealMetrics } from '../../../genome-renderer/src/renderers/pixi/shared/track-layout';
import {
  MIN_ZOOM,
  MAX_ZOOM,
  clampZoom,
  normalizeWheelDeltaY,
  computeScaledConfig,
  computeCanvasFitOnceMinZoom,
  autofitCharsPerLine,
  deriveSequenceLodLevel,
  detailTrackPreviewProgress,
  cdsDetailZoomProgress,
  canRenderNucleotideText,
  formatZoomPercent,
  nextZoomFromWheelDelta,
  stepZoomByFactor,
  WRAP_ZOOM_SENSITIVITY,
} from '../zoom-math';

describe('CDS replacement density', () => {
  it('uses the indexed color cutoff with one continuous body/color fade at each pane width', () => {
    for (const viewportSpanPx of [840, 1342, 1800])
      for (const charWidth of [0.08, 0.16, 0.24, 0.3, 0.38, 0.46, 0.55, 0.8, 2.66, 2.68, 8]) {
        const metrics = {
          charWidth,
          fontSize: (charWidth * 11) / 8,
          rowHeight: (charWidth * 20) / 8,
          viewportSpanPx,
        };
        const indexed = computeSequenceRevealMetrics(true, charWidth, viewportSpanPx);
        const onset = indexed.sequenceFullViewportPixelsPerBp;
        const t = Math.max(0, Math.min(1, (charWidth - onset) / (onset * 0.25)));
        const fade = t * t * (3 - 2 * t);
        expect(cdsDetailZoomProgress(metrics)).toBeCloseTo(fade, 12);
        expect(deriveSequenceLodLevel(metrics)).toBe(fade > 0 ? 'detail' : 'feature');
        const pose = cdsReplacementZoomPresentation(charWidth, viewportSpanPx);
        if (fade > 0) expect(pose.bandProgress).toBe(1);
        expect(pose.colorAlpha).toBeCloseTo(fade, 12);
        expect(pose.barHeight).toBe(pose.aaHeight);
      }
  });
});

describe('clampZoom', () => {
  it('uses an absolute minimum zoom independent of sequence length', () => {
    expect(MIN_ZOOM).toBe(0.2);
  });

  it('passes values in range unchanged', () => {
    expect(clampZoom(100)).toBe(100);
    expect(clampZoom(50)).toBe(50);
    expect(clampZoom(75)).toBe(75);
  });

  it('clamps below MIN_ZOOM', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(-500)).toBe(MIN_ZOOM);
  });

  it('clamps above MAX_ZOOM', () => {
    expect(clampZoom(500)).toBe(MAX_ZOOM);
    expect(clampZoom(10_000)).toBe(MAX_ZOOM);
  });

  it('handles non-finite input by returning 100', () => {
    expect(clampZoom(NaN)).toBe(100);
    expect(clampZoom(Infinity)).toBe(MAX_ZOOM);
    expect(clampZoom(-Infinity)).toBe(MIN_ZOOM);
  });
});

describe('normalizeWheelDeltaY', () => {
  it('passes pixel mode through unchanged', () => {
    expect(normalizeWheelDeltaY({ deltaY: 50, deltaMode: 0 })).toBe(50);
    expect(normalizeWheelDeltaY({ deltaY: -120, deltaMode: 0 })).toBe(-120);
  });

  it('scales line mode by ~16 px', () => {
    expect(normalizeWheelDeltaY({ deltaY: 1, deltaMode: 1 })).toBe(16);
    expect(normalizeWheelDeltaY({ deltaY: -3, deltaMode: 1 })).toBe(-48);
  });

  it('scales page mode by ~320 px (20 lines)', () => {
    expect(normalizeWheelDeltaY({ deltaY: 1, deltaMode: 2 })).toBe(320);
    expect(normalizeWheelDeltaY({ deltaY: -2, deltaMode: 2 })).toBe(-640);
  });
});

describe('continuous multiplicative zoom', () => {
  it('makes Cmd+scroll twice as gradual without rounding away fractions', () => {
    expect(WRAP_ZOOM_SENSITIVITY).toBe(15);
    expect(nextZoomFromWheelDelta(50, 160, { sensitivity: WRAP_ZOOM_SENSITIVITY })).toBe(25);
    const tiny = nextZoomFromWheelDelta(50, 0.25, { sensitivity: WRAP_ZOOM_SENSITIVITY });
    expect(tiny).toBeCloseTo(50 * 2 ** (-0.25 / 160), 12);
    expect(nextZoomFromWheelDelta(tiny, -0.25, { sensitivity: WRAP_ZOOM_SENSITIVITY })).toBeCloseTo(
      50,
      12
    );
  });

  it('uses gradual, reversible ten-percent keyboard/button steps', () => {
    expect(stepZoomByFactor(40, 1)).toBe(44);
    expect(stepZoomByFactor(44, -1)).toBe(40);
    expect(stepZoomByFactor(100, -1)).toBe(90.9);
    expect(stepZoomByFactor(0.2, 1)).toBe(0.22);
  });
  it('preserves sub-display-step wheel input during the live gesture', () => {
    const next = nextZoomFromWheelDelta(75, 0.1, {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      sensitivity: 10,
    });
    expect(next).toBeLessThan(75);
    expect(next).toBeCloseTo(75 * 2 ** (-0.1 / 240), 10);
  });

  it('does not jump from 25% directly to the 0.2% floor', () => {
    const next = stepZoomByFactor(25, -1);
    expect(next).toBeLessThan(25);
    expect(next).toBeGreaterThan(0.2);
  });

  it('zooms back in from the 0.2% floor with one toolbar step', () => {
    expect(stepZoomByFactor(0.2, 1)).toBeGreaterThan(0.2);
  });

  it('wheel zoom is multiplicative at low zoom instead of additive-to-floor', () => {
    const next = nextZoomFromWheelDelta(25, 100, {
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      sensitivity: 30,
      maxAbsDeltaPx: 120,
    });
    expect(next).toBeLessThan(25);
    expect(next).toBeGreaterThan(0.2);
  });

  it('formats fractional low zoom levels without noisy floating-point tails', () => {
    expect(formatZoomPercent(17.67766952966369)).toBe('18%');
    expect(formatZoomPercent(0.282842712474619)).toBe('0.283%');
    expect(formatZoomPercent(0.2)).toBe('0.2%');
  });
});

describe('computeScaledConfig', () => {
  const base = { charWidth: 9, fontSize: 11, rowHeight: 20, marginLeft: 4 };

  it('at zoomLevel 100 returns the base values (floats still)', () => {
    const r = computeScaledConfig(base, 100);
    expect(r.charWidth).toBe(9);
    expect(r.fontSize).toBe(11);
    expect(r.rowHeight).toBe(20);
  });

  it('allows twenty-percent larger glyphs and clamps further zoom to 120%', () => {
    expect(MAX_ZOOM).toBe(120);
    const maximum = computeScaledConfig(base, 120);
    expect(maximum.charWidth).toBeCloseTo(10.8, 10);
    expect(maximum.fontSize).toBe(13.2);
    expect(maximum.rowHeight).toBe(24);
    expect(maximum.marginLeft).toBe(4);
    const r = computeScaledConfig(base, 200);
    expect(r.charWidth).toBeCloseTo(10.8, 10);
    expect(r.fontSize).toBe(13.2);
    expect(r.rowHeight).toBe(24);
    expect(nextZoomFromWheelDelta(110, -1000)).toBe(120);
    expect(stepZoomByFactor(110, 1)).toBe(120);
  });

  it('at zoomLevel 50 halves all three', () => {
    const r = computeScaledConfig(base, 50);
    expect(r.charWidth).toBe(4.5);
    expect(r.fontSize).toBe(5.5);
    expect(r.rowHeight).toBe(10);
  });

  it('preserves non-scaled fields', () => {
    const r = computeScaledConfig(base, 150);
    expect(r.marginLeft).toBe(4);
  });

  it('clamps zoomLevel before scaling (below min)', () => {
    const r = computeScaledConfig(base, 0);
    expect(r.charWidth).toBe(9 * (MIN_ZOOM / 100));
  });

  it('clamps zoomLevel before scaling (above max)', () => {
    const r = computeScaledConfig(base, 10_000);
    expect(r.charWidth).toBe(9 * (MAX_ZOOM / 100));
  });

  it('produces floats when the scale requires them', () => {
    const r = computeScaledConfig(base, 65);
    expect(r.charWidth).toBeCloseTo(5.85, 5);
  });
});

describe('CDS replacement reveal', () => {
  it('preserves the symmetric body through color replacement, then reserves the top line within the compact height', () => {
    const viewportSpanPx = 1342;
    const onset = (viewportSpanPx + 256) / 3000;
    const compact = cdsReplacementZoomPresentation(onset, viewportSpanPx);
    expect(compact.progress).toBe(0);
    expect(compact.aaHeight).toBe(14);
    expect(compact.topLineHeight).toBe(0);
    expect(compact.bandHeight).toBe(14);
    expect(compact.colorAlpha).toBe(0);
    const middle = cdsReplacementZoomPresentation(onset * 1.125, viewportSpanPx);
    expect(middle.progress).toBeCloseTo(0.5, 10);
    expect(middle.bandProgress).toBe(1);
    expect(middle.barHeight).toBe(14);
    expect(middle.aaHeight).toBe(middle.barHeight);
    expect(middle.topLineHeight).toBe(0);
    expect(middle.residueAlpha).toBe(0);
    const colorEnd = cdsReplacementZoomPresentation(onset * 1.25, viewportSpanPx);
    expect(colorEnd.colorAlpha).toBe(1);
    expect(colorEnd.topLineHeight).toBe(0);
    expect(colorEnd.barHeight).toBe(14);
    const lineMiddle = cdsReplacementZoomPresentation(onset * 1.3125, viewportSpanPx);
    expect(lineMiddle.colorAlpha).toBe(1);
    expect(lineMiddle.topLineHeight).toBeCloseTo(2.25, 10);
    expect(lineMiddle.barHeight).toBeCloseTo(11.75, 10);
    expect(lineMiddle.bandHeight).toBe(14);
    const colors = cdsReplacementZoomPresentation(0.8, viewportSpanPx);
    expect(colors.bandProgress).toBe(1);
    expect(colors.barHeight).toBeCloseTo(9.5, 10);
    expect(colors.topLineHeight).toBe(4.5);
    expect(colors.bandHeight).toBe(14);
    expect(colors.colorAlpha).toBe(1);
    expect(colors.residueAlpha).toBe(0);
    expect(cdsReplacementZoomPresentation(8 / 3, viewportSpanPx).residueAlpha).toBe(0);
    expect(cdsReplacementZoomPresentation(2.68, viewportSpanPx).residueAlpha).toBe(1);
    expect(cdsReplacementZoomPresentation(onset + 1e-8, viewportSpanPx).colorAlpha).toBeLessThan(
      1e-10
    );
    const growthPitch = 9.5 / 2.25;
    for (const pitch of [
      onset * 0.7,
      onset * 0.8125,
      onset,
      onset * 1.125,
      onset * 1.25,
      onset * 1.3125,
      0.8,
      2.68,
      4,
      growthPitch,
      8,
    ]) {
      const pose = cdsReplacementZoomPresentation(pitch, viewportSpanPx);
      expect(pose.barHeight).toBe(pose.aaHeight);
      expect(pose.bandHeight).toBeCloseTo(pose.aaHeight + pose.topLineHeight, 10);
      expect(pose.bandHeight).toBeCloseTo(Math.max(14, 2.25 * pitch + pose.topLineHeight), 10);
      if (pose.colorAlpha < 1) {
        expect(pose.topLineHeight).toBe(0);
        expect(pose.barHeight).toBe(14);
      }
    }
    const below = cdsReplacementZoomPresentation(growthPitch - 1e-8, viewportSpanPx);
    const above = cdsReplacementZoomPresentation(growthPitch + 1e-8, viewportSpanPx);
    expect(below.aaHeight).toBe(9.5);
    expect(above.aaHeight - below.aaHeight).toBeCloseTo(2.25e-8, 10);
  });
  it('finishes the label lift before the first codon color in both zoom directions', () => {
    for (const viewportSpanPx of [655, 1342, 1800]) {
      const onset = (viewportSpanPx + 256) / 3000;
      const phases = [0.7, 0.75, 0.8125, 0.875, 1, 1.125, 1.25, 1, 0.8125, 0.75].map((scale) =>
        cdsReplacementZoomPresentation(onset * scale, viewportSpanPx)
      );
      const lifts = [0, 0, 0.5, 1, 1, 1, 1, 1, 0.5, 0];
      phases.forEach((p, i) => expect(p.bandProgress).toBeCloseTo(lifts[i], 12));
      for (const phase of phases) {
        expect(phase.barHeight).toBe(14);
        expect(phase.aaHeight).toBe(14);
        expect(phase.topLineHeight).toBe(0);
        if (phase.bandProgress < 1) {
          expect(phase.colorAlpha).toBe(0);
        }
        if (phase.colorAlpha > 0) expect(phase.bandProgress).toBe(1);
      }
    }
  });
  it('preserves compact shapes below the indexed pane-density boundary and the independent base-text gate', () => {
    const base = { charWidth: 8, fontSize: 11, rowHeight: 20 };
    const below = { ...computeScaledConfig(base, 2), viewportSpanPx: 1342 };
    expect(deriveSequenceLodLevel(below)).toBe('feature');
    expect(cdsDetailZoomProgress(below)).toBe(0);
    expect(canRenderNucleotideText(computeScaledConfig(base, 40))).toBe(false);
    expect(canRenderNucleotideText(computeScaledConfig(base, 46.8))).toBe(true);
    expect(detailTrackPreviewProgress(computeScaledConfig(base, 44))).toBe(1);
  });
});

describe('deriveSequenceLodLevel', () => {
  it('fully reserves nucleotide tracks before the font-density boundary is crossed', () => {
    const metrics = { charWidth: 3.48, rowHeight: 8.7, fontSize: 4.785 };
    expect(canRenderNucleotideText(metrics)).toBe(false);
    expect(detailTrackPreviewProgress(metrics)).toBe(1);
    expect(detailTrackPreviewProgress({ charWidth: 2, rowHeight: 5, fontSize: 2.75 })).toBe(0);
  });
  it('keeps nucleotide detail visible at the 50% desktop zoom step', () => {
    expect(
      deriveSequenceLodLevel({
        charWidth: 8 * 0.5,
        rowHeight: 20 * 0.5,
        fontSize: 11 * 0.5,
      })
    ).toBe('detail');
  });

  it('keeps CDS detail independent of base-text readability', () => {
    expect(
      deriveSequenceLodLevel({
        charWidth: 8 * 0.25,
        rowHeight: 20 * 0.25,
        fontSize: 11 * 0.25,
      })
    ).toBe('detail');
  });

  it('does not implicitly enter density LOD at extreme zoom-out', () => {
    const scale = MIN_ZOOM / 100;
    expect(
      deriveSequenceLodLevel({
        charWidth: 8 * scale,
        rowHeight: 20 * scale,
        fontSize: 11 * scale,
      })
    ).toBe('feature');
  });
});

describe('autofitCharsPerLine', () => {
  it('computes a reasonable integer from container width', () => {
    expect(autofitCharsPerLine(800, 4, 9)).toBe(88);
    expect(autofitCharsPerLine(1200, 4, 9)).toBe(132);
  });

  it('floors to an integer (fractional chars-per-line breaks wrapping)', () => {
    expect(autofitCharsPerLine(800, 4, 13)).toBe(61);
  });

  it('never returns below 10 (minimum usable)', () => {
    expect(autofitCharsPerLine(100, 4, 9)).toBe(10);
    expect(autofitCharsPerLine(50, 40, 9)).toBe(10);
  });

  it('handles zero / invalid charWidth with safe default', () => {
    expect(autofitCharsPerLine(800, 4, 0)).toBe(10);
    expect(autofitCharsPerLine(800, 4, -1)).toBe(10);
  });

  it('handles container narrower than margin', () => {
    expect(autofitCharsPerLine(4, 4, 9)).toBe(10);
    expect(autofitCharsPerLine(0, 4, 9)).toBe(10);
  });
});

describe('computeCanvasFitOnceMinZoom', () => {
  it('inverts to a lower zoom when content currently overflows the viewport', () => {
    const floor = computeCanvasFitOnceMinZoom({
      observedHeight: 600,
      observedZoom: 80,
      viewportHeight: 200,
      minZoom: 1,
      maxZoom: 100,
    });
    expect(floor).toBeGreaterThan(45);
    expect(floor).toBeLessThan(48);
    expect(floor).toBeLessThan(80);
  });

  it('inverts to a higher zoom (clamped to maxZoom) when content already fits with slack', () => {
    const floor = computeCanvasFitOnceMinZoom({
      observedHeight: 50,
      observedZoom: 50,
      viewportHeight: 200,
      minZoom: 1,
      maxZoom: 100,
    });
    expect(floor).toBe(100);
  });

  it('returns the global minimum when the observation is degenerate', () => {
    expect(
      computeCanvasFitOnceMinZoom({
        observedHeight: 0,
        observedZoom: 100,
        viewportHeight: 200,
        minZoom: 0.5,
        maxZoom: 100,
      })
    ).toBe(0.5);

    expect(
      computeCanvasFitOnceMinZoom({
        observedHeight: 200,
        observedZoom: 100,
        viewportHeight: 0,
        minZoom: 0.5,
        maxZoom: 100,
      })
    ).toBe(0.5);
  });

  it('clamps to [minZoom, maxZoom] when the inverted target falls outside', () => {
    expect(
      computeCanvasFitOnceMinZoom({
        observedHeight: 10_000,
        observedZoom: 100,
        viewportHeight: 1,
        minZoom: 2,
        maxZoom: 100,
      })
    ).toBe(2);
  });

  it('converges across repeated observations toward the true fit zoom', () => {
    const realH = (z: number) => 2 * z + 0.05 * z * z;
    const V = 200;

    let z = 100;
    let h = realH(z);
    expect(h).toBeGreaterThan(V);

    const distances: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      z = computeCanvasFitOnceMinZoom({
        observedHeight: h,
        observedZoom: z,
        viewportHeight: V,
        minZoom: 1,
        maxZoom: 100,
      });
      h = realH(z);
      distances.push(Math.abs(h - V));
    }

    for (let i = 1; i < distances.length; i += 1) {
      expect(distances[i]).toBeLessThan(distances[i - 1]);
    }
    expect(distances[distances.length - 1]).toBeLessThan(1);
  });
});

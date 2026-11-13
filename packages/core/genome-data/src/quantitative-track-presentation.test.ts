import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QUANTITATIVE_TRACK_PRESENTATION,
  MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS,
  buildQuantitativeSourceSummary,
  normalizeQuantitativeTrackPresentation,
  resolveQuantitativeDisplayRange,
} from './quantitative-track-presentation';

describe('quantitative track presentation', () => {
  it.each(['robust-global', 'full-global', 'visible-window', 'fixed'] as const)(
    'preserves %s ranges and clipping with values visited directly from intervals',
    (mode) => {
      const values = [-9, -2, 0, 3, 25, Number.NaN, Number.POSITIVE_INFINITY];
      const presentation = {
        version: 1 as const,
        graph: 'bar' as const,
        showRange: true,
        scale: { mode, transform: 'linear' as const, min: -4, max: 10 },
      };
      const sourceSummary = buildQuantitativeSourceSummary({
        samples: [-4, -2, 0, 5, 10],
        targetSampleCount: 32,
      });
      const expected = resolveQuantitativeDisplayRange({
        presentation,
        sourceSummary,
        visibleValues: values,
      });
      const visibleValues = {
        forEach(visit: (value: number) => void) {
          for (const value of values) visit(value);
        },
      };
      expect(
        resolveQuantitativeDisplayRange({ presentation, sourceSummary, visibleValues })
      ).toEqual(expected);
    }
  );

  it('uses a stable source-wide robust range and reports clipped viewport spikes', () => {
    const summary = buildQuantitativeSourceSummary({
      samples: [...Array.from({ length: 999 }, (_, index) => index / 100), 10_000],
      targetSampleCount: 65_536,
      fullMin: 0,
      fullMax: 10_000,
    });
    const range = resolveQuantitativeDisplayRange({
      sourceSummary: summary,
      visibleValues: [1, 5, 10_000],
    });

    expect(DEFAULT_QUANTITATIVE_TRACK_PRESENTATION.scale.mode).toBe('robust-global');
    expect(range).toMatchObject({
      source: 'source-robust',
      rawMin: 0,
      rawMax: 9.94005,
      clippedLowCount: 0,
      clippedHighCount: 1,
    });
  });

  it('supports exact whole-track, visible-window, fixed, and log1p ranges', () => {
    const summary = buildQuantitativeSourceSummary({
      samples: [0, 1, 2, 3, 4, 5],
      targetSampleCount: 32,
      fullMin: 0,
      fullMax: 1000,
    });
    expect(
      resolveQuantitativeDisplayRange({
        presentation: {
          version: 1,
          graph: 'bar',
          showRange: true,
          scale: { mode: 'full-global', transform: 'linear' },
        },
        sourceSummary: summary,
        visibleValues: [2, 3],
      }).rawMax
    ).toBe(1000);
    expect(
      resolveQuantitativeDisplayRange({
        presentation: {
          version: 1,
          graph: 'bar',
          showRange: true,
          scale: { mode: 'visible-window', transform: 'linear' },
        },
        sourceSummary: summary,
        visibleValues: [2, 3],
      }).rawMax
    ).toBe(3);
    expect(
      resolveQuantitativeDisplayRange({
        presentation: {
          version: 1,
          graph: 'bar',
          showRange: true,
          scale: { mode: 'fixed', transform: 'log1p', min: 0, max: 99 },
        },
        sourceSummary: summary,
        visibleValues: [9, 99],
      })
    ).toMatchObject({ displayMin: 0, displayMax: Math.log(100), transform: 'log1p' });
  });

  it('rejects log scaling for signed source signal', () => {
    const summary = buildQuantitativeSourceSummary({
      samples: [-4, 0, 10],
      targetSampleCount: 32,
      fullMin: -4,
      fullMax: 10,
    });
    expect(() =>
      resolveQuantitativeDisplayRange({
        presentation: {
          version: 1,
          graph: 'bar',
          showRange: true,
          scale: { mode: 'robust-global', transform: 'log1p' },
        },
        sourceSummary: summary,
        visibleValues: [0, 10],
      })
    ).toThrow('negative signal');
  });

  it('falls back explicitly to viewport data for a legacy source without a summary', () => {
    expect(resolveQuantitativeDisplayRange({ visibleValues: [2, 8] })).toMatchObject({
      source: 'visible-fallback',
      rawMin: 0,
      rawMax: 8,
    });
  });

  it('defaults to one-bin Gaussian smoothing, accepts a bounded sigma, and migrates legacy modes', () => {
    expect(MAX_QUANTITATIVE_SMOOTHING_SIGMA_BINS).toBe(10);
    expect(DEFAULT_QUANTITATIVE_TRACK_PRESENTATION.smoothingSigmaBins).toBe(1);
    expect(
      normalizeQuantitativeTrackPresentation({
        version: 1,
        graph: 'bar',
        showRange: true,
        scale: { mode: 'robust-global', transform: 'linear' },
      })
    ).toMatchObject({ smoothingSigmaBins: 1 });
    expect(
      normalizeQuantitativeTrackPresentation({
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothing: 'none',
        scale: { mode: 'robust-global', transform: 'linear' },
      })
    ).toMatchObject({ smoothingSigmaBins: 0 });
    expect(
      normalizeQuantitativeTrackPresentation({
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothingSigmaBins: 10,
        scale: { mode: 'robust-global', transform: 'linear' },
      })
    ).toMatchObject({ smoothingSigmaBins: 10 });
    expect(
      normalizeQuantitativeTrackPresentation({
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothing: 'gaussian-subtle',
        scale: { mode: 'robust-global', transform: 'linear' },
      })
    ).toMatchObject({ smoothingSigmaBins: 0.6 });
    expect(() =>
      normalizeQuantitativeTrackPresentation({
        version: 1,
        graph: 'bar',
        showRange: true,
        smoothingSigmaBins: 10.1,
        scale: { mode: 'robust-global', transform: 'linear' },
      } as never)
    ).toThrow('smoothing');
  });
});

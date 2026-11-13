import { describe, expect, it, vi } from 'vitest';

import { buildQuantitativeTrackVertices } from './quantitative-track-vertices';

describe('quantitative retained vertices', () => {
  it('keeps contiguous signal bins at their exact source values', () => {
    const vertices = buildQuantitativeTrackVertices({
      mode: 'signal',
      defaultColor: 0x2563eb,
      records: [
        { chrom: 'chr1', start: 10, end: 20, value: 2 },
        { chrom: 'chr1', start: 20, end: 30, value: 6 },
        { chrom: 'chr1', start: 30, end: 40, value: 4 },
      ],
    });

    const topLeft = (bar: number) => vertices.value[bar * 6 + 5];
    const topRight = (bar: number) => vertices.value[bar * 6 + 2];
    expect(topLeft(0)).toBe(2);
    expect(topRight(0)).toBe(2);
    expect(topLeft(1)).toBe(6);
    expect(topRight(1)).toBe(6);
    expect(topLeft(2)).toBe(4);
    expect(topRight(2)).toBe(4);
  });

  it('keeps negative signal, missing regions, and an automatic zero baseline explicit', () => {
    const vertices = buildQuantitativeTrackVertices({
      mode: 'signal',
      defaultColor: 0x2563eb,
      records: [
        { chrom: 'chr1', start: 10, end: 20, value: -2 },
        { chrom: 'chr1', start: 30, end: 40, value: 5 },
      ],
    });
    expect(vertices).toMatchObject({
      minValue: -2,
      maxValue: 5,
      barCount: 2,
    });
    expect([...new Set(vertices.value)]).toEqual([-2, 5]);
  });

  it('adds a retained summit marker without losing the peak interval', () => {
    const vertices = buildQuantitativeTrackVertices({
      mode: 'peak',
      defaultColor: 0x7c3aed,
      records: [
        {
          chrom: 'chr1',
          start: 100,
          end: 200,
          summit: 155,
          signalValue: 12,
        },
      ],
    });
    expect(vertices.barCount).toBe(2);
    expect(vertices.minValue).toBe(0);
    expect(vertices.maxValue).toBe(12);
  });

  it('increases Gaussian smoothing continuously without crossing missing signal regions', () => {
    const light = buildQuantitativeTrackVertices({
      mode: 'signal',
      smoothingSigmaBins: 0.6,
      defaultColor: 0x2563eb,
      records: [
        { chrom: 'chr1', start: 0, end: 10, value: 0 },
        { chrom: 'chr1', start: 10, end: 20, value: 10 },
        { chrom: 'chr1', start: 20, end: 30, value: 0 },
        { chrom: 'chr1', start: 40, end: 50, value: 20 },
      ],
    });
    const stronger = buildQuantitativeTrackVertices({
      mode: 'signal',
      smoothingSigmaBins: 1.2,
      defaultColor: 0x2563eb,
      records: [
        { chrom: 'chr1', start: 0, end: 10, value: 0 },
        { chrom: 'chr1', start: 10, end: 20, value: 10 },
        { chrom: 'chr1', start: 20, end: 30, value: 0 },
        { chrom: 'chr1', start: 40, end: 50, value: 20 },
      ],
    });

    const valueForBar = (vertices: typeof light, bar: number) => vertices.value[bar * 6];
    expect(valueForBar(light, 0)).toBeGreaterThan(0);
    expect(valueForBar(light, 1)).toBeLessThan(10);
    expect(valueForBar(stronger, 0)).toBeGreaterThan(valueForBar(light, 0));
    expect(valueForBar(stronger, 1)).toBeLessThan(valueForBar(light, 1));
    expect(valueForBar(light, 3)).toBe(20);
    expect(valueForBar(stronger, 3)).toBe(20);
  });

  it('supports a broad whole-bin smoothing range', () => {
    const vertices = buildQuantitativeTrackVertices({
      mode: 'signal',
      smoothingSigmaBins: 10,
      defaultColor: 0x2563eb,
      records: [
        { chrom: 'chr1', start: 0, end: 10, value: 0 },
        { chrom: 'chr1', start: 10, end: 20, value: 100 },
        { chrom: 'chr1', start: 20, end: 30, value: 0 },
      ],
    });

    expect(vertices.presentedValues[0]).toBeGreaterThan(30);
    expect(vertices.presentedValues[1]).toBeLessThan(35);
    expect(vertices.presentedValues[2]).toBeGreaterThan(30);
  });

  it('keeps maximum smoothing off the per-neighbor exponential path and respects gaps', () => {
    const exp = vi.spyOn(Math, 'exp');
    try {
      const records = Array.from({ length: 4_096 }, (_, index) => ({
        chrom: 'chr1',
        start: index < 2_048 ? index * 10 : index * 10 + 10,
        end: index < 2_048 ? index * 10 + 10 : index * 10 + 20,
        value: index === 2_047 ? 100 : 0,
      }));

      const vertices = buildQuantitativeTrackVertices({
        mode: 'signal',
        smoothingSigmaBins: 10,
        defaultColor: 0x2563eb,
        records,
      });

      expect(exp).not.toHaveBeenCalled();
      expect(vertices.barCount).toBe(records.length);
      expect(vertices.presentedValues[2_047]).toBeGreaterThan(0);
      expect(vertices.presentedValues[2_048]).toBe(0);
    } finally {
      exp.mockRestore();
    }
  });
});

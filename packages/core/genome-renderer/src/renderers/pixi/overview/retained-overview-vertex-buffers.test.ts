// @vitest-environment jsdom

import { beforeAll, describe, expect, it } from 'vitest';

import type { OverviewBin } from '../overlays/annotation-overview-cache';

type LayerModule = typeof import('./retained-overview-layer');
let buildRetainedOverviewVertexBuffers: LayerModule['buildRetainedOverviewVertexBuffers'];
let webglAnnotationColorForMode: typeof import('../shared/theme').webglAnnotationColorForMode;

beforeAll(async () => {
  ({ buildRetainedOverviewVertexBuffers } = await import('./retained-overview-layer'));
  ({ webglAnnotationColorForMode } = await import('../shared/theme'));
});

function bins(count: number): OverviewBin[] {
  return Array.from({ length: count }, (_, index) => ({
    startBp: index * 1_000,
    endBp: index * 1_000 + 250 + (index % 7) * 50,
    offset: -14 - (index % 3) * 18,
    halfHeight: 7,
    color: [0x3b82f6, 0xef4444, 0x10b981][index % 3],
    alpha: 0.85 - (index % 4) * 0.1,
    coverageRatio: (index % 5) / 4,
    sourceCount: 1 + (index % 4),
  })) as unknown as OverviewBin[];
}

function reference(
  source: readonly OverviewBin[],
  style: 'retained' | 'full-shapes',
  themeMode: 'light' | 'dark' | undefined
) {
  const vertexCount = source.length * 6;
  const bps = new Float32Array(vertexCount);
  const normalOffsets = new Float32Array(vertexCount);
  const colors = new Float32Array(vertexCount * 4);
  let vertex = 0;
  for (const bin of source) {
    const color = webglAnnotationColorForMode(bin.color, themeMode);
    const r = ((color >> 16) & 0xff) / 255;
    const g = ((color >> 8) & 0xff) / 255;
    const b = (color & 0xff) / 255;
    const outerOffset = bin.offset - bin.halfHeight;
    const innerOffset = bin.offset + bin.halfHeight;
    const bpValues = [bin.startBp, bin.endBp, bin.endBp, bin.startBp, bin.endBp, bin.startBp];
    const offsetValues = [
      outerOffset,
      outerOffset,
      innerOffset,
      outerOffset,
      innerOffset,
      innerOffset,
    ];
    const coverage = Math.max(0, Math.min(1, bin.coverageRatio || 0));
    const alpha = style === 'retained' ? bin.alpha : bin.alpha * Math.sqrt(coverage);
    for (let i = 0; i < 6; i++) {
      bps[vertex] = bpValues[i];
      normalOffsets[vertex] = offsetValues[i];
      const colorIndex = vertex * 4;
      colors[colorIndex] = r;
      colors[colorIndex + 1] = g;
      colors[colorIndex + 2] = b;
      colors[colorIndex + 3] = alpha;
      vertex++;
    }
  }
  return { bps, normalOffsets, colors };
}

describe('buildRetainedOverviewVertexBuffers', () => {
  it('writes byte-identical vertex buffers to the per-bin table implementation', () => {
    for (const style of ['retained', 'full-shapes'] as const) {
      for (const themeMode of ['light', 'dark', undefined] as const) {
        const source = bins(257);
        const actual = buildRetainedOverviewVertexBuffers(source, style, themeMode);
        const expected = reference(source, style, themeMode);
        expect(actual.bps).toStrictEqual(expected.bps);
        expect(actual.normalOffsets).toStrictEqual(expected.normalOffsets);
        expect(actual.colors).toStrictEqual(expected.colors);
      }
    }
  });

  it('handles an empty bin list', () => {
    const actual = buildRetainedOverviewVertexBuffers([], 'retained', 'light');
    expect(actual.bps.length).toBe(0);
    expect(actual.colors.length).toBe(0);
  });
});

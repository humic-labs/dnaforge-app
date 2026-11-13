import { describe, it, expect } from 'vitest';
import { buildLinearFeatureQuadVertices } from './retained-linear-feature-vertices';
import { webglAnnotationColorForMode } from '../shared/theme';
import type { OverviewBin } from '../overlays/annotation-overview-cache';
import { packedBpRelativeToOrigin, unpackBpCoordinate } from './bp-coordinate-packing';

const bin = (over: Partial<OverviewBin> = {}): OverviewBin => ({
  startBp: 100,
  endBp: 200,
  offset: 10,
  halfHeight: 4,
  color: 0x3b82f6,
  alpha: 0.85,
  coverageBp: 100,
  coverageRatio: 1,
  sourceCount: 1,
  ...over,
});

describe('buildLinearFeatureQuadVertices — pixel-identity contract', () => {
  it('emits 6 vertices per bin in featureQuadAt triangle-list order', () => {
    const b = bin();
    const {
      bpStartChunk,
      bpStartDelta,
      bpEndChunk,
      bpEndDelta,
      offsetCenter,
      halfH,
      xSide,
      ySide,
      color,
    } = buildLinearFeatureQuadVertices([b], 'light');

    expect(bpStartChunk.length).toBe(6);
    expect(bpStartDelta.length).toBe(6);
    expect(bpEndChunk.length).toBe(6);
    expect(bpEndDelta.length).toBe(6);
    expect(offsetCenter.length).toBe(6);
    expect(halfH.length).toBe(6);
    expect(xSide.length).toBe(6);
    expect(ySide.length).toBe(6);
    expect(color.length).toBe(24);

    expect(
      Array.from(bpStartChunk, (chunk, i) => unpackBpCoordinate(chunk, bpStartDelta[i]))
    ).toEqual([b.startBp, b.startBp, b.startBp, b.startBp, b.startBp, b.startBp]);
    expect(Array.from(bpEndChunk, (chunk, i) => unpackBpCoordinate(chunk, bpEndDelta[i]))).toEqual([
      b.endBp,
      b.endBp,
      b.endBp,
      b.endBp,
      b.endBp,
      b.endBp,
    ]);
    expect(Array.from(offsetCenter)).toEqual([
      b.offset,
      b.offset,
      b.offset,
      b.offset,
      b.offset,
      b.offset,
    ]);
    expect(Array.from(halfH)).toEqual([
      b.halfHeight,
      b.halfHeight,
      b.halfHeight,
      b.halfHeight,
      b.halfHeight,
      b.halfHeight,
    ]);
    expect(Array.from(xSide)).toEqual([0, 1, 1, 0, 1, 0]);
    expect(Array.from(ySide)).toEqual([-1, -1, 1, -1, 1, 1]);
  });

  it('preserves start/end side semantics for the shader projection', () => {
    const b = bin();
    const { bpStartChunk, bpStartDelta, bpEndChunk, bpEndDelta, xSide } =
      buildLinearFeatureQuadVertices([b], 'light');
    const projectedBp = Array.from(xSide, (side, i) =>
      side === 0
        ? unpackBpCoordinate(bpStartChunk[i], bpStartDelta[i])
        : unpackBpCoordinate(bpEndChunk[i], bpEndDelta[i])
    );
    expect(projectedBp).toEqual([b.startBp, b.endBp, b.endBp, b.startBp, b.endBp, b.startBp]);
  });

  it('fills every vertex with the themed color + bin alpha (exact sink fill)', () => {
    for (const mode of ['light', 'dark'] as const) {
      const b = bin({ color: 0x22c55e, alpha: 0.5 });
      const themed = webglAnnotationColorForMode(b.color, mode);
      const r = ((themed >> 16) & 0xff) / 255;
      const g = ((themed >> 8) & 0xff) / 255;
      const bl = (themed & 0xff) / 255;
      const { color } = buildLinearFeatureQuadVertices([b], mode);
      for (let v = 0; v < 6; v++) {
        const ci = v * 4;
        expect(color[ci]).toBeCloseTo(r, 6);
        expect(color[ci + 1]).toBeCloseTo(g, 6);
        expect(color[ci + 2]).toBeCloseTo(bl, 6);
        expect(color[ci + 3]).toBe(0.5);
      }
    }
  });

  it('packs multiple bins contiguously, count = bins*6', () => {
    const bins = [bin({ startBp: 0, endBp: 10 }), bin({ startBp: 50, endBp: 60, offset: 30 })];
    const { bpStartChunk, bpStartDelta, offsetCenter, color } = buildLinearFeatureQuadVertices(
      bins,
      'light'
    );
    expect(bpStartChunk.length).toBe(12);
    expect(color.length).toBe(48);
    expect(unpackBpCoordinate(bpStartChunk[6], bpStartDelta[6])).toBe(50);
    expect(offsetCenter[6]).toBe(30);
  });

  it('empty bin list → empty buffers (mesh hidden upstream)', () => {
    const { bpStartChunk, bpStartDelta, bpEndChunk, bpEndDelta, offsetCenter, color } =
      buildLinearFeatureQuadVertices([], 'light');
    expect(bpStartChunk.length).toBe(0);
    expect(bpStartDelta.length).toBe(0);
    expect(bpEndChunk.length).toBe(0);
    expect(bpEndDelta.length).toBe(0);
    expect(offsetCenter.length).toBe(0);
    expect(color.length).toBe(0);
  });

  it('packs chr1-scale bp coordinates without float32 absolute-coordinate drift', () => {
    const absolute = new Float32Array([248_000_123])[0];
    expect(absolute).not.toBe(248_000_123);

    const { bpStartChunk, bpStartDelta, bpEndChunk, bpEndDelta } = buildLinearFeatureQuadVertices(
      [bin({ startBp: 248_000_123, endBp: 248_000_457 })],
      'light'
    );
    expect(unpackBpCoordinate(bpStartChunk[0], bpStartDelta[0])).toBe(248_000_123);
    expect(unpackBpCoordinate(bpEndChunk[0], bpEndDelta[0])).toBe(248_000_457);
    expect(
      packedBpRelativeToOrigin(bpStartChunk[0], bpStartDelta[0], bpStartChunk[0], bpStartDelta[0])
    ).toBe(0);
    expect(
      packedBpRelativeToOrigin(bpEndChunk[0], bpEndDelta[0], bpStartChunk[0], bpStartDelta[0])
    ).toBe(334);
  });
});

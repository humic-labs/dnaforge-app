import { describe, expect, it } from 'vitest';

import { unpackBpCoordinate } from './bp-coordinate-packing';
import {
  packTranscriptGlyphInstances,
  TRANSCRIPT_GLYPH_INSTANCE_CORNERS,
  TRANSCRIPT_GLYPH_INSTANCE_LAYOUT,
} from './transcript-glyph-instances';
import { packTranscriptGlyphVertices, type DirectionalBlock } from './transcript-glyph-vertices';

const blocks: DirectionalBlock[] = [
  {
    startBp: 248_000_123,
    endBp: 248_000_457,
    offsetCenter: 20,
    halfH: 7,
    color: 0x123456,
    role: 'transcript:intron' as const,
    alpha: 0.5,
    cdsFade: 0.85,
    dirSign: 1,
  },
  {
    startBp: 10,
    endBp: 90,
    offsetCenter: -4,
    halfH: 1.25,
    color: 0xfedcba,
    role: 'transcript:intron' as const,
    alpha: 0.595,
    cdsFade: 0,
    dirSign: 0,
  },
  {
    startBp: 4_000_000_003,
    endBp: 4_000_001_003,
    offsetCenter: 44,
    halfH: 4.34,
    color: 0x000001,
    role: 'transcript:intron' as const,
    alpha: 0.85,
    cdsFade: 0,
    dirSign: -1,
  },
];

function instanceField(data: Float32Array, instance: number, offset: number): number {
  return data[instance * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats + offset];
}

function instanceColor(data: Float32Array, instance: number): number[] {
  const base =
    instance * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats +
    TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.color;
  return Array.from(data.subarray(base, base + 4));
}

describe('packTranscriptGlyphInstances', () => {
  it('preserves every logical legacy attribute once per block, including precision-safe bp', () => {
    const legacy = packTranscriptGlyphVertices(blocks);
    const packed = packTranscriptGlyphInstances(blocks);
    expect(packed.instanceCount).toBe(blocks.length);
    expect(packed.data).toHaveLength(blocks.length * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideFloats);

    let legacyVertex = 0;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      const startChunk = instanceField(
        packed.data,
        i,
        TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartChunk
      );
      const startDelta = instanceField(
        packed.data,
        i,
        TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpStartDelta
      );
      const endChunk = instanceField(packed.data, i, TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndChunk);
      const endDelta = instanceField(packed.data, i, TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.bpEndDelta);

      expect(unpackBpCoordinate(startChunk, startDelta)).toBe(block.startBp);
      expect(unpackBpCoordinate(endChunk, endDelta)).toBe(block.endBp);
      expect(startChunk).toBe(legacy.bpStartChunk[legacyVertex]);
      expect(startDelta).toBe(legacy.bpStartDelta[legacyVertex]);
      expect(endChunk).toBe(legacy.bpEndChunk[legacyVertex]);
      expect(endDelta).toBe(legacy.bpEndDelta[legacyVertex]);
      expect(instanceField(packed.data, i, TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.offsetCenter)).toBe(
        legacy.offsetCenter[legacyVertex]
      );
      expect(instanceField(packed.data, i, TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.halfH)).toBe(
        legacy.halfH[legacyVertex]
      );
      expect(instanceField(packed.data, i, TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.dirSign)).toBe(
        legacy.dirSign[legacyVertex]
      );
      expect(instanceField(packed.data, i, TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.cdsFade)).toBe(
        legacy.cdsFade[legacyVertex]
      );
      expect(instanceColor(packed.data, i)).toEqual(
        Array.from(legacy.color.subarray(legacyVertex * 4, legacyVertex * 4 + 4))
      );

      legacyVertex += block.dirSign === 0 ? 6 : 9;
    }
  });

  it('uses one static nine-vertex fan for both arrows and rectangles', () => {
    expect(Array.from(TRANSCRIPT_GLYPH_INSTANCE_CORNERS)).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 4]);
  });

  it('is exactly 48 bytes/block: 21,001,008 bytes for the measured 437,521 blocks', () => {
    const measuredBlockCount = 437_521;
    const instanceBytes = measuredBlockCount * TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes;
    expect(TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes).toBe(48);
    expect(instanceBytes).toBe(21_001_008);
    expect(instanceBytes / 1024 / 1024).toBeCloseTo(20.028, 3);
    expect((6 * 52) / TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes).toBe(6.5);
    expect((9 * 52) / TRANSCRIPT_GLYPH_INSTANCE_LAYOUT.strideBytes).toBe(9.75);
  });

  it('packs empty input without a sentinel instance', () => {
    const packed = packTranscriptGlyphInstances([]);
    expect(packed.instanceCount).toBe(0);
    expect(packed.data.byteLength).toBe(0);
  });
});

type Point = readonly [number, number];
type Triangle = readonly [Point, Point, Point];

function projectedCorners(block: DirectionalBlock, pixelsPerBp: number): Point[] {
  let x1 = block.startBp * pixelsPerBp;
  let x2 = block.endBp * pixelsPerBp;
  const actualWidth = Math.max(0, x2 - x1);
  const stableWidth = Math.max(actualWidth, 1);
  if (stableWidth > actualWidth) {
    const mid = (x1 + x2) * 0.5;
    x1 = mid - stableWidth * 0.5;
    x2 = mid + stableWidth * 0.5;
  }
  const cy = block.offsetCenter;
  const hh = block.halfH;
  let aw = 0;
  if (block.dirSign !== 0) {
    const candidate = Math.min(2 * hh * 0.6, actualWidth * 0.3, 8);
    if (actualWidth > candidate * 2) aw = candidate;
  }
  return block.dirSign < 0
    ? [
        [x1 + aw, cy - hh],
        [x2, cy - hh],
        [x2, cy + hh],
        [x1 + aw, cy + hh],
        [x1, cy],
      ]
    : [
        [x1, cy - hh],
        [x2 - aw, cy - hh],
        [x2, cy],
        [x2 - aw, cy + hh],
        [x1, cy + hh],
      ];
}

function triangles(corners: Point[], order: ArrayLike<number>): Triangle[] {
  const out: Triangle[] = [];
  for (let i = 0; i < order.length; i += 3) {
    out.push([corners[order[i]], corners[order[i + 1]], corners[order[i + 2]]]);
  }
  return out;
}

function signedArea(a: Point, b: Point, p: Point): number {
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
}

function contains(triangle: Triangle, point: Point): boolean {
  const [a, b, c] = triangle;
  const ab = signedArea(a, b, point);
  const bc = signedArea(b, c, point);
  const ca = signedArea(c, a, point);
  return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
}

function covered(tris: Triangle[], point: Point): boolean {
  return tris.some((triangle) => contains(triangle, point));
}

describe('instanced nine-corner fan pixel geometry', () => {
  it.each([
    { dirSign: 0 as const, pixelsPerBp: 0.002 },
    { dirSign: 0 as const, pixelsPerBp: 1 },
    { dirSign: 1 as const, pixelsPerBp: 0.002 },
    { dirSign: 1 as const, pixelsPerBp: 1 },
    { dirSign: -1 as const, pixelsPerBp: 1 },
  ])('matches legacy triangle coverage for $dirSign at $pixelsPerBp px/bp', (testCase) => {
    const block: DirectionalBlock = {
      startBp: 10,
      endBp: 90,
      offsetCenter: 20,
      halfH: 7,
      color: 0x123456,
      role: 'transcript:intron' as const,
      alpha: 0.5,
      cdsFade: 0,
      dirSign: testCase.dirSign,
    };
    const corners = projectedCorners(block, testCase.pixelsPerBp);
    const instanced = triangles(corners, TRANSCRIPT_GLYPH_INSTANCE_CORNERS);
    const legacyOrder =
      block.dirSign === 0 ? [0, 1, 3, 0, 3, 4] : Array.from(TRANSCRIPT_GLYPH_INSTANCE_CORNERS);
    const legacy = triangles(corners, legacyOrder);

    const xs = corners.map(([x]) => x);
    const ys = corners.map(([, y]) => y);
    const minX = Math.min(...xs) - 1;
    const maxX = Math.max(...xs) + 1;
    const minY = Math.min(...ys) - 1;
    const maxY = Math.max(...ys) + 1;
    for (let x = minX; x <= maxX; x += 0.25) {
      for (let y = minY; y <= maxY; y += 0.25) {
        expect(covered(instanced, [x, y]), `coverage mismatch at ${x},${y}`).toBe(
          covered(legacy, [x, y])
        );
      }
    }
  });
});

import { webglAnnotationColorForMode, type WebGLThemeMode } from '../shared/theme';
import type { OverviewBin } from '../overlays/annotation-overview-cache';
import { writePackedBpCoordinate } from './bp-coordinate-packing';

export type LinearFeatureQuadVertices = {
  bpStartChunk: Float32Array;
  bpStartDelta: Float32Array;
  bpEndChunk: Float32Array;
  bpEndDelta: Float32Array;
  offsetCenter: Float32Array;
  halfH: Float32Array;
  xSide: Float32Array;
  ySide: Float32Array;
  color: Float32Array;
};

export function buildLinearFeatureQuadVertices(
  bins: readonly OverviewBin[],
  themeMode: WebGLThemeMode | undefined
): LinearFeatureQuadVertices {
  const vertexCount = bins.length * 6;
  const bpStartChunk = new Float32Array(vertexCount);
  const bpStartDelta = new Float32Array(vertexCount);
  const bpEndChunk = new Float32Array(vertexCount);
  const bpEndDelta = new Float32Array(vertexCount);
  const offsetCenter = new Float32Array(vertexCount);
  const halfH = new Float32Array(vertexCount);
  const xSide = new Float32Array(vertexCount);
  const ySide = new Float32Array(vertexCount);
  const color = new Float32Array(vertexCount * 4);
  let vertex = 0;

  for (const bin of bins) {
    const themed = webglAnnotationColorForMode(bin.color, themeMode);
    const r = ((themed >> 16) & 0xff) / 255;
    const g = ((themed >> 8) & 0xff) / 255;
    const b = (themed & 0xff) / 255;
    const a = bin.alpha;
    const xCorners = [0, 1, 1, 0, 1, 0];
    const yCorners = [-1, -1, 1, -1, 1, 1];

    for (let i = 0; i < 6; i++) {
      writePackedBpCoordinate(bin.startBp, bpStartChunk, bpStartDelta, vertex);
      writePackedBpCoordinate(bin.endBp, bpEndChunk, bpEndDelta, vertex);
      offsetCenter[vertex] = bin.offset;
      halfH[vertex] = bin.halfHeight;
      xSide[vertex] = xCorners[i];
      ySide[vertex] = yCorners[i];
      const ci = vertex * 4;
      color[ci] = r;
      color[ci + 1] = g;
      color[ci + 2] = b;
      color[ci + 3] = a;
      vertex++;
    }
  }
  return {
    bpStartChunk,
    bpStartDelta,
    bpEndChunk,
    bpEndDelta,
    offsetCenter,
    halfH,
    xSide,
    ySide,
    color,
  };
}

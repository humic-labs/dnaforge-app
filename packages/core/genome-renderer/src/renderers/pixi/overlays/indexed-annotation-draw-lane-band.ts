import type { Graphics } from 'pixi.js';
import type { PathMapper } from '../shared/path-mapper';
import { drawLaneBand, rangeLength, screenWidthToBp } from '../shared/lane-path';

export function drawLaneBandWithGaps(
  host: { genomeLength: number },
  g: Graphics,
  path: PathMapper,
  startBp: number,
  endBp: number,
  offset: number,
  halfHeight: number,
  color: number,
  alpha: number,
  gaps: Array<{ startBp: number; endBp: number }>
): void {
  const totalLen = rangeLength(startBp, endBp, host.genomeLength);
  if (totalLen <= 0) return;

  const gapPadBp = screenWidthToBp(path, startBp, 1.5, offset, totalLen);
  const normalizedGaps = gaps
    .map((gap) => {
      const rawStart = rangeLength(startBp, gap.startBp, host.genomeLength);
      const rawEnd = rangeLength(startBp, gap.endBp, host.genomeLength);
      return {
        start: Math.max(0, rawStart - gapPadBp),
        end: Math.min(totalLen, rawEnd + gapPadBp),
      };
    })
    .filter((gap) => gap.end > gap.start && gap.start < totalLen && gap.end > 0)
    .sort((a, b) => a.start - b.start);

  let cursor = 0;
  for (const gap of normalizedGaps) {
    const gapStart = Math.max(cursor, gap.start);
    if (gapStart > cursor + 1e-6) {
      drawLaneBand(
        g,
        path,
        startBp + cursor,
        startBp + gapStart,
        offset,
        halfHeight,
        color,
        alpha,
        host.genomeLength
      );
    }
    cursor = Math.max(cursor, gap.end);
  }

  if (cursor < totalLen - 1e-6) {
    drawLaneBand(
      g,
      path,
      startBp + cursor,
      endBp,
      offset,
      halfHeight,
      color,
      alpha,
      host.genomeLength
    );
  }
}

import { describe, it, expect } from 'vitest';
import { cullLinesToViewport } from '../canvas-worker-protocol';
import type { PrecomputedLinePosition } from '../hooks/usePrecomputedLayout';

function makeLine(
  lineIndex: number,
  absoluteLineY: number,
  lineHeight: number
): PrecomputedLinePosition {
  return {
    line: {
      lineIndex,
      startPos: lineIndex * 80,
      endPos: (lineIndex + 1) * 80,
      sequence: 'A'.repeat(80),
      annotations: [],
      annotationLaneCount: 0,
    } as PrecomputedLinePosition['line'],
    annotationY: absoluteLineY,
    translationY: absoluteLineY + 16,
    translationLaneCount: 0,
    sequenceY: absoluteLineY + 32,
    complementY: absoluteLineY + 48,
    mutationTrackY: absoluteLineY + 64,
    hasMutationTrack: false,
    rulerY: absoluteLineY + 80,
    forwardPrimerY: absoluteLineY + 96,
    reversePrimerY: absoluteLineY + 112,
    lineEndY: absoluteLineY + lineHeight,
    hasPrimers: false,
    hasForwardPrimers: false,
    hasReversePrimers: false,
    absoluteLineY,
    forwardOrfY: absoluteLineY + 128,
    reverseOrfY: absoluteLineY + 144,
    forwardOrfLaneCount: 0,
    reverseOrfLaneCount: 0,
  };
}

describe('cullLinesToViewport — circular top-buffer scroll window ', () => {
  const BUFFER_ROW_COUNT = 40;
  const BUFFER_ROW_HEIGHT = 347;
  const REAL_ROW_COUNT = 30;
  const REAL_ROW_HEIGHT = 160;

  const realRowsStartY = BUFFER_ROW_COUNT * BUFFER_ROW_HEIGHT;
  const viewportHeight = 1600;

  const bufferLines = Array.from({ length: BUFFER_ROW_COUNT }, (_, i) =>
    makeLine(i, i * BUFFER_ROW_HEIGHT, BUFFER_ROW_HEIGHT)
  );
  const realLines = Array.from({ length: REAL_ROW_COUNT }, (_, i) =>
    makeLine(BUFFER_ROW_COUNT + i, realRowsStartY + i * REAL_ROW_HEIGHT, REAL_ROW_HEIGHT)
  );
  const lines = [...bufferLines, ...realLines];

  it('anchors the fixture: realRowsStartY is the summed top-buffer height', () => {
    expect(realRowsStartY).toBe(13880);
    expect(realLines[0].absoluteLineY).toBe(realRowsStartY);
    expect(bufferLines.every((lp) => lp.absoluteLineY < realRowsStartY)).toBe(true);
  });

  it('scrollTop=0 culls ONLY top-buffer rows — no real sequence rows (the blank window)', () => {
    const cache: PrecomputedLinePosition[] = [];
    const count = cullLinesToViewport(lines, 0, viewportHeight, cache);
    const emitted = cache.slice(0, count);

    expect(count).toBeGreaterThan(0);

    for (const lp of emitted) {
      expect(lp.absoluteLineY).toBeLessThan(realRowsStartY);
    }
    expect(emitted.some((lp) => lp.absoluteLineY >= realRowsStartY)).toBe(false);
  });

  it('scrollTop=realRowsStartY culls the FIRST real row into the viewport band', () => {
    const cache: PrecomputedLinePosition[] = [];
    const count = cullLinesToViewport(lines, realRowsStartY, viewportHeight, cache);
    const emitted = cache.slice(0, count);

    expect(count).toBeGreaterThan(0);

    const firstReal = emitted.find((lp) => lp.absoluteLineY >= realRowsStartY);
    expect(firstReal).toBeDefined();
    expect(firstReal!.absoluteLineY).toBe(realRowsStartY);

    const relativeY = firstReal!.absoluteLineY - realRowsStartY;
    expect(relativeY).toBeGreaterThanOrEqual(-2);
    expect(relativeY).toBeLessThanOrEqual(viewportHeight);
  });
});

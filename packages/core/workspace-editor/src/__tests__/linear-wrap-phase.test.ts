import { describe, expect, it } from 'vitest';
import { computeZoomStepWithAnchor, zoomAnchorContentY } from '../use-zoom-controller';
import { computeSequenceLayoutImpl, getPositionFromCoordinates } from '../useSequenceLayout';
import { getCursorPositionFromX, getPositionFromX } from '../hit-detection';
import { BASE, buildLayoutAt, CONTAINER_RECT, CONTAINER_WIDTH } from '../testing/zoom-fixtures';
import { absoluteRowIndexForBp } from '../layout-utils';
import { computeLineTrackPositions } from '../line-track-layout';
import { charsPerRowAt, pxPerBpAt } from '../zoom-math';

describe('linear wrap phase preserves the screen column and every base', () => {
  for (const anchorBp of [10, 12345, 19999]) {
    for (const targetZoom of [12.5, 30.999999, 31.000001, 75, 99.999]) {
      it(`keeps ${anchorBp} under its screen point at ${targetZoom}% without dropping the prefix`, () => {
        const options = {
          targetZoom,
          deltaPx: 0,
          anchorBp,
          cursor: { clientX: CONTAINER_RECT.left + 431, clientY: CONTAINER_RECT.top + 310 },
          currentZoom: 100,
          currentTopBp: 0,
          circularOffset: 0,
          isCircular: false,
          rebaseLinearOrigin: true,
          sequenceLength: 20000,
          baseConfig: BASE,
          containerWidth: CONTAINER_WIDTH,
          containerRect: CONTAINER_RECT,
          minZoom: 0.1,
          maxZoom: 100,
          sensitivity: 20,
        };
        const next = computeZoomStepWithAnchor(options)!;
        const cpr = charsPerRowAt(targetZoom, CONTAINER_WIDTH, BASE);
        expect(next.topBp).toBeLessThanOrEqual(0);
        expect(next.topBp).toBeGreaterThan(-cpr);
        const built = buildLayoutAt(targetZoom, { seqLen: 20000 });
        const config = { ...built.config, linearWrapPhase: true };
        const layout = computeSequenceLayoutImpl(
          built.seq,
          config,
          0,
          0,
          [],
          false,
          [],
          next.topBp
        );
        expect(layout.lines.map((row) => row.sequence).join('')).toBe(built.seq.sequence);
        expect(layout.lines[0].startPos).toBe(0);
        expect(layout.lines[layout.lines.length - 1].endPos).toBe(20000);
        const row = layout.lines.find(
          (row) => row.lineIndex === absoluteRowIndexForBp(anchorBp, layout.summary!)
        )!;
        const y = computeLineTrackPositions(row, config).sequenceY + config.rowHeight / 2;
        const x = 431;
        expect(getPositionFromCoordinates(x, y, layout, config)).toBe(anchorBp);
        expect(getCursorPositionFromX(x, row, config)).toBe(anchorBp);
        expect(getPositionFromX(x + pxPerBpAt(targetZoom, BASE) / 2, row, config, 20000)).toBe(
          anchorBp
        );
        expect(
          zoomAnchorContentY(
            anchorBp,
            { role: 'real', progress: 0.5, sequenceProgress: 0.5 },
            layout,
            config
          )
        ).toBeCloseTo(y, 10);
      });
    }
  }
});

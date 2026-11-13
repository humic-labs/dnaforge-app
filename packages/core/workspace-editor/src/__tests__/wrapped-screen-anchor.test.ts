import { describe, expect, it } from 'vitest';
import {
  captureZoomAnchorRowPlacement,
  computeZoomStepWithAnchor,
  zoomAnchorContentY,
} from '../use-zoom-controller';
import { bpAtCursorForZoom } from '../use-zoom-gesture';
import {
  BASE,
  CONTAINER_RECT,
  CONTAINER_WIDTH,
  buildLayoutAt,
  mockContainer,
} from '../testing/zoom-fixtures';
import { charsPerRowAt, pxPerBpAt } from '../zoom-math';
import { computeLineTrackPositions, lineTrackBoundaries } from '../line-track-layout';
import { rowPaintBounds } from '../predictive-wrap-layout';

describe('screen anchoring while annotation heights settle', () => {
  it('keeps an arbitrary screen point in its own track instead of snapping to nearby DNA', () => {
    const { layout, config } = buildLayoutAt(100, {
      circular: true,
      seqLen: 20000,
      virtualRowCount: 20,
    });
    const row = layout.lines.find((row) => row.startPos <= 250 && row.endPos > 250)!;
    const bands = lineTrackBoundaries(row, config);
    const points = [
      row.y - 1,
      row.y + 1,
      row.y + bands[5] - 45,
      row.y + bands[6] + 12,
      row.y + bands[bands.length - 1] + 1,
    ];
    for (const contentY of points) {
      const placement = captureZoomAnchorRowPlacement(250, contentY, layout, config);
      expect(
        zoomAnchorContentY(250, placement, layout, config),
        `screen y=${contentY}`
      ).toBeCloseTo(contentY, 8);
    }
  });

  it('keeps the same point within a nucleotide glyph as its track spacing changes', () => {
    const bp = 250;
    const before = buildLayoutAt(37.94, { circular: true, seqLen: 2686, virtualRowCount: 20 });
    const after = buildLayoutAt(50.06, { circular: true, seqLen: 2686, virtualRowCount: 20 });
    const oldRow = before.layout.lines.find((row) => row.startPos <= bp && row.endPos > bp)!;
    const oldTracks = computeLineTrackPositions(oldRow, before.config);
    const oldBounds = rowPaintBounds(oldRow, oldTracks.sequenceY, before.config.rowHeight);
    const placement = captureZoomAnchorRowPlacement(
      bp,
      oldBounds.y + oldBounds.height * 0.5,
      before.layout,
      before.config
    );
    expect(placement.sequenceProgress).toBeCloseTo(0.5);
    const newRow = after.layout.lines.find((row) => row.startPos <= bp && row.endPos > bp)!;
    const natural = lineTrackBoundaries(newRow, after.config);
    const painted = natural.map((edge, index) => edge + (index >= 6 ? 14 : 0));
    newRow.trackMorph = { natural, painted };
    const newTracks = computeLineTrackPositions(newRow, after.config);
    const newBounds = rowPaintBounds(newRow, newTracks.sequenceY, after.config.rowHeight);
    expect(zoomAnchorContentY(bp, placement, after.layout, after.config)).toBeCloseTo(
      newBounds.y + newBounds.height * 0.5,
      8
    );
  });
});

describe('continuous circular screen anchor', () => {
  for (const anchorBp of [0, 17, 12345, 19999]) {
    for (const targetZoom of [12.5, 30.999999, 31.000001, 75, 99.999]) {
      it(`keeps base ${anchorBp} on its screen column at ${targetZoom}% without enlarging the buffer`, () => {
        const sequenceLength = 20000;
        const cursor = { clientX: CONTAINER_RECT.left + 431, clientY: CONTAINER_RECT.top + 310 };
        const next = computeZoomStepWithAnchor({
          targetZoom,
          deltaPx: 0,
          cursor,
          anchorBp,
          anchorUnwrappedBp: anchorBp - sequenceLength,
          currentZoom: 100,
          currentTopBp: 0,
          circularOffset: 0,
          isCircular: true,
          rebaseCircularOrigin: true,
          sequenceLength,
          baseConfig: BASE,
          containerWidth: CONTAINER_WIDTH,
          containerRect: CONTAINER_RECT,
          minZoom: 0.1,
          maxZoom: 100,
          sensitivity: 20,
        })!;
        const column = Math.min(
          charsPerRowAt(targetZoom, CONTAINER_WIDTH, BASE) - 1,
          Math.round(
            (cursor.clientX - CONTAINER_RECT.left - BASE.marginLeft) / pxPerBpAt(targetZoom, BASE)
          )
        );
        expect((next.topBp + column) % sequenceLength).toBe(anchorBp);
        expect(next.circularOffset).toBe(next.topBp);
        const { layout, config } = buildLayoutAt(targetZoom, {
          circular: true,
          seqLen: sequenceLength,
          virtualRowCount: 20,
          bpOffset: next.topBp,
        });
        const contentY = zoomAnchorContentY(
          anchorBp,
          {
            role: 'real',
            cycle: anchorBp < next.topBp ? 1 : 0,
            progress: 0.5,
            sequenceProgress: 0.5,
          },
          layout,
          config
        )!;
        const container = mockContainer(contentY - (cursor.clientY - CONTAINER_RECT.top));
        expect(bpAtCursorForZoom(layout, config, container, cursor.clientX, cursor.clientY)).toBe(
          anchorBp
        );
        expect(layout.summary?.topBufferCount).toBe(20);
        expect(layout.summary?.bottomBufferCount).toBe(20);
      });
    }
  }
  it('does not apply the wheel dead zone to a precise slider target', () => {
    const next = computeZoomStepWithAnchor({
      targetZoom: 99.999,
      deltaPx: 0,
      cursor: { clientX: 400, clientY: 300 },
      anchorBp: 700,
      currentZoom: 100,
      currentTopBp: 0,
      circularOffset: 0,
      isCircular: true,
      rebaseCircularOrigin: true,
      sequenceLength: 20000,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      minZoom: 0.1,
      maxZoom: 100,
      sensitivity: 20,
    });
    expect(next?.zoomLevel).toBe(99.999);
  });
});

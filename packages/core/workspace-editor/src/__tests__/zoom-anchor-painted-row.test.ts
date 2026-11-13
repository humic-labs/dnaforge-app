import { describe, expect, it } from 'vitest';
import { drawRowBackgrounds } from '../canvas-drawing';
import { computeLineTrackPositions } from '../line-track-layout';
import { rowPaintBounds } from '../predictive-wrap-layout';
import { captureScreenTracks, morphScreenTracks } from '../screen-track-morph';
import { computeSequenceLayoutImpl, getPositionFromCoordinates } from '../useSequenceLayout';
import { bpAtCursorForZoom } from '../use-zoom-gesture';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import type { SequenceDrawingContext } from '../rendering/drawing-context';
import { buildLayoutAt, CONTAINER_RECT, mockContainer } from '../testing/zoom-fixtures';

describe('zoom anchor owns the visibly painted row', () => {
  it('uses the later painted row when its moving stripe overlaps the previous DNA band', () => {
    const { layout, config } = buildLayoutAt(50, { seqLen: 3000 });
    const previous = layout.lines[0];
    const row = layout.lines[1];
    const dna = rowPaintBounds(
      previous,
      computeLineTrackPositions(previous, config).sequenceY,
      config.rowHeight
    );
    const cursorY = dna.y + dna.height / 2;
    const rectangles: { y: number; height: number }[] = [];
    const ctx = {
      fillRect: (_x: number, y: number, _width: number, height: number) =>
        rectangles.push({ y, height }),
    } as unknown as SequenceDrawingContext;
    drawRowBackgrounds(ctx, [computeLineTrackPositions(row, config)], 1000);
    const background = rowPaintBounds(row, rectangles[0].y, rectangles[0].height);
    row.stripeTopOffsetPx = cursorY - background.y - 0.25;
    const x = config.marginLeft + 20 * config.charWidth;
    expect(getPositionFromCoordinates(x, cursorY, layout, config)).toBe(previous.startPos + 20);
    expect(
      bpAtCursorForZoom(
        layout,
        config,
        mockContainer(),
        CONTAINER_RECT.left + x,
        CONTAINER_RECT.top + cursorY
      )
    ).toBe(row.startPos + 20);
  });

  it('preserves a direct DNA caret hit at the painted row final column', () => {
    const { layout, config } = buildLayoutAt(50, { seqLen: 3000 });
    const row = layout.lines[1];
    const dna = rowPaintBounds(
      row,
      computeLineTrackPositions(row, config).sequenceY,
      config.rowHeight
    );
    expect(
      bpAtCursorForZoom(
        layout,
        config,
        mockContainer(),
        CONTAINER_RECT.left + config.marginLeft + row.sequence.length * config.charWidth,
        CONTAINER_RECT.top + dna.y + dna.height / 2
      )
    ).toBe(row.startPos + row.sequence.length);
  });

  for (const circular of [false, true]) {
    for (const elapsed of [0, 16, 40]) {
      it(`uses the row just inside its stripe top during ${elapsed}ms of ${circular ? 'circular' : 'linear'} track accommodation`, () => {
        const sequence = {
          id: 'zoom-anchor-painted-top',
          name: 'zoom-anchor-painted-top',
          sequence: 'ACGT'.repeat(750),
          length: 3000,
          circular,
          annotations: Array.from({ length: 4 }, (_, lane) => ({
            name: `coding-${lane}`,
            type: 'CDS',
            start: lane === 0 ? 90 : 100 + lane,
            end: 180 - lane,
            direction: 1 as const,
          })),
        };
        const beforeConfig = {
          ...DEFAULT_EDITOR_CONFIG,
          charsPerLine: 100,
          charWidth: 2,
          rowHeight: 4,
        };
        const config = { ...beforeConfig, charsPerLine: 120 };
        const virtualRows = circular ? 3 : 0;
        const before = computeSequenceLayoutImpl(sequence, beforeConfig, 0, virtualRows);
        const target = computeSequenceLayoutImpl(sequence, config, 0, virtualRows);
        const first = morphScreenTracks(
          target,
          config,
          captureScreenTracks(before, beforeConfig, 43, 0),
          43,
          0,
          { min: -3, max: 5 },
          { fastZoomInternal: true }
        );
        const { layout } = morphScreenTracks(
          target,
          config,
          first.frame,
          43,
          elapsed,
          { min: -3, max: 5 },
          { fastZoomInternal: true }
        );
        const row = layout.lines.find(
          (candidate) =>
            candidate.startPos === 120 && !candidate.isTopBuffer && !candidate.isBottomBuffer
        )!;
        expect(row).toBeDefined();
        expect(row.translationLaneCount).toBe(4);

        const rectangles: { y: number; height: number }[] = [];
        const ctx = {
          fillRect: (_x: number, y: number, _width: number, height: number) =>
            rectangles.push({ y, height }),
        } as unknown as SequenceDrawingContext;
        drawRowBackgrounds(ctx, [computeLineTrackPositions(row, config)], 1000);
        const natural = rectangles[0];
        const painted = rowPaintBounds(row, natural.y, natural.height);
        const stripeTop = painted.y + (row.stripeTopOffsetPx ?? 0);
        const cursorY = stripeTop + 0.25;
        const column = 20;
        const container = mockContainer(Math.max(0, stripeTop - 100));
        const clientX =
          CONTAINER_RECT.left + config.marginLeft + (row.xOffset ?? 0) + column * config.charWidth;
        const clientY = CONTAINER_RECT.top + cursorY - container.scrollTop;

        expect(
          bpAtCursorForZoom(layout, config, container, clientX, clientY),
          `painted row ${row.lineIndex}, stripe top ${stripeTop}, content top ${row.y}`
        ).toBe(140);
      });
    }
  }
});

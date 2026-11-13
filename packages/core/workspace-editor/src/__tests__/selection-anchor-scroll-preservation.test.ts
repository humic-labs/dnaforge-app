import { describe, it, expect } from 'vitest';
import type { LayoutSnapshot2D } from '../types';
import { DEFAULT_EDITOR_CONFIG } from '../types';
import { calculateLinePositions } from '../line-positions';
import { lineTrackBoundaries } from '../line-track-layout';
import {
  captureViewportCenterPosition,
  captureSelectionScreenAnchor,
  getScrollYForSequencePosition,
} from '../layout-utils';

function buildLayout(
  seqLength: number,
  charsPerLine: number,
  lineHeight: number
): LayoutSnapshot2D {
  const lines: Array<{ startPos: number; endPos: number; y: number; sequence: string }> = [];
  const bases = 'ATCGATCGATCG';
  for (let i = 0; i < seqLength; i += charsPerLine) {
    const len = Math.min(charsPerLine, seqLength - i);
    let sequence = '';
    for (let k = 0; k < len; k++) sequence += bases[(i + k) % bases.length];
    lines.push({
      startPos: i,
      endPos: i + len - 1,
      y: lines.length * lineHeight,
      sequence,
    });
  }
  return {
    lines,
    sequenceLength: seqLength,
    totalHeight: lines.length * lineHeight,
  } as unknown as LayoutSnapshot2D;
}

function screenYOf(bp: number, layout: LayoutSnapshot2D, scrollTop: number): number {
  const rowY = getScrollYForSequencePosition(bp, layout, true);
  expect(rowY).not.toBeNull();
  return (rowY as number) - scrollTop;
}

describe('selection-anchored scroll preservation ', () => {
  it('captures the displayed nucleotide band while row tracks are changing height', () => {
    const layout = buildLayout(12000, 80, 120);
    const line = layout.lines[10];
    line.annotationLaneCount = 2;
    line.translationLaneCount = 1;
    const natural = lineTrackBoundaries(line, DEFAULT_EDITOR_CONFIG);
    const painted = natural.map((y, index) => (index === 0 ? y : y - 12));
    line.trackMorph = { natural, painted };
    const displayedSequenceY = line.y + painted[5];
    const anchor = captureSelectionScreenAnchor(
      displayedSequenceY - 80,
      600,
      layout,
      line.startPos + 5,
      { config: DEFAULT_EDITOR_CONFIG, primers: [] }
    );
    expect(anchor?.anchorOffsetPx).toBe(80);
  });

  it('anchors the painted nucleotide band, independent of its column within the row', () => {
    const layout = buildLayout(12000, 80, 120);
    const line = layout.lines[10];
    line.annotationLaneCount = 2;
    line.translationLaneCount = 1;
    const geometry = { config: DEFAULT_EDITOR_CONFIG, primers: [] };
    const bandY = calculateLinePositions(line, geometry.config, [], 12000).sequenceY;
    const scrollTop = bandY - 80;
    for (const column of [5, 55]) {
      const anchor = captureSelectionScreenAnchor(
        scrollTop,
        600,
        layout,
        line.startPos + column,
        geometry
      );
      expect(anchor?.anchorOffsetPx).toBe(80);
    }
  });

  it('captures the visible circular buffer copy instead of an offscreen primary row', () => {
    const layout = buildLayout(12000, 80, 120);
    const primary = layout.lines[50];
    layout.lines.unshift({ ...primary, lineIndex: -1, y: 0, isTopBuffer: true });
    layout.firstRealRowIndex = 1;
    layout.firstBottomBufferIndex = layout.lines.length;
    const geometry = { config: DEFAULT_EDITOR_CONFIG, primers: [] };
    const anchor = captureSelectionScreenAnchor(0, 600, layout, primary.startPos + 10, geometry);
    expect(anchor).toMatchObject({ position: primary.startPos + 10, anchorOffsetPx: 0 });
  });

  const SEQ = 12000;
  const LINE_HEIGHT = 20;
  const CLIENT_HEIGHT = 600;

  const wide = buildLayout(SEQ, 80, LINE_HEIGHT);
  const narrow = buildLayout(SEQ, 60, LINE_HEIGHT);

  const scrollTopBefore = 1200;
  const selectionStart = (() => {
    const targetScreenY = 80;
    const rowIndex = Math.round((scrollTopBefore + targetScreenY) / LINE_HEIGHT);
    return wide.lines[rowIndex].startPos + 5;
  })();

  it('captureSelectionScreenAnchor returns the highlight screen-y when visible', () => {
    const anchor = captureSelectionScreenAnchor(
      scrollTopBefore,
      CLIENT_HEIGHT,
      wide,
      selectionStart
    );
    expect(anchor).not.toBeNull();
    expect(anchor!.position).toBe(selectionStart);
    const expectedScreenY = screenYOf(selectionStart, wide, scrollTopBefore);
    expect(anchor!.anchorOffsetPx).toBeCloseTo(expectedScreenY, 5);
    expect(anchor!.anchorOffsetPx).toBeLessThan(CLIENT_HEIGHT / 2 - 100);
  });

  it('returns null when the highlight is outside the viewport (caller center-preserves)', () => {
    const offScreenBp =
      wide.lines[Math.round((scrollTopBefore + CLIENT_HEIGHT + 400) / LINE_HEIGHT)].startPos;
    const anchor = captureSelectionScreenAnchor(scrollTopBefore, CLIENT_HEIGHT, wide, offScreenBp);
    expect(anchor).toBeNull();
  });

  it('selection-anchor keeps the highlight screen-y INVARIANT across rewrap; center-preserve DRIFTS it', () => {
    const screenYBefore = screenYOf(selectionStart, wide, scrollTopBefore);

    const centerBp = captureViewportCenterPosition(scrollTopBefore, CLIENT_HEIGHT, wide, null);
    expect(centerBp).not.toBeNull();
    const centerRowYNarrow = getScrollYForSequencePosition(centerBp as number, narrow, true)!;
    const centerRestoreScrollTop = Math.max(0, centerRowYNarrow - CLIENT_HEIGHT / 2);
    const screenYAfterCenter = screenYOf(selectionStart, narrow, centerRestoreScrollTop);
    const centerDrift = Math.abs(screenYAfterCenter - screenYBefore);

    const anchor = captureSelectionScreenAnchor(
      scrollTopBefore,
      CLIENT_HEIGHT,
      wide,
      selectionStart
    )!;
    const anchorRowYNarrow = getScrollYForSequencePosition(anchor.position, narrow, true)!;
    const anchorRestoreScrollTop = Math.max(0, anchorRowYNarrow - anchor.anchorOffsetPx);
    const screenYAfterAnchor = screenYOf(selectionStart, narrow, anchorRestoreScrollTop);
    const anchorDrift = Math.abs(screenYAfterAnchor - screenYBefore);

    expect(anchorDrift).toBeLessThan(1);
    expect(centerDrift).toBeGreaterThan(40);
  });
});

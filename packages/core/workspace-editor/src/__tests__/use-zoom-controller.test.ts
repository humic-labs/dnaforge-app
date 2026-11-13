import { describe, it, expect } from 'vitest';
import {
  captureZoomAnchorRowPlacement,
  computeZoomStep,
  computeZoomStepWithAnchor,
  zoomAnchorContentY,
} from '../use-zoom-controller';
import { bpAtCursor } from '../use-zoom-gesture';
import { bpForAbsoluteRowIndex, yForAbsoluteRowIndex } from '../layout-utils';
import { computeLineTrackPositions } from '../line-track-layout';
import { charsPerRowAt, pxPerBpAt } from '../zoom-math';
import {
  BASE,
  CONTAINER_RECT,
  CONTAINER_WIDTH,
  buildLayoutAt,
  mockContainer,
} from '../testing/zoom-fixtures';

describe('computeZoomStep — dead zones and clamps', () => {
  it('returns null when accumulated delta is below 0.5 px', () => {
    const { layout, config } = buildLayoutAt(100, { circular: true });
    const container = mockContainer(0);
    const result = computeZoomStep({
      deltaPx: 0.2,
      cursor: { clientX: 300, clientY: 200 },
      currentZoom: 100,
      currentTopBp: 0,
      isCircular: true,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      container,
      layout,
      config,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });
    expect(result).toBeNull();
  });

  it('returns null at MAX_ZOOM when trying to zoom in', () => {
    const { layout, config } = buildLayoutAt(100, { circular: true });
    const container = mockContainer(0);
    const result = computeZoomStep({
      deltaPx: -500,
      cursor: { clientX: 300, clientY: 200 },
      currentZoom: 100,
      currentTopBp: 0,
      isCircular: true,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      container,
      layout,
      config,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });
    expect(result).toBeNull();
  });

  it('returns null at MIN_ZOOM when trying to zoom out', () => {
    const { layout, config } = buildLayoutAt(25, { circular: true });
    const container = mockContainer(0);
    const result = computeZoomStep({
      deltaPx: 500,
      cursor: { clientX: 300, clientY: 200 },
      currentZoom: 25,
      currentTopBp: 0,
      isCircular: true,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      container,
      layout,
      config,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });
    expect(result).toBeNull();
  });
});

describe('computeZoomStep — center-preserve fallback', () => {
  it('preserves topBp when the cursor is in the left gutter', () => {
    const { layout, config } = buildLayoutAt(100, { circular: true });
    const container = mockContainer(0);
    const result = computeZoomStep({
      deltaPx: 300,
      cursor: { clientX: CONTAINER_RECT.left + 2, clientY: CONTAINER_RECT.top + 100 },
      currentZoom: 100,
      currentTopBp: 42,
      isCircular: true,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      container,
      layout,
      config,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });
    expect(result).not.toBeNull();
    expect(result!.zoomLevel).toBeLessThan(100);
    expect(result!.topBp).toBe(42);
  });
});

describe('computeZoomStep — anchor closed-form invariant', () => {
  it('newTopBp mod newCpr matches (anchorBp - colNew) mod newCpr', () => {
    const { layout, config } = buildLayoutAt(100, { seqLen: 2000, circular: true });
    const container = mockContainer(0);

    const clientX = CONTAINER_RECT.left + BASE.marginLeft + 50 * BASE.baseCharWidth;
    const clientY = CONTAINER_RECT.top + 70;

    const anchorBp = bpAtCursor(layout, config, container, clientX, clientY);
    expect(anchorBp).not.toBeNull();

    const result = computeZoomStep({
      deltaPx: 500,
      cursor: { clientX, clientY },
      currentZoom: 100,
      currentTopBp: 0,
      isCircular: true,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      container,
      layout,
      config,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });

    expect(result).not.toBeNull();
    const { zoomLevel: newZoom, topBp: newTopBp } = result!;
    expect(newZoom).toBeLessThan(100);

    const newCpr = charsPerRowAt(newZoom, CONTAINER_WIDTH, BASE);
    const newPxPerBp = pxPerBpAt(newZoom, BASE);
    const rawCol = Math.round((clientX - CONTAINER_RECT.left - BASE.marginLeft) / newPxPerBp);
    const colNew = Math.max(0, Math.min(newCpr - 1, rawCol));

    const placement = captureZoomAnchorRowPlacement(
      anchorBp!,
      container.scrollTop + clientY - CONTAINER_RECT.top,
      layout,
      config
    );
    const unwrapped = anchorBp! + (placement.cycle ?? 0) * layout.summary!.seqLength;
    const expectedMod = (((unwrapped - colNew) % newCpr) + newCpr) % newCpr;
    const actualMod = ((newTopBp % newCpr) + newCpr) % newCpr;
    expect(actualMod).toBe(expectedMod);
  });
});

describe('computeZoomStep — circular sequence: anchor physically visible in new layout', () => {
  it('some row in the new layout has startPos + colNew ≡ anchorBp (mod seqLen)', () => {
    const seqLen = 1000;
    const virtualRowCount = 10;
    const { layout: layoutOld, config: configOld } = buildLayoutAt(100, {
      seqLen,
      circular: true,
      virtualRowCount,
    });
    const row = layoutOld.lines[layoutOld.summary!.topBufferCount + 2];
    const dnaY = computeLineTrackPositions(row, configOld).sequenceY + configOld.rowHeight / 2;
    const container = mockContainer(dnaY - 320);

    const clientX = CONTAINER_RECT.left + BASE.marginLeft + 30 * BASE.baseCharWidth;
    const clientY = CONTAINER_RECT.top + 320;

    const anchorBp = (row.startPos + 30) % seqLen;
    expect(bpAtCursor(layoutOld, configOld, container, clientX, clientY)).toBe(anchorBp);

    const result = computeZoomStep({
      deltaPx: 400,
      cursor: { clientX, clientY },
      currentZoom: 100,
      currentTopBp: 0,
      isCircular: true,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      container,
      layout: layoutOld,
      config: configOld,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });
    expect(result).not.toBeNull();

    const { zoomLevel: newZoom, topBp: newTopBp } = result!;
    const newCpr = charsPerRowAt(newZoom, CONTAINER_WIDTH, BASE);
    const newPxPerBp = pxPerBpAt(newZoom, BASE);
    const rawCol = Math.round((clientX - CONTAINER_RECT.left - BASE.marginLeft) / newPxPerBp);
    const colNew = Math.max(0, Math.min(newCpr - 1, rawCol));

    const { layout: layoutNew } = buildLayoutAt(newZoom, {
      seqLen,
      circular: true,
      virtualRowCount,
      bpOffset: newTopBp,
    });

    const matchingLine = layoutNew.lines.find((l) => {
      const target = (l.startPos + colNew) % seqLen;
      return target === anchorBp;
    });
    expect(matchingLine).toBeDefined();
  });
});

describe('Canvas zoom row placement', () => {
  it('restores a gap-resolved anchor inside the row that contains its bp', () => {
    const { layout } = buildLayoutAt(100, {
      seqLen: 1000,
      circular: true,
      virtualRowCount: 5,
    });
    const summary = layout.summary;
    expect(summary).toBeDefined();
    if (!summary) return;

    const rowIndex = summary.topBufferCount + 2;
    const anchorBp = bpForAbsoluteRowIndex(rowIndex, summary);
    const contentY = yForAbsoluteRowIndex(rowIndex, summary) - 1;
    const placement = captureZoomAnchorRowPlacement(anchorBp, contentY, layout);
    const restoredY = zoomAnchorContentY(anchorBp, placement, layout);

    expect(placement.role).toBe('real');
    expect(restoredY).not.toBeNull();
    if (restoredY === null) throw new Error('Expected a restored anchor Y');
    expect(restoredY).toBeGreaterThan(yForAbsoluteRowIndex(rowIndex, summary));
    expect(restoredY).toBeLessThan(yForAbsoluteRowIndex(rowIndex + 1, summary) - summary.rowGapPx);
  });
});

describe('computeZoomStep — multi-step (within-gesture-like)', () => {
  it('each commit produces a consistent closed-form anchor (against its own input layout)', () => {
    const seqLen = 2000;
    let currentZoom = 100;
    let currentTopBp = 0;
    const container = mockContainer(0);

    for (const deltaPx of [250, 250, 250]) {
      const { layout, config } = buildLayoutAt(currentZoom, {
        seqLen,
        circular: true,
        virtualRowCount: 10,
        bpOffset: currentTopBp,
      });

      const row = layout.lines[layout.summary!.topBufferCount + 2];
      const dnaY = computeLineTrackPositions(row, config).sequenceY + config.rowHeight / 2;
      container.scrollTop = dnaY - 320;
      const clientX = CONTAINER_RECT.left + config.marginLeft + 40 * config.charWidth;
      const clientY = CONTAINER_RECT.top + 320;
      const anchorBp = (row.startPos + 40) % seqLen;
      expect(bpAtCursor(layout, config, container, clientX, clientY)).toBe(anchorBp);

      const result = computeZoomStep({
        deltaPx,
        cursor: { clientX, clientY },
        currentZoom,
        currentTopBp,
        isCircular: true,
        circularOffset: 0,
        baseConfig: BASE,
        containerWidth: CONTAINER_WIDTH,
        containerRect: CONTAINER_RECT,
        container,
        layout,
        config,
        minZoom: 25,
        maxZoom: 100,
        sensitivity: 10,
      });
      if (result === null) break;

      const newCpr = charsPerRowAt(result.zoomLevel, CONTAINER_WIDTH, BASE);
      const newPxPerBp = pxPerBpAt(result.zoomLevel, BASE);
      const rawCol = Math.round((clientX - CONTAINER_RECT.left - BASE.marginLeft) / newPxPerBp);
      const colNew = Math.max(0, Math.min(newCpr - 1, rawCol));

      const placement = captureZoomAnchorRowPlacement(
        anchorBp!,
        container.scrollTop + clientY - CONTAINER_RECT.top,
        layout,
        config
      );
      const unwrapped = anchorBp! + (placement.cycle ?? 0) * layout.summary!.seqLength;
      const expectedMod = (((unwrapped - colNew) % newCpr) + newCpr) % newCpr;
      const actualMod = ((result.topBp % newCpr) + newCpr) % newCpr;
      expect(actualMod).toBe(expectedMod);

      currentZoom = result.zoomLevel;
      currentTopBp = result.topBp;
    }
  });
});

describe('computeZoomStep — circularOffset mechanics', () => {
  it('new bpOffset component stays in [0, newCpr) regardless of circularOffset', () => {
    const { layout, config } = buildLayoutAt(100, { circular: true });
    const container = mockContainer(0);

    const clientX = CONTAINER_RECT.left + BASE.marginLeft + 20 * BASE.baseCharWidth;
    const clientY = CONTAINER_RECT.top + 70;

    const circularOffset = 123;

    const result = computeZoomStep({
      deltaPx: 300,
      cursor: { clientX, clientY },
      currentZoom: 100,
      currentTopBp: circularOffset + 5,
      isCircular: true,
      circularOffset,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      container,
      layout,
      config,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });

    if (result !== null) {
      const newCpr = charsPerRowAt(result.zoomLevel, CONTAINER_WIDTH, BASE);
      const bpOffsetComponent = result.topBp - circularOffset;
      expect(bpOffsetComponent).toBeGreaterThanOrEqual(0);
      expect(bpOffsetComponent).toBeLessThan(newCpr);
    }
  });
});

describe('computeZoomStepWithAnchor', () => {
  it('uses the frozen anchor bp without re-reading layout at commit time', () => {
    const { layout, config } = buildLayoutAt(100, { seqLen: 2000, circular: true });
    const container = mockContainer(0);

    const clientX = CONTAINER_RECT.left + BASE.marginLeft + 32 * BASE.baseCharWidth;
    const clientY = CONTAINER_RECT.top + 90;
    const anchorBp = bpAtCursor(layout, config, container, clientX, clientY);
    expect(anchorBp).not.toBeNull();

    const result = computeZoomStepWithAnchor({
      deltaPx: 300,
      cursor: { clientX, clientY },
      anchorBp: anchorBp!,
      currentZoom: 100,
      currentTopBp: 0,
      isCircular: true,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });

    expect(result).not.toBeNull();
    const newCpr = charsPerRowAt(result!.zoomLevel, CONTAINER_WIDTH, BASE);
    const newPxPerBp = pxPerBpAt(result!.zoomLevel, BASE);
    const rawCol = Math.round((clientX - CONTAINER_RECT.left - BASE.marginLeft) / newPxPerBp);
    const colNew = Math.max(0, Math.min(newCpr - 1, rawCol));
    const expectedMod = (((anchorBp! - colNew) % newCpr) + newCpr) % newCpr;
    const actualMod = ((result!.topBp % newCpr) + newCpr) % newCpr;
    expect(actualMod).toBe(expectedMod);
  });

  it('preserves topBp when the frozen anchor is invalid', () => {
    const result = computeZoomStepWithAnchor({
      deltaPx: 300,
      cursor: { clientX: 300, clientY: 200 },
      anchorBp: -1,
      currentZoom: 100,
      currentTopBp: 77,
      isCircular: true,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });

    expect(result).not.toBeNull();
    expect(result!.topBp).toBe(77);
  });
});

describe('computeZoomStep — a linear document keeps its topBp', () => {
  it('returns the current topBp instead of a solved column offset', () => {
    const { layout, config } = buildLayoutAt(100, { seqLen: 2000 });
    const container = mockContainer();

    const result = computeZoomStep({
      deltaPx: 120,
      cursor: { clientX: CONTAINER_RECT.left + 400, clientY: CONTAINER_RECT.top + 60 },
      currentZoom: 100,
      currentTopBp: 0,
      isCircular: false,
      circularOffset: 0,
      baseConfig: BASE,
      containerWidth: CONTAINER_WIDTH,
      containerRect: CONTAINER_RECT,
      container,
      layout,
      config,
      minZoom: 25,
      maxZoom: 100,
      sensitivity: 10,
    });

    expect(result).not.toBeNull();
    expect(result?.zoomLevel).toBeLessThan(100);
    expect(result?.topBp).toBe(0);
  });
});

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  buildPaintInfo,
  createProbeContext,
  runExtraLaneContractTests,
} from '@waypoint/workspace-editor';
import { gcContentLane } from '../lane-plugins';

function constantValues(length: number, value: number): Float32Array {
  const out = new Float32Array(length);
  out.fill(value);
  return out;
}

runExtraLaneContractTests('gcContentLane', (columnCount) =>
  gcContentLane({
    values: constantValues(columnCount, 0.5),
    windowSize: 100,
  })
);

describe('gcContentLane — visualization encoding', () => {
  it('uses lineTo (not stepped fillRects) so canvas anti-aliasing smooths edges', () => {
    const length = 1_000;
    const values = new Float32Array(length);
    for (let i = 0; i < length; i++) values[i] = i % 2 === 0 ? 0.7 : 0.3;
    const lane = gcContentLane({ values, windowSize: 100 });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({ columnCount: length, pxPerBase: 1 });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const lineToCount = probe.log.filter((op) => op.op === 'lineTo').length;
    const fillRectCount = probe.log.filter((op) => op.op === 'fillRect').length;
    expect(
      lineToCount,
      'GC lane should render via filled polygons (lineTo) for smooth edges, not stepped fillRects'
    ).toBeGreaterThan(10);
    expect(fillRectCount, 'GC lane uses fillRect only for the band background').toBeLessThan(
      lineToCount
    );
  });

  it('produces both an above-baseline and a below-baseline fill', () => {
    const length = 200;
    const values = new Float32Array(length);
    for (let i = 0; i < length; i++) values[i] = i < length / 2 ? 0.8 : 0.2;
    const lane = gcContentLane({ values, windowSize: 100, height: 80 });
    const probe = createProbeContext(400);
    const info = buildPaintInfo({
      columnCount: length,
      pxPerBase: 2,
      laneHeight: 80,
      viewportWidth: 400,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const fillCount = probe.log.filter((op) => op.op === 'fill').length;
    expect(
      fillCount,
      'expected one fill per bipolar polygon (above + below)'
    ).toBeGreaterThanOrEqual(2);
  });

  it('polygon vertical extent stays within the inner band (padding-aware)', () => {
    const length = 100;
    const values = constantValues(length, 1.0);
    const lane = gcContentLane({ values, windowSize: 100, height: 60 });
    const probe = createProbeContext(400);
    const info = buildPaintInfo({
      columnCount: length,
      pxPerBase: 4,
      laneHeight: 60,
      laneY: 100,
      viewportWidth: 400,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const lineToOps = probe.log.filter((op) => op.op === 'lineTo');
    expect(lineToOps.length).toBeGreaterThan(0);
    for (const op of lineToOps) {
      if (op.op !== 'lineTo') continue;
      expect(op.y).toBeGreaterThanOrEqual(info.laneY);
      expect(op.y).toBeLessThanOrEqual(info.laneY + info.laneHeight);
    }
  });

  it('regression: zoom-in with large scrollLeft does not draw past the right edge', () => {
    const length = 5_000;
    const values = constantValues(length, 0.6);
    const lane = gcContentLane({ values, windowSize: 100 });
    const probe = createProbeContext(1024);
    const info = buildPaintInfo({
      columnCount: length,
      pxPerBase: 16,
      scrollLeft: 12_000,
      viewportWidth: 1024,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const lineToOps = probe.log.map((op, i) => ({ op, i })).filter(({ op }) => op.op === 'lineTo');
    expect(lineToOps.length).toBeGreaterThan(0);
    for (const { op, i } of lineToOps) {
      if (op.op !== 'lineTo') continue;
      const screenX = probe.resolveScreenX(op.x, i);
      expect(screenX, `lineTo screen x=${screenX} > viewport right (1024)`).toBeLessThanOrEqual(
        1024 + 64
      );
      expect(screenX).toBeGreaterThanOrEqual(-64);
    }
  });
});

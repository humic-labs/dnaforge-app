// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { buildPaintInfo, createProbeContext } from '@waypoint/workspace-editor';
import { gcContentLane } from '../lane-plugins';

type SnapshotOp =
  | { op: 'fillRect'; x: number; y: number; w: number; h: number }
  | { op: 'rect'; x: number; y: number; w: number; h: number }
  | { op: 'beginPath' }
  | { op: 'closePath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'fill' }
  | { op: 'stroke' };

function summarizeOps(log: ReturnType<typeof createProbeContext>['log']): SnapshotOp[] {
  return log
    .filter((op) =>
      ['fillRect', 'rect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'fill', 'stroke'].includes(
        op.op
      )
    )
    .map((op) => {
      switch (op.op) {
        case 'fillRect':
        case 'rect':
          return {
            op: op.op,
            x: Math.round(op.x),
            y: Math.round(op.y),
            w: Math.round(op.w),
            h: Math.round(op.h),
          };
        case 'moveTo':
        case 'lineTo':
          return { op: op.op, x: Math.round(op.x), y: Math.round(op.y) };
        case 'beginPath':
        case 'closePath':
        case 'fill':
        case 'stroke':
          return { op: op.op };
        default:
          throw new Error(`unexpected op ${op.op}`);
      }
    }) as SnapshotOp[];
}

function deterministicValues(length: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = 0.5 + 0.3 * Math.sin((i / length) * Math.PI * 6);
  }
  return out;
}

describe('gcContentLane — op-log snapshot regression', () => {
  it('renders the expected polygon shape at default zoom', () => {
    const length = 1_000;
    const lane = gcContentLane({
      values: deterministicValues(length),
      windowSize: 100,
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: length,
      pxPerBase: 4,
      scrollLeft: 0,
      laneY: 200,
      laneHeight: 56,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const summary = summarizeOps(probe.log);
    expect(summary).toMatchSnapshot();
  });

  it('renders the expected shape when zoomed in (high pxPerBase)', () => {
    const length = 1_000;
    const lane = gcContentLane({
      values: deterministicValues(length),
      windowSize: 100,
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: length,
      pxPerBase: 12,
      scrollLeft: 2_400,
      laneY: 200,
      laneHeight: 56,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const summary = summarizeOps(probe.log);
    expect(summary).toMatchSnapshot();
  });

  it('renders the expected shape when zoomed out (low pxPerBase, full sequence visible)', () => {
    const length = 5_000;
    const lane = gcContentLane({
      values: deterministicValues(length),
      windowSize: 100,
    });
    const probe = createProbeContext(800);
    const info = buildPaintInfo({
      columnCount: length,
      pxPerBase: 0.16,
      scrollLeft: 0,
      laneY: 200,
      laneHeight: 56,
      viewportWidth: 800,
    });

    probe.ctx.save();
    probe.ctx.translate(-info.scrollLeft, 0);
    lane.draw(probe.ctx, info);
    probe.ctx.restore();

    const summary = summarizeOps(probe.log);
    expect(summary).toMatchSnapshot();
  });
});

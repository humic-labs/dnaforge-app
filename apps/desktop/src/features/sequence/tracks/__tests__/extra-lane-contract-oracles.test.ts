import { describe, expect, it } from 'vitest';
import {
  assertNoOffScreenDraws,
  assertWithinLaneVertical,
  buildPaintInfo,
  createProbeContext,
} from '@waypoint/workspace-editor';

const info = buildPaintInfo({ viewportWidth: 800, laneY: 200, laneHeight: 56 });

for (const { axis, min, max } of [
  { axis: 'x', min: -64, max: 864 },
  { axis: 'y', min: 196, max: 260 },
] as const) {
  describe(`ExtraLane ${axis}-coordinate contract`, () => {
    function point(value: number) {
      const probe = createProbeContext();
      probe.ctx.lineTo(axis === 'x' ? value : 0, axis === 'y' ? value : info.laneY);
      return probe;
    }

    function check(probe: ReturnType<typeof createProbeContext>, margin?: number) {
      if (axis === 'x') assertNoOffScreenDraws(probe, info, 'coordinate oracle', margin);
      else assertWithinLaneVertical(probe, info, 'coordinate oracle', margin);
    }

    it('accepts both inclusive bounds and an interior point', () => {
      const probe = point(min);
      probe.ctx.lineTo(axis === 'x' ? max : 0, axis === 'y' ? max : info.laneY);
      probe.ctx.lineTo(
        axis === 'x' ? (min + max) / 2 : 0,
        axis === 'y' ? (min + max) / 2 : info.laneY
      );
      expect(() => check(probe)).not.toThrow();
    });

    it.each([
      { label: 'below the lower bound', value: min - 0.01 },
      { label: 'above the upper bound', value: max + 0.01 },
      { label: 'NaN', value: Number.NaN },
      { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
      { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    ])('rejects $label', ({ value }) => {
      expect(() => check(point(value))).toThrow();
    });

    it('preserves the caller-specified zero margin', () => {
      const probe = point(axis === 'x' ? -0.01 : info.laneY - 0.01);
      expect(() => check(probe)).not.toThrow();
      expect(() => check(probe, 0)).toThrow();
    });

    it('checks transformed screen positions rather than untransformed coordinates', () => {
      const inside = createProbeContext();
      inside.ctx.translate(axis === 'x' ? 80 : 0, axis === 'y' ? 40 : 0);
      inside.ctx.lineTo(axis === 'x' ? -80 : 0, axis === 'y' ? 160 : info.laneY);
      expect(() => check(inside, 0)).not.toThrow();

      const outside = createProbeContext();
      outside.ctx.translate(axis === 'x' ? 801 : 0, axis === 'y' ? 57 : 0);
      outside.ctx.lineTo(0, info.laneY);
      expect(() => check(outside, 0)).toThrow();
    });

    it('rejects an invalid last point after a long valid prefix', () => {
      const probe = createProbeContext();
      for (let n = 0; n < 4096; n++) probe.ctx.lineTo(0, info.laneY);
      probe.ctx.lineTo(axis === 'x' ? max + 0.01 : 0, axis === 'y' ? max + 0.01 : info.laneY);
      expect(() => check(probe)).toThrow();
    });
  });
}

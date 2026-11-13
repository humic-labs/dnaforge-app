import { describe, expect, it } from 'vitest';

import {
  AnnotationTrackLayoutInputError,
  computeAnnotationTrackLayoutPlan,
  type AnnotationTrackLayoutPlanInput,
} from './annotation-track-layout-plan';

const GEOMETRY = {
  laneStepPx: 16,
  barHeightPx: 14,
  trackGapPx: 4,
} as const;

function compute(tracks: AnnotationTrackLayoutPlanInput['tracks']) {
  return computeAnnotationTrackLayoutPlan({ tracks, ...GEOMETRY });
}

describe('computeAnnotationTrackLayoutPlan', () => {
  it('reserves the complete 12-lane policy height independently of occupancy', () => {
    const plan = compute([{ trackId: 'mRNA', laneCapacity: 12 }]);

    expect(plan.totalHeightPx).toBe(192);
    expect(plan.outerBoundPx).toBe(-192);
    expect(plan.tracks[0]).toMatchObject({
      trackId: 'mRNA',
      order: 0,
      laneCapacity: 12,
      baseOffsetPx: 0,
      slotHeightPx: 192,
      slotInnerBoundPx: 0,
      slotOuterBoundPx: -192,
      hitBand: { innerBoundPx: 0, outerBoundPx: -192 },
    });
    expect(plan.tracks[0].laneCenterOffsetsPx).toEqual([
      -7, -23, -39, -55, -71, -87, -103, -119, -135, -151, -167, -183,
    ]);
  });

  it('stacks the caller order outward with exactly the requested inter-track gap', () => {
    const plan = compute([
      { trackId: 'gene', laneCapacity: 2 },
      { trackId: 'mRNA', laneCapacity: 3 },
    ]);

    expect(plan.tracks).toEqual([
      expect.objectContaining({
        trackId: 'gene',
        order: 0,
        baseOffsetPx: 0,
        slotInnerBoundPx: 0,
        slotOuterBoundPx: -32,
      }),
      expect.objectContaining({
        trackId: 'mRNA',
        order: 1,
        baseOffsetPx: -36,
        slotInnerBoundPx: -36,
        slotOuterBoundPx: -84,
      }),
    ]);
    expect(plan.totalHeightPx).toBe(84);
    expect(plan.tracks[0].slotOuterBoundPx - plan.tracks[1].slotInnerBoundPx).toBe(4);
  });

  it('keeps each track local geometry unchanged when composition order changes', () => {
    const first = compute([
      { trackId: 'gene', laneCapacity: 2 },
      { trackId: 'mRNA', laneCapacity: 3 },
    ]);
    const reordered = compute([
      { trackId: 'mRNA', laneCapacity: 3 },
      { trackId: 'gene', laneCapacity: 2 },
    ]);

    const firstGene = first.getTrack('gene');
    const reorderedGene = reordered.getTrack('gene');
    const firstMrna = first.getTrack('mRNA');
    const reorderedMrna = reordered.getTrack('mRNA');
    expect(firstGene?.laneCenterOffsetsPx).toEqual(reorderedGene?.laneCenterOffsetsPx);
    expect(firstMrna?.laneCenterOffsetsPx).toEqual(reorderedMrna?.laneCenterOffsetsPx);
    expect(firstGene?.slotHeightPx).toBe(reorderedGene?.slotHeightPx);
    expect(firstMrna?.slotHeightPx).toBe(reorderedMrna?.slotHeightPx);
    expect(firstGene?.order).toBe(0);
    expect(reorderedGene?.order).toBe(1);
    expect(firstMrna?.baseOffsetPx).toBe(-36);
    expect(reorderedMrna?.baseOffsetPx).toBe(0);
  });

  it('exposes deterministic id and hit-band lookup while leaving gaps noninteractive', () => {
    const plan = compute([
      { trackId: 'gene', laneCapacity: 2 },
      { trackId: 'mRNA', laneCapacity: 3 },
    ]);

    expect(plan.getTrack('mRNA')?.trackId).toBe('mRNA');
    expect(plan.getTrack('missing')).toBeUndefined();
    expect(plan.trackAtOffsetPx(0)?.trackId).toBe('gene');
    expect(plan.trackAtOffsetPx(-31.99)?.trackId).toBe('gene');
    expect(plan.trackAtOffsetPx(-32)).toBeUndefined();
    expect(plan.trackAtOffsetPx(-35.99)).toBeUndefined();
    expect(plan.trackAtOffsetPx(-36)?.trackId).toBe('mRNA');
    expect(plan.trackAtOffsetPx(-84)?.trackId).toBe('mRNA');
    expect(plan.trackAtOffsetPx(1)).toBeUndefined();
    expect(plan.trackAtOffsetPx(-85)).toBeUndefined();
    expect(plan.trackAtOffsetPx(Number.NaN)).toBeUndefined();
  });

  it('returns a deeply frozen plan so layout policy cannot drift after construction', () => {
    const plan = compute([{ trackId: 'mRNA', laneCapacity: 12 }]);

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.tracks)).toBe(true);
    expect(Object.isFrozen(plan.tracks[0])).toBe(true);
    expect(Object.isFrozen(plan.tracks[0].laneCenterOffsetsPx)).toBe(true);
    expect(Object.isFrozen(plan.tracks[0].hitBand)).toBe(true);
  });

  it('rejects empty and duplicate track lists', () => {
    expect(() => compute([])).toThrowError(AnnotationTrackLayoutInputError);
    expect(() =>
      compute([
        { trackId: 'mRNA', laneCapacity: 12 },
        { trackId: 'mRNA', laneCapacity: 12 },
      ])
    ).toThrowError(/Duplicate annotation track id/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid laneCapacity %s',
    (laneCapacity) => {
      expect(() => compute([{ trackId: 'mRNA', laneCapacity }])).toThrowError(
        AnnotationTrackLayoutInputError
      );
    }
  );

  it.each([
    { ...GEOMETRY, laneStepPx: 0 },
    { ...GEOMETRY, laneStepPx: Number.NaN },
    { ...GEOMETRY, barHeightPx: 0 },
    { ...GEOMETRY, barHeightPx: 17 },
    { ...GEOMETRY, trackGapPx: -1 },
    { ...GEOMETRY, trackGapPx: Number.POSITIVE_INFINITY },
  ])('rejects invalid geometry %#', (geometry) => {
    expect(() =>
      computeAnnotationTrackLayoutPlan({
        tracks: [{ trackId: 'mRNA', laneCapacity: 12 }],
        ...geometry,
      })
    ).toThrowError(AnnotationTrackLayoutInputError);
  });

  it('rejects feature occupancy and global-lane fields as layout inputs', () => {
    expect(() =>
      compute([
        {
          trackId: 'mRNA',
          laneCapacity: 12,
          observedMaxLane: 4,
        } as never,
      ])
    ).toThrowError(/observedMaxLane/);
    expect(() =>
      compute([
        {
          trackId: 'mRNA',
          laneCapacity: 12,
          globalFeatureLane: 27,
        } as never,
      ])
    ).toThrowError(/globalFeatureLane/);
  });

  it('fails closed when finite inputs overflow the output coordinate range', () => {
    expect(() =>
      computeAnnotationTrackLayoutPlan({
        tracks: [{ trackId: 'mRNA', laneCapacity: Number.MAX_SAFE_INTEGER }],
        laneStepPx: Number.MAX_VALUE,
        barHeightPx: 1,
        trackGapPx: 0,
      })
    ).toThrowError(/non-finite slot height/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  layoutJunctionHandles,
  panDeltaToRevealHandle,
  type JunctionHandleLayoutInput,
} from './JunctionHandleLayout';

const STRIP_WIDTH = 466;
const HIT_WIDTH = 28;

function grip(
  rawCenterX: number,
  overrides: Partial<JunctionHandleLayoutInput> = {}
): JunctionHandleLayoutInput {
  return {
    rawCenterX,
    hitWidth: HIT_WIDTH,
    interactive: true,
    boundaryDrawable: true,
    ...overrides,
  };
}

function layout(inputs: JunctionHandleLayoutInput[], width = STRIP_WIDTH) {
  return layoutJunctionHandles(inputs, width, HIT_WIDTH);
}

describe('layoutJunctionHandles', () => {
  it('parks two boundaries beyond the left edge side by side in sequence order', () => {
    const [overlapStart, overlapEnd] = layout([grip(-326), grip(-86)]);

    expect(overlapStart).toEqual({
      kind: 'offscreen',
      edge: 'left',
      order: 0,
      row: 0,
      centerX: 14,
      distancePx: 326,
    });
    expect(overlapEnd).toEqual({
      kind: 'offscreen',
      edge: 'left',
      order: 1,
      row: 0,
      centerX: 42,
      distancePx: 86,
    });
  });

  it('parks an overlap end and a primer binding end beyond the right edge side by side', () => {
    const [overlapStart, overlapEnd, bindingStart, bindingEnd] = layout([
      grip(299),
      grip(539),
      grip(211),
      grip(595),
    ]);

    expect(overlapStart).toEqual({ kind: 'boundary', centerX: 299, indicatorX: 14 });
    expect(bindingStart).toEqual({ kind: 'boundary', centerX: 211, indicatorX: 14 });
    expect(bindingEnd).toMatchObject({ kind: 'offscreen', edge: 'right', order: 0, centerX: 452 });
    expect(overlapEnd).toMatchObject({ kind: 'offscreen', edge: 'right', order: 1, centerX: 424 });
  });

  it('keeps a boundary exactly at an edge as a grip whose guide stays on the boundary', () => {
    const [atLeft, atRight] = layout([grip(0), grip(200)], 200);

    expect(atLeft).toEqual({ kind: 'boundary', centerX: 14, indicatorX: 0 });
    expect(atRight).toEqual({ kind: 'boundary', centerX: 186, indicatorX: 28 });
  });

  it('keeps two visible boundaries near the same edge on separate targets', () => {
    expect(layout([grip(0), grip(8)], 200)).toEqual([
      { kind: 'boundary', centerX: 14, indicatorX: 0 },
      { kind: 'boundary', centerX: 22, indicatorX: 0 },
    ]);
    expect(layout([grip(192), grip(200)], 200)).toEqual([
      { kind: 'boundary', centerX: 178, indicatorX: 28 },
      { kind: 'boundary', centerX: 186, indicatorX: 28 },
    ]);
  });

  it('never moves a guide away from its boundary', () => {
    const rawCenters = [-40, 0, 3, 11, 90, 190, 197, 200, 260];
    const placements = layout(
      rawCenters.map((x) => grip(x)),
      200
    );

    placements.forEach((placement, index) => {
      if (placement.kind !== 'boundary') return;
      expect(placement.centerX - 14 + placement.indicatorX).toBeCloseTo(rawCenters[index]);
      expect(placement.indicatorX).toBeGreaterThanOrEqual(0);
      expect(placement.indicatorX).toBeLessThanOrEqual(28);
    });
    expect(placements.filter((placement) => placement.kind === 'offscreen')).toHaveLength(2);
  });

  it('gives every control its own target', () => {
    const placements = layout([grip(-598), grip(-326), grip(-86), grip(-6), grip(700), grip(120)]);
    const centers = placements.map((placement) =>
      placement.kind === 'hidden' ? null : placement.centerX
    );

    expect(new Set(centers).size).toBe(centers.length);
    expect(centers).toEqual([14, 42, 70, 98, 452, 120]);
  });

  it('lifts parked handles one row when a visible grip needs that corner', () => {
    const [parked, nearEdge] = layout([grip(-50), grip(20)]);
    const [parkedClear, away] = layout([grip(-50), grip(60)]);

    expect(parked).toMatchObject({ kind: 'offscreen', row: 1 });
    expect(nearEdge).toEqual({ kind: 'boundary', centerX: 20, indicatorX: 14 });
    expect(parkedClear).toMatchObject({ kind: 'offscreen', row: 0 });
    expect(away).toEqual({ kind: 'boundary', centerX: 60, indicatorX: 14 });
  });

  it('leaves grips away from the edges on their boundaries', () => {
    expect(layout([grip(100), grip(108), grip(100)], 400)).toEqual([
      { kind: 'boundary', centerX: 100, indicatorX: 14 },
      { kind: 'boundary', centerX: 108, indicatorX: 14 },
      { kind: 'boundary', centerX: 100, indicatorX: 14 },
    ]);
  });

  it('does not let a locked marker push an editable grip', () => {
    const [marker, editable] = layout([grip(0, { interactive: false }), grip(8)], 200);

    expect(marker).toEqual({ kind: 'boundary', centerX: 14, indicatorX: 0 });
    expect(editable).toEqual({ kind: 'boundary', centerX: 14, indicatorX: 8 });
  });

  it('hides a locked marker whose boundary is off screen', () => {
    expect(layout([grip(-10, { interactive: false })])).toEqual([{ kind: 'hidden' }]);
  });

  it('shows a handle whose boundary cannot be drawn yet only while it is off screen', () => {
    const [inView, offscreen, neighbour] = layout([
      grip(4, { boundaryDrawable: false }),
      grip(-159, { boundaryDrawable: false }),
      grip(10),
    ]);

    expect(inView).toEqual({ kind: 'hidden' });
    expect(offscreen).toMatchObject({ kind: 'offscreen', edge: 'left', order: 0, row: 1 });
    expect(neighbour).toEqual({ kind: 'boundary', centerX: 14, indicatorX: 10 });
  });

  it('treats every handle as in view until the strip has been measured', () => {
    expect(layout([grip(-50), grip(900)], 0)).toEqual([
      { kind: 'boundary', centerX: -50, indicatorX: 14 },
      { kind: 'boundary', centerX: 900, indicatorX: 14 },
    ]);
  });
});

describe('panDeltaToRevealHandle', () => {
  it('brings a boundary beyond the left edge a short way inside it', () => {
    expect(-326 - panDeltaToRevealHandle(-326, STRIP_WIDTH)).toBe(96);
  });

  it('brings a boundary beyond the right edge a short way inside it', () => {
    expect(595 - panDeltaToRevealHandle(595, STRIP_WIDTH)).toBe(STRIP_WIDTH - 96);
  });

  it('uses a quarter of a narrow strip as the inset', () => {
    expect(-10 - panDeltaToRevealHandle(-10, 200)).toBe(50);
  });

  it('does not move the strip for a boundary already in view', () => {
    expect(panDeltaToRevealHandle(0, 200)).toBe(0);
    expect(panDeltaToRevealHandle(200, 200)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';

import { adaptUcscTrackRecords, type AnnotationRecord } from '@waypoint/genome-data';

import {
  assignAnnotationLanes,
  computeAnnotationDrawOps,
  type AnnotationDrawOp,
  type BpToX,
} from './annotation-track-draw-ops';

const CHROM_LENGTH = 1_000_000;
const TRACK_HEIGHT = 64;
const LANE_HEIGHT = 8;
const MAX_LANES = 8;
const DEFAULT_COLOR = 0x3b82f6;

const identityBpToX: BpToX = (bp) => bp;

function planOps(args: {
  records: ReadonlyArray<AnnotationRecord>;
  viewportBpRange: { start: number; end: number };
  bpToX?: BpToX;
  trackHeightPx?: number;
  laneHeightPx?: number;
  maxLanes?: number;
}): AnnotationDrawOp[] {
  const assignment = assignAnnotationLanes(args.records, CHROM_LENGTH, args.maxLanes ?? MAX_LANES);
  return computeAnnotationDrawOps({
    records: args.records,
    assignment,
    viewportBpRange: args.viewportBpRange,
    bpToX: args.bpToX ?? identityBpToX,
    trackHeightPx: args.trackHeightPx ?? TRACK_HEIGHT,
    laneHeightPx: args.laneHeightPx ?? LANE_HEIGHT,
    defaultColor: DEFAULT_COLOR,
  });
}

describe('computeAnnotationDrawOps — empty + degenerate inputs', () => {
  it('returns no ops for an empty record list', () => {
    expect(planOps({ records: [], viewportBpRange: { start: 0, end: 1000 } })).toEqual([]);
  });

  it('returns no ops when no records overlap the viewport', () => {
    const records: AnnotationRecord[] = [
      { chrom: 'chr11', start: 100, end: 200 },
      { chrom: 'chr11', start: 5000, end: 5500 },
    ];
    expect(planOps({ records, viewportBpRange: { start: 1000, end: 2000 } })).toEqual([]);
  });

  it('returns no ops when the viewport is degenerate', () => {
    const records: AnnotationRecord[] = [{ chrom: 'chr11', start: 0, end: 100 }];
    expect(planOps({ records, viewportBpRange: { start: 100, end: 100 } })).toEqual([]);
  });
});

describe('computeAnnotationDrawOps — single-lane painting', () => {
  it('projects a real UCSC CpG island into non-empty retained geometry', () => {
    const adapted = adaptUcscTrackRecords(
      'interval',
      [
        {
          bin: 585,
          chrom: 'chr1',
          chromStart: 28_735,
          chromEnd: 29_737,
          name: 'CpG: 111',
          length: 1002,
          cpgNum: 111,
          gcNum: 731,
          perCpg: 22.2,
          perGc: 73,
          obsExp: 0.85,
        },
      ],
      { chrom: 'chr1', localStart: 0, localEnd: 65_536, globalStart: 0 }
    );
    if (adapted.scientificKind !== 'interval') throw new Error('wrong adapter');

    const ops = planOps({
      records: adapted.records,
      viewportBpRange: { start: 0, end: 50_000 },
      bpToX: (bp) => bp / 50,
    });

    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ recordIndex: 0, x: 574.7, y: 0 });
    expect(ops[0].width).toBeCloseTo(20.04);
    expect(ops[0].height).toBeGreaterThan(0);
  });

  it('emits one op per visible record at the expected screen position', () => {
    const records: AnnotationRecord[] = [
      { chrom: 'chr11', start: 100, end: 200 },
      { chrom: 'chr11', start: 500, end: 600 },
    ];
    const ops = planOps({ records, viewportBpRange: { start: 0, end: 1000 } });
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ x: 100, width: 100, y: 0 });
    expect(ops[1]).toMatchObject({ x: 500, width: 100, y: 0 });
  });

  it('clamps width to a minimum of 1 px for sub-pixel records', () => {
    const records: AnnotationRecord[] = [{ chrom: 'chr11', start: 100, end: 101 }];
    const ops = planOps({
      records,
      viewportBpRange: { start: 0, end: 200 },
      bpToX: (bp) => bp * 0.0001,
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].width).toBe(1);
  });

  it('preserves recordIndex for hit-test even after culling', () => {
    const records: AnnotationRecord[] = [
      { chrom: 'chr11', start: 0, end: 50 },
      { chrom: 'chr11', start: 200, end: 300 },
      { chrom: 'chr11', start: 5000, end: 6000 },
      { chrom: 'chr11', start: 400, end: 500 },
    ];
    const ops = planOps({ records, viewportBpRange: { start: 100, end: 600 } });
    expect(ops).toHaveLength(2);
    expect(ops[0].recordIndex).toBe(1);
    expect(ops[1].recordIndex).toBe(3);
  });
});

describe('computeAnnotationDrawOps — lane stacking for overlapping records', () => {
  it('places non-overlapping records in lane 0', () => {
    const records: AnnotationRecord[] = [
      { chrom: 'chr11', start: 0, end: 100 },
      { chrom: 'chr11', start: 200, end: 300 },
      { chrom: 'chr11', start: 400, end: 500 },
    ];
    const ops = planOps({ records, viewportBpRange: { start: 0, end: 1000 } });
    expect(ops.map((o) => o.y)).toEqual([0, 0, 0]);
  });

  it('stacks overlapping records into lanes 0, 1, 2 ...', () => {
    const records: AnnotationRecord[] = [
      { chrom: 'chr11', start: 100, end: 500 },
      { chrom: 'chr11', start: 200, end: 600 },
      { chrom: 'chr11', start: 300, end: 700 },
    ];
    const ops = planOps({ records, viewportBpRange: { start: 0, end: 1000 } });
    expect(ops).toHaveLength(3);
    expect(ops[0].y).toBe(0);
    expect(ops[1].y).toBe(LANE_HEIGHT);
    expect(ops[2].y).toBe(LANE_HEIGHT * 2);
  });

  it('drops records that exceed the maxLanes cap', () => {
    const records: AnnotationRecord[] = Array.from({ length: 6 }, (_, i) => ({
      chrom: 'chr11',
      start: 100 + i,
      end: 1000,
    }));
    const ops = planOps({
      records,
      viewportBpRange: { start: 0, end: 2000 },
      maxLanes: 4,
    });
    expect(ops).toHaveLength(4);
    expect(ops.map((o) => o.y)).toEqual([0, LANE_HEIGHT, LANE_HEIGHT * 2, LANE_HEIGHT * 3]);
  });

  it('clamps lane rows so a deeper lane never paints past the track bottom', () => {
    const records: AnnotationRecord[] = Array.from({ length: 4 }, (_, i) => ({
      chrom: 'chr11',
      start: 100 + i,
      end: 1000,
    }));
    const ops = planOps({
      records,
      viewportBpRange: { start: 0, end: 2000 },
      trackHeightPx: 16,
    });
    expect(ops).toHaveLength(4);
    for (const op of ops) {
      expect(op.y + op.height).toBeLessThanOrEqual(16);
    }
  });
});

describe('computeAnnotationDrawOps — color resolution', () => {
  it('uses record.color when present', () => {
    const records: AnnotationRecord[] = [{ chrom: 'chr11', start: 100, end: 200, color: 0xff0000 }];
    const ops = planOps({ records, viewportBpRange: { start: 0, end: 500 } });
    expect(ops[0].color).toBe(0xff0000);
  });

  it('falls back to the configured default color when record.color is undefined', () => {
    const records: AnnotationRecord[] = [{ chrom: 'chr11', start: 100, end: 200 }];
    const ops = planOps({ records, viewportBpRange: { start: 0, end: 500 } });
    expect(ops[0].color).toBe(DEFAULT_COLOR);
  });

  it('per-record color works independently of lane assignment', () => {
    const records: AnnotationRecord[] = [
      { chrom: 'chr11', start: 100, end: 500, color: 0x111111 },
      { chrom: 'chr11', start: 200, end: 600, color: 0x222222 },
      { chrom: 'chr11', start: 300, end: 700 },
    ];
    const ops = planOps({ records, viewportBpRange: { start: 0, end: 1000 } });
    expect(ops[0].color).toBe(0x111111);
    expect(ops[1].color).toBe(0x222222);
    expect(ops[2].color).toBe(DEFAULT_COLOR);
  });
});

describe('computeAnnotationDrawOps — bp→x projection', () => {
  it('uses the provided bpToX to project record start/end onto the canvas', () => {
    const records: AnnotationRecord[] = [{ chrom: 'chr11', start: 100, end: 200 }];
    const ops = planOps({
      records,
      viewportBpRange: { start: 0, end: 500 },
      bpToX: (bp) => bp * 2,
    });
    expect(ops[0].x).toBe(200);
    expect(ops[0].width).toBe(200);
  });
});

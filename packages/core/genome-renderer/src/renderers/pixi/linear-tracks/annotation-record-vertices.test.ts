import { describe, expect, it } from 'vitest';

import type { AnnotationRecord } from '@waypoint/genome-data';

import {
  advanceAnnotationRecordVerticesJob,
  beginAnnotationRecordVerticesJob,
  buildAnnotationRecordVertices,
  createAnnotationRecordVerticesPool,
  ensureVerticesPoolCapacity,
  finishAnnotationRecordVerticesJob,
  isAnnotationRecordVerticesJobComplete,
  type BuildVerticesConfig,
} from './annotation-record-vertices';

function rec(start: number, end: number, color?: number): AnnotationRecord {
  return { chrom: 'chr11', start, end, color };
}

const defaultConfig: BuildVerticesConfig = {
  laneHeightPx: 8,
  defaultColor: 0x3b82f6,
};

describe('time-bounded vertex preparation', () => {
  it('yields under expensive records and resumes to byte-identical complete geometry', () => {
    const records = Array.from({ length: 64 }, (_, index) =>
      rec(index * 200, index * 200 + 150, index % 2 ? 0xabcdef : undefined)
    );
    const lanes = Int32Array.from(records, (_, index) => (index % 7 === 0 ? -1 : index % 4));
    let clock = 0;
    const config: BuildVerticesConfig = {
      ...defaultConfig,
      includeRecord: (_record, index) => {
        clock += 0.5;
        return index % 5 !== 0;
      },
      colorForRecord: (_record, index) => (index % 3 ? 0x123456 : 0xff8800),
    };
    const expected = buildAnnotationRecordVertices(records, lanes, config);
    const job = beginAnnotationRecordVerticesJob(records, lanes, config);
    clock = 0;
    const options = { workBudgetMs: 2, now: () => clock };
    const consumed = advanceAnnotationRecordVerticesJob(job, records.length, options);

    expect(consumed).toBeGreaterThan(0);
    expect(consumed).toBeLessThan(records.length);
    expect(clock).toBeLessThanOrEqual(4);
    expect(job.recordCursor).toBe(consumed);
    expect(isAnnotationRecordVerticesJobComplete(job)).toBe(false);
    let iterations = 0;
    while (!isAnnotationRecordVerticesJobComplete(job) && iterations++ < records.length) {
      expect(advanceAnnotationRecordVerticesJob(job, records.length, options)).toBeGreaterThan(0);
    }

    expect(isAnnotationRecordVerticesJobComplete(job)).toBe(true);
    expect(finishAnnotationRecordVerticesJob(job)).toEqual(expected);
  });

  it('yields even when every expensive record is filtered out', () => {
    const records = Array.from({ length: 64 }, (_, index) => rec(index * 200, index * 200 + 150));
    let clock = 0;
    const job = beginAnnotationRecordVerticesJob(records, new Int32Array(records.length), {
      ...defaultConfig,
      includeRecord: () => {
        clock += 0.5;
        return false;
      },
    });
    clock = 0;
    const consumed = advanceAnnotationRecordVerticesJob(job, records.length, {
      workBudgetMs: 2,
      now: () => clock,
    });

    expect(consumed).toBeGreaterThan(0);
    expect(consumed).toBeLessThan(records.length);
    expect(clock).toBeLessThanOrEqual(4);
    expect(job.recordCursor).toBe(consumed);
    expect(job.vertexCursor).toBe(0);
    expect(isAnnotationRecordVerticesJobComplete(job)).toBe(false);
  });

  it('keeps an explicit record cap while time remains', () => {
    const records = Array.from({ length: 8 }, (_, index) => rec(index * 200, index * 200 + 150));
    const job = beginAnnotationRecordVerticesJob(
      records,
      new Int32Array(records.length),
      defaultConfig
    );

    expect(advanceAnnotationRecordVerticesJob(job, 2, { workBudgetMs: 2, now: () => 0 })).toBe(2);
    expect(job.recordCursor).toBe(2);
    expect(isAnnotationRecordVerticesJobComplete(job)).toBe(false);
  });
});

describe('buildAnnotationRecordVertices', () => {
  it('returns empty buffers for empty input', () => {
    const out = buildAnnotationRecordVertices([], new Int16Array(0), defaultConfig);
    expect(out.visibleRecordCount).toBe(0);
    expect(out.droppedRecordCount).toBe(0);
    expect(out.bpStartChunk.length).toBe(0);
    expect(out.color.length).toBe(0);
  });

  it('throws when records.length !== laneAssignment.length', () => {
    expect(() =>
      buildAnnotationRecordVertices([rec(0, 100)], new Int16Array(0), defaultConfig)
    ).toThrow(/laneAssignment/);
  });

  it('throws on zero laneHeightPx', () => {
    expect(() =>
      buildAnnotationRecordVertices([rec(0, 100)], new Int16Array([0]), {
        ...defaultConfig,
        laneHeightPx: 0,
      })
    ).toThrow(/laneHeightPx/);
  });

  it('emits 6 vertices per visible record', () => {
    const records = [rec(0, 100), rec(200, 300), rec(400, 500)];
    const out = buildAnnotationRecordVertices(records, new Int16Array([0, 0, 0]), defaultConfig);
    expect(out.visibleRecordCount).toBe(3);
    expect(out.bpStartChunk.length).toBe(3 * 6);
    expect(out.color.length).toBe(3 * 6 * 4);
  });

  it('skips dropped records and counts them separately', () => {
    const records = [rec(0, 100), rec(200, 300), rec(400, 500)];
    const out = buildAnnotationRecordVertices(records, new Int16Array([0, -1, 1]), defaultConfig);
    expect(out.visibleRecordCount).toBe(2);
    expect(out.droppedRecordCount).toBe(1);
    expect(out.bpStartChunk.length).toBe(2 * 6);
  });

  it('packs the same bp into all 6 vertices of a record', () => {
    const records = [rec(123_456, 789_012)];
    const out = buildAnnotationRecordVertices(records, new Int16Array([0]), defaultConfig);
    for (let v = 1; v < 6; v++) {
      expect(out.bpStartChunk[v]).toBe(out.bpStartChunk[0]);
      expect(out.bpStartDelta[v]).toBe(out.bpStartDelta[0]);
      expect(out.bpEndChunk[v]).toBe(out.bpEndChunk[0]);
      expect(out.bpEndDelta[v]).toBe(out.bpEndDelta[0]);
    }
    expect(out.xSide.slice(0, 6)).toEqual(new Float32Array([0, 1, 1, 0, 1, 0]));
    expect(out.ySide.slice(0, 6)).toEqual(new Float32Array([-1, -1, 1, -1, 1, 1]));
  });

  it('places lanes at the correct y offsets', () => {
    const records = [rec(0, 100), rec(200, 300)];
    const out = buildAnnotationRecordVertices(records, new Int16Array([0, 3]), {
      laneHeightPx: 8,
      defaultColor: 0,
    });
    expect(out.offsetCenter[0]).toBe(4);
    expect(out.offsetCenter[6]).toBe(28);
  });

  it('halfH equals (laneHeightPx - 1) / 2 for the 1-pixel lane gap', () => {
    const records = [rec(0, 100)];
    const out = buildAnnotationRecordVertices(records, new Int16Array([0]), {
      laneHeightPx: 8,
      defaultColor: 0,
    });
    expect(out.halfH[0]).toBe(3.5);
  });

  it('uses record.color when present', () => {
    const records = [rec(0, 100, 0xff0000)];
    const out = buildAnnotationRecordVertices(records, new Int16Array([0]), defaultConfig);
    expect(out.color[0]).toBe(1);
    expect(out.color[1]).toBe(0);
    expect(out.color[2]).toBe(0);
    expect(out.color[3]).toBe(1);
  });

  it('falls back to defaultColor when record.color is undefined', () => {
    const records = [rec(0, 100)];
    const out = buildAnnotationRecordVertices(records, new Int16Array([0]), {
      laneHeightPx: 8,
      defaultColor: 0xff8800,
    });
    expect(out.color[0]).toBeCloseTo(1, 2);
    expect(out.color[1]).toBeCloseTo(0x88 / 255, 2);
    expect(out.color[2]).toBe(0);
  });

  it('respects defaultAlpha override', () => {
    const records = [rec(0, 100)];
    const out = buildAnnotationRecordVertices(records, new Int16Array([0]), {
      laneHeightPx: 8,
      defaultColor: 0xff0000,
      defaultAlpha: 0.5,
    });
    expect(out.color[3]).toBe(0.5);
  });

  it('streams Int32 row assignments, clipping, and computed colors without copied records', () => {
    const records = [rec(0, 100), rec(200, 300), rec(400, 500)];
    const rows = new Int32Array([2, 4, -1]);
    const out = buildAnnotationRecordVertices(records, rows, {
      laneHeightPx: 8,
      defaultColor: 0,
      includeRecord: (record) => record.start >= 200,
      colorForRecord: (_record, index) => (index === 1 ? 0x3366cc : 0xff0000),
    });

    expect(out.visibleRecordCount).toBe(1);
    expect(out.droppedRecordCount).toBe(1);
    expect(out.offsetCenter[0]).toBe(36);
    expect(out.bpStartDelta[0]).toBe(200);
    expect(out.color[0]).toBeCloseTo(0x33 / 255, 5);
    expect(out.color[1]).toBeCloseTo(0x66 / 255, 5);
    expect(out.color[2]).toBeCloseTo(0xcc / 255, 5);
  });

  describe('pooled output  zero-allocation swap)', () => {
    const buildPooled = (
      records: readonly AnnotationRecord[],
      lanes: Int16Array,
      pool: ReturnType<typeof createAnnotationRecordVerticesPool>
    ) => {
      const job = beginAnnotationRecordVerticesJob(records, lanes, defaultConfig, { pool });
      advanceAnnotationRecordVerticesJob(job, Number.POSITIVE_INFINITY);
      return finishAnnotationRecordVerticesJob(job);
    };

    it('pooled output is BYTE-IDENTICAL to the non-pool build for the active prefix', () => {
      const records = [rec(0, 100, 0x3b82f6), rec(200, 300, 0xff0000), rec(400, 500)];
      const lanes = new Int16Array([0, 2, -1]);
      const ref = buildAnnotationRecordVertices(records, lanes, defaultConfig);
      const pool = createAnnotationRecordVerticesPool();
      const pooled = buildPooled(records, lanes, pool);
      expect(pooled.visibleRecordCount).toBe(ref.visibleRecordCount);
      expect(pooled.droppedRecordCount).toBe(ref.droppedRecordCount);
      expect(pooled.activeVertexCount).toBe(ref.bpStartChunk.length);
      const n = ref.bpStartChunk.length;
      for (const k of [
        'bpStartChunk',
        'bpStartDelta',
        'bpEndChunk',
        'bpEndDelta',
        'offsetCenter',
        'halfH',
        'xSide',
        'ySide',
      ] as const) {
        expect(pooled[k].subarray(0, n)).toEqual(ref[k]);
      }
      expect(pooled.color.subarray(0, n * 4)).toEqual(ref.color);
    });

    it('a SECOND build at ≤ capacity does NOT grow the pool (zero per-swap allocation)', () => {
      const pool = createAnnotationRecordVerticesPool();
      const big = Array.from({ length: 40 }, (_, i) => rec(i * 10, i * 10 + 5, 0x123456));
      const bigLanes = new Int16Array(big.map((_, i) => i % 8));
      buildPooled(big, bigLanes, pool);
      const capAfterCold = pool.capacityVertices;
      expect(capAfterCold).toBeGreaterThanOrEqual(40 * 6);
      const arraysAfterCold = pool.bpStartChunk;
      const small = Array.from({ length: 10 }, (_, i) => rec(i * 10, i * 10 + 5, 0x654321));
      const smallLanes = new Int16Array(small.map((_, i) => i % 4));
      const grewSmall = ensureVerticesPoolCapacity(pool, small.length * 6);
      expect(grewSmall).toBe(false);
      const out = buildPooled(small, smallLanes, pool);
      expect(pool.capacityVertices).toBe(capAfterCold);
      expect(pool.bpStartChunk).toBe(arraysAfterCold);
      expect(out.activeVertexCount).toBe(10 * 6);
      expect(ensureVerticesPoolCapacity(pool, 40 * 6)).toBe(false);
    });

    it('ensureVerticesPoolCapacity reports growth only when it must allocate', () => {
      const pool = createAnnotationRecordVerticesPool();
      expect(ensureVerticesPoolCapacity(pool, 60)).toBe(true);
      expect(ensureVerticesPoolCapacity(pool, 60)).toBe(false);
      expect(ensureVerticesPoolCapacity(pool, 30)).toBe(false);
      expect(ensureVerticesPoolCapacity(pool, pool.capacityVertices)).toBe(false);
      expect(ensureVerticesPoolCapacity(pool, pool.capacityVertices + 1)).toBe(true);
    });
  });

  it('handles a large retained annotation batch (114k records) with exact linear-size output', () => {
    const N = 114_579;
    const records: AnnotationRecord[] = [];
    const lanes: number[] = [];
    const FULL_ASSEMBLY_BP = 3_088_269_832;
    for (let i = 0; i < N; i++) {
      const start = Math.floor((FULL_ASSEMBLY_BP / N) * i);
      records.push(rec(start, start + 200, 0x3b82f6));
      lanes.push(i % 32);
    }
    const out = buildAnnotationRecordVertices(records, new Int16Array(lanes), defaultConfig);
    expect(out.visibleRecordCount).toBe(N);
    expect(out.activeVertexCount).toBe(N * 6);
    expect(out.bpStartChunk.length).toBe(N * 6);
    expect(out.color.length).toBe(N * 6 * 4);
  });
});

import { describe, it, expect } from 'vitest';
import { FeatureLaneIndex } from './feature-lane-index';

describe('feature lane overlap index', () => {
  it('projects a complete-genome overview without scanning every feature boundary', () => {
    const length = 4_641_652;
    const index = new FeatureLaneIndex(
      Array.from({ length: 5000 }, (_, i) => ({ start0: i * 920, end0: i * 920 + 600 }))
    );
    const internal = index as unknown as { positions: number[] };
    let boundaryReads = 0;
    internal.positions = new Proxy(internal.positions, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) boundaryReads++;
        return Reflect.get(target, property, receiver);
      },
    });
    for (const circular of [false, true]) {
      boundaryReads = 0;
      const cpr = 181_250;
      const offset = -37;
      const topBuffer = circular ? 26 : 0;
      const rows = circular ? 78 : 26;
      const runs = index.rowMaximumRuns(cpr, length, circular, offset, topBuffer, rows);

      expect(runs).toEqual([{ start: 0, end: rows, value: 1 }]);
      expect(boundaryReads).toBeLessThan(5000);
    }
  });

  it('represents a million rows by overlap changes without expanding every row', () => {
    const index = new FeatureLaneIndex([
      { start0: 5, end0: 210 },
      { start0: 80, end0: 160 },
      { start0: 9_999_980, end0: 10_000_000 },
    ]);
    const runs = index.rowMaximumRuns(10, 10_000_000, false, 0, 0, 1_000_000);
    expect(runs.length).toBeLessThan(12);
    expect(runs[0].start).toBe(0);
    expect(runs.at(-1)!.end).toBe(1_000_000);
    for (const row of [0, 7, 8, 15, 16, 20, 21, 50_000, 999_997, 999_998, 999_999]) {
      const run = runs.find((value) => value.start <= row && row < value.end)!;
      expect(run.value).toBe(index.query(row * 10, (row + 1) * 10));
    }
  });

  it('retains half-open ownership through circular copies in a sparse row plan', () => {
    const index = new FeatureLaneIndex([
      { start0: 0, end0: 5 },
      { start0: 5, end0: 11 },
      { start0: 8, end0: 20 },
      { start0: 19, end0: 31 },
    ]);
    for (const cpr of [1, 7, 31, 65])
      for (const offset of [-105, -1, 0, 30, 67]) {
        const runs = index.rowMaximumRuns(cpr, 31, true, offset, 2, 15);
        for (let row = 0; row < 15; row++) {
          const run = runs.find((value) => value.start <= row && row < value.end)!;
          const start = offset + (row - 2) * cpr;
          let expected = 0;
          for (let bp = start; bp < start + cpr; bp++) {
            const local = ((bp % 31) + 31) % 31;
            expected = Math.max(expected, index.query(local, local + 1));
          }
          expect(run.value, `${cpr}:${offset}:${row}`).toBe(expected);
        }
      }
  });

  it('lets adjacent features share a lane without inventing an overlap', () => {
    const index = new FeatureLaneIndex([
      { start0: 10, end0: 30 },
      { start0: 30, end0: 50 },
    ]);
    expect(index.query(0, 30)).toBe(1);
    expect(index.query(30, 60)).toBe(1);
    expect(index.query(20, 40)).toBe(1);
    expect(index.query(60, 70)).toBe(0);
  });
  it('matches an independent clipped sweep for every range in a varied fixture', () => {
    const intervals = Array.from({ length: 70 }, (_, i) => ({
      start0: (i * 17) % 173,
      end0: ((i * 17) % 173) + 5 + ((i * 11) % 47),
    }));
    const index = new FeatureLaneIndex(intervals);
    for (let start = 0; start < 230; start += 3)
      for (const width of [1, 7, 29, 80]) {
        const events = intervals
          .filter((i) => i.start0 < start + width && i.end0 > start)
          .flatMap((i) => [
            [Math.max(start, i.start0), 1],
            [Math.min(start + width, i.end0), -1],
          ]);
        events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
        let active = 0,
          max = 0;
        for (const [, delta] of events) {
          active += delta;
          max = Math.max(max, active);
        }
        expect(index.query(start, start + width)).toBe(max);
      }
  });

  it('fills complete linear and repeated circular row plans from sparse runs', () => {
    const index = new FeatureLaneIndex([
      { start0: 3, end0: 39 },
      { start0: 39, end0: 78 },
      { start0: 20, end0: 50 },
    ]);
    for (const circular of [true, false])
      for (const offset of [0, 7, 89])
        for (const cpr of [5, 17, 80]) {
          const values = index.rowMaximums(cpr, 100, circular, offset, 3, 20);
          values.forEach((value, row) => {
            const start = offset + (row - 3) * cpr;
            let expected = 0;
            if (circular) {
              for (let i = 0; i < cpr; i++)
                expected = Math.max(
                  expected,
                  index.query(
                    (((start + i) % 100) + 100) % 100,
                    ((((start + i) % 100) + 100) % 100) + 1
                  )
                );
              const lo = ((start % 100) + 100) % 100;
              expected =
                lo + cpr <= 100
                  ? index.query(lo, lo + cpr)
                  : Math.max(index.query(lo, 100), index.query(0, lo + cpr - 100));
            } else expected = index.query(start, start + cpr);
            expect(value, `${circular}:${offset}:${cpr}:${row}`).toBe(expected);
          });
        }
  });

  it('uses compact counts for ordinary tracks without truncating crowded lanes', () => {
    const ordinary = new FeatureLaneIndex([{ start0: 10, end0: 30 }]);
    expect(ordinary.rowMaximums(10, 100, false, 0, 0, 10)).toBeInstanceOf(Uint8Array);
    const crowded = new FeatureLaneIndex(
      Array.from({ length: 300 }, () => ({ start0: 10, end0: 30 }))
    );
    const counts = crowded.rowMaximums(10, 100, false, 0, 0, 10);
    expect(counts).toBeInstanceOf(Uint16Array);
    expect(counts[1]).toBe(300);
    expect(counts[2]).toBe(300);
  });

  it('sweeps circular origin and repeated cycles with exact boundary ownership', () => {
    const length = 31;
    const intervals = [
      { start0: 0, end0: 5 },
      { start0: 5, end0: 11 },
      { start0: 8, end0: 20 },
      { start0: 19, end0: 31 },
      { start0: 30, end0: 31 },
    ];
    const index = new FeatureLaneIndex(intervals);
    for (const offset of [-105, -1, 0, 30, 67])
      for (const cpr of [1, 7, 31, 65]) {
        const values = index.rowMaximums(cpr, length, true, offset, 2, 15);
        values.forEach((value, row) => {
          const start = offset + (row - 2) * cpr;
          let expected = 0;
          for (let bp = start; bp < start + cpr; bp++) {
            const at = ((bp % length) + length) % length;
            const lanes = intervals.filter((range) => range.start0 <= at && at < range.end0).length;
            expected = Math.max(expected, lanes);
          }
          expect(value, `${offset}:${cpr}:${row}`).toBe(expected);
        });
      }
  });
});

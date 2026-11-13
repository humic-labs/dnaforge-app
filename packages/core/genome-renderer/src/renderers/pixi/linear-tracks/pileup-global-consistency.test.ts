import { describe, expect, it } from 'vitest';

import type { PileupRecord } from '@waypoint/genome-data';

const READ_LEN = 150;
const BIG_BUDGET = 100_000;
const IS_CI = process.env.CI === 'true';

function makeReads(opts: {
  region: number;
  coverage: number;
  seed: number;
  gapEvery?: number;
  gapWidth?: number;
}): PileupRecord[] {
  let s = opts.seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const meanGap = READ_LEN / opts.coverage;
  const reads: PileupRecord[] = [];
  let pos = 0;
  let i = 0;
  while (pos < opts.region) {
    pos += Math.max(1, -Math.log(1 - rand()) * meanGap);
    if (
      opts.gapEvery &&
      Math.floor(pos / opts.gapEvery) !== Math.floor((pos - 1) / opts.gapEvery)
    ) {
      pos += opts.gapWidth ?? READ_LEN * 2;
    }
    const start = Math.round(pos);
    if (start + READ_LEN > opts.region) break;
    reads.push({
      chrom: 'synthetic-contig',
      start,
      end: start + READ_LEN,
      readId: `r${i++}`,
      strand: '+',
      mapq: 60,
    });
  }
  return reads;
}

function rowMap(reads: PileupRecord[]): Map<string, number> {
  const a = assignPileupRowsFromScratch(reads, BIG_BUDGET);
  const m = new Map<string, number>();
  reads.forEach((r, i) => {
    if (a.rows[i] >= 0) m.set(r.readId, a.rows[i]);
  });
  return m;
}

const visibleIn = (reads: PileupRecord[], w0: number, w1: number) =>
  reads.filter((r) => r.end > w0 && r.start < w1);

function assignPileupRowsFromScratch(
  records: ReadonlyArray<PileupRecord>,
  maxRows: number
): { rows: Int32Array } {
  const rows = new Int32Array(records.length).fill(-1);
  if (records.length === 0) return { rows };
  const order = Array.from({ length: records.length }, (_, i) => i).sort((a, b) => {
    const d = records[a].start - records[b].start;
    return d !== 0 ? d : records[a].end - records[b].end;
  });

  type RowEnd = { end: number; row: number };
  const heap: RowEnd[] = [];
  const less = (a: RowEnd, b: RowEnd): boolean =>
    a.end < b.end || (a.end === b.end && a.row < b.row);
  const swap = (i: number, j: number) => {
    const t = heap[i];
    heap[i] = heap[j];
    heap[j] = t;
  };
  const up = (i: number) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i], heap[p])) break;
      swap(i, p);
      i = p;
    }
  };
  const down = (i: number) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && less(heap[l], heap[m])) m = l;
      if (r < heap.length && less(heap[r], heap[m])) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  };
  const push = (entry: RowEnd) => {
    heap.push(entry);
    up(heap.length - 1);
  };
  const popMin = (): RowEnd => {
    const top = heap[0];
    const last = heap.pop() as RowEnd;
    if (heap.length > 0) {
      heap[0] = last;
      down(0);
    }
    return top;
  };

  let rowCount = 0;
  for (const idx of order) {
    const record = records[idx];
    if (heap.length > 0 && heap[0].end <= record.start) {
      const top = popMin();
      rows[idx] = top.row;
      push({ end: record.end, row: top.row });
    } else if (rowCount < maxRows) {
      const row = rowCount++;
      rows[idx] = row;
      push({ end: record.end, row });
    }
  }
  return { rows };
}

function collisions(reads: PileupRecord[], map: Map<string, number>): number {
  const byRow = new Map<number, PileupRecord[]>();
  for (const r of reads) {
    const row = map.get(r.readId);
    if (row == null) continue;
    (byRow.get(row) ?? byRow.set(row, []).get(row)!).push(r);
  }
  let bad = 0;
  for (const rs of byRow.values()) {
    rs.sort((a, b) => a.start - b.start);
    for (let i = 1; i < rs.length; i++) if (rs[i].start < rs[i - 1].end) bad++;
  }
  return bad;
}

type IV = [number, number, string];
class PersistentLayout {
  private placed = new Map<string, number>();
  private rows: { maxEnd: number; iv: IV[] }[] = [];

  private rowClear(r: number, s: number, e: number): boolean {
    const row = this.rows[r];
    if (s >= row.maxEnd) return true;
    let lo = 0,
      hi = row.iv.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (row.iv[m][0] < s) lo = m + 1;
      else hi = m;
    }
    if (lo < row.iv.length && row.iv[lo][0] < e) return false;
    if (lo > 0 && row.iv[lo - 1][1] > s) return false;
    return true;
  }

  place(readId: string, s: number, e: number, maxRows: number): number {
    const existing = this.placed.get(readId);
    if (existing != null) return existing;
    let r = 0;
    for (; r < this.rows.length; r++) if (this.rowClear(r, s, e)) break;
    if (r >= maxRows) return -1;
    if (r === this.rows.length) this.rows.push({ maxEnd: 0, iv: [] });
    const row = this.rows[r];
    if (s >= row.maxEnd) row.iv.push([s, e, readId]);
    else {
      let lo = 0,
        hi = row.iv.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (row.iv[m][0] < s) lo = m + 1;
        else hi = m;
      }
      row.iv.splice(lo, 0, [s, e, readId]);
    }
    if (e > row.maxEnd) row.maxEnd = e;
    this.placed.set(readId, r);
    return r;
  }

  gc(live: Set<string>): void {
    const dirty = new Set<number>();
    for (const [id, row] of this.placed)
      if (!live.has(id)) (this.placed.delete(id), dirty.add(row));
    for (const r of dirty) {
      const row = this.rows[r];
      row.iv = row.iv.filter((x) => this.placed.has(x[2]));
      row.maxEnd = row.iv.reduce((m, x) => (x[1] > m ? x[1] : m), 0);
    }
  }

  size(): number {
    return this.placed.size;
  }
  rowCount(): number {
    return this.rows.filter((r) => r.iv.length > 0).length;
  }
}

function runPersistentScrollScenario() {
  const region = 400_000;
  const coverage = 33;
  const reads = makeReads({ region, coverage, seed: 21 });
  const inRange = (lo: number, hi: number) => reads.filter((r) => r.end > lo && r.start < hi);

  const viewportBp = 10_000;
  const paddingBp = 10_000;
  const maxRows = 80;
  const steps: number[] = [];
  for (let w = 0; w <= 160_000; w += 5_000) steps.push(w);
  for (let w = 160_000; w >= 0; w -= 5_000) steps.push(w);

  const layout = new PersistentLayout();
  let persistPlaceMs = 0;
  let scratchPackMs = 0;
  let scratchMoves = 0;
  let persistMoves = 0;
  let maxLayoutSize = 0;
  let maxRowCount = 0;
  let collisionsTotal = 0;
  let prevScratch = new Map<string, number>();
  let prevPersist = new Map<string, number>();

  for (const w of steps) {
    const buf = inRange(w - paddingBp, w + viewportBp + paddingBp);
    const vis = inRange(w, w + viewportBp);
    const liveIds = new Set(
      inRange(w - 2 * paddingBp, w + viewportBp + 2 * paddingBp).map((r) => r.readId)
    );

    const curPersist = new Map<string, number>();
    const t0 = performance.now();
    for (const r of buf) {
      const row = layout.place(r.readId, r.start, r.end, maxRows);
      if (row >= 0) curPersist.set(r.readId, row);
    }
    layout.gc(liveIds);
    persistPlaceMs += performance.now() - t0;
    maxLayoutSize = Math.max(maxLayoutSize, layout.size());
    maxRowCount = Math.max(maxRowCount, layout.rowCount());
    collisionsTotal += collisions(vis, curPersist);
    for (const r of vis) {
      const previous = prevPersist.get(r.readId);
      const current = curPersist.get(r.readId);
      if (previous != null && current != null && previous !== current) persistMoves++;
    }
    prevPersist = curPersist;

    const t1 = performance.now();
    const scratch = assignPileupRowsFromScratch(buf, maxRows);
    scratchPackMs += performance.now() - t1;
    const curScratch = new Map<string, number>();
    buf.forEach((r, i) => {
      if (scratch.rows[i] >= 0) curScratch.set(r.readId, scratch.rows[i]);
    });
    for (const r of vis) {
      const previous = prevScratch.get(r.readId);
      const current = curScratch.get(r.readId);
      if (previous != null && current != null && previous !== current) scratchMoves++;
    }
    prevScratch = curScratch;
  }

  return {
    steps: steps.length,
    maxRows,
    persistPlaceMs,
    scratchPackMs,
    scratchMoves,
    persistMoves,
    maxLayoutSize,
    maxRowCount,
    collisionsTotal,
  };
}

function runDeepCoverageScenario() {
  const reads = makeReads({ region: 120_000, coverage: 200, seed: 5 });
  const inRange = (lo: number, hi: number) => reads.filter((r) => r.end > lo && r.start < hi);
  const viewportBp = 8_000;
  const paddingBp = 8_000;
  const maxRows = 300;
  const layout = new PersistentLayout();
  let elapsedMs = 0;
  let maxLayoutSize = 0;
  for (let w = 0; w <= 60_000; w += 4_000) {
    const buf = inRange(w - paddingBp, w + viewportBp + paddingBp);
    const t0 = performance.now();
    for (const r of buf) layout.place(r.readId, r.start, r.end, maxRows);
    layout.gc(
      new Set(inRange(w - 2 * paddingBp, w + viewportBp + 2 * paddingBp).map((r) => r.readId))
    );
    elapsedMs += performance.now() - t0;
    maxLayoutSize = Math.max(maxLayoutSize, layout.size());
  }
  return {
    elapsedMs,
    maxLayoutSize,
    rowCount: layout.rowCount(),
    maxRows,
    totalReads: reads.length,
  };
}

describe('pileup packing — DATA oracle (no screenshots)', () => {
  it('global greedy packing is collision-free', () => {
    const reads = makeReads({ region: 60_000, coverage: 33, seed: 7 });
    const g = rowMap(reads);
    expect(reads.length).toBeGreaterThan(10_000);
    expect(collisions(reads, g)).toBe(0);
  });

  it.skipIf(IS_CI)(
    'MEASURES how much left-context a window needs to reproduce the global packing (continuous coverage)',
    () => {
      const reads = makeReads({ region: 120_000, coverage: 33, seed: 11 });
      const g = rowMap(reads);
      const w0 = 60_000;
      const w1 = 70_000;
      const vis = visibleIn(reads, w0, w1);

      const rows: string[] = [];
      for (const margin of [0, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000]) {
        const win = reads.filter((r) => r.end > w0 - margin && r.start < w1);
        const p = rowMap(win);
        const match = vis.filter((r) => p.get(r.readId) === g.get(r.readId)).length;
        rows.push(
          `  left-margin ${String(margin).padStart(6)}bp: ${match}/${vis.length} visible reads match global (${((100 * match) / vis.length).toFixed(1)}%)`
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `\n[CONTINUOUS 33x, 10kb viewport, ${vis.length} visible reads]\n${rows.join('\n')}\n`
      );
    }
  );

  it.skipIf(IS_CI)(
    'CHARACTERIZES the lock-in left-context margin across coverage × viewport width',
    () => {
      const MARGINS = Array.from({ length: 41 }, (_, i) => i * 2_000);
      const lockIn = (coverage: number, vw: number, seed: number): number => {
        const reads = makeReads({ region: 200_000, coverage, seed });
        const g = rowMap(reads);
        const w0 = 100_000;
        const w1 = w0 + vw;
        const vis = visibleIn(reads, w0, w1);
        const pct = MARGINS.map((m) => {
          const win = reads.filter((r) => r.end > w0 - m && r.start < w1);
          const p = rowMap(win);
          const match = vis.filter((r) => p.get(r.readId) === g.get(r.readId)).length;
          return match === vis.length;
        });
        let lock = -1;
        for (let i = MARGINS.length - 1; i >= 0; i--) {
          if (!pct[i]) break;
          lock = i;
        }
        return lock < 0 ? -1 : MARGINS[lock];
      };
      const out: string[] = [];
      for (const cov of [15, 33, 60, 100]) {
        for (const vw of [5_000, 10_000, 20_000]) {
          const m = lockIn(cov, vw, 100 + cov + vw);
          out.push(
            `  coverage ${String(cov).padStart(3)}x, viewport ${String(vw / 1000).padStart(2)}kb → lock-in left-context = ${m < 0 ? '>80kb' : m / 1000 + 'kb'}`
          );
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `\n[LOCK-IN MARGIN — smallest left-context giving STABLE 100% global match]\n${out.join('\n')}\n`
      );
    }
  );

  it('JBrowse2-style persistent layout keeps reads stable, collision-free, and bounded', () => {
    const result = runPersistentScrollScenario();
    expect(result.persistMoves).toBe(0);
    expect(result.collisionsTotal).toBe(0);
    expect(result.scratchMoves).toBeGreaterThan(0);
    expect(result.maxRowCount).toBeLessThanOrEqual(result.maxRows);
  }, 30_000);

  it('JBrowse2-style at DEEP coverage (200x) keeps retained reads and rows bounded', () => {
    const result = runDeepCoverageScenario();
    expect(result.maxLayoutSize).toBeLessThan(result.totalReads);
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.rowCount).toBeLessThanOrEqual(result.maxRows);
  });

  it.skipIf(IS_CI)(
    'benchmark: persistent placement stays under 3 ms/window (isolated runs only)',
    () => {
      const result = runPersistentScrollScenario();
      expect(result.persistPlaceMs / result.steps).toBeLessThan(3);
      // eslint-disable-next-line no-console
      console.log(
        `\n[JBROWSE2-STYLE vs FROM-SCRATCH — ${result.steps} scroll windows, 33x, 10kb viewport]\n` +
          `  persistent=${result.persistPlaceMs.toFixed(1)}ms total  scratch=${result.scratchPackMs.toFixed(1)}ms total\n`
      );
    }
  );

  it.skipIf(IS_CI)(
    'benchmark: persistent placement stays bounded at 200x (isolated runs only)',
    () => {
      const result = runDeepCoverageScenario();
      expect(result.elapsedMs).toBeLessThan(500);
      // eslint-disable-next-line no-console
      console.log(
        `\n[JBROWSE2-STYLE @200x] place total=${result.elapsedMs.toFixed(1)}ms, maxLayoutReads=${result.maxLayoutSize}, finalRows=${result.rowCount}\n`
      );
    }
  );

  it.skipIf(IS_CI)(
    'MEASURES the same with periodic coverage gaps (gaps are exact sync points)',
    () => {
      const reads = makeReads({
        region: 120_000,
        coverage: 33,
        seed: 11,
        gapEvery: 5_000,
        gapWidth: 400,
      });
      const g = rowMap(reads);
      const w0 = 60_000;
      const w1 = 70_000;
      const vis = visibleIn(reads, w0, w1);

      const rows: string[] = [];
      for (const margin of [0, 250, 500, 1_000, 2_000, 5_000, 10_000, 20_000]) {
        const win = reads.filter((r) => r.end > w0 - margin && r.start < w1);
        const p = rowMap(win);
        const match = vis.filter((r) => p.get(r.readId) === g.get(r.readId)).length;
        rows.push(
          `  left-margin ${String(margin).padStart(6)}bp: ${match}/${vis.length} match global (${((100 * match) / vis.length).toFixed(1)}%)`
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `\n[GAPS every 5kb, 10kb viewport, ${vis.length} visible reads]\n${rows.join('\n')}\n`
      );
    }
  );
});

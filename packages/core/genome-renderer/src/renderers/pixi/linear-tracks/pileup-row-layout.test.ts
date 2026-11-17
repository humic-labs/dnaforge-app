import { describe, expect, it } from 'vitest';

import type { PileupRecord } from '@waypoint/genome-data';

import {
  PersistentRowLayout,
  pileupReadPlacementKey,
  type PileupRowLayout,
} from './pileup-row-layout';

const READ_LEN = 150;

function makeReads(region: number, coverage: number, seed: number): PileupRecord[] {
  let s = seed >>> 0;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff), s / 0x7fffffff);
  const mean = READ_LEN / coverage;
  const out: PileupRecord[] = [];
  let pos = 0;
  let i = 0;
  while (pos < region) {
    pos += Math.max(1, -Math.log(1 - rand()) * mean);
    const start = Math.round(pos);
    if (start + READ_LEN > region) break;
    out.push({
      chrom: 'chr1',
      start,
      end: start + READ_LEN,
      readId: `r${i++}`,
      strand: '+',
      mapq: 60,
    });
  }
  return out;
}

const inRange = (reads: PileupRecord[], lo: number, hi: number) =>
  reads.filter((r) => r.end > lo && r.start < hi);

function rowMapOf(
  layout: PileupRowLayout,
  records: PileupRecord[],
  maxRows: number
): Map<string, number> {
  const a = layout.assign(records, maxRows);
  const m = new Map<string, number>();
  records.forEach((r, i) => {
    if (a.rows[i] >= 0) m.set(r.readId, a.rows[i]);
  });
  return m;
}

function collisions(records: PileupRecord[], map: Map<string, number>): number {
  const byRow = new Map<number, PileupRecord[]>();
  for (const r of records) {
    const row = map.get(r.readId);
    if (row == null) continue;
    let bucket = byRow.get(row);
    if (!bucket) byRow.set(row, (bucket = []));
    bucket.push(r);
  }
  let bad = 0;
  for (const rs of byRow.values()) {
    rs.sort((a, b) => a.start - b.start);
    for (let i = 1; i < rs.length; i++) if (rs[i].start < rs[i - 1].end) bad++;
  }
  return bad;
}

describe('PersistentRowLayout (JBrowse2-style)', () => {
  it('keeps exact read inspection identities across reused and replaced immutable bands', () => {
    const first: PileupRecord = {
      chrom: 'chr1',
      start: 100,
      end: 250,
      readId: 'paired',
      strand: '+',
      mapq: 60,
      flag: 99,
      pair: { paired: true, readNumber: 1 },
    };
    const mate: PileupRecord = {
      ...first,
      start: 160,
      end: 310,
      strand: '-',
      flag: 147,
      pair: { paired: true, readNumber: 2 },
    };
    const exon: PileupRecord = { ...first, start: 500, end: 650 };
    const layout = new PersistentRowLayout();
    const initial = layout.assign([first, mate, exon], 8).readHitIndex;
    expect(initial.recordIndexFor({ ...first })).toBe(0);
    expect(initial.recordIndexFor({ ...mate })).toBe(1);
    expect(initial.recordIndexFor({ ...exon })).toBe(2);
    expect(initial.recordIndexFor({ ...first, chrom: 'chr2' })).toBeNull();
    expect(initial.recordIndexFor({ ...first, flag: 355 })).toBeNull();

    const replacedMate: PileupRecord = { ...mate, start: 800, end: 950 };
    const next = layout.assign([first, exon, replacedMate], 8).readHitIndex;
    expect(next.recordIndexFor({ ...first })).toBe(0);
    expect(next.recordIndexFor({ ...exon })).toBe(1);
    expect(next.recordIndexFor({ ...replacedMate })).toBe(2);
    expect(next.recordIndexFor({ ...mate })).toBeNull();
    expect(initial.recordIndexFor({ ...mate })).toBe(1);
  });

  it('produces a collision-free, tight layout over a window', () => {
    const reads = makeReads(40_000, 33, 1);
    const layout = new PersistentRowLayout();
    const map = rowMapOf(layout, reads, 200);
    expect(reads.length).toBeGreaterThan(5_000);
    expect(collisions(reads, map)).toBe(0);
    expect(Math.max(...map.values()) + 1).toBeLessThan(80);
  });

  it('a placed read NEVER moves across overlapping windows (in-region stability)', () => {
    const reads = makeReads(120_000, 33, 2);
    const layout = new PersistentRowLayout();
    const VW = 10_000;
    const PAD = 10_000;
    const prev = new Map<string, number>();
    let moves = 0;
    for (let w = 0; w <= 40_000; w += 5_000) {
      const buf = inRange(reads, w - PAD, w + VW + PAD);
      const map = rowMapOf(layout, buf, 200);
      layout.retain(buf);
      for (const r of inRange(reads, w, w + VW)) {
        const a = prev.get(r.readId);
        const b = map.get(r.readId);
        if (a != null && b != null && a !== b) moves++;
      }
      for (const [id, row] of map) prev.set(id, row);
    }
    expect(moves).toBe(0);
  });

  it('retain() evicts reads no longer present (bounded memory) and stays collision-free', () => {
    const reads = makeReads(200_000, 33, 3);
    const layout = new PersistentRowLayout();
    const VW = 8_000;
    const PAD = 8_000;
    let maxPlaced = 0;
    for (let w = 0; w <= 160_000; w += 8_000) {
      const buf = inRange(reads, w - PAD, w + VW + PAD);
      const map = rowMapOf(layout, buf, 200);
      layout.retain(inRange(reads, w - 2 * PAD, w + VW + 2 * PAD));
      expect(collisions(buf, map)).toBe(0);
      maxPlaced = Math.max(maxPlaced, buf.length);
    }
    expect(maxPlaced).toBeLessThan(reads.length);
  });

  it('overflow past maxRows is reported as hidden (never silently dropped)', () => {
    const reads = makeReads(20_000, 200, 4);
    const a = new PersistentRowLayout().assign(reads, 40);
    expect(a.hiddenReadCount).toBeGreaterThan(0);
    expect(a.rowCount).toBeLessThanOrEqual(40);
  });

  it('advances resumable assignment in bounded chunks and matches synchronous assignment', () => {
    const reads = makeReads(10_000, 33, 44);
    const cap = 17;
    const sync = new PersistentRowLayout().assign(reads, 120);
    const layout = new PersistentRowLayout();
    const job = layout.beginAssignment(reads, 120);

    let frames = 0;
    while (!job.complete) {
      const processed = layout.advanceAssignment(job, cap);
      expect(processed).toBeGreaterThan(0);
      expect(processed).toBeLessThanOrEqual(cap);
      frames++;
      expect(frames).toBeLessThan(10_000);
    }
    const chunked = layout.finishAssignment(job);

    expect(frames).toBeGreaterThan(1);
    expect([...chunked.rows]).toEqual([...sync.rows]);
    expect(chunked.rowCount).toBe(sync.rowCount);
    expect(chunked.hiddenReadCount).toBe(sync.hiddenReadCount);
  });

  it('yields assignment on elapsed work budget without changing the final layout', () => {
    const reads = makeReads(10_000, 33, 45);
    const sync = new PersistentRowLayout().assign(reads, 120);
    const layout = new PersistentRowLayout();
    const job = layout.beginAssignment(reads, 120, { coordinateOrdered: true });
    const first = layout.advanceAssignmentWithinBudget(
      job,
      reads.length,
      1,
      () => job.processedCount * 0.02
    );
    expect(first).toBeGreaterThanOrEqual(50);
    expect(first * 0.02).toBeLessThan(1.1);
    expect(job.complete).toBe(false);
    while (!job.complete) {
      layout.advanceAssignmentWithinBudget(job, reads.length, 1, () => 0);
    }
    expect([...layout.finishAssignment(job).rows]).toEqual([...sync.rows]);
  });

  it('accumulates record extents and read counts within resumable assignment work', () => {
    const records = makeReads(2_000, 20, 50).map((record, index) => ({
      ...record,
      strand: index % 3 === 0 ? '-' as const : '+' as const,
      ...(index % 2 === 0 ? { pair: { paired: true } } : {}),
    }));
    const layout = new PersistentRowLayout();
    const job = layout.beginAssignment(records, 4, { coordinateOrdered: true });
    layout.advanceAssignment(job, 16);
    expect(job.recordStats.forwardReadCount + job.recordStats.reverseReadCount).toBe(16);
    while (!job.complete) layout.advanceAssignment(job, 16);
    const result = layout.finishAssignment(job);

    expect(result.hiddenReadCount).toBeGreaterThan(0);
    expect(job.recordStats).toEqual({
      startBp: Math.min(...records.map((record) => record.start)),
      endBp: Math.max(...records.map((record) => record.end)),
      earliestEndBp: Math.min(...records.map((record) => record.end)),
      latestStartBp: Math.max(...records.map((record) => record.start)),
      forwardReadCount: records.filter((record) => record.strand === '+').length,
      reverseReadCount: records.filter((record) => record.strand === '-').length,
      pairedReadCount: records.filter((record) => record.pair?.paired).length,
    });
  });

  it('bounds interval searches while filling a dense retained window in coordinate order', () => {
    const depth = 80;
    const retained: PileupRecord[] = [];
    const added: PileupRecord[] = [];
    for (let block = 0; block < 120; block++) {
      for (let lane = 0; lane < depth; lane++) {
        const start = block * 200;
        retained.push({
          chrom: 'chr1',
          start,
          end: start + 100,
          readId: `retained-${block}-${lane}`,
          strand: '+',
          mapq: 60,
        });
        added.push({
          chrom: 'chr1',
          start: start + 100,
          end: start + 200,
          readId: `added-${block}-${lane}`,
          strand: '+',
          mapq: 60,
        });
      }
    }
    const layout = new PersistentRowLayout();
    const initial = layout.assign(retained, depth);
    let intervalReads = 0;
    const storedRows = Reflect.get(layout, 'rows') as Array<{ iv: unknown[] }>;
    for (const row of storedRows) {
      row.iv = new Proxy(row.iv, {
        get(target, property, receiver) {
          if (typeof property === 'string' && /^\d+$/.test(property)) intervalReads++;
          return Reflect.get(target, property, receiver);
        },
      });
    }
    const job = layout.beginAssignment(added, depth, { coordinateOrdered: true });
    while (!job.complete) layout.advanceAssignmentWithinBudget(job, 512, 0.75);
    const result = layout.finishAssignment(job);

    expect(result.hiddenReadCount).toBe(0);
    expect([...result.rows]).toEqual([...initial.rows]);
    expect(intervalReads).toBeLessThan(added.length * 200);
    expect([...layout.assign([...retained].reverse(), depth).rows]).toEqual(
      [...initial.rows].reverse()
    );
  });

  it('checks dense interval occupancy without hashing every conflicting read identity', () => {
    const reads = makeReads(80_000, 80, 47);
    const layout = new PersistentRowLayout();
    const placements = Reflect.get(layout, 'placed') as Map<string, unknown>;
    const has = placements.has.bind(placements);
    let membershipChecks = 0;
    placements.has = (key) => {
      membershipChecks++;
      return has(key);
    };

    const result = layout.assign(reads, 200);

    expect(result.hiddenReadCount).toBe(0);
    expect(collisions(reads, rowMapOf(layout, reads, 200))).toBe(0);
    expect(membershipChecks).toBeLessThan(reads.length * 2);
  });

  it('trusts the coordinate-order receipt without synchronously rescanning the input', () => {
    const reads = makeReads(1_000, 20, 46);
    const guarded = reads.map((record, index) =>
      index === 0
        ? record
        : new Proxy(record, {
            get(target, property, receiver) {
              if (property === 'start' || property === 'end') {
                throw new Error('coordinate order was synchronously rescanned');
              }
              return Reflect.get(target, property, receiver);
            },
          })
    );
    const job = new PersistentRowLayout().beginAssignment(guarded, 120, {
      coordinateOrdered: true,
    });
    expect(job.processedCount).toBe(0);
  });

  it('forks an independent working layout for an atomic renderer handoff', () => {
    const resident = new PersistentRowLayout();
    const oldReads: PileupRecord[] = [
      { chrom: 'chr1', start: 0, end: 100, readId: 'old-a', strand: '+', mapq: 60 },
      { chrom: 'chr1', start: 100, end: 200, readId: 'old-b', strand: '+', mapq: 60 },
    ];
    resident.assign(oldReads, 4);

    const working = resident.clone();
    const incoming: PileupRecord[] = [
      { chrom: 'chr1', start: 50, end: 150, readId: 'incoming', strand: '+', mapq: 60 },
    ];
    expect([...working.assign(incoming, 4).rows]).toEqual([1]);
    working.retain(incoming);

    expect(resident.retainedPlacementCount()).toBe(2);
    expect(resident.retainedIntervalCount()).toBe(2);
    expect([...resident.assign(incoming, 4).rows]).toEqual([1]);
  });

  it('does not mutate committed placements when a working assignment is abandoned', () => {
    const resident = new PersistentRowLayout();
    const committed = makeReads(2_000, 20, 48);
    resident.assign(committed, 80);
    const placedBefore = resident.retainedPlacementCount();
    const intervalsBefore = resident.retainedIntervalCount();
    const incoming = makeReads(2_000, 20, 49).map((record) => ({
      ...record,
      readId: `incoming-${record.readId}`,
    }));
    const working = resident.forkForAssignment();
    const job = working.beginAssignment(incoming, 80, { coordinateOrdered: true });

    working.advanceAssignment(job, 32);

    expect(job.complete).toBe(false);
    expect(working.retainedPlacementCount()).toBe(32);
    expect(resident.retainedPlacementCount()).toBe(placedBefore);
    expect(resident.retainedIntervalCount()).toBe(intervalsBefore);
  });

  it('appends an overlapping replacement band while preserving committed read rows', () => {
    const readForBlock = (start: number, end: number, readId: string): PileupRecord => ({
      chrom: 'chr1',
      start,
      end,
      readId,
      strand: '+',
      mapq: 60,
    });
    const retained: PileupRecord[] = [];
    const added: PileupRecord[] = [];
    for (let block = 0; block < 120; block++) {
      for (let lane = 0; lane < 80; lane++) {
        const start = block * 200;
        retained.push(readForBlock(start, start + 100, `retained-${block}-${lane}`));
        added.push(readForBlock(start + 100, start + 200, `added-${block}-${lane}`));
      }
    }
    const resident = new PersistentRowLayout();
    const initial = resident.assign(retained, 80);
    const initialRows = new Map(retained.map((record, index) => [record.readId, initial.rows[index]]));
    const incoming = [...retained, ...added]
      .filter((record) => record.start >= 10_000)
      .sort((left, right) => left.start - right.start || left.end - right.end);
    const working = resident.forkForAssignment();
    const job = working.beginAssignment(incoming, 80, { coordinateOrdered: true });
    working.advanceAssignment(job, 160);
    const rows = Reflect.get(working, 'rows') as Array<{ iv: unknown[] }>;
    for (const row of rows) {
      row.iv.splice = () => {
        throw new Error('coordinate-ordered replacement inserted into the middle of a row');
      };
    }
    while (!job.complete) working.advanceAssignmentWithinBudget(job, 512, 0.75);
    const result = working.finishAssignment(job);

    expect(result.hiddenReadCount).toBe(0);
    incoming.forEach((record, index) => {
      if (initialRows.has(record.readId)) {
        expect(result.rows[index]).toBe(initialRows.get(record.readId));
      }
    });
    expect(
      collisions(incoming, new Map(incoming.map((record, index) => [record.readId, result.rows[index]])))
    ).toBe(0);
    expect(working.retainedPlacementCount()).toBe(incoming.length);
    expect(working.retainedIntervalCount()).toBe(incoming.length);
    expect(resident.retainedPlacementCount()).toBe(retained.length);
  });

  it('reserves future baseline rows, reuses duplicate keys and respects a reduced row limit', () => {
    const resident = new PersistentRowLayout();
    const first: PileupRecord = {
      chrom: 'chr1', start: 100, end: 200, readId: 'first', strand: '+', mapq: 60,
    };
    const second = { ...first, readId: 'second' };
    resident.assign([first, second], 3);
    const early = { ...first, start: 50, end: 150, readId: 'early' };
    const working = resident.forkForAssignment();
    const assigned = working.assign([early, second, { ...second }], 3);

    expect([...assigned.rows]).toEqual([2, 1, 1]);
    expect(working.retainedPlacementCount()).toBe(2);
    expect(working.retainedIntervalCount()).toBe(2);
    expect(assigned.readHitIndex.hitRecordIndex([early, second, second], 1, 150)).toBe(2);

    const reduced = resident.forkForAssignment().assign([second], 1);
    expect([...reduced.rows]).toEqual([-1]);
    expect(reduced.hiddenReadCount).toBe(1);
    expect(resident.retainedPlacementCount()).toBe(2);
  });

  it('advances retain in bounded chunks and tombstoned intervals stop blocking rows before compaction', () => {
    const layout = new PersistentRowLayout();
    const oldReads: PileupRecord[] = [
      { chrom: 'chr1', start: 0, end: 100, readId: 'old-a', strand: '+', mapq: 60 },
      { chrom: 'chr1', start: 100, end: 200, readId: 'old-b', strand: '+', mapq: 60 },
    ];
    const replacement: PileupRecord[] = [
      { chrom: 'chr1', start: 0, end: 50, readId: 'replacement', strand: '+', mapq: 60 },
    ];
    expect([...layout.assign(oldReads, 1).rows]).toEqual([0, 0]);

    const retain = layout.beginRetain(replacement);
    expect(layout.advanceRetain(retain, replacement.length)).toBe(replacement.length);
    expect(retain.phase).toBe('scan-placed');
    expect(layout.advanceRetain(retain, 1)).toBe(1);

    const assignment = layout.assign(replacement, 1);
    expect([...assignment.rows]).toEqual([0]);
    expect(assignment.hiddenReadCount).toBe(0);

    let chunks = 2;
    while (!retain.complete) {
      expect(layout.advanceRetain(retain, 1)).toBeLessThanOrEqual(1);
      chunks++;
      expect(chunks).toBeLessThan(20);
    }
    expect(layout.retainedPlacementCount()).toBe(1);
    expect(layout.retainedIntervalCount()).toBe(1);
  });

  it('treats paired alignments with the same QNAME but different starts as distinct rows', () => {
    const reads: PileupRecord[] = [
      {
        chrom: 'chr1',
        start: 1_000,
        end: 1_150,
        readId: 'shared-template-qname',
        strand: '+',
        mapq: 60,
        pair: { paired: true, readNumber: 1 },
      },
      {
        chrom: 'chr1',
        start: 1_050,
        end: 1_200,
        readId: 'shared-template-qname',
        strand: '-',
        mapq: 60,
        pair: { paired: true, readNumber: 2 },
      },
    ];

    const assignment = new PersistentRowLayout().assign(reads, 40);

    expect([...assignment.rows]).toEqual([0, 1]);
    expect(assignment.rowCount).toBe(2);
    expect(assignment.hiddenReadCount).toBe(0);
  });

  it('uses a stable alignment-record key instead of bare QNAME', () => {
    const first: PileupRecord = {
      chrom: 'chr1',
      start: 1_000,
      end: 1_150,
      readId: 'shared-template-qname',
      strand: '+',
      mapq: 60,
      pair: { paired: true, readNumber: 1 },
    };
    const second: PileupRecord = {
      ...first,
      start: 1_050,
      end: 1_200,
      pair: { paired: true, readNumber: 2 },
    };

    expect(pileupReadPlacementKey(first)).not.toBe(pileupReadPlacementKey(second));
    expect(pileupReadPlacementKey(first)).toBe(pileupReadPlacementKey({ ...first }));
    expect(pileupReadPlacementKey(first)).not.toBe(
      pileupReadPlacementKey({ ...first, flag: 2048 })
    );
  });
});

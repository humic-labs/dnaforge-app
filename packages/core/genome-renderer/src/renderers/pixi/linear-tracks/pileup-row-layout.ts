import type { PileupRecord } from '@waypoint/genome-data';

export interface PileupRowAssignment {
  rows: Int32Array;
  rowCount: number;
  hiddenReadCount: number;
  readHitIndex: PileupReadHitIndex;
}

export interface PileupRowAssignmentJob {
  records: ReadonlyArray<PileupRecord>;
  maxRows: number;
  rows: Int32Array;
  rowCursors: number[];
  order: number[] | null;
  totalCount: number;
  processedCount: number;
  rowCount: number;
  hiddenReadCount: number;
  readHitRecordIndicesByRow: number[][];
  readHitRecordIndexByIdentity: Map<string, number>;
  complete: boolean;
}

export interface PileupRowRetainJob {
  activeRecords: ReadonlyArray<PileupRecord>;
  activeKeys: Set<string>;
  activeIndex: number;
  placedIterator: IterableIterator<[string, number]> | null;
  dirtyRows: Set<number>;
  dirtyRowIndices: number[] | null;
  dirtyRowIndex: number;
  phase: 'active-keys' | 'scan-placed' | 'compact-rows' | 'complete';
  complete: boolean;
}

export interface PileupRowLayout {
  assign(records: ReadonlyArray<PileupRecord>, maxRows: number): PileupRowAssignment;
  retain(activeRecords: ReadonlyArray<PileupRecord>): void;
  reset(): void;
}

const ROW_ASSIGNMENT_BUDGET_CHECK_RECORDS = 4;
const monotonicNow = (): number => performance.now();

const placementKeyByRecord = new WeakMap<PileupRecord, string>();
const interactionKeyByRecord = new WeakMap<PileupRecord, string>();

export function pileupReadPlacementKey(record: PileupRecord): string {
  const cached = placementKeyByRecord.get(record);
  if (cached !== undefined) return cached;
  const key =
    `${record.readId}\x00${record.start}\x00${record.end}\x00${record.strand}\x00` +
    `${record.flag ?? ''}\x00${record.pair?.readNumber ?? ''}\x00` +
    `${record.pair?.mateStart ?? ''}`;
  placementKeyByRecord.set(record, key);
  return key;
}

export function pileupReadInteractionKey(
  record: Pick<PileupRecord, 'readId' | 'chrom' | 'start' | 'flag' | 'pair'>
): string {
  return [
    record.readId,
    record.chrom,
    record.start,
    record.flag ?? '',
    record.pair?.readNumber ?? '',
  ].join('\x00');
}

function immutableReadInteractionKey(record: PileupRecord): string {
  const cached = interactionKeyByRecord.get(record);
  if (cached !== undefined) return cached;
  const key = pileupReadInteractionKey(record);
  interactionKeyByRecord.set(record, key);
  return key;
}

export class PileupReadHitIndex {
  constructor(
    private readonly recordIndicesByRow: ReadonlyArray<ReadonlyArray<number>>,
    private readonly recordIndexByIdentity: ReadonlyMap<string, number>
  ) {}

  hitRecordIndex(records: ReadonlyArray<PileupRecord>, row: number, bp: number): number | null {
    const indices = this.recordIndicesByRow[row];
    if (!indices || indices.length === 0) return null;
    let lo = 0;
    let hi = indices.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const record = records[indices[mid]];
      if (record && record.start <= bp) lo = mid + 1;
      else hi = mid;
    }
    const recordIndex = indices[lo - 1];
    if (recordIndex === undefined) return null;
    const record = records[recordIndex];
    return record && bp >= record.start && bp < record.end ? recordIndex : null;
  }

  recordIndexFor(
    read: Pick<PileupRecord, 'readId' | 'chrom' | 'start' | 'flag' | 'pair'>
  ): number | null {
    return this.recordIndexByIdentity.get(pileupReadInteractionKey(read)) ?? null;
  }
}

type IV = [start: number, end: number, id: string];

export class PersistentRowLayout implements PileupRowLayout {
  private placed = new Map<string, number>();
  private rows: { maxEnd: number; iv: IV[] }[] = [];

  private rowClear(r: number, s: number, e: number, cursors: number[]): boolean {
    const row = this.rows[r];
    if (s >= row.maxEnd) return true;
    let cursor = cursors[r] ?? 0;
    while (cursor < row.iv.length) {
      const interval = row.iv[cursor];
      if (interval[1] > s && this.placed.has(interval[2])) {
        cursors[r] = cursor;
        return interval[0] >= e;
      }
      cursor++;
    }
    cursors[r] = cursor;
    return true;
  }

  private place(key: string, s: number, e: number, maxRows: number, cursors: number[]): number {
    const existing = this.placed.get(key);
    if (existing != null) return existing;
    let r = 0;
    for (; r < this.rows.length; r++) if (this.rowClear(r, s, e, cursors)) break;
    if (r >= maxRows) return -1;
    if (r === this.rows.length) this.rows.push({ maxEnd: 0, iv: [] });
    const row = this.rows[r];
    if (s >= row.maxEnd) {
      cursors[r] = row.iv.length;
      row.iv.push([s, e, key]);
    } else {
      let lo = 0;
      let hi = row.iv.length;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (row.iv[m][0] < s) lo = m + 1;
        else hi = m;
      }
      row.iv.splice(lo, 0, [s, e, key]);
      cursors[r] = lo;
    }
    if (e > row.maxEnd) row.maxEnd = e;
    this.placed.set(key, r);
    return r;
  }

  assign(records: ReadonlyArray<PileupRecord>, maxRows: number): PileupRowAssignment {
    const job = this.beginAssignment(records, maxRows);
    while (!job.complete) this.advanceAssignment(job, Number.POSITIVE_INFINITY);
    return this.finishAssignment(job);
  }

  beginAssignment(
    records: ReadonlyArray<PileupRecord>,
    maxRows: number,
    { coordinateOrdered = false }: { coordinateOrdered?: boolean } = {}
  ): PileupRowAssignmentJob {
    const n = records.length;
    const rows = new Int32Array(n).fill(-1);
    let sorted = coordinateOrdered;
    if (!coordinateOrdered) {
      sorted = true;
      for (let i = 1; i < n; i++) {
        const prev = records[i - 1];
        const cur = records[i];
        if (prev.start > cur.start || (prev.start === cur.start && prev.end > cur.end)) {
          sorted = false;
          break;
        }
      }
    }
    const order = sorted
      ? null
      : Array.from({ length: n }, (_, i) => i).sort((a, b) =>
          records[a].start !== records[b].start
            ? records[a].start - records[b].start
            : records[a].end - records[b].end
        );
    return {
      records,
      maxRows,
      rows,
      rowCursors: [],
      order,
      totalCount: n,
      processedCount: 0,
      rowCount: 0,
      hiddenReadCount: 0,
      readHitRecordIndicesByRow: Array.from({ length: maxRows }, () => []),
      readHitRecordIndexByIdentity: new Map(),
      complete: n === 0,
    };
  }

  advanceAssignment(job: PileupRowAssignmentJob, maxRecords: number): number {
    if (job.complete) return 0;
    const limit = Math.min(job.totalCount, job.processedCount + Math.max(0, maxRecords));
    const startedAt = job.processedCount;
    for (let ordinal = job.processedCount; ordinal < limit; ordinal++) {
      const idx = job.order ? job.order[ordinal] : ordinal;
      const rec = job.records[idx];
      const key = pileupReadPlacementKey(rec);
      const row = this.place(key, rec.start, rec.end, job.maxRows, job.rowCursors);
      job.rows[idx] = row;
      if (row < 0) job.hiddenReadCount++;
      else {
        job.readHitRecordIndicesByRow[row].push(idx);
        job.readHitRecordIndexByIdentity.set(immutableReadInteractionKey(rec), idx);
        if (row + 1 > job.rowCount) job.rowCount = row + 1;
      }
    }
    job.processedCount = limit;
    job.complete = job.processedCount >= job.totalCount;
    return limit - startedAt;
  }

  advanceAssignmentWithinBudget(
    job: PileupRowAssignmentJob,
    maxRecords: number,
    budgetMs: number,
    now: () => number = monotonicNow
  ): number {
    if (job.complete || maxRecords <= 0) return 0;
    if (!(Number.isFinite(budgetMs) && budgetMs > 0)) {
      throw new TypeError('pileup row assignment budget must be finite and positive');
    }
    const startedAt = now();
    let processed = 0;
    while (!job.complete && processed < maxRecords) {
      const batchSize = Math.min(ROW_ASSIGNMENT_BUDGET_CHECK_RECORDS, maxRecords - processed);
      const advanced = this.advanceAssignment(job, batchSize);
      processed += advanced;
      if (advanced === 0 || now() - startedAt >= budgetMs) break;
    }
    return processed;
  }

  finishAssignment(job: PileupRowAssignmentJob): PileupRowAssignment {
    if (!job.complete) {
      throw new Error(
        `Cannot finish incomplete pileup row assignment: ${job.processedCount}/${job.totalCount}`
      );
    }
    return {
      rows: job.rows,
      rowCount: job.rowCount,
      hiddenReadCount: job.hiddenReadCount,
      readHitIndex: new PileupReadHitIndex(
        job.readHitRecordIndicesByRow,
        job.readHitRecordIndexByIdentity
      ),
    };
  }

  clone(): PersistentRowLayout {
    const copy = new PersistentRowLayout();
    copy.placed = new Map(this.placed);
    copy.rows = this.rows.map((row) => ({
      maxEnd: row.maxEnd,
      iv: row.iv.slice(),
    }));
    return copy;
  }

  retain(activeRecords: ReadonlyArray<PileupRecord>): void {
    const job = this.beginRetain(activeRecords);
    while (!job.complete) this.advanceRetain(job, Number.POSITIVE_INFINITY);
  }

  beginRetain(activeRecords: ReadonlyArray<PileupRecord>): PileupRowRetainJob {
    return {
      activeRecords,
      activeKeys: new Set(),
      activeIndex: 0,
      placedIterator: null,
      dirtyRows: new Set(),
      dirtyRowIndices: null,
      dirtyRowIndex: 0,
      phase: 'active-keys',
      complete: false,
    };
  }

  advanceRetain(job: PileupRowRetainJob, maxItems: number): number {
    if (job.complete) return 0;
    let remaining = Math.max(0, maxItems);
    let processed = 0;
    while (remaining > 0 && !job.complete) {
      if (job.phase === 'active-keys') {
        while (remaining > 0 && job.activeIndex < job.activeRecords.length) {
          job.activeKeys.add(pileupReadPlacementKey(job.activeRecords[job.activeIndex++]));
          remaining--;
          processed++;
        }
        if (job.activeIndex >= job.activeRecords.length) {
          job.placedIterator = this.placed[Symbol.iterator]();
          job.phase = 'scan-placed';
        }
      } else if (job.phase === 'scan-placed') {
        if (!job.placedIterator) job.placedIterator = this.placed[Symbol.iterator]();
        while (remaining > 0) {
          const next = job.placedIterator.next();
          if (next.done) {
            job.dirtyRowIndices = Array.from(job.dirtyRows);
            job.phase = 'compact-rows';
            break;
          }
          const [id, row] = next.value;
          if (!job.activeKeys.has(id)) {
            this.placed.delete(id);
            job.dirtyRows.add(row);
          }
          remaining--;
          processed++;
        }
      } else if (job.phase === 'compact-rows') {
        const rows = job.dirtyRowIndices ?? [];
        while (remaining > 0 && job.dirtyRowIndex < rows.length) {
          this.compactRow(rows[job.dirtyRowIndex++]);
          remaining--;
          processed++;
        }
        if (job.dirtyRowIndex >= rows.length) {
          job.phase = 'complete';
          job.complete = true;
        }
      } else {
        job.complete = true;
      }
    }
    return processed;
  }

  private compactRow(r: number): void {
    const row = this.rows[r];
    if (!row) return;
    row.iv = row.iv.filter((x) => this.placed.has(x[2]));
    row.maxEnd = row.iv.reduce((m, x) => (x[1] > m ? x[1] : m), 0);
  }

  retainedPlacementCount(): number {
    return this.placed.size;
  }

  retainedIntervalCount(): number {
    let count = 0;
    for (const row of this.rows) count += row.iv.length;
    return count;
  }

  reset(): void {
    this.placed.clear();
    this.rows = [];
  }
}

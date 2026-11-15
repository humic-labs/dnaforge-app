import type { PileupRecord } from '@waypoint/genome-data';

const TARGET_BIN_BP = 16;
const MAX_BINS = 32768;

export interface ReadRowHeightField {
  startBp: number;
  endBp: number;
  binSizeBp: number;
  bins: Uint16Array;
}

export interface ReadRowHeightFieldJob {
  readonly records: ReadonlyArray<PileupRecord> | null;
  readonly rows: Int32Array | null;
  readonly field: ReadRowHeightField | null;
  recordCursor: number;
  binCursor: number;
  binEnd: number;
  height: number;
  complete: boolean;
}

export function beginReadRowHeightFieldJob(
  records: ReadonlyArray<PileupRecord> | null,
  rows: Int32Array | null,
  startBp: number,
  endBp: number
): ReadRowHeightFieldJob {
  const valid =
    records !== null &&
    rows !== null &&
    records.length > 0 &&
    rows.length === records.length &&
    endBp > startBp;
  const span = endBp - startBp;
  const binCount = valid ? Math.min(MAX_BINS, Math.max(1, Math.ceil(span / TARGET_BIN_BP))) : 0;
  return {
    records,
    rows,
    field: valid
      ? { startBp, endBp, binSizeBp: span / binCount, bins: new Uint16Array(binCount) }
      : null,
    recordCursor: 0,
    binCursor: 0,
    binEnd: 0,
    height: 0,
    complete: !valid,
  };
}

export function advanceReadRowHeightFieldJob(
  job: ReadRowHeightFieldJob,
  maxItems: number,
  options?: { workBudgetMs?: number; now?: () => number }
): number {
  if (job.complete || maxItems <= 0) return 0;
  const workBudgetMs = options?.workBudgetMs;
  if (workBudgetMs !== undefined && (!Number.isFinite(workBudgetMs) || workBudgetMs <= 0)) {
    throw new TypeError('read row height work budget must be finite and positive');
  }
  const now = options?.now ?? monotonicNow;
  const startedAt = workBudgetMs === undefined ? 0 : now();
  const { records, rows, field } = job;
  if (records === null || rows === null || field === null) return 0;
  const { startBp, endBp, binSizeBp, bins } = field;
  let consumed = 0;
  while (!job.complete && consumed < maxItems) {
    if (
      consumed > 0 &&
      workBudgetMs !== undefined &&
      (job.binCursor >= job.binEnd || consumed % 32 === 0) &&
      now() - startedAt >= workBudgetMs
    )
      break;
    consumed += 1;
    if (job.binCursor < job.binEnd) {
      const bin = job.binCursor++;
      if (job.height > bins[bin]) bins[bin] = job.height;
      if (job.binCursor === job.binEnd) job.recordCursor += 1;
    } else {
      const row = rows[job.recordCursor];
      if (row < 0) {
        job.recordCursor += 1;
      } else {
        const record = records[job.recordCursor];
        const start = Math.max(record.start, startBp);
        const end = Math.min(record.end, endBp);
        if (end <= start) {
          job.recordCursor += 1;
        } else {
          job.binCursor = Math.max(
            0,
            Math.min(bins.length - 1, Math.floor((start - startBp) / binSizeBp))
          );
          job.binEnd = Math.max(
            job.binCursor + 1,
            Math.min(bins.length, Math.ceil((end - startBp) / binSizeBp))
          );
          job.height = Math.min(65535, row + 1);
        }
      }
    }
    job.complete = job.recordCursor >= records.length;
  }
  return consumed;
}

export function isReadRowHeightFieldJobComplete(job: ReadRowHeightFieldJob): boolean {
  return job.complete;
}

export function finishReadRowHeightFieldJob(job: ReadRowHeightFieldJob): ReadRowHeightField | null {
  if (!job.complete) throw new Error('Cannot finish incomplete read row height field');
  return job.field;
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

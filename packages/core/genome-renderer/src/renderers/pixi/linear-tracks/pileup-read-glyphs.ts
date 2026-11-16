import type { PileupMismatch, PileupRecord } from '@waypoint/genome-data';

import type { WebGLThemeMode } from '../shared/theme';

export interface PileupReadDifferenceMark {
  readonly bp: number;
  readonly length: number;
  readonly row: number;
  readonly recordIndex: number;
  readonly event: PileupMismatch;
}

export interface PileupReadDifferenceMarksInput {
  readonly records: ReadonlyArray<PileupRecord>;
  readonly rows: Int32Array;
  readonly viewportStartBp?: number;
  readonly viewportEndBp?: number;
}

export interface PileupReadDifferenceMarksJob {
  readonly records: ReadonlyArray<PileupRecord>;
  readonly rows: Int32Array;
  readonly viewportStartBp: number;
  readonly viewportEndBp: number;
  readonly marks: PileupReadDifferenceMark[];
  readonly rowMarkIndices: Map<number, number[]>;
  recordCursor: number;
  eventCursor: number;
  complete: boolean;
}

export interface PileupReadDifferenceMarksJobOptions {
  readonly workBudgetMs?: number;
  readonly now?: () => number;
  readonly onMark?: (mark: PileupReadDifferenceMark, index: number) => void;
}

const WORK_BUDGET_CHECK_ITEMS = 4;
const monotonicNow = (): number => performance.now();

export function beginPileupReadDifferenceMarksJob(
  input: PileupReadDifferenceMarksInput
): PileupReadDifferenceMarksJob {
  return {
    records: input.records,
    rows: input.rows,
    viewportStartBp: input.viewportStartBp ?? Number.NEGATIVE_INFINITY,
    viewportEndBp: input.viewportEndBp ?? Number.POSITIVE_INFINITY,
    marks: [],
    rowMarkIndices: new Map(),
    recordCursor: 0,
    eventCursor: 0,
    complete: input.records.length === 0 || input.rows.length !== input.records.length,
  };
}

export function advancePileupReadDifferenceMarksJob(
  job: PileupReadDifferenceMarksJob,
  maxItems: number,
  options?: PileupReadDifferenceMarksJobOptions
): number {
  const workBudgetMs = options?.workBudgetMs;
  if (workBudgetMs !== undefined && (!Number.isFinite(workBudgetMs) || workBudgetMs <= 0)) {
    throw new TypeError('pileup read-difference work budget must be finite and positive');
  }
  if (job.complete || maxItems <= 0) return 0;
  const limit = Math.max(0, Math.floor(maxItems));
  const now = options?.now ?? monotonicNow;
  const startedAt = workBudgetMs === undefined ? 0 : now();
  let consumed = 0;

  while (!job.complete && consumed < limit) {
    if (
      workBudgetMs !== undefined &&
      consumed > 0 &&
      consumed % WORK_BUDGET_CHECK_ITEMS === 0 &&
      now() - startedAt >= workBudgetMs
    ) {
      break;
    }
    const recordIndex = job.recordCursor;
    const record = job.records[recordIndex]!;
    const row = job.rows[recordIndex]!;
    const outside = record.end <= job.viewportStartBp || record.start >= job.viewportEndBp;
    const events = row < 0 || outside ? undefined : record.mismatches;

    if (!events || events.length === 0) {
      job.recordCursor += 1;
      job.eventCursor = 0;
    } else {
      const event = events[job.eventCursor]!;
      const length = Math.max(1, event.length ?? 1);
      const eventEnd = event.kind === 'del' ? event.pos + length : event.pos + 1;
      if (!(eventEnd <= job.viewportStartBp || event.pos >= job.viewportEndBp)) {
        const mark: PileupReadDifferenceMark = {
          bp: event.pos,
          length,
          row,
          recordIndex,
          event,
        };
        const markIndex = job.marks.length;
        options?.onMark?.(mark, markIndex);
        job.marks.push(mark);
        let indices = job.rowMarkIndices.get(row);
        if (!indices) {
          indices = [];
          job.rowMarkIndices.set(row, indices);
        }
        indices.push(markIndex);
      }
      job.eventCursor += 1;
      if (job.eventCursor >= events.length) {
        job.recordCursor += 1;
        job.eventCursor = 0;
      }
    }
    consumed += 1;
    job.complete = job.recordCursor >= job.records.length;
  }

  return consumed;
}

export function isPileupReadDifferenceMarksJobComplete(job: PileupReadDifferenceMarksJob): boolean {
  return job.complete;
}

export function finishPileupReadDifferenceMarksJob(
  job: PileupReadDifferenceMarksJob
): PileupReadDifferenceMark[] {
  if (!job.complete) throw new Error('Cannot finish incomplete pileup read-difference marks');
  return job.marks;
}

export function buildPileupReadDifferenceMarks(
  input: PileupReadDifferenceMarksInput
): PileupReadDifferenceMark[] {
  const job = beginPileupReadDifferenceMarksJob(input);
  advancePileupReadDifferenceMarksJob(job, Number.POSITIVE_INFINITY);
  return finishPileupReadDifferenceMarksJob(job);
}

export const PILEUP_DIFFERENCE_COLOR_BY_THEME = {
  light: [224 / 255, 68 / 255, 25 / 255],
  dark: [1, 107 / 255, 92 / 255],
} as const;

export function pileupDifferenceColor(theme: WebGLThemeMode): readonly [number, number, number] {
  return PILEUP_DIFFERENCE_COLOR_BY_THEME[theme];
}

import type { PileupRecord } from '@waypoint/genome-data';

export interface ReadVisibleMembershipJob {
  readonly candidate: ReadonlyArray<PileupRecord>;
  readonly incoming: ReadonlyArray<PileupRecord>;
  readonly candidateRows: Int32Array | null;
  readonly startBp: number;
  readonly endBp: number;
  candidateCursor: number;
  incomingCursor: number;
  candidateNext: PileupRecord | null;
  incomingNext: PileupRecord | null;
  candidateDone: boolean;
  incomingDone: boolean;
  complete: boolean;
  equivalent: boolean;
}

export function beginReadVisibleMembershipJob(
  candidate: ReadonlyArray<PileupRecord>,
  incoming: ReadonlyArray<PileupRecord>,
  startBp: number,
  endBp: number,
  candidateRows: Int32Array | null = null
): ReadVisibleMembershipJob {
  const valid =
    Number.isFinite(startBp) &&
    Number.isFinite(endBp) &&
    endBp > startBp &&
    (candidateRows === null || candidateRows.length === candidate.length);
  return {
    candidate,
    incoming,
    candidateRows,
    startBp,
    endBp,
    candidateCursor: 0,
    incomingCursor: 0,
    candidateNext: null,
    incomingNext: null,
    candidateDone: false,
    incomingDone: false,
    complete: !valid || (candidate === incoming && candidateRows === null),
    equivalent: valid && candidate === incoming && candidateRows === null,
  };
}

export function advanceReadVisibleMembershipJob(
  job: ReadVisibleMembershipJob,
  maxItems: number,
  options?: { workBudgetMs?: number; now?: () => number }
): number {
  if (job.complete || maxItems <= 0) return 0;
  const workBudgetMs = options?.workBudgetMs;
  if (workBudgetMs !== undefined && (!Number.isFinite(workBudgetMs) || workBudgetMs <= 0)) {
    throw new TypeError('visible read membership work budget must be finite and positive');
  }
  const now = options?.now ?? monotonicNow;
  const startedAt = workBudgetMs === undefined ? 0 : now();
  let consumed = 0;
  let budgetCheckedItems = 0;
  while (!job.complete && consumed < maxItems) {
    if (workBudgetMs !== undefined && consumed - budgetCheckedItems >= 4) {
      budgetCheckedItems = consumed;
      if (now() - startedAt >= workBudgetMs) break;
    }
    if (job.candidateNext === null && !job.candidateDone) {
      if (job.candidateCursor < job.candidate.length) {
        const index = job.candidateCursor++;
        const record = job.candidate[index];
        if (record.end > job.startBp && record.start < job.endBp) {
          if (job.candidateRows !== null && job.candidateRows[index] < 0) {
            job.complete = true;
            job.equivalent = false;
          } else job.candidateNext = record;
        }
        consumed += 1;
        continue;
      }
      job.candidateDone = true;
    }
    if (job.incomingNext === null && !job.incomingDone) {
      if (job.incomingCursor < job.incoming.length) {
        const record = job.incoming[job.incomingCursor++];
        if (record.end > job.startBp && record.start < job.endBp) job.incomingNext = record;
        consumed += 1;
        continue;
      }
      job.incomingDone = true;
    }
    if (job.candidateNext === null || job.incomingNext === null) {
      job.complete = true;
      job.equivalent = job.candidateNext === null && job.incomingNext === null;
    } else if (job.candidateNext !== job.incomingNext) {
      job.complete = true;
      job.equivalent = false;
    } else {
      job.candidateNext = null;
      job.incomingNext = null;
    }
  }
  return consumed;
}

export function isReadVisibleMembershipJobComplete(job: ReadVisibleMembershipJob): boolean {
  return job.complete;
}

export function finishReadVisibleMembershipJob(job: ReadVisibleMembershipJob): boolean {
  if (!job.complete) throw new Error('Cannot finish incomplete visible read membership');
  return job.equivalent;
}

function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

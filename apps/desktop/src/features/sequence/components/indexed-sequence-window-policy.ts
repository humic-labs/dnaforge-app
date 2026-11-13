export type SequenceViewportRange = { start: number; end: number };
export type SequenceWindowCoverage = { startBp: number; endBp: number };
export type SequenceWindowPending = SequenceWindowCoverage & { token: number; requestId?: string };

export const SEQUENCE_WINDOW_TARGET_BP = 128 * 1024;
export const SEQUENCE_WINDOW_PAD_BP = 64 * 1024;
export const SEQUENCE_WINDOW_REFETCH_GUARD_BP = 32 * 1024;

export const SEQUENCE_RENDER_MIN_PIXELS_PER_BP = 0.2;
export const SEQUENCE_STREAM_MIN_PIXELS_PER_BP = 0.025;

export type SequenceWindowPolicyInput = {
  reportedCenterBp: number;
  handleCenterBp?: number | null;
  viewportRange?: SequenceViewportRange | null;
  length: number;
  containerWidth: number;
  loadedCoverage?: SequenceWindowCoverage | null;
  pendingCoverage?: SequenceWindowPending | null;
};

type SequenceWindowPolicyBase = {
  centerBp: number;
  viewportRange: SequenceViewportRange | null;
  requiredStart: number;
  requiredEnd: number;
  visibleBp: number | null;
  pixelsPerBp: number | null;
};

export type SequenceWindowPolicyDecision =
  | (SequenceWindowPolicyBase & { kind: 'skip-lod'; threshold: number })
  | (SequenceWindowPolicyBase & {
      kind: 'loaded-coverage';
      coverage: SequenceWindowCoverage;
    })
  | (SequenceWindowPolicyBase & {
      kind: 'pending-coverage';
      pending: SequenceWindowPending;
    })
  | (SequenceWindowPolicyBase & {
      kind: 'request';
      request: SequenceWindowCoverage;
    });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function clampSequenceBp(value: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), value));
}

export function normalizeSequenceViewportRange(
  range: SequenceViewportRange | null | undefined,
  length: number
): SequenceViewportRange | null {
  if (!range || !isFiniteNumber(range.start) || !isFiniteNumber(range.end)) return null;
  const start = Math.max(0, Math.min(length, Math.min(range.start, range.end)));
  const end = Math.max(start, Math.min(length, Math.max(range.start, range.end)));
  return end > start ? { start, end } : null;
}

export function sequenceWindowRequestBounds(input: {
  centerBp: number;
  viewportRange: SequenceViewportRange | null;
  length: number;
}): SequenceWindowCoverage {
  const visibleBp = input.viewportRange
    ? Math.max(1, input.viewportRange.end - input.viewportRange.start)
    : 1;
  const targetWindowBp = Math.min(
    input.length,
    Math.max(SEQUENCE_WINDOW_TARGET_BP, Math.ceil(visibleBp))
  );
  const totalWindowBp = Math.min(input.length, targetWindowBp + SEQUENCE_WINDOW_PAD_BP * 2);
  const maxStart = Math.max(0, input.length - totalWindowBp);
  const startBp = Math.max(0, Math.min(maxStart, Math.floor(input.centerBp - totalWindowBp / 2)));
  return { startBp, endBp: Math.min(input.length, startBp + totalWindowBp) };
}

export function viewportCoverageSatisfiesGuard(input: {
  coverage: { startBp: number; endBp: number } | null | undefined;
  viewportStart: number;
  viewportEnd: number;
  guardBp: number;
  domainStart?: number;
  domainEnd?: number;
}): boolean {
  const coverage = input.coverage;
  if (!coverage) return false;
  const domainStart = input.domainStart ?? Number.NEGATIVE_INFINITY;
  const domainEnd = input.domainEnd ?? Number.POSITIVE_INFINITY;
  const guardedStart = Math.max(domainStart, input.viewportStart - input.guardBp);
  const guardedEnd = Math.min(domainEnd, input.viewportEnd + input.guardBp);
  return coverage.startBp <= guardedStart && coverage.endBp >= guardedEnd;
}

function coverageContainsRequiredRange(
  coverage: SequenceWindowCoverage,
  requiredStart: number,
  requiredEnd: number,
  length: number
): boolean {
  return viewportCoverageSatisfiesGuard({
    coverage,
    viewportStart: requiredStart,
    viewportEnd: requiredEnd,
    guardBp: SEQUENCE_WINDOW_REFETCH_GUARD_BP,
    domainStart: 0,
    domainEnd: length,
  });
}

export function decideSequenceWindowPolicy(
  input: SequenceWindowPolicyInput
): SequenceWindowPolicyDecision {
  const viewportRange = normalizeSequenceViewportRange(input.viewportRange, input.length);
  const centerBp = clampSequenceBp(
    viewportRange
      ? (viewportRange.start + viewportRange.end) / 2
      : isFiniteNumber(input.handleCenterBp)
        ? input.handleCenterBp
        : input.reportedCenterBp,
    input.length
  );
  const requiredStart = viewportRange?.start ?? centerBp;
  const requiredEnd = viewportRange?.end ?? centerBp;
  const visibleBp = viewportRange ? viewportRange.end - viewportRange.start : null;
  const pixelsPerBp =
    visibleBp && visibleBp > 0 && input.containerWidth > 0
      ? input.containerWidth / visibleBp
      : null;
  const base = {
    centerBp,
    viewportRange,
    requiredStart,
    requiredEnd,
    visibleBp,
    pixelsPerBp,
  };

  if (pixelsPerBp != null && pixelsPerBp < SEQUENCE_STREAM_MIN_PIXELS_PER_BP) {
    return { ...base, kind: 'skip-lod', threshold: SEQUENCE_STREAM_MIN_PIXELS_PER_BP };
  }

  if (
    input.loadedCoverage &&
    coverageContainsRequiredRange(input.loadedCoverage, requiredStart, requiredEnd, input.length)
  ) {
    return { ...base, kind: 'loaded-coverage', coverage: input.loadedCoverage };
  }

  if (
    input.pendingCoverage &&
    coverageContainsRequiredRange(input.pendingCoverage, requiredStart, requiredEnd, input.length)
  ) {
    return { ...base, kind: 'pending-coverage', pending: input.pendingCoverage };
  }

  return {
    ...base,
    kind: 'request',
    request: sequenceWindowRequestBounds({ centerBp, viewportRange, length: input.length }),
  };
}

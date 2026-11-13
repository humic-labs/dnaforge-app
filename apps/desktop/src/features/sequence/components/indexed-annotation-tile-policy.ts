import {
  GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
  GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
} from '../../../shared/indexed-genome';
import { viewportCoverageSatisfiesGuard } from './indexed-sequence-window-policy';

export type AnnotationViewportRange = { start: number; end: number };
export type AnnotationTileCoverage = { startBp: number; endBp: number };
export type AnnotationTilePending = AnnotationTileCoverage & { token: number; requestId?: string };

export const ANNOTATION_VIEWPORT_TILE_MAX_BP = Math.min(
  GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
  512 * 1024
);
export const ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP = Math.min(
  GENOME_ANNOTATION_VIEWPORT_TILE_MAX_BP,
  2 * 1024 * 1024
);
export const ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET = GENOME_ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET;
export const ANNOTATION_VIEWPORT_TILE_TARGET_BP = 16 * 1024;
export const ANNOTATION_VIEWPORT_TILE_PAD_BP = 8 * 1024;
export const ANNOTATION_VIEWPORT_TILE_REFETCH_GUARD_BP = 4 * 1024;

export type AnnotationViewportTilePolicyInput = {
  reportedCenterBp: number;
  handleCenterBp?: number | null;
  viewportRange?: AnnotationViewportRange | null;
  length: number;
  containerWidth: number;
  loadedCoverage?: AnnotationTileCoverage | null;
  loadedCoverages?: ReadonlyArray<AnnotationTileCoverage> | null;
  pendingCoverage?: AnnotationTilePending | null;
};

type AnnotationViewportTilePolicyBase = {
  centerBp: number;
  viewportRange: AnnotationViewportRange | null;
  requiredStart: number;
  requiredEnd: number;
  visibleBp: number | null;
  pixelsPerBp: number | null;
};

export type AnnotationViewportTilePolicyDecision =
  | (AnnotationViewportTilePolicyBase & {
      kind: 'skip-wide';
      maxVisibleBp: number;
    })
  | (AnnotationViewportTilePolicyBase & {
      kind: 'loaded-coverage';
      coverage: AnnotationTileCoverage;
    })
  | (AnnotationViewportTilePolicyBase & {
      kind: 'pending-coverage';
      pending: AnnotationTilePending;
    })
  | (AnnotationViewportTilePolicyBase & {
      kind: 'request';
      request: AnnotationTileCoverage;
    });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampAnnotationBp(value: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), value));
}

export function normalizeAnnotationViewportRange(
  range: AnnotationViewportRange | null | undefined,
  length: number
): AnnotationViewportRange | null {
  if (!range || !isFiniteNumber(range.start) || !isFiniteNumber(range.end)) return null;
  const start = Math.max(0, Math.min(length, Math.min(range.start, range.end)));
  const end = Math.max(start, Math.min(length, Math.max(range.start, range.end)));
  return end > start ? { start, end } : null;
}

export function annotationViewportTileRequestBounds(input: {
  centerBp: number;
  viewportRange: AnnotationViewportRange | null;
  length: number;
}): AnnotationTileCoverage {
  const visibleBp = input.viewportRange
    ? Math.max(1, input.viewportRange.end - input.viewportRange.start)
    : 1;
  const guardedVisibleSpan = Math.max(
    Math.ceil(visibleBp) + ANNOTATION_VIEWPORT_TILE_PAD_BP * 2,
    Math.ceil(visibleBp) * 4
  );
  const requestedSpan = Math.min(
    input.length,
    ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP,
    Math.max(ANNOTATION_VIEWPORT_TILE_TARGET_BP, guardedVisibleSpan)
  );
  const maxStart = Math.max(0, input.length - requestedSpan);
  const startBp = Math.max(0, Math.min(maxStart, Math.floor(input.centerBp - requestedSpan / 2)));
  return { startBp, endBp: Math.min(input.length, startBp + requestedSpan) };
}

export function annotationTileCoverageContainsRequiredRange(
  coverage: AnnotationTileCoverage,
  requiredStart: number,
  requiredEnd: number,
  length?: number
): boolean {
  const guard = ANNOTATION_VIEWPORT_TILE_REFETCH_GUARD_BP;
  if (typeof length === 'number') {
    return viewportCoverageSatisfiesGuard({
      coverage,
      viewportStart: requiredStart,
      viewportEnd: requiredEnd,
      guardBp: guard,
      domainStart: 0,
      domainEnd: length,
    });
  }
  const coverageWidth = coverage.endBp - coverage.startBp;
  if (coverageWidth <= guard * 2) {
    return requiredStart >= coverage.startBp && requiredEnd <= coverage.endBp;
  }
  return requiredStart >= coverage.startBp + guard && requiredEnd <= coverage.endBp - guard;
}

export function decideAnnotationViewportTilePolicy(
  input: AnnotationViewportTilePolicyInput
): AnnotationViewportTilePolicyDecision {
  const viewportRange = normalizeAnnotationViewportRange(input.viewportRange, input.length);
  const centerBp = clampAnnotationBp(
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

  if (visibleBp != null && visibleBp > ANNOTATION_VIEWPORT_TILE_MAX_BP) {
    return { ...base, kind: 'skip-wide', maxVisibleBp: ANNOTATION_VIEWPORT_TILE_MAX_BP };
  }

  const loadedCoverage = firstCoverageContainingRequiredRange(
    input.loadedCoverages,
    requiredStart,
    requiredEnd,
    input.length
  );
  if (loadedCoverage) {
    return { ...base, kind: 'loaded-coverage', coverage: loadedCoverage };
  }

  if (
    input.loadedCoverage &&
    annotationTileCoverageContainsRequiredRange(
      input.loadedCoverage,
      requiredStart,
      requiredEnd,
      input.length
    )
  ) {
    return { ...base, kind: 'loaded-coverage', coverage: input.loadedCoverage };
  }

  if (
    input.pendingCoverage &&
    annotationTileCoverageContainsRequiredRange(
      input.pendingCoverage,
      requiredStart,
      requiredEnd,
      input.length
    )
  ) {
    return { ...base, kind: 'pending-coverage', pending: input.pendingCoverage };
  }

  return {
    ...base,
    kind: 'request',
    request: annotationViewportTileRequestBounds({ centerBp, viewportRange, length: input.length }),
  };
}

function firstCoverageContainingRequiredRange(
  coverages: ReadonlyArray<AnnotationTileCoverage> | null | undefined,
  requiredStart: number,
  requiredEnd: number,
  length: number
): AnnotationTileCoverage | null {
  if (!coverages) return null;
  for (const coverage of coverages) {
    if (annotationTileCoverageContainsRequiredRange(coverage, requiredStart, requiredEnd, length)) {
      return coverage;
    }
  }
  return null;
}

// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  SEQUENCE_RENDER_MIN_PIXELS_PER_BP,
  SEQUENCE_STREAM_MIN_PIXELS_PER_BP,
  SEQUENCE_WINDOW_PAD_BP,
  SEQUENCE_WINDOW_REFETCH_GUARD_BP,
  SEQUENCE_WINDOW_TARGET_BP,
  clampSequenceBp,
  decideSequenceWindowPolicy,
  normalizeSequenceViewportRange,
  sequenceWindowRequestBounds,
  viewportCoverageSatisfiesGuard,
} from './indexed-sequence-window-policy';

const CHR11_LENGTH = 135_086_622;
const VIEW_WIDTH = 1_200;

describe('indexed sequence-window policy', () => {
  it('normalizes viewport ranges and clamps camera centers to chromosome bounds', () => {
    expect(normalizeSequenceViewportRange({ start: 200, end: 100 }, 1_000)).toEqual({
      start: 100,
      end: 200,
    });
    expect(normalizeSequenceViewportRange({ start: -50, end: 1_200 }, 1_000)).toEqual({
      start: 0,
      end: 1_000,
    });
    expect(normalizeSequenceViewportRange({ start: Number.NaN, end: 100 }, 1_000)).toBeNull();
    expect(clampSequenceBp(-10, 1_000)).toBe(0);
    expect(clampSequenceBp(5_000, 1_000)).toBe(999);
  });

  it('returns bounded request windows centered on the active viewport', () => {
    const request = sequenceWindowRequestBounds({
      centerBp: 626_744,
      viewportRange: { start: 626_578, end: 626_910 },
      length: CHR11_LENGTH,
    });

    expect(request.endBp - request.startBp).toBe(
      SEQUENCE_WINDOW_TARGET_BP + SEQUENCE_WINDOW_PAD_BP * 2
    );
    expect(request.startBp).toBeLessThan(626_578);
    expect(request.endBp).toBeGreaterThan(626_910);
  });

  it('skips sequence requests for chromosome-scale zoomed-out views', () => {
    const decision = decideSequenceWindowPolicy({
      reportedCenterBp: 70_000_000,
      viewportRange: { start: 10_000_000, end: 120_000_000 },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
    });

    expect(decision.kind).toBe('skip-lod');
    expect(decision.pixelsPerBp).toBeLessThan(SEQUENCE_STREAM_MIN_PIXELS_PER_BP);
  });

  it('prefetches bounded sequence before nucleotide render LOD is reached', () => {
    const decision = decideSequenceWindowPolicy({
      reportedCenterBp: 47_450_000,
      viewportRange: { start: 47_426_000, end: 47_474_000 },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
    });

    expect(decision.pixelsPerBp).toBe(SEQUENCE_STREAM_MIN_PIXELS_PER_BP);
    expect(decision.pixelsPerBp).toBeLessThan(SEQUENCE_RENDER_MIN_PIXELS_PER_BP);
    expect(decision.kind).toBe('request');
    if (decision.kind !== 'request') throw new Error('expected request decision');
    expect(decision.request.endBp - decision.request.startBp).toBe(
      SEQUENCE_WINDOW_TARGET_BP + SEQUENCE_WINDOW_PAD_BP * 2
    );
    expect(decision.request.startBp).toBeLessThan(47_426_000);
    expect(decision.request.endBp).toBeGreaterThan(47_474_000);
  });

  it('reuses only loaded coverage that contains the visible range with guard bands', () => {
    const decision = decideSequenceWindowPolicy({
      reportedCenterBp: 626_744,
      viewportRange: { start: 626_578, end: 626_910 },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
      loadedCoverage: { startBp: 528_441, endBp: 725_049 },
    });

    expect(decision.kind).toBe('loaded-coverage');
  });

  it('does not treat old loaded coverage as valid after relocating to a new locus', () => {
    const decision = decideSequenceWindowPolicy({
      reportedCenterBp: 108_500_591,
      viewportRange: { start: 108_500_499, end: 108_500_683 },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
      loadedCoverage: { startBp: 528_441, endBp: 725_049 },
    });

    expect(decision.kind).toBe('request');
    if (decision.kind !== 'request') throw new Error('expected request decision');
    expect(decision.request.startBp).toBeGreaterThan(108_000_000);
    expect(decision.request.endBp).toBeLessThan(109_000_000);
    expect(decision.request.endBp - decision.request.startBp).toBe(
      SEQUENCE_WINDOW_TARGET_BP + SEQUENCE_WINDOW_PAD_BP * 2
    );
  });

  it('clips the prefetch margin to a chromosome that is not at the start of an assembly', () => {
    const chromosomeStart = 2_000_000;
    const chromosomeEnd = 2_500_000;
    const covered = viewportCoverageSatisfiesGuard({
      coverage: { startBp: chromosomeEnd - 262_144, endBp: chromosomeEnd },
      viewportStart: chromosomeEnd - 400,
      viewportEnd: chromosomeEnd,
      guardBp: SEQUENCE_WINDOW_REFETCH_GUARD_BP,
      domainStart: chromosomeStart,
      domainEnd: chromosomeEnd,
    });
    const interiorStillReloads = viewportCoverageSatisfiesGuard({
      coverage: { startBp: chromosomeStart + 100_000, endBp: chromosomeStart + 200_000 },
      viewportStart: chromosomeStart + 190_000,
      viewportEnd: chromosomeStart + 191_000,
      guardBp: SEQUENCE_WINDOW_REFETCH_GUARD_BP,
      domainStart: chromosomeStart,
      domainEnd: chromosomeEnd,
    });

    expect(covered).toBe(true);
    expect(interiorStillReloads).toBe(false);
  });

  it('reuses a window pinned to either chromosome end instead of refetching on every zoom', () => {
    const windowBp = SEQUENCE_WINDOW_TARGET_BP + SEQUENCE_WINDOW_PAD_BP * 2;
    const visibleBp = 400;
    const endLoaded = decideSequenceWindowPolicy({
      reportedCenterBp: CHR11_LENGTH - visibleBp / 2,
      viewportRange: { start: CHR11_LENGTH - visibleBp, end: CHR11_LENGTH },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
      loadedCoverage: { startBp: CHR11_LENGTH - windowBp, endBp: CHR11_LENGTH },
    });
    const endPending = decideSequenceWindowPolicy({
      reportedCenterBp: CHR11_LENGTH - visibleBp / 2,
      viewportRange: { start: CHR11_LENGTH - visibleBp, end: CHR11_LENGTH },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
      pendingCoverage: {
        startBp: CHR11_LENGTH - windowBp,
        endBp: CHR11_LENGTH,
        token: 4,
      },
    });
    const startLoaded = decideSequenceWindowPolicy({
      reportedCenterBp: visibleBp / 2,
      viewportRange: { start: 0, end: visibleBp },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
      loadedCoverage: { startBp: 0, endBp: windowBp },
    });

    expect(endLoaded.kind).toBe('loaded-coverage');
    expect(endPending.kind).toBe('pending-coverage');
    expect(startLoaded.kind).toBe('loaded-coverage');
  });

  it('still refetches before the guard when the chromosome continues past the window', () => {
    const decision = decideSequenceWindowPolicy({
      reportedCenterBp: 1_050_000,
      viewportRange: { start: 1_049_800, end: 1_050_200 },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
      loadedCoverage: { startBp: 900_000, endBp: 1_056_000 },
    });

    expect(decision.kind).toBe('request');
  });

  it('dedupes only pending requests that cover the same guarded visible range', () => {
    const coveredPending = decideSequenceWindowPolicy({
      reportedCenterBp: 626_744,
      viewportRange: { start: 626_578, end: 626_910 },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
      pendingCoverage: { startBp: 528_441, endBp: 725_049, token: 7 },
    });
    expect(coveredPending.kind).toBe('pending-coverage');

    const relocated = decideSequenceWindowPolicy({
      reportedCenterBp: 108_500_591,
      viewportRange: { start: 108_500_499, end: 108_500_683 },
      length: CHR11_LENGTH,
      containerWidth: VIEW_WIDTH,
      pendingCoverage: { startBp: 528_441, endBp: 725_049, token: 7 },
    });
    expect(relocated.kind).toBe('request');
  });
});

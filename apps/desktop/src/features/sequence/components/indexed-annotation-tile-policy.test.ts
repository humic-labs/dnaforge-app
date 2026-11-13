// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET,
  ANNOTATION_VIEWPORT_TILE_MAX_BP,
  ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP,
  decideAnnotationViewportTilePolicy,
} from './indexed-annotation-tile-policy';

describe('indexed annotation viewport tile policy', () => {
  it('skips exact viewport annotation tiles when the viewport is too wide', () => {
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: 50_000_000,
      viewportRange: { start: 10_000_000, end: 30_000_001 },
      length: 135_000_000,
      containerWidth: 1000,
    });

    expect(decision.kind).toBe('skip-wide');
    expect(decision.visibleBp).toBeGreaterThan(ANNOTATION_VIEWPORT_TILE_MAX_BP);
  });

  it('requests a bounded guard-band tile for a zoomed-in viewport', () => {
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: 1_000_500,
      viewportRange: { start: 1_000_000, end: 1_001_000 },
      length: 135_000_000,
      containerWidth: 1000,
    });

    expect(decision.kind).toBe('request');
    if (decision.kind !== 'request') return;
    expect(decision.request.startBp).toBeGreaterThanOrEqual(0);
    expect(decision.request.endBp).toBeLessThanOrEqual(135_000_000);
    expect(decision.request.startBp).toBeLessThanOrEqual(1_000_000);
    expect(decision.request.endBp).toBeGreaterThanOrEqual(1_001_000);
    expect(decision.request.endBp - decision.request.startBp).toBeLessThanOrEqual(
      ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP
    );
    expect(ANNOTATION_VIEWPORT_TILE_BYTE_BUDGET).toBeGreaterThan(0);
  });

  it('requests exact/best-available annotation detail at the 500kb gene-reference zoom', () => {
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: 47_450_000,
      viewportRange: { start: 47_200_000, end: 47_700_000 },
      length: 135_086_622,
      containerWidth: 1343,
    });

    expect(decision.kind).toBe('request');
    if (decision.kind !== 'request') return;
    expect(decision.request.startBp).toBeLessThanOrEqual(47_200_000);
    expect(decision.request.endBp).toBeGreaterThanOrEqual(47_700_000);
    expect(decision.request.endBp - decision.request.startBp).toBeLessThanOrEqual(
      ANNOTATION_VIEWPORT_TILE_REQUEST_MAX_BP
    );
    expect(decision.request.endBp - decision.request.startBp).toBeGreaterThan(500_000);
  });

  it('reuses loaded coverage while the visible range remains inside the guard band', () => {
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: 1_050_000,
      viewportRange: { start: 1_040_000, end: 1_060_000 },
      length: 135_000_000,
      containerWidth: 1000,
      loadedCoverage: { startBp: 900_000, endBp: 1_200_000 },
    });

    expect(decision).toMatchObject({
      kind: 'loaded-coverage',
      coverage: { startBp: 900_000, endBp: 1_200_000 },
    });
  });

  it('reuses any retained loaded coverage instead of only the most recent tile', () => {
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: 1_050_000,
      viewportRange: { start: 1_040_000, end: 1_060_000 },
      length: 135_000_000,
      containerWidth: 1000,
      loadedCoverages: [
        { startBp: 9_900_000, endBp: 10_100_000 },
        { startBp: 900_000, endBp: 1_200_000 },
      ],
    });

    expect(decision).toMatchObject({
      kind: 'loaded-coverage',
      coverage: { startBp: 900_000, endBp: 1_200_000 },
    });
  });

  it('reuses a tile pinned to the chromosome end while zooming there', () => {
    const length = 135_086_622;
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: length - 200,
      viewportRange: { start: length - 400, end: length },
      length,
      containerWidth: 1200,
      loadedCoverage: { startBp: length - 32_000, endBp: length },
    });

    expect(decision.kind).toBe('loaded-coverage');
  });

  it('keeps an in-flight terminal tile instead of cancelling it on the next zoom step', () => {
    const length = 135_086_622;
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: length - 200,
      viewportRange: { start: length - 400, end: length },
      length,
      containerWidth: 1200,
      pendingCoverage: { startBp: length - 32_000, endBp: length, token: 9 },
    });

    expect(decision.kind).toBe('pending-coverage');
  });

  it('does not fire duplicate requests while equivalent coverage is pending', () => {
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: 1_050_000,
      viewportRange: { start: 1_040_000, end: 1_060_000 },
      length: 135_000_000,
      containerWidth: 1000,
      pendingCoverage: { startBp: 900_000, endBp: 1_200_000, token: 12 },
    });

    expect(decision).toMatchObject({
      kind: 'pending-coverage',
      pending: { token: 12 },
    });
  });

  it('treats a wide tile that already ends at the chromosome end as covering the end', () => {
    const length = 135_086_622;
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: length - 2_000,
      viewportRange: { start: length - 4_000, end: length },
      length,
      containerWidth: 1000,
      loadedCoverage: { startBp: length - 200_000, endBp: length },
    });

    expect(decision.kind).toBe('loaded-coverage');
  });

  it('keeps the guard on a wide tile that stops short of the chromosome end', () => {
    const length = 135_086_622;
    const decision = decideAnnotationViewportTilePolicy({
      reportedCenterBp: length - 2_000,
      viewportRange: { start: length - 4_000, end: length },
      length,
      containerWidth: 1000,
      loadedCoverage: { startBp: length - 200_000, endBp: length - 1 },
    });

    expect(decision.kind).toBe('request');
  });
});

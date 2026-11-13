// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { buildAnnotationTileRequest } from './indexed-annotation-tile-request';
import { computeLaneEpoch } from './stable-lane-assignment';

describe('buildAnnotationTileRequest (Slice 1c)', () => {
  const baseInput = {
    chrom: 'chr11',
    start: 1_000_000,
    end: 1_500_000,
    lod: 1,
    generation: 42,
    fidelity: 'best_available' as const,
    byteBudget: 512 * 1024,
    sourceFingerprint: 'fp-chr11',
    visibleTypes: new Set(['gene', 'mRNA']),
    laneLimit: 8 as const,
  };

  it('stamps the request with laneEpoch matching computeLaneEpoch', () => {
    const request = buildAnnotationTileRequest(baseInput);
    const expectedEpoch = computeLaneEpoch({
      sourceFingerprint: baseInput.sourceFingerprint,
      chrom: baseInput.chrom,
      visibleTypes: baseInput.visibleTypes,
      laneLimit: baseInput.laneLimit,
    });
    expect(request.laneEpoch).toBe(expectedEpoch);
  });

  it('passes through the standard request fields verbatim', () => {
    const request = buildAnnotationTileRequest(baseInput);
    expect(request).toMatchObject({
      trackId: 'chr11:annotations',
      chrom: 'chr11',
      start: 1_000_000,
      end: 1_500_000,
      lod: 1,
      generation: 42,
      fidelity: 'best_available',
      byteBudget: 512 * 1024,
    });
  });

  it('changes the laneEpoch when visibleTypes changes (filter toggle)', () => {
    const a = buildAnnotationTileRequest(baseInput);
    const b = buildAnnotationTileRequest({
      ...baseInput,
      visibleTypes: new Set(['gene', 'mRNA', 'enhancer']),
    });
    expect(a.laneEpoch).not.toBe(b.laneEpoch);
  });

  it('changes the laneEpoch when laneLimit changes', () => {
    const a = buildAnnotationTileRequest(baseInput);
    const b = buildAnnotationTileRequest({ ...baseInput, laneLimit: null });
    expect(a.laneEpoch).not.toBe(b.laneEpoch);
  });

  it('does NOT change the laneEpoch when generation / range / lod change', () => {
    const a = buildAnnotationTileRequest(baseInput);
    const b = buildAnnotationTileRequest({
      ...baseInput,
      generation: 99,
      start: 2_000_000,
      end: 2_500_000,
      lod: 2,
      fidelity: 'summary',
    });
    expect(a.laneEpoch).toBe(b.laneEpoch);
  });

  it('produces the same epoch for two opens with matching sourceFingerprint', () => {
    const reopen = buildAnnotationTileRequest({
      ...baseInput,
      generation: 0,
    });
    const original = buildAnnotationTileRequest(baseInput);
    expect(reopen.laneEpoch).toBe(original.laneEpoch);
  });
});

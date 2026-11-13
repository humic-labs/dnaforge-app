// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import type { GenomeTrackTile } from '../../../shared/indexed-genome';
import { pollAnnotationSummaryTile, SUMMARY_TILE_MAX_ATTEMPTS } from './pollAnnotationSummaryTile';

function tile(overrides: Partial<GenomeTrackTile> = {}): GenomeTrackTile {
  return {
    kind: 'annotation',
    chrom: 'chr1',
    start: 0,
    end: 100,
    lod: 0,
    generation: 1,
    fidelity: 'summary',
    state: 'ready',
    recordCount: 2,
    byteCount: 10,
    validationState: 'valid',
    ...overrides,
  } as GenomeTrackTile;
}

describe('pollAnnotationSummaryTile', () => {
  it('returns the first non-pending tile', async () => {
    const getAnnotationTile = vi.fn(async () => tile({ state: 'ready' }));
    const result = await pollAnnotationSummaryTile({
      sessionId: 's',
      chrom: 'chr1',
      length: 100,
      generation: 3,
      visibleTypes: new Set(['mRNA']),
      laneLimit: null,
      sourceFingerprint: 'fp',
      isCancelled: () => false,
      getAnnotationTile,
      delay: async () => undefined,
    });
    expect(result.state).toBe('ready');
    expect(getAnnotationTile).toHaveBeenCalledTimes(1);
    expect(getAnnotationTile.mock.calls[0]?.[2]).toBe('overview-annotations-3-0');
  });

  it('retries pending tiles then returns ready', async () => {
    const getAnnotationTile = vi
      .fn()
      .mockResolvedValueOnce(tile({ state: 'building_summary', recordCount: 0 }))
      .mockResolvedValueOnce(tile({ state: 'ready', recordCount: 4 }));
    const pending: GenomeTrackTile[] = [];
    const result = await pollAnnotationSummaryTile({
      sessionId: 's',
      chrom: 'chr1',
      length: 100,
      generation: 1,
      visibleTypes: new Set(),
      laneLimit: 4,
      sourceFingerprint: 'fp',
      isCancelled: () => false,
      getAnnotationTile,
      onPendingTile: (next) => pending.push(next),
      delay: async () => undefined,
    });
    expect(result.recordCount).toBe(4);
    expect(pending).toHaveLength(1);
    expect(getAnnotationTile).toHaveBeenCalledTimes(2);
  });

  it('throws when cancelled between attempts', async () => {
    let cancelled = false;
    const getAnnotationTile = vi.fn(async () => {
      cancelled = true;
      return tile({ state: 'building_summary' });
    });
    await expect(
      pollAnnotationSummaryTile({
        sessionId: 's',
        chrom: 'chr1',
        length: 100,
        generation: 1,
        visibleTypes: new Set(),
        laneLimit: null,
        sourceFingerprint: 'fp',
        isCancelled: () => cancelled,
        getAnnotationTile,
        delay: async () => undefined,
      })
    ).rejects.toThrow('Annotation summary request cancelled.');
  });

  it('throws after the attempt budget if the tile stays pending', async () => {
    const getAnnotationTile = vi.fn(async () =>
      tile({ state: 'building_summary', message: 'still building' })
    );
    await expect(
      pollAnnotationSummaryTile({
        sessionId: 's',
        chrom: 'chr1',
        length: 100,
        generation: 1,
        visibleTypes: new Set(),
        laneLimit: null,
        sourceFingerprint: 'fp',
        isCancelled: () => false,
        getAnnotationTile,
        delay: async () => undefined,
      })
    ).rejects.toThrow('still building');
    expect(getAnnotationTile).toHaveBeenCalledTimes(SUMMARY_TILE_MAX_ATTEMPTS);
  });
});

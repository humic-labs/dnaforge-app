// @vitest-environment node

import { describe, expect, it } from 'vitest';

import { waitForCoordinateReadyGenomeSession } from './assembly-session-ready';
import type { GenomeSessionShell, IndexedGenomeManifest } from '../../../shared/indexed-genome';

function shell(patch: Partial<GenomeSessionShell> = {}): GenomeSessionShell {
  return {
    sessionId: 'session-chr11',
    sourcePath: '/workspace/chr11.gff3.gz',
    sourceFingerprint: 'fp',
    chrom: 'chr11',
    coordinateReady: false,
    validationState: 'metadata_match',
    tracks: [],
    openedAt: 0,
    ...patch,
  };
}

describe('waitForCoordinateReadyGenomeSession', () => {
  it('polls until main attaches a coordinate-ready manifest', async () => {
    const manifest: IndexedGenomeManifest = {
      chrom: 'chr11',
      fastaPath: '/workspace/chr11.fa',
      faiPath: '/workspace/chr11.fa.fai',
      gffPath: '/workspace/chr11.gff3.gz',
      tbiPath: '/workspace/chr11.gff3.gz.tbi',
      length: 135_086_622,
    };
    let calls = 0;

    const ready = await waitForCoordinateReadyGenomeSession({
      initialShell: shell(),
      getSession: async () => {
        calls += 1;
        return calls < 2 ? shell() : shell({ coordinateReady: true, manifest });
      },
      timeoutMs: 1_000,
      pollMs: 1,
    });

    expect(calls).toBe(2);
    expect(ready.manifest).toEqual(manifest);
  });

  it('throws before returning a session without a manifest', async () => {
    await expect(
      waitForCoordinateReadyGenomeSession({
        initialShell: shell(),
        getSession: async () => shell({ coordinateReady: true }),
        timeoutMs: 2,
        pollMs: 1,
      })
    ).rejects.toThrow(/did not become coordinate-ready/);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readAlignmentDetails } from './alignment-read-client';
import type { PileupSource } from './pileup-source';

vi.mock('../../services/sidecar-session', () => ({
  resolveSidecarBaseUrl: vi.fn(async () => 'http://127.0.0.1:8000'),
  sidecarFetch: (url: string, init: RequestInit, fetchImpl: typeof fetch) => fetchImpl(url, init),
}));

afterEach(() => vi.clearAllMocks());

describe('alignment read computation', () => {
  it.each([false, true])('uses the admitted calculation origin (cluster=%s)', async (cluster) => {
    const source: PileupSource = {
      bamPath: 'http://127.0.0.1:54000/v1/source/alignment.bam',
      indexPath: '/private/index.bai',
      ...(cluster
        ? {
            remote: {
              locator: {
                contract: 'remote-alignment-locator.v1',
                endpointId: 'endpoint',
                target: 'cluster',
                alignmentPath: '/data/reads.bam',
              },
              tileBaseUrl: 'http://127.0.0.1:54000/v1/source/compute',
            },
          }
        : {}),
    };
    const details = {
      readId: 'original',
      chrom: 'chr1',
      start: 100,
      end: 103,
      strand: '+',
      mapq: 60,
      flag: 0,
      cigar: '3M',
      seq: 'ACG',
      baseQualities: [40, 40, 40],
      tags: { MD: '3' },
    };
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(details), { status: 200 })
    );
    const hit = {
      trackId: 'reads',
      sourceGenerationKey: '',
      readId: 'original',
      chrom: 'chr1',
      referenceStart: 100,
      start: 100,
      end: 103,
      flag: 0,
      strand: '+' as const,
      mapq: 60,
      screenX: 0,
      screenY: 0,
    };
    expect(await readAlignmentDetails({ source, hit, fetchImpl })).toMatchObject(details);
    expect(fetchImpl).toHaveBeenCalledWith(
      `${cluster ? source.remote!.tileBaseUrl : 'http://127.0.0.1:8000'}/tiles/alignment/read`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      bamPath: source.bamPath,
      readId: 'original',
      referenceStart: 100,
      flag: 0,
    });
  });
});

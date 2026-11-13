import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { decodeTrackManifest, decodeTrackManifestV1 } from './track-manifest';

describe('decodeTrackManifestV1', () => {
  it('accepts an assembly-bound mix of local and linked workflow outputs', () => {
    expect(
      decodeTrackManifestV1(
        JSON.stringify({
          contract: 'dnaforge.track-manifest.v1',
          assemblyId: 'grch38',
          artifacts: [
            { path: 'tracks/coverage.bigWig' },
            { path: 'sample.bam' },
            { url: 'https://results.example.org/run/accessibility.bw' },
          ],
        }),
        'grch38'
      )
    ).toEqual({
      contract: 'dnaforge.track-manifest.v1',
      assemblyId: 'grch38',
      artifacts: [
        { path: 'tracks/coverage.bigWig' },
        { path: 'sample.bam' },
        { url: 'https://results.example.org/run/accessibility.bw' },
      ],
    });
  });

  it('rejects a manifest for a different reference before reading any artifact', () => {
    expect(() =>
      decodeTrackManifestV1(
        JSON.stringify({
          contract: 'dnaforge.track-manifest.v1',
          assemblyId: 'grch37',
          artifacts: [{ path: 'coverage.bw' }],
        }),
        'grch38'
      )
    ).toThrow('declares assembly grch37, but the open reference is grch38');
  });

  it.each([
    [{ path: '../secret.bw' }, 'may not traverse outside'],
    [{ path: '/private/secret.bw' }, 'must be relative to the manifest'],
    [{ path: 'coverage.bw', url: 'https://example.org/coverage.bw' }, 'exactly one'],
    [{ url: 'https://user:secret@example.org/coverage.bw' }, 'may not contain credentials'],
    [{ url: 'https://example.org/coverage.bw#fragment' }, 'may not contain credentials'],
    [{ url: 'https://example.org/coverage.bw?token=secret' }, 'credential parameters'],
    [
      { url: 'https://bucket.example.org/coverage.bw?X-Amz-Signature=secret' },
      'credential parameters',
    ],
  ])('rejects an unsafe artifact locator', (artifact, message) => {
    expect(() =>
      decodeTrackManifestV1(
        JSON.stringify({
          contract: 'dnaforge.track-manifest.v1',
          assemblyId: 'grch38',
          artifacts: [artifact],
        }),
        'grch38'
      )
    ).toThrow(message);
  });

  it('rejects duplicate artifact identities and unbounded manifests', () => {
    expect(() =>
      decodeTrackManifestV1(
        JSON.stringify({
          contract: 'dnaforge.track-manifest.v1',
          assemblyId: 'grch38',
          artifacts: [{ path: 'coverage.bw' }, { path: 'coverage.bw' }],
        }),
        'grch38'
      )
    ).toThrow('duplicate artifact');

    expect(() => decodeTrackManifestV1(' '.repeat(1_048_577), 'grch38')).toThrow(
      'larger than 1 MiB'
    );
  });
});

describe('decodeTrackManifest', () => {
  it('keeps the signal-only pipeline example executable without a read index', () => {
    const text = readFileSync(
      new URL(
        '../../../../docs/examples/track-manifests/atac-signal-only.dnaforge-tracks.json',
        import.meta.url
      ),
      'utf8'
    );

    expect(decodeTrackManifest(text, 'grch38')).toMatchObject({
      contract: 'dnaforge.track-manifest.v2',
      artifacts: [
        { id: 'accessibility', formatId: 'bigwig', scientificKind: 'quantitative' },
        { id: 'peaks', formatId: 'narrowpeak', scientificKind: 'peak' },
      ],
      views: [],
    });
  });

  it('keeps the copyable ATAC authoring example executable', () => {
    const text = readFileSync(
      new URL(
        '../../../../docs/examples/track-manifests/atac-signal-read-pileup.dnaforge-tracks.json',
        import.meta.url
      ),
      'utf8'
    );

    expect(decodeTrackManifest(text, 'grch38')).toMatchObject({
      contract: 'dnaforge.track-manifest.v2',
      artifacts: [
        { id: 'reads', formatId: 'cram', scientificKind: 'reads' },
        { id: 'accessibility', formatId: 'bigwig', scientificKind: 'quantitative' },
        { id: 'peaks', formatId: 'narrowpeak', scientificKind: 'peak' },
      ],
      views: [
        {
          kind: 'signal-read-pileup',
          reads: 'reads',
          signal: 'accessibility',
        },
      ],
    });
  });

  it('accepts an explicit signal-to-reads view without relying on filenames', () => {
    expect(
      decodeTrackManifest(
        JSON.stringify({
          contract: 'dnaforge.track-manifest.v2',
          assemblyId: 'grch38',
          artifacts: [
            {
              id: 'aligned-reads',
              path: 'align/GM12878.filtered.bam',
              indexPath: 'align/GM12878.filtered.bam.bai',
              formatId: 'bam',
              scientificKind: 'reads',
            },
            {
              id: 'accessibility',
              url: 'https://results.example.org/artifacts/42',
              formatId: 'bigwig',
              scientificKind: 'quantitative',
            },
            {
              id: 'peaks',
              path: 'peaks/GM12878.narrowPeak',
              formatId: 'narrowpeak',
              scientificKind: 'peak',
            },
          ],
          views: [
            {
              id: 'gm12878-hybrid',
              kind: 'signal-read-pileup',
              reads: 'aligned-reads',
              signal: 'accessibility',
              label: 'GM12878 accessibility + reads',
              showSourceTracks: true,
              presentation: {
                color: 0xa8ceff,
                heightPx: 276,
                rowHeightPx: 3,
                maxRows: 80,
                coverageCutoffDepth: 80,
                loadingAnimation: 'diagonal-scan',
              },
            },
          ],
        }),
        'grch38'
      )
    ).toEqual({
      contract: 'dnaforge.track-manifest.v2',
      assemblyId: 'grch38',
      artifacts: [
        {
          id: 'aligned-reads',
          path: 'align/GM12878.filtered.bam',
          indexPath: 'align/GM12878.filtered.bam.bai',
          formatId: 'bam',
          scientificKind: 'reads',
        },
        {
          id: 'accessibility',
          url: 'https://results.example.org/artifacts/42',
          formatId: 'bigwig',
          scientificKind: 'quantitative',
        },
        {
          id: 'peaks',
          path: 'peaks/GM12878.narrowPeak',
          formatId: 'narrowpeak',
          scientificKind: 'peak',
        },
      ],
      views: [
        {
          id: 'gm12878-hybrid',
          kind: 'signal-read-pileup',
          reads: 'aligned-reads',
          signal: 'accessibility',
          label: 'GM12878 accessibility + reads',
          showSourceTracks: true,
          presentation: {
            color: 0xa8ceff,
            heightPx: 276,
            rowHeightPx: 3,
            maxRows: 80,
            coverageCutoffDepth: 80,
            loadingAnimation: 'diagonal-scan',
          },
        },
      ],
    });
  });

  it.each([
    [
      {
        artifacts: [
          {
            id: 'reads',
            path: 'sample.bam',
            indexPath: 'sample.bam.bai',
            formatId: 'bam',
            scientificKind: 'reads',
          },
          {
            id: 'signal',
            path: 'sample.bigWig',
            formatId: 'bigwig',
            scientificKind: 'quantitative',
          },
        ],
        views: [{ id: 'hybrid', kind: 'signal-read-pileup', reads: 'missing', signal: 'signal' }],
      },
      'unknown reads artifact missing',
    ],
    [
      {
        artifacts: [
          {
            id: 'reads',
            path: 'sample.bam',
            indexPath: 'sample.bam.bai',
            formatId: 'bam',
            scientificKind: 'reads',
          },
          {
            id: 'reads',
            path: 'other.bam',
            indexPath: 'other.bam.bai',
            formatId: 'bam',
            scientificKind: 'reads',
          },
        ],
        views: [],
      },
      'duplicate artifact id reads',
    ],
    [
      {
        artifacts: [
          {
            id: 'reads',
            path: 'sample.bam',
            indexPath: '../sample.bam.bai',
            formatId: 'bam',
            scientificKind: 'reads',
          },
          {
            id: 'signal',
            path: 'sample.bigWig',
            formatId: 'bigwig',
            scientificKind: 'quantitative',
          },
        ],
        views: [{ id: 'hybrid', kind: 'signal-read-pileup', reads: 'reads', signal: 'signal' }],
      },
      'index path may not traverse outside',
    ],
    [
      {
        artifacts: [
          {
            id: 'reads',
            path: 'sample.bam',
            indexPath: 'sample.bam.bai',
            formatId: 'bam',
            scientificKind: 'reads',
          },
          {
            id: 'signal',
            path: 'sample.narrowPeak',
            formatId: 'narrowpeak',
            scientificKind: 'peak',
          },
        ],
        views: [{ id: 'hybrid', kind: 'signal-read-pileup', reads: 'reads', signal: 'signal' }],
      },
      'signal artifact signal must be quantitative BigWig',
    ],
    [
      {
        artifacts: [
          {
            id: 'reads',
            path: 'sample.bam',
            indexPath: 'sample.bam.bai',
            formatId: 'bam',
            scientificKind: 'reads',
          },
          {
            id: 'signal',
            path: 'sample.bigWig',
            formatId: 'bigwig',
            scientificKind: 'quantitative',
          },
        ],
        views: [
          { id: 'hybrid-a', kind: 'signal-read-pileup', reads: 'reads', signal: 'signal' },
          { id: 'hybrid-b', kind: 'signal-read-pileup', reads: 'reads', signal: 'signal' },
        ],
      },
      'duplicate signal-to-reads source pair',
    ],
  ])('rejects an invalid explicit view contract', (body, message) => {
    expect(() =>
      decodeTrackManifest(
        JSON.stringify({
          contract: 'dnaforge.track-manifest.v2',
          assemblyId: 'grch38',
          ...body,
        }),
        'grch38'
      )
    ).toThrow(message);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { directTrackAdmissionRequest } from '@waypoint/genome-data';

import {
  admitIndexedBigBedRequest,
  admitIndexedBigWigRequest,
  admitIndexedBigWigSource,
} from './indexed-track-admission';
import { portableAdmittedContentFingerprint } from './portable-genome-view-adapter';
import { admitPortableTracks } from './portable-genome-view-restore';
import { trackViewConfigurationKey } from './track-view-configuration';
import { trackViewFixture } from '../../shared/track-view-fixture';
import { parseTrackViewDocument } from '../../shared/track-view';

const mocks = vi.hoisted(() => ({
  admit: vi.fn(),
  open: vi.fn(),
  queryQuantitative: vi.fn(),
  closeSource: vi.fn(),
}));

vi.mock('./indexed-track-client', () => ({
  admitIndexedTrack: mocks.admit,
}));

vi.mock('./bbi-reader-runtime', () => ({
  getBbiReaderWorkerClient: () => ({
    open: mocks.open,
    queryQuantitative: mocks.queryQuantitative,
    closeSource: mocks.closeSource,
  }),
}));

describe('indexed BigWig admission', () => {
  beforeEach(() => {
    mocks.admit.mockReset().mockResolvedValue({
      sourceUri: 'file:///analysis/signal.bigWig',
      sourceToken: 'opaque-token',
      canonicalUrlHash: 'source-hash',
      byteLength: 4096,
      expiresAtMs: Date.now() + 60_000,
      provenanceId: 'local-file\u0000grch38\u0000/analysis/signal.bigWig',
    });
    mocks.open.mockReset().mockResolvedValue({
      fileType: 'bigwig',
      references: [{ name: 'chr1', length: 248_956_422 }],
      zoomReductionLevels: [10, 100, 1_000],
      totalSummary: { basesCovered: 10, scoreMin: 0, scoreMax: 12 },
    });
    mocks.queryQuantitative.mockReset().mockResolvedValue([
      {
        starts: new Int32Array([0]),
        ends: new Int32Array([100]),
        values: new Float32Array([0, 3, 12]),
      },
    ]);
    mocks.closeSource.mockReset().mockResolvedValue(undefined);
  });

  it('closes the temporary reader after creating a durable source descriptor', async () => {
    const source = await admitIndexedBigWigSource({
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
      source: { kind: 'path', path: '/analysis/signal.bigWig' },
    });

    expect(source).toMatchObject({
      readerKind: 'bbi',
      scientificKind: 'quantitative',
      assemblyId: 'grch38',
    });
    expect(mocks.closeSource).toHaveBeenCalledOnce();
    expect(mocks.closeSource).toHaveBeenCalledWith(source.fingerprint);
  });

  it.each([
    { kind: 'path' as const, path: '/analysis/signal.bigWig' },
    { kind: 'url' as const, url: 'https://results.example.org/signal.bigWig' },
  ])('restores unchanged inferred BigWig data through its saved request ($kind)', async (input) => {
    const references = [{ name: 'chr1', length: 248_956_422 }];
    const saved = await admitIndexedBigWigSource({
      assemblyId: 'grch38',
      assemblyReferences: references,
      source: input,
    });
    expect(saved.request?.scientificKind).toBe('quantitative');
    if (!saved.request) throw new Error('Admission must retain its durable request');
    const contentFingerprint = await portableAdmittedContentFingerprint(saved);
    const restored = await admitPortableTracks({
      assemblyId: 'grch38',
      assemblyReferences: references,
      tracks: [
        {
          trackId: 'same-published-signal',
          trackType: 'quantitative',
          label: 'Signal',
          order: 0,
          visible: false,
          source: {
            kind: 'admitted-source',
            request: saved.request,
            assemblyId: 'grch38',
            contentFingerprint,
            referenceSignature: saved.referenceReceipt.referenceSignature,
          },
          presentation: {
            kind: 'quantitative',
            color: '#3366cc',
            trackHeightPx: 96,
            scale: { kind: 'auto' },
          },
        },
      ],
      admit: (request) => admitIndexedBigWigRequest(request),
    });
    expect(restored.outcomes).toEqual([
      { trackId: 'same-published-signal', label: 'Signal', status: 'restored' },
    ]);
    expect(restored.dataTracks).toHaveLength(1);
    expect(restored.dataTracks[0].visible).toBe(false);
    const unchangedGrant = await mocks.admit.mock.results[0].value;
    mocks.admit.mockResolvedValueOnce({
      ...unchangedGrant,
      etag: '"actually-changed-file"',
    });
    const changed = await admitIndexedBigWigRequest({
      request: saved.request,
      assemblyReferences: references,
    });
    expect(await portableAdmittedContentFingerprint(changed)).not.toBe(contentFingerprint);
  });

  it('does not mark an unchanged re-admitted inferred BigWig as unsaved', async () => {
    const references = [{ name: 'chr1', length: 248_956_422 }];
    const saved = await admitIndexedBigWigSource({
      assemblyId: 'grch38',
      assemblyReferences: references,
      source: { kind: 'path', path: '/analysis/signal.bigWig' },
    });
    if (!saved.request) throw new Error('Admission must retain its durable request');
    const reopened = await admitIndexedBigWigRequest({
      request: saved.request,
      assemblyReferences: references,
    });
    const base = parseTrackViewDocument(JSON.stringify(trackViewFixture()));
    const track = {
      trackId: 'signal',
      trackType: 'quantitative',
      label: 'Signal',
      color: 0x3366cc,
      trackPx: 96,
      laneHeightPx: 8,
      maxLanes: 32,
      visible: false,
    };
    const before = { ...base, dataTracks: [{ ...track, source: saved }] };
    const after = { ...base, dataTracks: [{ ...track, source: reopened }] };
    expect(trackViewConfigurationKey(after)).toBe(trackViewConfigurationKey(before));
    expect(
      trackViewConfigurationKey({
        ...after,
        dataTracks: [
          {
            ...track,
            source: {
              ...reopened,
              fingerprint: `${reopened.fingerprint}\u0000changed-file-validator`,
            },
          },
        ],
      })
    ).not.toBe(trackViewConfigurationKey(before));
  });

  it('retains approved dev-fixture authority in the durable source descriptor', async () => {
    const source = await admitIndexedBigWigSource({
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
      source: { kind: 'path', path: '/analysis/signal.bigWig' },
      localAuthorityContext: 'dev-scenario-fixture',
    });

    expect(mocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'path', path: '/analysis/signal.bigWig' } }),
      expect.objectContaining({ localAuthorityContext: 'dev-scenario-fixture' })
    );
    expect(source.provenance).toMatchObject({ devScenarioFixture: true });
  });

  it('admits a sparse signal file while verifying its represented chromosome lengths', async () => {
    const source = await admitIndexedBigWigSource({
      assemblyId: 'grch38',
      assemblyReferences: [
        { name: 'chr1', length: 248_956_422 },
        { name: 'chrY', length: 57_227_415 },
      ],
      source: { kind: 'path', path: '/analysis/signal.bigWig' },
    });

    expect(source.referenceReceipt).toMatchObject({
      checkedContigs: 1,
      contigMap: { chr1: 'chr1' },
      status: 'compatible',
    });
    expect(source.referenceReceipt.contigMap).not.toHaveProperty('chrY');
  });

  it('closes the temporary reader when reference validation rejects the source', async () => {
    mocks.open.mockResolvedValueOnce({
      fileType: 'bigwig',
      references: [{ name: 'chr1', length: 1 }],
      zoomReductionLevels: [],
    });

    await expect(
      admitIndexedBigWigSource({
        assemblyId: 'grch38',
        assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
        source: { kind: 'path', path: '/analysis/signal.bigWig' },
      })
    ).rejects.toThrow('BigWig reference mismatch for chr1');
    expect(mocks.closeSource).toHaveBeenCalledOnce();
  });
});

describe('indexed BigBed admission', () => {
  beforeEach(() => {
    mocks.admit.mockReset().mockResolvedValue({
      sourceUri: 'https://results.example.org/genes.bb',
      sourceToken: 'opaque-token',
      canonicalUrlHash: 'source-hash',
      byteLength: 8192,
      etag: '"genes-v1"',
      expiresAtMs: Date.now() + 60_000,
      provenanceId: 'remote-url\u0000grch38\u0000https://results.example.org/genes.bb',
    });
    mocks.open.mockReset().mockResolvedValue({
      fileType: 'bigbed',
      references: [{ name: 'chr1', length: 248_956_422 }],
      zoomReductionLevels: [],
    });
    mocks.closeSource.mockReset().mockResolvedValue(undefined);
  });

  it('admits a reference-compatible BigBed with explicit scientific meaning', async () => {
    const request = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'url', url: 'https://results.example.org/genes.bb' },
      formatId: 'bigbed',
      scientificKind: 'transcript',
      ingress: 'url',
    });

    const source = await admitIndexedBigBedRequest({
      request,
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
    });

    expect(source).toMatchObject({
      admissionVersion: 2,
      request,
      formatId: 'bigbed',
      readerKind: 'bbi',
      scientificKind: 'transcript',
      recommendedTypes: ['imported-transcript'],
      expectedValidators: { etag: '"genes-v1"', contentLength: 8192 },
    });
    expect(mocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({ formatId: 'bigbed' }),
      expect.any(Object)
    );
    expect(mocks.open).toHaveBeenCalledWith(
      source.fingerprint,
      'bigbed',
      expect.any(Object),
      undefined
    );
    expect(mocks.closeSource).toHaveBeenCalledWith(source.fingerprint);
  });

  it('infers transcript meaning from AutoSQL when the request does not specify it', async () => {
    mocks.open.mockResolvedValueOnce({
      fileType: 'bigbed',
      references: [{ name: 'chr1', length: 248_956_422 }],
      zoomReductionLevels: [],
      autoSql: `table transcript\n"Transcript intervals"\n(\n  string chrom;\n  uint chromStart;\n  uint chromEnd;\n  string name;\n  char[1] strand;\n  uint blockCount;\n  uint[blockCount] blockSizes;\n  uint[blockCount] blockStarts;\n)`,
    });
    const request = directTrackAdmissionRequest({
      assemblyId: 'grch38',
      input: { kind: 'url', url: 'https://results.example.org/genes.bb' },
      formatId: 'bigbed',
      ingress: 'url',
    });

    const source = await admitIndexedBigBedRequest({
      request,
      assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
    });

    expect(source.scientificKind).toBe('transcript');
    expect(source.recommendedTypes).toEqual(['imported-transcript']);
    expect(source.request.scientificKind).toBe('transcript');
  });
});

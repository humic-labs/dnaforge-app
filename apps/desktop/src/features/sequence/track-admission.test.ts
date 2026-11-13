import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TRACK_ADMISSION_REQUEST_V1,
  type CurrentAdmittedTrackSource,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import { admitTrackSource } from './track-admission';
import { admitAlignedReadTrackRequest } from './aligned-read-track-admission';
import { admitIndexedBigBedRequest, admitIndexedBigWigRequest } from './indexed-track-admission';
import { admitTextIntervalTrackRequest } from './text-interval-track-admission';
import { admitVariantTrackRequest } from './variant-track-admission';

vi.mock('./aligned-read-track-admission', () => ({
  admitAlignedReadTrackRequest: vi.fn(),
}));

vi.mock('./indexed-track-admission', () => ({
  admitIndexedBigBedRequest: vi.fn(),
  admitIndexedBigWigRequest: vi.fn(),
}));

vi.mock('./text-interval-track-admission', () => ({
  admitTextIntervalTrackRequest: vi.fn(),
  isTextIntervalFormatId: (value: string | undefined) =>
    ['bed', 'gff3', 'gtf', 'genepred', 'refflat', 'narrowpeak', 'broadpeak'].includes(value ?? ''),
}));

vi.mock('./variant-track-admission', () => ({ admitVariantTrackRequest: vi.fn() }));

const references = [{ name: 'chr1', length: 1_000 }];

function request(overrides: Partial<TrackAdmissionRequestV1> = {}): TrackAdmissionRequestV1 {
  return {
    contract: TRACK_ADMISSION_REQUEST_V1,
    assemblyId: 'grch38',
    source: { kind: 'http', url: 'https://data.example.org/signal.bigWig' },
    formatId: 'bigwig',
    ingress: { kind: 'url' },
    ...overrides,
  };
}

function admitted(admissionRequest: TrackAdmissionRequestV1): CurrentAdmittedTrackSource {
  return {
    admissionVersion: 2,
    request: admissionRequest,
    admittedAt: '2026-09-21T18:00:00.000Z',
    uri: 'https://data.example.org/signal.bigWig',
    input: { kind: 'url', url: 'https://data.example.org/signal.bigWig' },
    formatId: 'bigwig',
    fingerprint: 'generation-1',
    readerKind: 'bbi',
    scientificKind: 'quantitative',
    assemblyId: 'grch38',
    referenceReceipt: {
      assemblyId: 'grch38',
      referenceSignature: 'reference-signature',
      sourceSignature: 'source-signature',
      contigMap: { chr1: 'chr1' },
      checkedContigs: 1,
      status: 'compatible',
      checkedAt: '2026-09-21T18:00:00.000Z',
    },
    provenance: { provider: 'direct-url', sourceKind: 'remote-url', label: 'signal.bigWig' },
  };
}

describe('source-neutral track admission dispatcher', () => {
  beforeEach(() => {
    vi.mocked(admitIndexedBigBedRequest)
      .mockReset()
      .mockImplementation(async (input) => ({
        ...admitted(input.request),
        formatId: 'bigbed',
        scientificKind: input.request.scientificKind ?? 'interval',
      }));
    vi.mocked(admitIndexedBigWigRequest)
      .mockReset()
      .mockImplementation(async (input) => admitted(input.request));
    vi.mocked(admitTextIntervalTrackRequest)
      .mockReset()
      .mockImplementation(async (input) => ({
        ...admitted(input.request),
        formatId: input.request.formatId ?? 'bed',
        readerKind: 'interval-text',
        scientificKind: input.request.scientificKind ?? 'interval',
      }));
    vi.mocked(admitAlignedReadTrackRequest)
      .mockReset()
      .mockImplementation(async (input) => ({
        ...admitted(input.request),
        formatId: input.request.formatId ?? 'bam',
        readerKind: 'bam',
        scientificKind: 'reads',
      }));
    vi.mocked(admitVariantTrackRequest)
      .mockReset()
      .mockImplementation(async (input) => ({
        ...admitted(input.request),
        formatId: input.request.formatId ?? 'vcf',
        readerKind: 'variant',
        scientificKind: 'variants',
      }));
  });

  it('routes an explicit BigWig through the shared request without losing ingress', async () => {
    const admissionRequest = request({ ingress: { kind: 'automation' }, label: 'Coverage' });

    const source = await admitTrackSource({
      request: admissionRequest,
      assemblyId: 'grch38',
      assemblyReferences: references,
    });

    expect(admitIndexedBigWigRequest).toHaveBeenCalledWith({
      request: admissionRequest,
      assemblyReferences: references,
      signal: undefined,
      localAuthorityContext: undefined,
    });
    expect(source).toMatchObject({
      admissionVersion: 2,
      request: { ingress: { kind: 'automation' }, label: 'Coverage' },
    });
  });

  it('detects a direct format when the ingress leaves formatId automatic', async () => {
    const automatic = request({ formatId: undefined });

    await admitTrackSource({
      request: automatic,
      assemblyId: 'grch38',
      assemblyReferences: references,
    });

    expect(admitIndexedBigWigRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({ formatId: 'bigwig' }),
      })
    );
  });

  it('routes BigBed through the indexed interval adapter with its scientific meaning', async () => {
    const admissionRequest = request({
      source: { kind: 'http', url: 'https://data.example.org/transcripts.bb' },
      formatId: 'bigbed',
      scientificKind: 'transcript',
    });

    const source = await admitTrackSource({
      request: admissionRequest,
      assemblyId: 'grch38',
      assemblyReferences: references,
    });

    expect(admitIndexedBigBedRequest).toHaveBeenCalledWith({
      request: admissionRequest,
      assemblyReferences: references,
      signal: undefined,
      localAuthorityContext: undefined,
    });
    expect(source).toMatchObject({
      formatId: 'bigbed',
      scientificKind: 'transcript',
    });
  });

  it('fails before I/O when the request belongs to another assembly', async () => {
    await expect(
      admitTrackSource({
        request: request({ assemblyId: 'grch37' }),
        assemblyId: 'grch38',
        assemblyReferences: references,
      })
    ).rejects.toThrow('belongs to assembly grch37, not grch38');
    expect(admitIndexedBigWigRequest).not.toHaveBeenCalled();
  });

  it('detects and routes a local BED through the common text interval adapter', async () => {
    const automatic = request({
      source: { kind: 'local-file', path: '/analysis/regions.bed' },
      formatId: undefined,
      ingress: { kind: 'file-picker' },
    });

    const source = await admitTrackSource({
      request: automatic,
      assemblyId: 'grch38',
      assemblyReferences: references,
    });

    expect(admitTextIntervalTrackRequest).toHaveBeenCalledWith({
      request: expect.objectContaining({ formatId: 'bed' }),
      assemblyReferences: references,
      signal: undefined,
      localAuthorityContext: undefined,
    });
    expect(source).toMatchObject({ formatId: 'bed', readerKind: 'interval-text' });
  });

  it.each(['bam', 'cram'] as const)(
    'routes %s through the aligned-read adapter with the shared admission request',
    async (formatId) => {
      const admissionRequest = request({
        source: { kind: 'local-file', path: `/analysis/reads.${formatId}` },
        formatId,
        scientificKind: 'reads',
        ingress: { kind: 'file-picker' },
      });

      const source = await admitTrackSource({
        request: admissionRequest,
        assemblyId: 'grch38',
        assemblyReferences: references,
      });

      expect(admitAlignedReadTrackRequest).toHaveBeenCalledWith({
        request: admissionRequest,
        assemblyReferences: references,
        signal: undefined,
      });
      expect(source).toMatchObject({
        formatId,
        readerKind: 'bam',
        scientificKind: 'reads',
      });
    }
  );

  it.each(['vcf', 'bcf'] as const)(
    'routes remote %s through the variant adapter and forwards its runtime receipt',
    async (formatId) => {
      const onVariantRuntime = vi.fn();
      const admissionRequest = request({
        source: { kind: 'http', url: `https://variants.example.org/sample.${formatId}` },
        index: {
          kind: 'http',
          url: `https://variants.example.org/sample.${formatId}.${formatId === 'vcf' ? 'tbi' : 'csi'}`,
        },
        formatId,
        scientificKind: 'variants',
      });

      const source = await admitTrackSource({
        request: admissionRequest,
        assemblyId: 'grch38',
        assemblyReferences: references,
        onVariantRuntime,
      });

      expect(admitVariantTrackRequest).toHaveBeenCalledWith({
        request: admissionRequest,
        assemblyReferences: references,
        signal: undefined,
        onRuntimeReady: onVariantRuntime,
      });
      expect(source).toMatchObject({ formatId, readerKind: 'variant', scientificKind: 'variants' });
    }
  );
});

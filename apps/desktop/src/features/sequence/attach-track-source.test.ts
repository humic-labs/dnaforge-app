import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TRACK_ADMISSION_REQUEST_V1,
  type CurrentAdmittedTrackSource,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';

import { attachTrackAdmissionRequest } from './attach-track-source';
import { useLaneContractStore } from './lane-contract-store';
import { admitTrackSource } from './track-admission';

vi.mock('./track-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./track-admission')>()),
  admitTrackSource: vi.fn(),
}));

const BASE_REQUEST: TrackAdmissionRequestV1 = {
  contract: TRACK_ADMISSION_REQUEST_V1,
  assemblyId: 'grch38',
  source: { kind: 'http', url: 'https://data.example.org/signal.bigWig' },
  formatId: 'bigwig',
  label: 'Coverage',
  ingress: { kind: 'url' },
};

function admitted(request: TrackAdmissionRequestV1): CurrentAdmittedTrackSource {
  return {
    admissionVersion: 2,
    request,
    admittedAt: '2026-09-21T18:00:00.000Z',
    uri: 'https://data.example.org/signal.bigWig',
    input: { kind: 'url', url: 'https://data.example.org/signal.bigWig' },
    formatId: 'bigwig',
    fingerprint: 'generation-1',
    readerKind: 'bbi',
    scientificKind: 'quantitative',
    quantitativeColumnSemantics: 'continuous-signal',
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
    provenance: { provider: 'direct-url', sourceKind: 'remote-url', label: 'Coverage' },
  };
}

describe('attachTrackAdmissionRequest', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
    vi.mocked(admitTrackSource)
      .mockReset()
      .mockImplementation(async ({ request }) => admitted(request));
  });

  it('attaches through the source-neutral dispatcher and creates a visible lane', async () => {
    const result = await attachTrackAdmissionRequest({
      laneOwnerId: 'tab-1',
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      request: BASE_REQUEST,
    });

    expect(result).toMatchObject({ status: 'added', label: 'Coverage' });
    expect(admitTrackSource).toHaveBeenCalledWith(
      expect.objectContaining({ request: BASE_REQUEST, assemblyId: 'grch38' })
    );
    expect(useLaneContractStore.getState().lanesForOwner('tab-1')).toEqual([
      expect.objectContaining({
        visible: true,
        source: expect.objectContaining({ admissionVersion: 2, request: BASE_REQUEST }),
        dataset: expect.objectContaining({ label: 'Coverage', trackPx: 96 }),
      }),
    ]);
  });

  it('attaches an admitted transcript BigBed to the transcript renderer', async () => {
    const request: TrackAdmissionRequestV1 = {
      ...BASE_REQUEST,
      source: { kind: 'http', url: 'https://data.example.org/transcripts.bb' },
      formatId: 'bigbed',
      scientificKind: 'transcript',
      label: 'Transcripts',
    };
    vi.mocked(admitTrackSource).mockResolvedValueOnce({
      ...admitted(request),
      uri: 'https://data.example.org/transcripts.bb',
      input: { kind: 'url', url: 'https://data.example.org/transcripts.bb' },
      formatId: 'bigbed',
      scientificKind: 'transcript',
      provenance: { provider: 'direct-url', sourceKind: 'remote-url', label: 'Transcripts' },
    });

    const result = await attachTrackAdmissionRequest({
      laneOwnerId: 'tab-1',
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      request,
    });

    expect(result.status).toBe('added');
    expect(useLaneContractStore.getState().lanesForOwner('tab-1')).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ formatId: 'bigbed', scientificKind: 'transcript' }),
        dataset: expect.objectContaining({
          trackType: 'imported-transcript',
          label: 'Transcripts',
          trackPx: 160,
        }),
      }),
    ]);
  });

  it('deduplicates the same source across URL, manifest, and automation ingress', async () => {
    const first = await attachTrackAdmissionRequest({
      laneOwnerId: 'tab-1',
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      request: BASE_REQUEST,
    });
    const second = await attachTrackAdmissionRequest({
      laneOwnerId: 'tab-1',
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      request: {
        ...BASE_REQUEST,
        label: 'A later label',
        ingress: { kind: 'manifest', manifestId: 'run-42' },
      },
    });
    const third = await attachTrackAdmissionRequest({
      laneOwnerId: 'tab-1',
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      request: { ...BASE_REQUEST, ingress: { kind: 'automation' } },
    });

    expect(first.trackId).toBe(second.trackId);
    expect(second.trackId).toBe(third.trackId);
    expect(second).toMatchObject({ status: 'duplicate', label: 'Coverage' });
    expect(third).toMatchObject({ status: 'duplicate', label: 'Coverage' });
    expect(admitTrackSource).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent admissions before committing one lane', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(admitTrackSource).mockImplementationOnce(async ({ request }) => {
      await gate;
      return admitted(request);
    });

    const first = attachTrackAdmissionRequest({
      laneOwnerId: 'tab-1',
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      request: BASE_REQUEST,
    });
    const second = attachTrackAdmissionRequest({
      laneOwnerId: 'tab-1',
      assemblyId: 'grch38',
      assemblyReferences: [{ name: 'chr1', length: 1_000 }],
      request: BASE_REQUEST,
    });
    release();

    expect((await first).status).toBe('added');
    expect((await second).status).toBe('duplicate');
    expect(admitTrackSource).toHaveBeenCalledTimes(1);
    expect(useLaneContractStore.getState().lanesForOwner('tab-1')).toHaveLength(1);
  });
});

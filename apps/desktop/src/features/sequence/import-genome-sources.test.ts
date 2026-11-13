import {
  TRACK_ADMISSION_REQUEST_V1,
  createTrackAdmissionRequestId,
  type AdmittedTrackSource,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../platform', () => ({ platform: () => ({}) }));
vi.mock('./alignment-coverage-operation-client', () => ({
  startAlignmentCoverageOperation: vi.fn(async () => ({ id: 'coverage-operation' })),
}));

import type { IndexedGenomeVariantSourceState } from '../../shared/indexed-genome';
import { useCanvasStore } from '../canvas/public/store';
import { startAlignmentCoverageOperation } from './alignment-coverage-operation-client';
import { commitVariantSourceToTab } from './attach-variant-request';
import { genomeSourceImportFamily, importGenomeSources } from './import-genome-sources';
import { useLaneContractStore } from './lane-contract-store';
import type { admitTrackSource } from './track-admission';

const ASSEMBLY_ID = 'saccer3-lab';
const LANE_OWNER = 'tab-genome-1';
const REFERENCES = [{ name: 'chrIV', length: 1_531_933 }];
const RECEIPT_STAMP = '2026-09-22T12:00:00.000Z';

type AdmitInput = Parameters<typeof admitTrackSource>[0];

function request(
  overrides: Partial<TrackAdmissionRequestV1> & Pick<TrackAdmissionRequestV1, 'source'>
): TrackAdmissionRequestV1 {
  return {
    contract: TRACK_ADMISSION_REQUEST_V1,
    assemblyId: ASSEMBLY_ID,
    ingress: { kind: 'automation' },
    ...overrides,
  };
}

const SIGNAL_URL = request({
  source: { kind: 'http', url: 'https://results.example.org/run/signal.bw' },
  formatId: 'bigwig',
  label: 'Signal',
});
const LOCAL_CRAM = request({
  source: { kind: 'local-file', path: '/lab/reads/reads.cram' },
  index: { kind: 'local-file', path: '/lab/reads/reads.cram.crai' },
  reference: { kind: 'local-file', path: '/lab/reference/saccer3.fa' },
  formatId: 'cram',
});
const REMOTE_VCF = request({
  source: { kind: 'http', url: 'https://variants.example.org/s288c/calls.vcf.gz' },
  index: { kind: 'http', url: 'https://variants.example.org/s288c/calls.vcf.gz.tbi' },
  formatId: 'vcf',
  label: 'Calls',
});

const RECEIPT_BASE = {
  admissionVersion: 2 as const,
  admittedAt: RECEIPT_STAMP,
  assemblyId: ASSEMBLY_ID,
  referenceReceipt: {
    assemblyId: ASSEMBLY_ID,
    referenceSignature: 'chrIV',
    sourceSignature: 'chrIV',
    contigMap: { chrIV: 'chrIV' },
    checkedContigs: 1,
    status: 'compatible' as const,
    checkedAt: RECEIPT_STAMP,
  },
};

function receiptFor(input: AdmitInput): AdmittedTrackSource {
  const { request: admission } = input;
  switch (admission.formatId) {
    case 'bigwig': {
      if (admission.source.kind !== 'http') throw new Error('test expects an http BigWig');
      return {
        ...RECEIPT_BASE,
        request: admission,
        uri: admission.source.url,
        input: { kind: 'url', url: admission.source.url },
        formatId: 'bigwig',
        fingerprint: `sha256:${'a'.repeat(64)}`,
        readerKind: 'bbi',
        scientificKind: 'quantitative',
        provenance: { provider: 'direct-url', sourceKind: 'remote-url', label: 'Signal' },
      };
    }
    case 'cram': {
      if (admission.source.kind !== 'local-file') throw new Error('test expects a local CRAM');
      const bamPath = admission.source.path;
      const indexPath = `${bamPath}.crai`;
      input.onAlignedReadRuntime?.({
        source: { bamPath, indexPath, referencePath: '/lab/reference/saccer3.fa' },
      });
      return {
        ...RECEIPT_BASE,
        request: admission,
        uri: `file://${bamPath}`,
        input: { kind: 'path', path: bamPath },
        index: { kind: 'path', path: indexPath },
        reference: { kind: 'path', path: '/lab/reference/saccer3.fa' },
        formatId: 'cram',
        fingerprint: `sha256:${'b'.repeat(64)}`,
        readerKind: 'bam',
        scientificKind: 'reads',
        provenance: { label: 'reads.cram' },
        alignedReadIndexState: 'present',
      };
    }
    case 'vcf': {
      if (admission.source.kind !== 'http' || admission.index?.kind !== 'http') {
        throw new Error('test expects a remote VCF with an index URL');
      }
      input.onVariantRuntime?.({
        runtime: {
          format: 'vcf',
          sourceToken: 'inert-source-token',
          indexToken: 'inert-index-token',
          sourceIdentity: 'vcf-source-1',
          assemblyRevision: 'rev-1',
          matchedReferences: ['chrIV'],
          samples: ['tumor'],
          grantExpiresAtMs: Date.now() + 60_000,
        },
      });
      return {
        ...RECEIPT_BASE,
        request: admission,
        uri: admission.source.url,
        input: { kind: 'url', url: admission.source.url },
        index: { kind: 'url', url: admission.index.url },
        formatId: 'vcf',
        fingerprint: `sha256:${'c'.repeat(64)}`,
        readerKind: 'variant',
        scientificKind: 'variants',
        provenance: { label: 'Calls' },
        expectedValidators: { contentLength: 2_048 },
      };
    }
    default:
      throw new Error(`unexpected format ${admission.formatId ?? 'unknown'}`);
  }
}

function genomeInput(overrides: Partial<Parameters<typeof importGenomeSources>[0]> = {}) {
  return {
    laneOwnerId: LANE_OWNER,
    assemblyId: ASSEMBLY_ID,
    assemblyDisplayName: 'Lab yeast',
    assemblyReferences: REFERENCES,
    requests: [] as ReadonlyArray<TrackAdmissionRequestV1>,
    ...overrides,
  };
}

beforeEach(() => {
  useLaneContractStore.setState({ lanesByOwnerId: {} });
  vi.mocked(startAlignmentCoverageOperation).mockClear();
});

describe('genomeSourceImportFamily', () => {
  it('routes by the resolved format', () => {
    expect(genomeSourceImportFamily('bam')).toBe('reads');
    expect(genomeSourceImportFamily('cram')).toBe('reads');
    expect(genomeSourceImportFamily('vcf')).toBe('variants');
    expect(genomeSourceImportFamily('bcf')).toBe('variants');
    expect(genomeSourceImportFamily('bigwig')).toBe('data');
    expect(genomeSourceImportFamily(undefined)).toBe('data');
  });
});

describe('importGenomeSources', () => {
  it('attaches every family through its own path and reports one outcome per source', async () => {
    const admit = vi.fn(async (input: AdmitInput) => receiptFor(input));
    const committed: IndexedGenomeVariantSourceState[] = [];
    const progress: string[] = [];

    const outcomes = await importGenomeSources(
      genomeInput({
        requests: [SIGNAL_URL, LOCAL_CRAM, REMOTE_VCF],
        admit,
        commitVariantSource: (source) => {
          committed.push(source);
          return 'added';
        },
        onProgress: (event) =>
          progress.push(
            `${event.sourceNumber}/${event.sourceCount} ${event.family} ${event.phase}`
          ),
      })
    );

    expect(outcomes.map((outcome) => [outcome.family, outcome.status])).toEqual([
      ['data', 'added'],
      ['reads', 'added'],
      ['variants', 'added'],
    ]);
    expect(outcomes[0]).toMatchObject({
      trackId: createTrackAdmissionRequestId(SIGNAL_URL),
      label: 'Signal',
    });
    expect(outcomes[1]).toMatchObject({
      trackId: expect.stringMatching(/^pileup-saccer3-lab-/u),
      label: 'Lab yeast: reads.cram',
    });
    expect(outcomes[2]).toMatchObject({ trackId: 'variant:vcf-source-1', label: 'Calls' });
    expect(admit).toHaveBeenCalledTimes(3);
    expect(
      useLaneContractStore
        .getState()
        .lanesForOwner(LANE_OWNER)
        .map((lane) => (lane.dataset.kind === 'pileup' ? 'pileup' : lane.dataset.trackType))
    ).toEqual(['quantitative', 'pileup']);
    expect(committed).toEqual([
      expect.objectContaining({
        sourceIdentity: 'vcf-source-1',
        label: 'Calls',
        matchedReferences: ['chrIV'],
      }),
    ]);
    expect(startAlignmentCoverageOperation).not.toHaveBeenCalled();
    expect(progress[0]).toBe('1/3 data admitting');
    expect(progress).toContain('2/3 reads adding-track');
  });

  it('reports a source already on the tab as a duplicate without admitting it again', async () => {
    const admit = vi.fn(async (input: AdmitInput) => receiptFor(input));
    const first = await importGenomeSources(genomeInput({ requests: [SIGNAL_URL], admit }));
    const second = await importGenomeSources(genomeInput({ requests: [SIGNAL_URL], admit }));
    expect(first[0]?.status).toBe('added');
    expect(second[0]).toMatchObject({ status: 'duplicate', trackId: first[0]?.trackId });
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it('keeps going past an invalid request and a failed admission', async () => {
    const admit = vi.fn(async (input: AdmitInput) => {
      if (input.request.formatId === 'bigwig') throw new Error('BigWig header is unreadable.');
      return receiptFor(input);
    });
    const outcomes = await importGenomeSources(
      genomeInput({
        requests: [{ ...SIGNAL_URL, assemblyId: 'another-assembly' }, SIGNAL_URL, REMOTE_VCF],
        admit,
        commitVariantSource: () => 'added',
      })
    );
    expect(outcomes).toEqual([
      expect.objectContaining({
        status: 'failed',
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('belongs to assembly another-assembly'),
      }),
      expect.objectContaining({
        status: 'failed',
        code: 'ADMISSION_FAILED',
        message: 'BigWig header is unreadable.',
      }),
      expect.objectContaining({ family: 'variants', status: 'added' }),
    ]);
    expect(useLaneContractStore.getState().lanesForOwner(LANE_OWNER)).toEqual([]);
  });

  it('marks every remaining source cancelled once the import is aborted', async () => {
    const admit = vi.fn(async (input: AdmitInput) => receiptFor(input));
    const controller = new AbortController();
    controller.abort();
    const outcomes = await importGenomeSources(
      genomeInput({ requests: [SIGNAL_URL, REMOTE_VCF], admit, signal: controller.signal })
    );
    expect(outcomes.map((outcome) => (outcome.status === 'failed' ? outcome.code : null))).toEqual([
      'CANCELLED',
      'CANCELLED',
    ]);
    expect(admit).not.toHaveBeenCalled();
  });
});

describe('commitVariantSourceToTab', () => {
  it('commits once into the owning tab and reports the same source as a duplicate', () => {
    const tabId = useCanvasStore.getState().openTab('main', {
      type: 'sequence',
      entityId: 'assembly:lab',
      label: 'Lab yeast',
      sequenceDocument: { kind: 'indexed-sequence', documentId: 'assembly:lab' },
      indexedGenome: {
        sourcePath: '/lab/reference/saccer3.fa',
        sourceExt: 'fa',
        chrom: 'chrIV',
        scope: { kind: 'all' },
      },
    });
    const source = {
      sourcePath: 'https://variants.example.org/s288c/calls.vcf.gz',
      queryPath: 'https://variants.example.org/s288c/calls.vcf.gz',
      indexPath: 'https://variants.example.org/s288c/calls.vcf.gz.tbi',
      format: 'vcf',
      label: 'Calls',
      sourceSizeBytes: 2_048,
      sourceIdentity: 'vcf-source-1',
      assemblyRevision: 'rev-1',
      matchedReferences: ['chrIV'],
      samples: ['tumor'],
      attachedAt: 1,
    } as IndexedGenomeVariantSourceState;
    const commit = commitVariantSourceToTab(tabId);

    expect(commit(source)).toBe('added');
    const tab = Object.values(useCanvasStore.getState().panels)
      .flatMap((panel) => panel.tabs)
      .find((candidate) => candidate.id === tabId);
    expect(tab?.indexedGenome?.variantSource).toEqual(source);
    expect(tab?.isDirty).toBe(true);
    expect(commit(source)).toBe('duplicate');
    expect(() => commitVariantSourceToTab('missing-tab')(source)).toThrow('no longer open');
  });
});

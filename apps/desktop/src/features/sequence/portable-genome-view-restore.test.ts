import {
  TRACK_ADMISSION_REQUEST_V1,
  type AdmittedTrackSource,
  type PortableGenomeViewTrack,
  type PortableGenomeViewTrackPresentation,
  type TrackAdmissionRequestV1,
} from '@waypoint/genome-data';
import { describe, expect, it, vi } from 'vitest';

import { portableAdmittedContentFingerprint } from './portable-genome-view-adapter';
import {
  admitPortableTracks,
  planPortableTrackRestore,
  portableRequestAuthRefs,
  relinkPortableTrack,
  summarizePortableTrackOutcomes,
  type PortableRestoreDeps,
} from './portable-genome-view-restore';
import type { admitTrackSource } from './track-admission';

const ASSEMBLY_ID = 'saccer3-lab';
const REFERENCE_SIGNATURE = `sha256:${'e'.repeat(64)}`;
const CONTENT_FINGERPRINT = `sha256:${'d'.repeat(64)}`;
const CHANGED_FINGERPRINT = `sha256:${'f'.repeat(64)}`;
const ASSEMBLY_REFERENCES = [
  { name: 'chrI', length: 230218 },
  { name: 'chrII', length: 813184 },
];

type AdmitInput = Parameters<typeof admitTrackSource>[0];

function request(
  overrides: Partial<TrackAdmissionRequestV1> & Pick<TrackAdmissionRequestV1, 'source'>
): TrackAdmissionRequestV1 {
  return {
    contract: TRACK_ADMISSION_REQUEST_V1,
    assemblyId: ASSEMBLY_ID,
    ingress: { kind: 'file-picker' },
    ...overrides,
  };
}

const LOCAL_SIGNAL = request({
  source: { kind: 'local-file', path: '/lab/signal/coverage.bw' },
  formatId: 'bigwig',
  scientificKind: 'quantitative',
  label: 'Coverage',
});

const LOCAL_CRAM = request({
  source: { kind: 'local-file', path: '/lab/reads/sample.cram' },
  index: { kind: 'local-file', path: '/lab/reads/sample.cram.crai' },
  reference: { kind: 'local-file', path: '/lab/reference/saccer3.fa' },
  formatId: 'cram',
  scientificKind: 'reads',
  label: 'Sample reads',
});

const PRIVATE_VCF = request({
  source: { kind: 'http', url: 'https://private.example.org/calls.vcf.gz', authRef: 'lab-vcf' },
  index: {
    kind: 'http',
    url: 'https://private.example.org/calls.vcf.gz.tbi',
    authRef: 'lab-vcf',
  },
  formatId: 'vcf',
  scientificKind: 'variants',
  label: 'Calls',
  ingress: { kind: 'url' },
});

const HUB_GENES = request({
  source: {
    kind: 'ucsc-track',
    sourceKind: 'ucsc-hub',
    genome: 'sacCer3',
    track: 'genes',
    hubUrl: 'https://hub.example.org/hub.txt',
  },
  formatId: 'bigbed',
  scientificKind: 'transcript',
  ingress: { kind: 'hub' },
});

const QUANTITATIVE: PortableGenomeViewTrackPresentation = {
  kind: 'quantitative',
  color: '#3366cc',
  trackHeightPx: 48,
  scale: { kind: 'auto' },
};

const ANNOTATION: PortableGenomeViewTrackPresentation = {
  kind: 'annotation',
  color: '#cc6633',
  trackHeightPx: 64,
  laneHeightPx: 12,
  maxLanes: 4,
};

const ALIGNED_READS: PortableGenomeViewTrackPresentation = {
  kind: 'aligned-reads',
  coverageCutoffDepth: 40,
};

function admittedTrack(
  trackId: string,
  order: number,
  admission: TrackAdmissionRequestV1,
  presentation: PortableGenomeViewTrackPresentation,
  contentFingerprint = CONTENT_FINGERPRINT
): PortableGenomeViewTrack {
  return {
    trackId,
    trackType:
      presentation.kind === 'quantitative'
        ? 'signal'
        : presentation.kind === 'aligned-reads'
          ? 'reads'
          : 'gene',
    label: admission.label ?? trackId,
    order,
    visible: true,
    source: {
      kind: 'admitted-source',
      request: admission,
      assemblyId: ASSEMBLY_ID,
      contentFingerprint,
      referenceSignature: REFERENCE_SIGNATURE,
    },
    presentation,
  };
}

function hostedTrack(trackId: string, order: number): PortableGenomeViewTrack {
  return {
    trackId,
    trackType: 'signal',
    label: 'GC percent',
    order,
    visible: true,
    source: {
      kind: 'hosted-track',
      provider: 'ucsc',
      catalogId: 'gc5BaseBw',
      assemblyId: ASSEMBLY_ID,
      contentFingerprint: CONTENT_FINGERPRINT,
      referenceSignature: REFERENCE_SIGNATURE,
    },
    presentation: QUANTITATIVE,
  };
}

function workspaceTrack(trackId: string, order: number): PortableGenomeViewTrack {
  return {
    trackId,
    trackType: 'gene',
    label: 'Project annotations',
    order,
    visible: true,
    source: {
      kind: 'workspace-track',
      entityId: 'entity-1',
      assemblyId: ASSEMBLY_ID,
      contentFingerprint: CONTENT_FINGERPRINT,
      referenceSignature: REFERENCE_SIGNATURE,
    },
    presentation: ANNOTATION,
  };
}

function receipt(
  admission: TrackAdmissionRequestV1,
  overrides: Partial<AdmittedTrackSource> = {}
): AdmittedTrackSource {
  const source = admission.source;
  const path = source.kind === 'local-file' ? source.path : null;
  const url = source.kind === 'http' ? source.url : null;
  return {
    admissionVersion: 2,
    request: admission,
    admittedAt: '2026-09-21T12:00:00.000Z',
    uri: path ? `file://${path}` : (url ?? `ucsc:${ASSEMBLY_ID}`),
    formatId: admission.formatId ?? 'bigwig',
    ...(path ? { input: { kind: 'path', path } } : url ? { input: { kind: 'url', url } } : {}),
    fingerprint: CONTENT_FINGERPRINT,
    readerKind: 'bbi',
    scientificKind: admission.scientificKind ?? 'quantitative',
    assemblyId: ASSEMBLY_ID,
    referenceReceipt: {
      assemblyId: ASSEMBLY_ID,
      referenceSignature: REFERENCE_SIGNATURE,
      sourceSignature: 'inert-source-signature',
      contigMap: { chrI: 'chrI', chrII: 'chrII' },
      checkedContigs: 2,
      status: 'compatible',
      checkedAt: '2026-09-21T12:00:00.000Z',
    },
    provenance: { label: admission.label ?? 'track' },
    ...overrides,
  };
}

function readsGeneration(root: string, mtimeNs = '1700000000000000000') {
  const file = (name: string, size: number) => ({
    canonicalPath: `${root}/${name}`,
    size,
    mtimeNs,
    ctimeNs: `${mtimeNs}1`,
  });
  return {
    contract: 'aligned-read-source-generation.v1' as const,
    alignment: file('reads.cram', 757),
    index: file('reads.cram.crai', 45),
  };
}

function readsReceipt(admission: TrackAdmissionRequestV1, root: string, mtimeNs?: string) {
  return receipt(admission, {
    readerKind: 'bam',
    fingerprint: `sha256:${root.length.toString(16).padStart(64, '0')}`,
    index: {
      kind: 'path',
      path:
        admission.index?.kind === 'local-file' ? admission.index.path : `${root}/reads.cram.crai`,
    },
    reference: { kind: 'path', path: '/lab/reference/saccer3.fa' },
    alignedReadGeneration: readsGeneration(root, mtimeNs),
  });
}

function deps(overrides: Partial<PortableRestoreDeps> = {}): PortableRestoreDeps {
  return {
    exists: async () => true,
    credentialConnected: async () => true,
    ...overrides,
  };
}

describe('planPortableTrackRestore', () => {
  it('classifies every saved track by what this machine is missing', async () => {
    const present = new Set(['/lab/signal/coverage.bw', '/lab/reads/sample.cram']);
    const plan = await planPortableTrackRestore(
      [
        hostedTrack('hosted', 0),
        admittedTrack('signal', 1, LOCAL_SIGNAL, QUANTITATIVE),
        admittedTrack('reads', 2, LOCAL_CRAM, ALIGNED_READS),
        admittedTrack('calls', 3, PRIVATE_VCF, {
          kind: 'variants',
          selectedSamples: [],
          filteredToPassing: false,
        }),
        admittedTrack('hub-genes', 4, HUB_GENES, ANNOTATION),
        workspaceTrack('project', 5),
      ],
      deps({
        exists: async (path) => present.has(path),
        credentialConnected: async (authRef) => authRef !== 'lab-vcf',
      })
    );

    expect(plan.map((resolution) => [resolution.track.trackId, resolution.status])).toEqual([
      ['hosted', 'ready'],
      ['signal', 'ready'],
      ['reads', 'relink-required'],
      ['calls', 'credential-required'],
      ['hub-genes', 'ready'],
      ['project', 'unsupported'],
    ]);
    const reads = plan[2];
    if (reads?.status !== 'relink-required') throw new Error('expected a relink plan');
    expect(reads.missing).toEqual([
      { role: 'index', path: '/lab/reads/sample.cram.crai' },
      { role: 'reference', path: '/lab/reference/saccer3.fa' },
    ]);
    const calls = plan[3];
    if (calls?.status !== 'credential-required') throw new Error('expected a credential plan');
    expect(calls.authRefs).toEqual(['lab-vcf']);
  });

  it('never touches the filesystem or keychain for hosted and hub sources', async () => {
    const exists = vi.fn(async () => false);
    const credentialConnected = vi.fn(async () => false);
    const plan = await planPortableTrackRestore(
      [hostedTrack('hosted', 0), admittedTrack('hub-genes', 1, HUB_GENES, ANNOTATION)],
      deps({ exists, credentialConnected })
    );
    expect(plan.every((resolution) => resolution.status === 'ready')).toBe(true);
    expect(exists).not.toHaveBeenCalled();
    expect(credentialConnected).not.toHaveBeenCalled();
  });
});

describe('relinkPortableTrack', () => {
  it('replaces only the local locators the user pointed at new files', () => {
    const relinked = relinkPortableTrack(admittedTrack('reads', 0, LOCAL_CRAM, ALIGNED_READS), {
      source: '/moved/sample.cram',
      index: '/moved/sample.cram.crai',
    });
    if (relinked.source.kind !== 'admitted-source') throw new Error('expected admitted source');
    expect(relinked.source.request).toEqual({
      ...LOCAL_CRAM,
      source: { kind: 'local-file', path: '/moved/sample.cram' },
      index: { kind: 'local-file', path: '/moved/sample.cram.crai' },
    });
    expect(relinked.source.contentFingerprint).toBe(CONTENT_FINGERPRINT);
  });

  it('refuses a relative replacement path like any other request input', () => {
    expect(() =>
      relinkPortableTrack(admittedTrack('reads', 0, LOCAL_CRAM, ALIGNED_READS), {
        index: 'reads/sample.cram.crai',
      })
    ).toThrow('index path must be an absolute path');
  });

  it('leaves remote locators alone even when a replacement names their role', () => {
    const track = admittedTrack('calls', 0, PRIVATE_VCF, {
      kind: 'variants',
      selectedSamples: [],
      filteredToPassing: false,
    });
    expect(relinkPortableTrack(track, { source: '/local/calls.vcf.gz' })).toEqual(track);
    expect(portableRequestAuthRefs(PRIVATE_VCF)).toEqual(['lab-vcf']);
  });
});

describe('admitPortableTracks', () => {
  it('restores each admitted source through one admission call and reports it', async () => {
    const savedFingerprint = await portableAdmittedContentFingerprint(
      readsReceipt(LOCAL_CRAM, '/lab/reads')
    );
    const admit = vi.fn(async (input: AdmitInput): Promise<AdmittedTrackSource> => {
      if (input.request.formatId === 'cram') return readsReceipt(input.request, '/moved');
      return receipt(input.request);
    });
    const relinkedReads = relinkPortableTrack(
      admittedTrack('reads', 1, LOCAL_CRAM, ALIGNED_READS, savedFingerprint),
      { source: '/moved/sample.cram', index: '/moved/sample.cram.crai' }
    );
    const progress: string[] = [];

    const result = await admitPortableTracks({
      tracks: [admittedTrack('signal', 0, LOCAL_SIGNAL, QUANTITATIVE), relinkedReads],
      relinkedTrackIds: new Set(['reads']),
      acceptChangedData: false,
      assemblyId: ASSEMBLY_ID,
      assemblyDisplayName: 'Lab yeast',
      assemblyReferences: ASSEMBLY_REFERENCES,
      admit,
      onProgress: (label) => progress.push(label),
    });

    expect(admit).toHaveBeenCalledTimes(2);
    expect(admit.mock.calls[0]?.[0]).toMatchObject({
      request: LOCAL_SIGNAL,
      assemblyId: ASSEMBLY_ID,
      assemblyDisplayName: 'Lab yeast',
      assemblyReferences: ASSEMBLY_REFERENCES,
      localAuthorityContext: 'workspace-grounded',
    });
    expect(result.dataTracks).toHaveLength(1);
    expect(result.dataTracks[0]).toMatchObject({
      trackId: 'signal',
      label: 'Coverage',
      order: 0,
      color: 0x3366cc,
      trackPx: 48,
      visible: true,
      source: { uri: 'file:///lab/signal/coverage.bw', scientificKind: 'quantitative' },
    });
    expect(result.bamTracks).toEqual([
      {
        trackId: 'reads',
        label: 'Sample reads',
        order: 1,
        source: {
          bamPath: '/moved/sample.cram',
          indexPath: '/moved/sample.cram.crai',
          referencePath: '/lab/reference/saccer3.fa',
          generation: expect.objectContaining({ contract: 'aligned-read-source-generation.v1' }),
        },
        admittedSource: expect.objectContaining({ readerKind: 'bam', formatId: 'cram' }),
        visible: true,
        coverageCutoffDepth: 40,
      },
    ]);
    expect(result.variantSource).toBeUndefined();
    expect(result.outcomes).toEqual([
      { trackId: 'signal', label: 'Coverage', status: 'restored' },
      { trackId: 'reads', label: 'Sample reads', status: 'relinked' },
    ]);
    expect(progress).toEqual(['Restoring Coverage…', 'Restoring Sample reads…']);
  });

  it('treats a relinked bundle with a different modification time as changed data', async () => {
    const savedFingerprint = await portableAdmittedContentFingerprint(
      readsReceipt(LOCAL_CRAM, '/lab/reads')
    );
    const admit = vi.fn(async (input: AdmitInput) =>
      readsReceipt(input.request, '/moved', '1800000000000000000')
    );
    const result = await admitPortableTracks({
      tracks: [
        relinkPortableTrack(
          admittedTrack('reads', 0, LOCAL_CRAM, ALIGNED_READS, savedFingerprint),
          {
            source: '/moved/sample.cram',
            index: '/moved/sample.cram.crai',
          }
        ),
      ],
      relinkedTrackIds: new Set(['reads']),
      acceptChangedData: false,
      assemblyId: ASSEMBLY_ID,
      assemblyDisplayName: 'Lab yeast',
      assemblyReferences: ASSEMBLY_REFERENCES,
      admit,
    });
    expect(result.bamTracks).toEqual([]);
    expect(result.outcomes).toEqual([
      {
        trackId: 'reads',
        label: 'Sample reads',
        status: 'skipped',
        message: 'Sample reads changed since this view was saved and was not restored.',
      },
    ]);
  });

  it('skips changed data unless the user accepted it, and always says so', async () => {
    const admit = vi.fn(async (input: AdmitInput) =>
      receipt(input.request, { fingerprint: CHANGED_FINGERPRINT })
    );
    const tracks = [admittedTrack('signal', 0, LOCAL_SIGNAL, QUANTITATIVE)];
    const base = {
      tracks,
      assemblyId: ASSEMBLY_ID,
      assemblyDisplayName: 'Lab yeast',
      assemblyReferences: ASSEMBLY_REFERENCES,
      admit,
    };

    const refused = await admitPortableTracks({ ...base, acceptChangedData: false });
    expect(refused.dataTracks).toEqual([]);
    expect(refused.outcomes).toEqual([
      {
        trackId: 'signal',
        label: 'Coverage',
        status: 'skipped',
        message: 'Coverage changed since this view was saved and was not restored.',
      },
    ]);

    const accepted = await admitPortableTracks({ ...base, acceptChangedData: true });
    expect(accepted.dataTracks).toHaveLength(1);
    expect(accepted.outcomes).toEqual([
      {
        trackId: 'signal',
        label: 'Coverage',
        status: 'changed',
        message: 'Coverage restored with data that changed since it was saved.',
      },
    ]);
  });

  it('keeps going past a failed source and never admits a skipped one', async () => {
    const admit = vi.fn(async (input: AdmitInput): Promise<AdmittedTrackSource> => {
      if (input.request.label === 'Coverage') throw new Error('BigWig header is unreadable.');
      return receipt(input.request);
    });
    const resolveHosted = vi.fn(async () => {
      throw new Error('hosted resolution must not run for a skipped track');
    });

    const result = await admitPortableTracks({
      tracks: [
        admittedTrack('signal', 0, LOCAL_SIGNAL, QUANTITATIVE),
        hostedTrack('hosted', 1),
        admittedTrack('hub-genes', 2, HUB_GENES, ANNOTATION),
      ],
      skippedTrackIds: new Set(['hosted']),
      acceptChangedData: false,
      assemblyId: ASSEMBLY_ID,
      assemblyDisplayName: 'Lab yeast',
      assemblyReferences: ASSEMBLY_REFERENCES,
      admit,
      resolveHosted,
    });

    expect(resolveHosted).not.toHaveBeenCalled();
    expect(result.dataTracks.map((track) => track.trackId)).toEqual(['hub-genes']);
    expect(result.outcomes).toEqual([
      {
        trackId: 'signal',
        label: 'Coverage',
        status: 'failed',
        message: 'BigWig header is unreadable.',
      },
      { trackId: 'hosted', label: 'GC percent', status: 'skipped' },
      { trackId: 'hub-genes', label: 'hub-genes', status: 'restored' },
    ]);
    expect(summarizePortableTrackOutcomes(result.outcomes)).toBe(
      '1 of 3 tracks restored, 1 skipped, 1 failed.'
    );
  });

  it('refuses a presentation that disagrees with what the source admitted as', async () => {
    const admit = vi.fn(async (input: AdmitInput) =>
      receipt(input.request, { scientificKind: 'transcript', formatId: 'bigbed' })
    );
    const result = await admitPortableTracks({
      tracks: [admittedTrack('signal', 0, LOCAL_SIGNAL, QUANTITATIVE)],
      acceptChangedData: false,
      assemblyId: ASSEMBLY_ID,
      assemblyDisplayName: 'Lab yeast',
      assemblyReferences: ASSEMBLY_REFERENCES,
      admit,
    });
    expect(result.dataTracks).toEqual([]);
    expect(result.outcomes[0]).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('refused to reinterpret the track'),
    });
  });

  it('stops at the first source once the open is cancelled', async () => {
    const controller = new AbortController();
    const admit = vi.fn(async (input: AdmitInput) => {
      controller.abort();
      return receipt(input.request);
    });
    await expect(
      admitPortableTracks({
        tracks: [
          admittedTrack('signal', 0, LOCAL_SIGNAL, QUANTITATIVE),
          admittedTrack('hub-genes', 1, HUB_GENES, ANNOTATION),
        ],
        acceptChangedData: false,
        assemblyId: ASSEMBLY_ID,
        assemblyDisplayName: 'Lab yeast',
        assemblyReferences: ASSEMBLY_REFERENCES,
        signal: controller.signal,
        admit,
      })
    ).rejects.toThrow('Opening this view was cancelled.');
    expect(admit).toHaveBeenCalledTimes(1);
  });
});

describe('summarizePortableTrackOutcomes', () => {
  it('counts relinked and changed tracks as restored', () => {
    expect(
      summarizePortableTrackOutcomes([
        { trackId: 'a', label: 'A', status: 'restored' },
        { trackId: 'b', label: 'B', status: 'relinked' },
        { trackId: 'c', label: 'C', status: 'changed' },
        { trackId: 'd', label: 'D', status: 'skipped' },
      ])
    ).toBe('3 of 4 tracks restored, 1 relinked, 1 with changed data, 1 skipped.');
  });
});

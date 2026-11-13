import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TrackAdmissionRequestV1 } from '@waypoint/genome-data';

import { useLaneContractStore } from '../lane-contract-store';
import type { BamTrackImportController } from './useBamTrackImport';
import type { IndexedTrackImportController } from './useIndexedTrackImport';
import { useDataFileImport } from './useDataFileImport';

const { mockAuthorizeLocalIndexedTrack, mockDialogOpen, mockReadTextFileSlice, mockStat } =
  vi.hoisted(() => ({
    mockAuthorizeLocalIndexedTrack: vi.fn(),
    mockDialogOpen: vi.fn(),
    mockReadTextFileSlice: vi.fn(),
    mockStat: vi.fn(),
  }));

vi.mock('../../../platform', () => ({
  platform: () => ({
    dialog: {
      open: mockDialogOpen,
      authorizeLocalIndexedTrack: mockAuthorizeLocalIndexedTrack,
    },
    fs: { readTextFileSlice: mockReadTextFileSlice, stat: mockStat },
  }),
}));

function bamController(
  addFiles: BamTrackImportController['addFiles'],
  addRequests: BamTrackImportController['addRequests'] = vi.fn(async () => undefined)
): BamTrackImportController {
  return {
    busy: null,
    progress: null,
    notice: null,
    lastOperation: null,
    clearNotice: vi.fn(),
    recentRemoteEndpoints: [],
    refreshRemoteEndpoints: vi.fn(async () => undefined),
    addRemote: vi.fn(async () => undefined),
    addFiles,
    addRequests,
    reconnectRemoteTrack: vi.fn(async () => true),
    repairTrack: vi.fn(async () => undefined),
  };
}

function indexedController(
  addBigWigFiles: IndexedTrackImportController['addBigWigFiles'],
  addRequests: IndexedTrackImportController['addRequests'] = vi.fn(async (requests) =>
    requests.map((request) => ({
      request,
      status: 'added' as const,
      label:
        request.source.kind === 'local-file'
          ? (request.source.path.split('/').pop() ?? request.source.path)
          : request.source.kind === 'http'
            ? (new URL(request.source.url).pathname.split('/').pop() ?? request.source.url)
            : 'track',
    }))
  )
): IndexedTrackImportController {
  return {
    busy: null,
    notice: null,
    clearNotice: vi.fn(),
    addRequests,
    addBigWigFiles,
  };
}

describe('useDataFileImport', () => {
  beforeEach(() => {
    useLaneContractStore.getState().clear();
    mockDialogOpen.mockReset();
    mockReadTextFileSlice.mockReset();
    mockStat.mockReset();
    mockAuthorizeLocalIndexedTrack.mockReset();
    mockAuthorizeLocalIndexedTrack.mockImplementation(async ({ path }: { path: string }) => ({
      canonicalPath: path,
      authority: 'manifest-related-proof',
    }));
    mockStat.mockImplementation(async (path: string) => ({
      canonicalPath: path,
      size: 100,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 1,
      mtimeNs: '1',
      ctimeNs: '1',
    }));
  });

  it('uses one picker and routes mixed workflow outputs by the canonical format registry', async () => {
    mockDialogOpen.mockResolvedValue([
      '/analysis/run/sample.bam',
      '/analysis/run/coverage.bigWig',
      '/analysis/run/sample.cram',
      '/analysis/run/accessibility.bw',
      '/analysis/run/regions.bigBed',
    ]);
    const addFiles = vi.fn(async () => undefined);
    const addAlignedReadRequests = vi.fn(async () => undefined);
    const addBigWigFiles = vi.fn(async () => undefined);
    const addRequests = vi.fn<IndexedTrackImportController['addRequests']>(async (requests) =>
      requests.map((request) => ({ request, status: 'added' as const, label: 'signal' }))
    );
    const { result } = renderHook(() =>
      useDataFileImport({
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        bamImport: bamController(addFiles, addAlignedReadRequests),
        indexedImport: indexedController(addBigWigFiles, addRequests),
      })
    );

    await act(async () => result.current.openFiles());

    expect(mockDialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: true,
        title: 'Add data to GRCh38',
        filters: expect.arrayContaining([
          expect.objectContaining({
            extensions: expect.arrayContaining([
              'bam',
              'cram',
              'bb',
              'bw',
              'bed',
              'gff3',
              'gtf',
              'genePred',
              'refFlat',
              'narrowPeak',
              'broadPeak',
              'gz',
              'bgz',
              'json',
            ]),
          }),
        ]),
      })
    );
    expect(addFiles).not.toHaveBeenCalled();
    expect(addAlignedReadRequests).toHaveBeenCalledWith([
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/sample.bam' },
        formatId: 'bam',
        scientificKind: 'reads',
        ingress: { kind: 'file-picker' },
      }),
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/sample.cram' },
        formatId: 'cram',
        scientificKind: 'reads',
        ingress: { kind: 'file-picker' },
      }),
    ]);
    expect(addBigWigFiles).not.toHaveBeenCalled();
    expect(addRequests).toHaveBeenCalledWith([
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/coverage.bigWig' },
        ingress: { kind: 'file-picker' },
      }),
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/accessibility.bw' },
        ingress: { kind: 'file-picker' },
      }),
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/regions.bigBed' },
        formatId: 'bigbed',
        ingress: { kind: 'file-picker' },
      }),
    ]);
    expect(result.current.notice).toBeNull();
  });

  it('routes every supported local text interval family through shared admission requests', async () => {
    mockDialogOpen.mockResolvedValue([
      '/analysis/regions.bed',
      '/analysis/genes.gff3',
      '/analysis/models.gtf.gz',
      '/analysis/known.genepred',
      '/analysis/ref.refflat.bgz',
      '/analysis/open.narrowPeak',
      '/analysis/domains.broadPeak.gz',
    ]);
    const addRequests = vi.fn<IndexedTrackImportController['addRequests']>(async (requests) =>
      requests.map((request) => ({ request, status: 'added' as const, label: 'interval' }))
    );
    const { result } = renderHook(() =>
      useDataFileImport({
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        bamImport: bamController(vi.fn(async () => undefined)),
        indexedImport: indexedController(
          vi.fn(async () => undefined),
          addRequests
        ),
      })
    );

    await act(async () => result.current.openFiles());

    expect(addRequests.mock.calls[0]?.[0].map((request) => request.formatId)).toEqual([
      'bed',
      'gff3',
      'gtf',
      'genepred',
      'refflat',
      'narrowpeak',
      'broadpeak',
    ]);
    expect(result.current.notice).toBeNull();
  });

  it('reports unsupported outputs without silently assigning a reader', async () => {
    mockDialogOpen.mockResolvedValue(['/analysis/run/variants.vcf', '/analysis/run/notes.txt']);
    const addFiles = vi.fn(async () => undefined);
    const addBigWigFiles = vi.fn(async () => undefined);
    const addRequests = vi.fn<IndexedTrackImportController['addRequests']>(async (requests) =>
      requests.map((request) => ({ request, status: 'added' as const, label: 'signal' }))
    );
    const { result } = renderHook(() =>
      useDataFileImport({
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        bamImport: bamController(addFiles),
        indexedImport: indexedController(addBigWigFiles, addRequests),
      })
    );

    await act(async () => result.current.openFiles());

    expect(addFiles).not.toHaveBeenCalled();
    expect(addBigWigFiles).not.toHaveBeenCalled();
    expect(addRequests).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({
      kind: 'warn',
      text: 'Not attached: variants.vcf (VCF viewing is not available yet), notes.txt (unsupported file type).',
    });
  });

  it('expands a script-written DNAForge manifest beside its local outputs', async () => {
    mockDialogOpen.mockResolvedValue('/analysis/run/outputs.dnaforge-tracks.json');
    mockReadTextFileSlice.mockResolvedValue({
      text: JSON.stringify({
        contract: 'dnaforge.track-manifest.v1',
        assemblyId: 'grch38',
        artifacts: [
          { path: 'sample.bam' },
          { path: 'coverage.bigWig' },
          { url: 'https://results.example.org/run/accessibility.bw' },
        ],
      }),
      bytesRead: 300,
    });
    const addFiles = vi.fn(async () => undefined);
    const addAlignedReadRequests = vi.fn(async () => undefined);
    const addBigWigFiles = vi.fn(async () => undefined);
    const addRequests = vi.fn<IndexedTrackImportController['addRequests']>(async (requests) =>
      requests.map((request) => ({ request, status: 'added' as const, label: 'signal' }))
    );
    const indexedImport = indexedController(addBigWigFiles, addRequests);
    const { result } = renderHook(() =>
      useDataFileImport({
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        bamImport: bamController(addFiles, addAlignedReadRequests),
        indexedImport,
      })
    );

    await act(async () => result.current.openFiles());

    expect(mockReadTextFileSlice).toHaveBeenCalledWith(
      '/analysis/run/outputs.dnaforge-tracks.json',
      1_048_577
    );
    expect(addFiles).not.toHaveBeenCalled();
    expect(addAlignedReadRequests).toHaveBeenCalledWith([
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/sample.bam' },
        formatId: 'bam',
        scientificKind: 'reads',
        ingress: { kind: 'manifest', manifestId: 'outputs.dnaforge-tracks.json' },
      }),
    ]);
    expect(addBigWigFiles).not.toHaveBeenCalled();
    expect(addRequests).toHaveBeenCalledWith([
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/coverage.bigWig' },
        ingress: { kind: 'manifest', manifestId: 'outputs.dnaforge-tracks.json' },
      }),
      expect.objectContaining({
        source: { kind: 'http', url: 'https://results.example.org/run/accessibility.bw' },
        ingress: { kind: 'manifest', manifestId: 'outputs.dnaforge-tracks.json' },
      }),
    ]);
    expect(mockAuthorizeLocalIndexedTrack).toHaveBeenCalledWith({
      path: '/analysis/run/coverage.bigWig',
      relatedManifestPath: '/analysis/run/outputs.dnaforge-tracks.json',
    });
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Attached outputs from outputs.dnaforge-tracks.json.',
    });
  });

  it('attaches the copyable signal-only v2 manifest without a read index or hybrid lane', async () => {
    mockDialogOpen.mockResolvedValue('/analysis/run/outputs.dnaforge-tracks.json');
    mockReadTextFileSlice.mockResolvedValue({
      text: readFileSync(
        resolve(
          process.cwd(),
          '../../docs/examples/track-manifests/atac-signal-only.dnaforge-tracks.json'
        ),
        'utf8'
      ),
      bytesRead: 400,
    });
    const importSources = vi.fn(
      async (call: { requests: ReadonlyArray<TrackAdmissionRequestV1> }) =>
        call.requests.map((request, index) => {
          const trackId = index === 0 ? 'signal-track' : 'peaks-track';
          useLaneContractStore.getState().addLane('tab-1', 'grch38', {
            kind: 'annotation',
            trackType: index === 0 ? 'quantitative' : 'peak',
            trackId,
            label: index === 0 ? 'Sample accessibility' : 'Sample peaks',
            color: 0xa8ceff,
            trackPx: 96,
            records: [],
          });
          return {
            request,
            label: request.label ?? trackId,
            family: 'data' as const,
            status: 'added' as const,
            trackId,
          };
        })
    );
    const { result } = renderHook(() =>
      useDataFileImport({
        laneOwnerId: 'tab-1',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
        bamImport: bamController(vi.fn(async () => undefined)),
        indexedImport: indexedController(vi.fn(async () => undefined)),
        importSources: importSources as never,
      })
    );

    await act(async () => result.current.openFiles());

    expect(importSources).toHaveBeenCalledOnce();
    const requests = importSources.mock.calls[0]?.[0].requests;
    expect(requests).toEqual([
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/signal/sample.bigWig' },
        formatId: 'bigwig',
        scientificKind: 'quantitative',
      }),
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/peaks/sample.narrowPeak' },
        formatId: 'narrowpeak',
        scientificKind: 'peak',
      }),
    ]);
    expect(requests?.every((request) => request.index === undefined)).toBe(true);
    expect(useLaneContractStore.getState().lanesForOwner('tab-1')).toMatchObject([
      { visible: true, dataset: { trackId: 'signal-track', trackType: 'quantitative' } },
      { visible: true, dataset: { trackId: 'peaks-track', trackType: 'peak' } },
    ]);
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Attached outputs from outputs.dnaforge-tracks.json.',
    });
  });

  it('constructs a declared signal-to-reads view from a v2 workflow manifest', async () => {
    mockDialogOpen.mockResolvedValue('/analysis/run/outputs.dnaforge-tracks.json');
    mockReadTextFileSlice.mockResolvedValue({
      text: JSON.stringify({
        contract: 'dnaforge.track-manifest.v2',
        assemblyId: 'grch38',
        artifacts: [
          {
            id: 'reads',
            path: 'align/sample.cram',
            indexPath: 'align/sample.cram.crai',
            referencePath: 'reference/GRCh38.fa',
            formatId: 'cram',
            scientificKind: 'reads',
          },
          {
            id: 'signal',
            path: 'signal/opaque-artifact',
            formatId: 'bigwig',
            scientificKind: 'quantitative',
          },
          {
            id: 'peaks',
            path: 'peaks/sample.narrowPeak',
            formatId: 'narrowpeak',
            scientificKind: 'peak',
          },
        ],
        views: [
          {
            id: 'accessibility',
            kind: 'signal-read-pileup',
            reads: 'reads',
            signal: 'signal',
            label: 'ATAC accessibility + reads',
            showSourceTracks: true,
            presentation: { maxRows: 64, loadingAnimation: 'diagonal-scan' },
          },
        ],
      }),
      bytesRead: 600,
    });
    const importSources = vi.fn(
      async (call: { requests: ReadonlyArray<TrackAdmissionRequestV1> }) =>
        call.requests.map((request, index) => {
          const trackId = ['reads-track', 'signal-track', 'peaks-track'][index]!;
          useLaneContractStore.getState().addLane(
            'tab-1',
            'grch38',
            index === 0
              ? {
                  kind: 'pileup',
                  trackType: 'pileup-genomewide',
                  trackId,
                  label: 'GRCh38: sample.bam',
                  color: 0xa8ceff,
                  laneHeightPx: 3,
                  maxLanes: 80,
                  overflowBandHeightPx: 36,
                  trackPx: 276,
                  records: [],
                  source: {
                    bamPath: '/analysis/run/align/sample.cram',
                    indexPath: '/analysis/run/align/sample.cram.crai',
                    referencePath: '/analysis/run/reference/GRCh38.fa',
                  },
                }
              : {
                  kind: 'annotation',
                  trackType: index === 1 ? 'quantitative' : 'peak',
                  trackId,
                  label: index === 1 ? 'sample.bigWig' : 'sample.narrowPeak',
                  color: 0xa8ceff,
                  laneHeightPx: 8,
                  maxLanes: 32,
                  trackPx: 96,
                  records: [],
                },
            true
          );
          return {
            request,
            label: request.label ?? trackId,
            family: index === 0 ? ('reads' as const) : ('data' as const),
            status: 'added' as const,
            trackId,
          };
        })
    );
    const { result } = renderHook(() =>
      useDataFileImport({
        laneOwnerId: 'tab-1',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        assemblyReferences: [{ name: 'chr1', length: 248_956_422 }],
        bamImport: bamController(vi.fn(async () => undefined)),
        indexedImport: indexedController(vi.fn(async () => undefined)),
        importSources: importSources as never,
      })
    );

    await act(async () => result.current.openFiles());

    expect(importSources).toHaveBeenCalledOnce();
    const requests = (
      importSources.mock.calls[0]?.[0] as {
        requests: ReadonlyArray<TrackAdmissionRequestV1>;
      }
    ).requests;
    expect(requests).toEqual([
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/align/sample.cram' },
        index: { kind: 'local-file', path: '/analysis/run/align/sample.cram.crai' },
        reference: { kind: 'local-file', path: '/analysis/run/reference/GRCh38.fa' },
        formatId: 'cram',
        scientificKind: 'reads',
      }),
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/signal/opaque-artifact' },
        formatId: 'bigwig',
        scientificKind: 'quantitative',
      }),
      expect.objectContaining({
        source: { kind: 'local-file', path: '/analysis/run/peaks/sample.narrowPeak' },
        formatId: 'narrowpeak',
        scientificKind: 'peak',
      }),
    ]);
    const lanes = useLaneContractStore.getState().lanesForOwner('tab-1');
    expect(lanes).toHaveLength(4);
    expect(lanes.at(-1)?.dataset).toMatchObject({
      label: 'ATAC accessibility + reads',
      maxLanes: 64,
      coverageCutoffDepth: 64,
      experimentalHybrid: {
        alignmentTrackId: 'reads-track',
        quantitativeTrackId: 'signal-track',
        loadingAnimation: 'diagonal-scan',
      },
    });
    expect(result.current.notice).toEqual({
      kind: 'success',
      text: 'Attached outputs and 1 signal-to-reads view from outputs.dnaforge-tracks.json.',
    });
  });

  it('attempts every manifest URL and reports a partial attachment', async () => {
    mockDialogOpen.mockResolvedValue('/analysis/run/outputs.dnaforge-tracks.json');
    mockReadTextFileSlice.mockResolvedValue({
      text: JSON.stringify({
        contract: 'dnaforge.track-manifest.v1',
        assemblyId: 'grch38',
        artifacts: [
          { url: 'https://broken.example.org/first.bw' },
          { url: 'https://results.example.org/second.bw' },
        ],
      }),
      bytesRead: 300,
    });
    const addRequests = vi.fn<IndexedTrackImportController['addRequests']>(async (requests) => [
      { request: requests[0], status: 'error', label: 'first.bw', message: 'HTTP 404' },
      { request: requests[1], status: 'added', label: 'second.bw' },
    ]);
    const { result } = renderHook(() =>
      useDataFileImport({
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        bamImport: bamController(vi.fn(async () => undefined)),
        indexedImport: indexedController(
          vi.fn(async () => undefined),
          addRequests
        ),
      })
    );

    await act(async () => result.current.openFiles());

    expect(addRequests).toHaveBeenCalledOnce();
    expect(addRequests.mock.calls[0]?.[0]).toHaveLength(2);
    expect(result.current.notice).toEqual({
      kind: 'warn',
      text: 'Not attached: first.bw: HTTP 404.',
    });
  });

  it('imports an IGV session through the shared operation with session ingress', async () => {
    mockDialogOpen.mockResolvedValue('/lab/sessions/chrIV.xml');
    mockReadTextFileSlice.mockResolvedValue({
      text: `<?xml version="1.0"?>
<Session genome="sacCer3" locus="chrIV:3,501-4,000" version="8">
  <Resources>
    <Resource path="../reads/reads.cram" type="cram" index="../reads/reads.cram.crai" name="Lab reads"/>
    <Resource path="https://variants.example.org/s288c/calls.vcf.gz" index="https://variants.example.org/s288c/calls.vcf.gz.tbi"/>
    <Resource path="/elsewhere/signal.bw" type="bw"/>
    <Resource path="gs://lab/runs/private.vcf.gz"/>
    <Resource path="https://data.example.org/x.bw?token=1"/>
  </Resources>
</Session>`,
      bytesRead: 700,
    });
    mockStat.mockImplementation(async (path: string) => ({
      canonicalPath: path.replace('/lab/sessions/../reads/', '/lab/reads/'),
      size: 100,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 1,
      mtimeNs: '1',
      ctimeNs: '1',
    }));
    const importSources = vi.fn(
      async (call: { requests: ReadonlyArray<TrackAdmissionRequestV1> }) =>
        call.requests.map((request, index) =>
          index === 3
            ? {
                request,
                label: 'private.vcf.gz',
                family: 'variants' as const,
                status: 'failed' as const,
                code: 'ADMISSION_FAILED' as const,
                message: 'needs a credential',
              }
            : {
                request,
                label: request.label ?? 'source',
                family: 'reads' as const,
                status: index === 1 ? ('duplicate' as const) : ('added' as const),
                trackId: `track-${index}`,
              }
        )
    );
    const addFiles = vi.fn(async () => undefined);
    const addAlignedReadRequests = vi.fn(async () => undefined);
    const addRequests = vi.fn<IndexedTrackImportController['addRequests']>(async () => []);
    const { result } = renderHook(() =>
      useDataFileImport({
        laneOwnerId: 'tab-1',
        assemblyId: 'local-yeast',
        assemblyDisplayName: 'Lab yeast',
        assemblyReferences: [{ name: 'chrIV', length: 1_531_933 }],
        assemblyUcscGenomeId: null,
        bamImport: bamController(addFiles, addAlignedReadRequests),
        indexedImport: indexedController(
          vi.fn(async () => undefined),
          addRequests
        ),
        importSources: importSources as never,
      })
    );

    await act(async () => result.current.openFiles());

    expect(mockReadTextFileSlice).toHaveBeenCalledWith(
      '/lab/sessions/chrIV.xml',
      4 * 1024 * 1024 + 1
    );
    expect(addFiles).not.toHaveBeenCalled();
    expect(addAlignedReadRequests).not.toHaveBeenCalled();
    expect(addRequests).not.toHaveBeenCalled();
    expect(importSources).toHaveBeenCalledOnce();
    const call = importSources.mock.calls[0]?.[0] as {
      laneOwnerId: string;
      assemblyId: string;
      localAuthorityContext: string;
      requests: ReadonlyArray<TrackAdmissionRequestV1>;
    };
    expect(call).toMatchObject({
      laneOwnerId: 'tab-1',
      assemblyId: 'local-yeast',
      localAuthorityContext: 'workspace-grounded',
    });
    expect(call.requests).toEqual([
      expect.objectContaining({
        source: { kind: 'local-file', path: '/lab/reads/reads.cram' },
        index: { kind: 'local-file', path: '/lab/reads/reads.cram.crai' },
        formatId: 'cram',
        label: 'Lab reads',
        ingress: { kind: 'session', sessionId: 'chrIV.xml' },
      }),
      expect.objectContaining({
        source: { kind: 'http', url: 'https://variants.example.org/s288c/calls.vcf.gz' },
        index: { kind: 'http', url: 'https://variants.example.org/s288c/calls.vcf.gz.tbi' },
        ingress: { kind: 'session', sessionId: 'chrIV.xml' },
      }),
      expect.objectContaining({
        source: { kind: 'local-file', path: '/elsewhere/signal.bw' },
        formatId: 'bigwig',
      }),
      expect.objectContaining({
        source: { kind: 'gcs', bucket: 'lab', object: 'runs/private.vcf.gz' },
      }),
    ]);
    expect(mockAuthorizeLocalIndexedTrack).toHaveBeenCalledTimes(0);
    expect(result.current.notice).toEqual({
      kind: 'warn',
      text: 'Attached 2 of 4 sources from chrIV.xml. 1 already was on this view. Not attached: private.vcf.gz: needs a credential. Skipped: https://data.example.org/x.bw?token=1 (carries credential parameters in its URL). Session locus chrIV:3,501-4,000.',
    });
  });

  it('imports UCSC custom tracks by address and notes a genome that differs from the open one', async () => {
    mockDialogOpen.mockResolvedValue(['/lab/sessions/tracks.txt']);
    mockReadTextFileSlice.mockResolvedValue({
      text: [
        'browser position chr21:33,031,597-33,041,570',
        'track type=bigWig name="GC signal" bigDataUrl=https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw',
        'track name="Inline peaks"',
        'chr21\t1\t2\tpeak',
      ].join('\n'),
      bytesRead: 200,
    });
    const importSources = vi.fn(
      async (call: { requests: ReadonlyArray<TrackAdmissionRequestV1> }) =>
        call.requests.map((request) => ({
          request,
          label: 'GC signal',
          family: 'data' as const,
          status: 'added' as const,
          trackId: 'track-gc',
        }))
    );
    const { result } = renderHook(() =>
      useDataFileImport({
        laneOwnerId: 'tab-1',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        assemblyReferences: [{ name: 'chr21', length: 46_709_983 }],
        assemblyUcscGenomeId: 'hg38',
        bamImport: bamController(vi.fn(async () => undefined)),
        indexedImport: indexedController(vi.fn(async () => undefined)),
        importSources: importSources as never,
      })
    );

    await act(async () => result.current.openFiles());

    expect(importSources).toHaveBeenCalledOnce();
    expect(
      (importSources.mock.calls[0]?.[0] as { requests: ReadonlyArray<TrackAdmissionRequestV1> })
        .requests
    ).toEqual([
      expect.objectContaining({
        source: {
          kind: 'http',
          url: 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5BaseBw/gc5Base.bw',
        },
        formatId: 'bigwig',
        label: 'GC signal',
        ingress: { kind: 'session', sessionId: 'tracks.txt' },
      }),
    ]);
    expect(result.current.notice).toEqual({
      kind: 'warn',
      text: 'Attached 1 of 1 source from tracks.txt. Skipped: Inline peaks (carries inline data lines). Session locus chr21:33,031,597-33,041,570.',
    });
  });

  it('treats a text file that is not a session as ordinary data', async () => {
    mockDialogOpen.mockResolvedValue(['/lab/notes.txt']);
    mockReadTextFileSlice.mockResolvedValue({ text: 'lab notes, not tracks\n', bytesRead: 22 });
    const importSources = vi.fn(async () => []);
    const { result } = renderHook(() =>
      useDataFileImport({
        laneOwnerId: 'tab-1',
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        bamImport: bamController(vi.fn(async () => undefined)),
        indexedImport: indexedController(vi.fn(async () => undefined)),
        importSources: importSources as never,
      })
    );

    await act(async () => result.current.openFiles());

    expect(importSources).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({
      kind: 'warn',
      text: 'Not attached: notes.txt (unsupported file type).',
    });
  });

  it('refuses a workflow manifest for another assembly before attaching anything', async () => {
    mockDialogOpen.mockResolvedValue('/analysis/run/outputs.dnaforge-tracks.json');
    mockReadTextFileSlice.mockResolvedValue({
      text: JSON.stringify({
        contract: 'dnaforge.track-manifest.v1',
        assemblyId: 'grch37',
        artifacts: [{ path: 'coverage.bigWig' }],
      }),
      bytesRead: 200,
    });
    const addFiles = vi.fn(async () => undefined);
    const addBigWigFiles = vi.fn(async () => undefined);
    const addRequests = vi.fn<IndexedTrackImportController['addRequests']>(async () => []);
    const { result } = renderHook(() =>
      useDataFileImport({
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        bamImport: bamController(addFiles),
        indexedImport: indexedController(addBigWigFiles, addRequests),
      })
    );

    await act(async () => result.current.openFiles());

    expect(addFiles).not.toHaveBeenCalled();
    expect(addBigWigFiles).not.toHaveBeenCalled();
    expect(addRequests).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({
      kind: 'error',
      text: 'outputs.dnaforge-tracks.json: This track manifest declares assembly grch37, but the open reference is grch38.',
    });
  });

  it('refuses a manifest artifact whose canonical path escapes through a symlink', async () => {
    mockDialogOpen.mockResolvedValue('/analysis/run/outputs.dnaforge-tracks.json');
    mockReadTextFileSlice.mockResolvedValue({
      text: JSON.stringify({
        contract: 'dnaforge.track-manifest.v1',
        assemblyId: 'grch38',
        artifacts: [{ path: 'linked-coverage.bigWig' }],
      }),
      bytesRead: 160,
    });
    mockStat.mockImplementation(async (path: string) => ({
      canonicalPath: path.endsWith('linked-coverage.bigWig') ? '/private/coverage.bigWig' : path,
      size: 100,
      isFile: true,
      isDirectory: false,
      mtime: 1,
      ctime: 1,
      mtimeNs: '1',
      ctimeNs: '1',
    }));
    const addFiles = vi.fn(async () => undefined);
    const addBigWigFiles = vi.fn(async () => undefined);
    const addRequests = vi.fn<IndexedTrackImportController['addRequests']>(async () => []);
    const { result } = renderHook(() =>
      useDataFileImport({
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
        bamImport: bamController(addFiles),
        indexedImport: indexedController(addBigWigFiles, addRequests),
      })
    );

    await act(async () => result.current.openFiles());

    expect(addFiles).not.toHaveBeenCalled();
    expect(addBigWigFiles).not.toHaveBeenCalled();
    expect(addRequests).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({
      kind: 'error',
      text: 'outputs.dnaforge-tracks.json: linked-coverage.bigWig resolves outside the manifest directory.',
    });
  });
});

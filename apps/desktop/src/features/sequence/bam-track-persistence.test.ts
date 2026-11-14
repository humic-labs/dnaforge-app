import { describe, expect, it } from 'vitest';

import { TRACK_ADMISSION_REQUEST_V1, type CurrentAdmittedTrackSource } from '@waypoint/genome-data';
import type { IndexedGenomeBamTrackState } from '../../shared/indexed-genome';
import type {
  RemoteAlignmentMaterializationV1,
  RemoteGenomicsRuntimeStatusV1,
} from '../../shared/remote-genomics-ipc';
import {
  canonicalRemoteReadIdentity,
  dedupePersistedBamTracks,
  laneFromIndexedGenomeBamTrack,
  laneFromUnreadablePersistedBamTrack,
  indexedGenomeBamTrackFromLane,
  indexedGenomeBamTracksEqual,
  remoteReconnectFailureMessage,
  remoteRuntimeStatusMatchesLocator,
  requirePersistedBamTrack,
  savedRemoteAlignmentMatchesRuntime,
} from './bam-track-persistence';

const PERSISTED_TRACK: IndexedGenomeBamTrackState = {
  trackId: 'pileup-grch38-stable-user-identity',
  label: 'Tumor / primary',
  order: 7,
  source: {
    bamPath: '/canonical/project/reads/tumor.bam',
    indexPath: '/canonical/indexes/tumor.bam.bai',
  },
  visible: false,
  color: 0x4a90d9,
  trackPx: 276,
  laneHeightPx: 3,
  maxLanes: 80,
  coverageCutoffDepth: 173,
};

const GENERATION = {
  contract: 'aligned-read-source-generation.v1' as const,
  alignment: {
    canonicalPath: '/canonical/project/reads/tumor.bam',
    size: 100,
    mtimeNs: '1000000',
    ctimeNs: '2000000',
    device: '42',
    inode: '1001',
  },
  index: {
    canonicalPath: '/canonical/indexes/tumor.bam.bai',
    size: 20,
    mtimeNs: '3000000',
    ctimeNs: '4000000',
    device: '42',
    inode: '1002',
  },
};

const ADMITTED_SOURCE: CurrentAdmittedTrackSource = {
  admissionVersion: 2,
  request: {
    contract: TRACK_ADMISSION_REQUEST_V1,
    assemblyId: 'grch38',
    source: { kind: 'local-file', path: '/canonical/project/reads/tumor.bam' },
    index: { kind: 'local-file', path: '/canonical/indexes/tumor.bam.bai' },
    formatId: 'bam',
    scientificKind: 'reads',
    ingress: { kind: 'file-picker' },
  },
  admittedAt: '2026-09-21T20:00:00.000Z',
  uri: 'file:///canonical/project/reads/tumor.bam',
  input: { kind: 'path', path: '/canonical/project/reads/tumor.bam' },
  index: { kind: 'path', path: '/canonical/indexes/tumor.bam.bai' },
  formatId: 'bam',
  recommendedTypes: ['pileup'],
  fingerprint: `sha256:${'a'.repeat(64)}`,
  readerKind: 'bam',
  scientificKind: 'reads',
  assemblyId: 'grch38',
  referenceReceipt: {
    assemblyId: 'grch38',
    referenceSignature: `sha256:${'b'.repeat(64)}`,
    sourceSignature: `sha256:${'c'.repeat(64)}`,
    contigMap: { chr1: 'chr1' },
    checkedContigs: 1,
    status: 'compatible',
    checkedAt: '2026-09-21T20:00:00.000Z',
  },
  provenance: { provider: 'local-file', sourceKind: 'local-file', label: 'tumor.bam' },
  expectedValidators: { contentLength: 100 },
  alignedReadGeneration: GENERATION,
};

describe('BAM track persistence descriptor', () => {
  it('persists a changed cluster server receipt even when the source files stay the same', () => {
    const saved: IndexedGenomeBamTrackState = {
      ...PERSISTED_TRACK,
      source: {
        ...PERSISTED_TRACK.source,
        remote: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'cluster',
          target: 'cluster',
          alignmentPath: PERSISTED_TRACK.source.bamPath,
          indexPath: PERSISTED_TRACK.source.indexPath,
          tileServerReceiptPath: '/home/user/old-node/connection.json',
        },
      },
    };
    const edited = {
      ...saved,
      source: {
        ...saved.source,
        remote: {
          ...saved.source.remote!,
          tileServerReceiptPath: '/home/user/new-node/connection.json',
        },
      },
    };
    expect(indexedGenomeBamTracksEqual([saved], [edited])).toBe(false);
    expect(() =>
      requirePersistedBamTrack({
        ...edited,
        source: {
          ...edited.source,
          remote: {
            ...edited.source.remote,
            tileServerReceiptPath: 'relative.json',
          },
        },
      })
    ).toThrow('invalid remote source');
  });
  it.each([undefined, '/data/first.bigWig', '/data/replacement.bigWig'])(
    'persists an SSH BigWig-only source edit from %s',
    (signalPath) => {
      const saved: IndexedGenomeBamTrackState = {
        ...PERSISTED_TRACK,
        source: {
          ...PERSISTED_TRACK.source,
          remote: {
            contract: 'remote-alignment-locator.v1',
            endpointId: 'endpoint-1',
            target: 'lab-hpc',
            alignmentPath: PERSISTED_TRACK.source.bamPath,
            indexPath: PERSISTED_TRACK.source.indexPath,
            ...(signalPath ? { signalPath } : {}),
          },
        },
      };
      const edited: IndexedGenomeBamTrackState = {
        ...saved,
        source: {
          ...saved.source,
          remote: {
            ...saved.source.remote!,
            signalPath:
              signalPath === '/data/replacement.bigWig' ? undefined : '/data/replacement.bigWig',
          },
        },
      };

      const persisted = indexedGenomeBamTracksEqual([saved], [edited]) ? saved : edited;
      expect(persisted.source.remote?.signalPath).toBe(edited.source.remote?.signalPath);
      const reopened = laneFromIndexedGenomeBamTrack(persisted, {
        assemblyId: 'grch38',
        assemblyDisplayName: 'GRCh38',
      });
      expect(reopened.dataset.source?.remote?.locator.signalPath).toBe(
        edited.source.remote?.signalPath
      );
      expect(indexedGenomeBamTracksEqual([edited], [edited])).toBe(true);
    }
  );

  it('round-trips source identity and presentation state without deriving new paths or IDs', () => {
    const lane = laneFromIndexedGenomeBamTrack(PERSISTED_TRACK, {
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
    });

    expect(lane).toMatchObject({
      order: 7,
      visible: false,
      dataset: {
        trackId: 'pileup-grch38-stable-user-identity',
        label: 'Tumor / primary',
        kind: 'pileup',
        source: {
          bamPath: '/canonical/project/reads/tumor.bam',
          indexPath: '/canonical/indexes/tumor.bam.bai',
        },
        coverageCutoffDepth: 173,
      },
    });
    expect(indexedGenomeBamTrackFromLane(lane)).toEqual(PERSISTED_TRACK);
  });

  it('round-trips the shared aligned-read admission receipt with the lane', () => {
    const persisted = {
      ...PERSISTED_TRACK,
      source: { ...PERSISTED_TRACK.source, generation: GENERATION },
      admittedSource: ADMITTED_SOURCE,
    } as IndexedGenomeBamTrackState;

    const lane = laneFromIndexedGenomeBamTrack(persisted, {
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
    });

    expect(lane.source).toEqual(ADMITTED_SOURCE);
    expect(indexedGenomeBamTrackFromLane(lane)).toEqual(persisted);
  });

  it('persists original remote locators instead of ephemeral native proxy URLs', () => {
    const admittedSource: CurrentAdmittedTrackSource = {
      ...ADMITTED_SOURCE,
      request: {
        ...ADMITTED_SOURCE.request,
        source: { kind: 'http', url: 'https://reads.example.org/run/tumor.bam' },
        index: { kind: 'http', url: 'https://reads.example.org/run/tumor.bam.bai' },
        ingress: { kind: 'url' },
      },
      uri: 'https://reads.example.org/run/tumor.bam',
      input: { kind: 'url', url: 'https://reads.example.org/run/tumor.bam' },
      index: { kind: 'url', url: 'https://reads.example.org/run/tumor.bam.bai' },
      provenance: { provider: 'http', sourceKind: 'http', label: 'tumor.bam' },
      expectedValidators: { contentLength: 10_000, etag: '"bam-v1"' },
      indexExpectedValidators: { contentLength: 500, etag: '"bai-v1"' },
      alignedReadGeneration: undefined,
    };
    const lane = laneFromIndexedGenomeBamTrack(
      {
        ...PERSISTED_TRACK,
        source: {
          bamPath: 'https://reads.example.org/run/tumor.bam',
          indexPath: 'https://reads.example.org/run/tumor.bam.bai',
        },
        admittedSource,
      },
      { assemblyId: 'grch38', assemblyDisplayName: 'GRCh38' }
    );
    lane.dataset.source = {
      bamPath: 'http://127.0.0.1:8000/external/range-proxy/secret-bam/tumor.bam',
      indexPath: 'http://127.0.0.1:8000/external/range-proxy/secret-bai/tumor.bam.bai',
    };

    const persisted = indexedGenomeBamTrackFromLane(lane);

    expect(persisted?.source).toEqual({
      bamPath: 'https://reads.example.org/run/tumor.bam',
      indexPath: 'https://reads.example.org/run/tumor.bam.bai',
    });
    expect(JSON.stringify(persisted)).not.toContain('/external/range-proxy/');
    expect(JSON.stringify(persisted)).not.toContain('secret-bam');
  });

  it('round-trips htsget endpoint identity without persisting its runtime token', () => {
    const identity = 'e'.repeat(64);
    const admittedSource: CurrentAdmittedTrackSource = {
      ...ADMITTED_SOURCE,
      request: {
        contract: TRACK_ADMISSION_REQUEST_V1,
        assemblyId: 'grch38',
        source: {
          kind: 'htsget',
          endpoint: 'https://htsget.example.org',
          resourceId: 'sample',
          dataClass: 'reads',
          format: 'BAM',
        },
        formatId: 'bam',
        scientificKind: 'reads',
        ingress: { kind: 'url' },
      },
      uri: `htsget:${identity}`,
      input: undefined,
      index: undefined,
      provenance: { provider: 'htsget', sourceKind: 'htsget', label: 'sample' },
      expectedValidators: undefined,
      alignedReadGeneration: undefined,
    };
    const lane = laneFromIndexedGenomeBamTrack(
      {
        ...PERSISTED_TRACK,
        source: {
          bamPath: `htsget-source://${identity}/source.bam`,
          indexPath: `htsget-source://${identity}/managed.bai`,
        },
        admittedSource,
      },
      { assemblyId: 'grch38', assemblyDisplayName: 'GRCh38' }
    );
    lane.dataset.source = {
      bamPath: `htsget-runtime://${identity}/source.bam`,
      grantExpiresAtMs: Date.now() + 900_000,
      htsget: {
        sourceToken: 'opaque-short-lived-token',
        sourceIdentity: identity,
        format: 'BAM',
      },
    };

    const persisted = indexedGenomeBamTrackFromLane(lane);

    expect(persisted?.source).toEqual({
      bamPath: `htsget-source://${identity}/source.bam`,
      indexPath: `htsget-source://${identity}/managed.bai`,
    });
    expect(JSON.stringify(persisted)).not.toContain('opaque-short-lived-token');
    expect(JSON.stringify(persisted)).not.toContain('htsget-runtime');
  });

  it('does not persist mock/static pileups that have no exact BAM index identity', () => {
    expect(
      indexedGenomeBamTrackFromLane({
        visible: true,
        dataset: {
          trackType: 'pileup-genomewide',
          trackId: 'mock-pileup',
          label: 'Mock pileup',
          color: 0x4a90d9,
          trackPx: 276,
          records: [],
          kind: 'pileup',
          source: { bamPath: '/tmp/mock.bam' },
        },
      })
    ).toBeNull();
  });

  it('round-trips the exact CRAM reference identity', () => {
    const persisted: IndexedGenomeBamTrackState = {
      ...PERSISTED_TRACK,
      trackId: 'cram-track',
      label: 'NA12718',
      source: {
        bamPath: '/data/NA12718.final.cram',
        indexPath: '/data/NA12718.final.cram.crai',
        referencePath: '/references/GRCh38.fa',
      },
    };

    const lane = laneFromIndexedGenomeBamTrack(persisted, {
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
    });

    expect(indexedGenomeBamTrackFromLane(lane)).toEqual(persisted);
  });

  it('round-trips only the durable SSH locator and never persists loopback tunnel URLs', () => {
    const persisted: IndexedGenomeBamTrackState = {
      ...PERSISTED_TRACK,
      trackId: 'remote-tumor-track',
      source: {
        bamPath: '/project/run 42/tumor.bam',
        indexPath: '/project/run 42/tumor.bam.bai',
        remote: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/project/run 42/tumor.bam',
          indexPath: '/project/run 42/tumor.bam.bai',
        },
      },
    };
    const materialization: RemoteAlignmentMaterializationV1 = {
      protocol: 'dnaforge-remote-range.v1',
      sessionId: 'session-1',
      endpoint: {
        endpointId: 'endpoint-1',
        displayName: 'Lab HPC',
        target: 'lab-hpc',
        lastConnectedAt: 1,
        observedPlatform: 'linux',
        lastFailure: null,
      },
      locator: persisted.source.remote!,
      runtimeStatus: {
        sourceId: 'source-1',
        endpointId: 'endpoint-1',
        target: 'lab-hpc',
        displayName: 'Lab HPC',
        alignmentPath: '/project/run 42/tumor.bam',
        indexPath: '/project/run 42/tumor.bam.bai',
        signalPath: null,
        state: 'online',
        attempt: 0,
        nextRetryAt: null,
        transportGeneration: 7,
        lastFailure: null,
        updatedAt: 1234,
      },
      bamUrl: 'http://127.0.0.1:43117/alignment.bam',
      indexPath: '/tmp/dnaforge-remote-index-1/alignment.bam.bai',
      generation: {
        alignment: {
          canonicalPath: persisted.source.bamPath,
          size: 100,
          mtimeNs: '1',
          ctimeNs: '2',
          device: null,
          inode: null,
        },
        index: {
          canonicalPath: persisted.source.indexPath,
          size: 20,
          mtimeNs: '3',
          ctimeNs: '4',
          device: null,
          inode: null,
        },
      },
    };
    const lane = laneFromIndexedGenomeBamTrack(
      persisted,
      { assemblyId: 'grch38', assemblyDisplayName: 'GRCh38' },
      materialization
    );

    expect(lane.dataset.source).toMatchObject({
      bamPath: 'http://127.0.0.1:43117/alignment.bam',
      indexPath: '/tmp/dnaforge-remote-index-1/alignment.bam.bai',
      remote: { sessionId: 'session-1', locator: persisted.source.remote },
    });
    expect(lane.dataset.source?.remote?.connection).toEqual({
      sourceId: 'source-1',
      state: 'online',
      attempt: 0,
      transportGeneration: 7,
      lastFailure: null,
      updatedAt: 1234,
    });
    expect(indexedGenomeBamTrackFromLane(lane)).toEqual(persisted);

    const canonicalizedLane = laneFromIndexedGenomeBamTrack(
      persisted,
      { assemblyId: 'grch38', assemblyDisplayName: 'GRCh38' },
      {
        ...materialization,
        sessionId: 'session-2',
        endpoint: { ...materialization.endpoint, endpointId: 'endpoint-current' },
        locator: { ...materialization.locator, endpointId: 'endpoint-current' },
      }
    );
    expect(indexedGenomeBamTrackFromLane(canonicalizedLane)?.source.remote?.endpointId).toBe(
      'endpoint-current'
    );
  });

  it('keeps a remote CRAM descriptor when the local reference has not been attached yet', () => {
    const remote = {
      contract: 'remote-alignment-locator.v1' as const,
      endpointId: 'endpoint-1',
      target: 'lab-hpc',
      alignmentPath: '/project/sample.bam',
      indexPath: '/project/sample.bam.bai',
    };
    const persisted: IndexedGenomeBamTrackState = {
      ...PERSISTED_TRACK,
      trackId: 'remote-cram-track',
      source: {
        bamPath: remote.alignmentPath,
        indexPath: remote.indexPath,
        remote,
      },
    };
    const lane = laneFromIndexedGenomeBamTrack(
      persisted,
      { assemblyId: 'hg19', assemblyDisplayName: 'GRCh37' },
      {
        protocol: 'dnaforge-remote-range.v1',
        sessionId: 'session-1',
        endpoint: {
          endpointId: 'endpoint-1',
          displayName: 'Lab HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
        locator: {
          ...remote,
          alignmentPath: '/project/sample.cram',
          indexPath: '/project/sample.cram.crai',
        },
        bamUrl: 'http://127.0.0.1:43117/v1/handle/alignment.cram',
        indexPath: '/tmp/dnaforge-remote-index-1/alignment.cram.crai',
        generation: {
          alignment: {
            canonicalPath: '/project/sample.cram',
            size: 100,
            mtimeNs: '1',
            ctimeNs: '2',
            device: null,
            inode: null,
          },
          index: {
            canonicalPath: '/project/sample.cram.crai',
            size: 20,
            mtimeNs: '3',
            ctimeNs: '4',
            device: null,
            inode: null,
          },
        },
      }
    );

    expect(lane.dataset.source?.referencePath).toBeUndefined();
    const saved = indexedGenomeBamTrackFromLane(lane);
    expect(saved?.source).toMatchObject({
      bamPath: '/project/sample.cram',
      indexPath: '/project/sample.cram.crai',
      remote: { alignmentPath: '/project/sample.cram' },
    });
    expect(() => requirePersistedBamTrack(saved!)).not.toThrow();
  });

  it('drops a stale single-chromosome reference when a remote CRAM reconnects', () => {
    const remote = {
      contract: 'remote-alignment-locator.v1' as const,
      endpointId: 'endpoint-1',
      target: 'lab-hpc',
      alignmentPath: '/project/sample.cram',
      indexPath: '/project/sample.cram.crai',
    };
    const persisted: IndexedGenomeBamTrackState = {
      ...PERSISTED_TRACK,
      trackId: 'remote-cram',
      source: {
        bamPath: remote.alignmentPath,
        indexPath: remote.indexPath,
        referencePath: '/prepared/chr1/chr1.fa',
        remote,
      },
    };
    const lane = laneFromIndexedGenomeBamTrack(
      persisted,
      { assemblyId: 'grch38', assemblyDisplayName: 'GRCh38' },
      {
        protocol: 'dnaforge-remote-range.v1',
        sessionId: 'session-1',
        endpoint: {
          endpointId: 'endpoint-1',
          displayName: 'Lab HPC',
          target: 'lab-hpc',
          lastConnectedAt: 1,
          observedPlatform: 'linux',
          lastFailure: null,
        },
        locator: remote,
        bamUrl: 'http://127.0.0.1:43119/v1/session_123/alignment.cram',
        indexPath: '/tmp/session_123/alignment.cram.crai',
        generation: {
          alignment: {
            canonicalPath: remote.alignmentPath,
            size: 100,
            mtimeNs: '1',
            ctimeNs: '2',
            device: null,
            inode: null,
          },
          index: {
            canonicalPath: remote.indexPath,
            size: 20,
            mtimeNs: '3',
            ctimeNs: '4',
            device: null,
            inode: null,
          },
        },
      }
    );

    expect(lane.dataset.source?.referencePath).toBeUndefined();
    expect(indexedGenomeBamTrackFromLane(lane)?.source.referencePath).toBeUndefined();
  });

  it('keeps authentication recovery guidance while removing nested IPC wrappers', () => {
    const message = remoteReconnectFailureMessage(
      'dnaforge-gcp-benchmark',
      new Error(
        "Error: Error invoking remote method 'remoteGenomics:connectAlignment': RemoteGenomicsError: OpenSSH needs authentication. Retry to answer its prompt in DNAForge, or check your SSH agent."
      )
    );
    expect(message).toContain('Retry to answer its prompt in DNAForge');
    expect(message).toContain('check your SSH agent');
    expect(message).not.toContain('Error invoking remote method');
    expect(message).not.toContain('RemoteGenomicsError');
    expect(remoteReconnectFailureMessage('dnaforge-gcp-benchmark', new Error(message))).toBe(
      message
    );
  });

  it('keeps a row for a saved remote file the reader will not accept', () => {
    const persisted: IndexedGenomeBamTrackState = {
      ...PERSISTED_TRACK,
      trackId: 'rejected-cram',
      label: 'GRCh37 (human): sample.bam',
      source: {
        bamPath: '/data/sample.cram',
        indexPath: '/data/sample.bai',
        remote: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/data/sample.cram',
          indexPath: '/data/sample.bai',
        },
      },
    };
    expect(() => requirePersistedBamTrack(persisted)).toThrow(/invalid remote source/i);
    const lane = laneFromUnreadablePersistedBamTrack(
      persisted,
      { assemblyId: 'hg19', assemblyDisplayName: 'GRCh37' },
      'Persisted aligned-read track GRCh37 (human): sample.bam has an invalid remote source.'
    );
    expect(lane?.dataset.trackId).toBe('rejected-cram');
    expect(lane?.dataset.source?.admissionError).toMatch(/Repair opens this saved file again/);
    expect(lane?.dataset.source?.remote?.locator).toMatchObject({
      target: 'lab-hpc',
      alignmentPath: '/data/sample.cram',
    });
  });

  it('keeps the first saved track when a second record points at the sibling CRAM', () => {
    const bam: IndexedGenomeBamTrackState = {
      ...PERSISTED_TRACK,
      trackId: 'original',
      source: {
        bamPath: '/data/sample.markdup.sorted.cram',
        indexPath: '/data/sample.markdup.sorted.cram.crai',
        remote: {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/data/sample.markdup.sorted.cram',
          indexPath: '/data/sample.markdup.sorted.cram.crai',
        },
      },
    };
    const duplicate: IndexedGenomeBamTrackState = {
      ...bam,
      trackId: 'second-attach',
    };
    expect(dedupePersistedBamTracks([bam, duplicate]).map((track) => track.trackId)).toEqual([
      'original',
    ]);
    expect(canonicalRemoteReadIdentity('endpoint-1', '/data/sample.markdup.sorted.cram')).toBe(
      canonicalRemoteReadIdentity('endpoint-1', '/data/sample.markdup.sorted.bam')
    );
  });

  it('round-trips a complete source generation while accepting legacy descriptors without one', () => {
    expect(() => requirePersistedBamTrack(PERSISTED_TRACK)).not.toThrow();
    const persisted: IndexedGenomeBamTrackState = {
      ...PERSISTED_TRACK,
      source: { ...PERSISTED_TRACK.source, generation: GENERATION },
    };

    const lane = laneFromIndexedGenomeBamTrack(persisted, {
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
    });

    expect(indexedGenomeBamTrackFromLane(lane)).toEqual(persisted);
  });

  it('migrates a legacy descriptor to explicit pileup presentation defaults', () => {
    const { color, trackPx, laneHeightPx, maxLanes, ...legacy } = PERSISTED_TRACK;
    const lane = laneFromIndexedGenomeBamTrack(legacy, {
      assemblyId: 'grch38',
      assemblyDisplayName: 'GRCh38',
    });

    expect(indexedGenomeBamTrackFromLane(lane)).toMatchObject({
      color: 0xa8ceff,
      trackPx: 276,
      laneHeightPx: 3,
      maxLanes: 80,
    });
  });

  it('rejects a malformed optional source generation instead of persisting partial identity', () => {
    const malformed = {
      ...PERSISTED_TRACK,
      source: {
        ...PERSISTED_TRACK.source,
        generation: {
          contract: 'aligned-read-source-generation.v1',
          alignment: {
            canonicalPath: '/data/tumor.bam',
            size: 100,
            mtimeNs: '1',
            ctimeNs: '2',
          },
        },
      },
    } as IndexedGenomeBamTrackState;

    expect(() => requirePersistedBamTrack(malformed)).toThrow(/invalid source generation/i);
  });

  it('accepts a sibling CRAM as the runtime file for a saved BAM', () => {
    expect(
      savedRemoteAlignmentMatchesRuntime(
        {
          alignmentPath: '/data/sample.markdup.sorted.bam',
          indexPath: '/data/sample.markdup.sorted.bam.bai',
        },
        {
          alignmentPath: '/data/sample.markdup.sorted.cram',
          indexPath: '/data/sample.markdup.sorted.cram.crai',
        }
      )
    ).toBe(true);
    expect(
      savedRemoteAlignmentMatchesRuntime(
        { alignmentPath: '/data/sample.bam', indexPath: '/data/sample.bam.bai' },
        { alignmentPath: '/data/other.cram', indexPath: '/data/other.cram.crai' }
      )
    ).toBe(false);
  });

  it('scopes runtime status to one file when an endpoint serves multiple tracks', () => {
    const status: RemoteGenomicsRuntimeStatusV1 = {
      sourceId: 'source-a',
      endpointId: 'endpoint-1',
      target: 'lab-hpc',
      displayName: 'Lab HPC',
      alignmentPath: '/data/sample-a.cram',
      indexPath: '/data/sample-a.cram.crai',
      signalPath: '/data/sample-a.bigWig',
      state: 'retrying',
      attempt: 1,
      nextRetryAt: 1,
      transportGeneration: 1,
      lastFailure: { code: 'tunnel-failed', message: 'Transport closed.' },
      updatedAt: 1,
    };
    expect(
      remoteRuntimeStatusMatchesLocator(
        {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/data/sample-a.bam',
          indexPath: '/data/sample-a.bam.bai',
          signalPath: '/data/sample-a.bigWig',
        },
        status
      )
    ).toBe(true);
    expect(
      remoteRuntimeStatusMatchesLocator(
        {
          contract: 'remote-alignment-locator.v1',
          endpointId: 'endpoint-1',
          target: 'lab-hpc',
          alignmentPath: '/data/sample-b.bam',
          indexPath: '/data/sample-b.bam.bai',
          signalPath: '/data/sample-b.bigWig',
        },
        status
      )
    ).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { createGenomeSessionShell } from './genome-session';
import {
  UnknownGenomeTrackError,
  emptyAnnotationTileForSequenceOnlySession,
  resolveGenomeTrackRoute,
} from './genome-track-routing';
import type { GenomeSessionShell, GenomeTileRequest } from '../../shared/indexed-genome';

function buildSessionWithTrack(
  extraTrackKind: 'alignment' | 'signal' | 'variant'
): GenomeSessionShell {
  const shell = createGenomeSessionShell({
    source: {
      sourcePath: '/Users/test/chr11.gbff',
      sourceExt: 'gbff',
      intent: { kind: 'reference-single' },
    },
    resolvedSourcePath: '/Users/test/chr11.gbff',
    stat: { size: 1234, mtimeMs: 42 },
    now: 1000,
  });
  return {
    ...shell,
    tracks: [
      ...shell.tracks,
      {
        id: `chr11:${extraTrackKind === 'alignment' ? 'pileup' : extraTrackKind}`,
        kind: extraTrackKind,
        label: extraTrackKind,
        state: 'metadata_pending',
        userState: 'Preparing',
      },
    ],
  };
}

function tileRequest(trackId: string): GenomeTileRequest {
  return {
    trackId,
    chrom: 'chr11',
    start: 0,
    end: 1000,
    lod: 0,
    generation: 1,
    fidelity: 'summary',
    byteBudget: 4096,
  };
}

describe('resolveGenomeTrackRoute', () => {
  it('routes the annotation track to annotation_tile trace', () => {
    const session = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42 },
      now: 1000,
    });

    const route = resolveGenomeTrackRoute({
      session,
      request: tileRequest('chr11:annotations'),
    });

    expect(route.kind).toBe('annotation');
    expect(route.traceKind).toBe('annotation_tile');
    expect(route.track).toMatchObject({ id: 'chr11:annotations', kind: 'annotation' });
  });

  it('routes the sequence track to track_tile trace with a sequence-kind descriptor', () => {
    const session = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42 },
      now: 1000,
    });

    const route = resolveGenomeTrackRoute({
      session,
      request: tileRequest('chr11:sequence'),
    });

    expect(route.kind).toBe('sequence');
    expect(route.traceKind).toBe('track_tile');
    expect(route.track).toMatchObject({ id: 'chr11:sequence', kind: 'sequence' });
  });

  it('routes an alignment track to unsupported with track_tile trace and no annotation suffix dependency', () => {
    const session = buildSessionWithTrack('alignment');

    const route = resolveGenomeTrackRoute({
      session,
      request: tileRequest('chr11:pileup'),
    });

    expect(route.kind).toBe('unsupported');
    expect(route.traceKind).toBe('track_tile');
    expect(route.track).toMatchObject({ id: 'chr11:pileup', kind: 'alignment' });
  });

  it('routes a signal track to unsupported with track_tile trace', () => {
    const session = buildSessionWithTrack('signal');

    const route = resolveGenomeTrackRoute({
      session,
      request: tileRequest('chr11:signal'),
    });

    expect(route.kind).toBe('unsupported');
    expect(route.traceKind).toBe('track_tile');
    expect(route.track.kind).toBe('signal');
  });

  it('routes a variant track to unsupported with track_tile trace', () => {
    const session = buildSessionWithTrack('variant');

    const route = resolveGenomeTrackRoute({
      session,
      request: tileRequest('chr11:variant'),
    });

    expect(route.kind).toBe('unsupported');
    expect(route.traceKind).toBe('track_tile');
    expect(route.track.kind).toBe('variant');
  });

  it('fails loudly when the trackId is not in session.tracks', () => {
    const session = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42 },
      now: 1000,
    });

    let thrown: unknown;
    try {
      resolveGenomeTrackRoute({
        session,
        request: tileRequest('chr11:mystery'),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(UnknownGenomeTrackError);
    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as UnknownGenomeTrackError;
    expect(error.trackId).toBe('chr11:mystery');
    expect(error.sessionId).toBe(session.sessionId);
    expect(error.knownTrackIds).toEqual(['chr11:sequence', 'chr11:annotations']);
    expect(error.message).toContain('chr11:mystery');
    expect(error.message).toContain('chr11:sequence');
  });

  it('does not silently coerce an unknown track id into the annotation route', () => {
    const session = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42 },
      now: 1000,
    });

    expect(() =>
      resolveGenomeTrackRoute({
        session,
        request: tileRequest('chr11:annotations:legacy-suffix'),
      })
    ).toThrow(UnknownGenomeTrackError);
  });
});

describe('emptyAnnotationTileForSequenceOnlySession', () => {
  const request: GenomeTileRequest = {
    trackId: 'chr11:annotations',
    chrom: 'chr11',
    start: 0,
    end: 135_086_622,
    lod: 0,
    generation: 3,
    fidelity: 'summary',
    laneEpoch: 'epoch-1',
  };

  function fastaSession(): GenomeSessionShell {
    return createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.fa',
        sourceExt: 'fa',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.fa',
      stat: { size: 1234, mtimeMs: 42 },
      now: 1000,
    });
  }

  it('answers a sequence-only genome with an empty annotation tile', () => {
    const session = fastaSession();
    expect(session.tracks.map((track) => track.kind)).toEqual(['sequence']);
    const tile = emptyAnnotationTileForSequenceOnlySession({
      session,
      request,
      requestId: 'r1',
    });
    expect(tile).toMatchObject({
      requestId: 'r1',
      trackId: 'chr11:annotations',
      state: 'empty',
      recordCount: 0,
      features: [],
      generation: 3,
      laneEpoch: 'epoch-1',
    });
  });

  it('leaves an annotated genome to the normal track route', () => {
    const session = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42 },
      now: 1000,
    });
    expect(
      emptyAnnotationTileForSequenceOnlySession({ session, request, requestId: 'r1' })
    ).toBeNull();
  });

  it('ignores non-annotation requests', () => {
    expect(
      emptyAnnotationTileForSequenceOnlySession({
        session: fastaSession(),
        request: { ...request, trackId: 'chr11:sequence' },
        requestId: 'r1',
      })
    ).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import {
  createDebugSnapshot,
  createGenomeSessionShell,
  createPlaceholderTrackTile,
  markGenomeSessionTrackError,
  updateGenomeSessionShellFromTabState,
} from './genome-session';

describe('genome session shell', () => {
  it('retains prepared reference ownership on an internal chromosome shell', () => {
    const assetGeneration = {
      contract: 'assembly-reference-asset-generation.v1',
      sourceFingerprint: 'a'.repeat(24),
      inventoryFingerprint: 'b'.repeat(64),
      themeMode: 'light',
    } as const;
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/reference-assets/grch38/generations/a/prepared/chr11.gff3.gz',
        workspaceRoot: '/Users/test/reference-assets/grch38',
        sourceExt: 'gff3.gz',
        intent: { kind: 'internal-assembly-segment', assetGeneration },
      },
      resolvedSourcePath:
        '/Users/test/reference-assets/grch38/generations/a/prepared/chr11.gff3.gz',
      stat: { size: 1234, mtimeMs: 42 },
      now: 999,
    });

    expect(shell.assemblyAssetGeneration).toEqual(assetGeneration);
    expect(shell.preparedReferenceReadOnly).toBe(true);
  });

  it('marks an internal prepared-reference child read-only before generation admission', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/reference-assets/sacCer3/generations/a/prepared/chrII.gff3.gz',
        workspaceRoot: '/Users/test/reference-assets/sacCer3',
        sourceExt: 'gff3.gz',
        intent: { kind: 'internal-assembly-segment' },
      },
      resolvedSourcePath:
        '/Users/test/reference-assets/sacCer3/generations/a/prepared/chrII.gff3.gz',
      stat: { size: 1234, mtimeMs: 42 },
      now: 999,
    });

    expect(shell.assemblyAssetGeneration).toBeUndefined();
    expect(shell.preparedReferenceReadOnly).toBe(true);
  });

  it('creates an immediate source-accepted shell without coordinate readiness', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        workspaceRoot: '/Users/test',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42, dev: 1, ino: 2 },
      now: 1000,
    });

    expect(shell.sessionId).toMatch(/^genome-/);
    expect(shell.chrom).toBe('chr11');
    expect(shell.coordinateReady).toBe(false);
    expect(shell.validationState).toBe('metadata_match');
    expect(shell.sourceFingerprint).toContain('/Users/test/chr11.gbff');
    expect(shell.tracks.map((track) => track.id)).toEqual(['chr11:sequence', 'chr11:annotations']);
    expect(shell.tracks[0]).toMatchObject({ state: 'metadata_pending', userState: 'Preparing' });
    expect(shell.tracks[1]).toMatchObject({ state: 'building_cache', userState: 'Updating' });
  });

  it('does not trust a renderer-provided manifest on the immediate source shell', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        manifest: {
          chrom: 'chr11',
          fastaPath: '/Users/test/.waypoint/chr11.fa',
          faiPath: '/Users/test/.waypoint/chr11.fa.fai',
          gffPath: '/Users/test/.waypoint/chr11.gff3.gz',
          tbiPath: '/Users/test/.waypoint/chr11.gff3.gz.tbi',
          length: 135_086_622,
        },
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42 },
      now: 1500,
    });

    expect(shell.coordinateReady).toBe(false);
    expect(shell.length).toBeUndefined();
    expect(shell.manifest).toBeUndefined();
    expect(shell.tracks[0]).toMatchObject({
      state: 'metadata_pending',
      userState: 'Preparing',
    });
    expect(shell.tracks[1]).toMatchObject({
      state: 'building_cache',
      userState: 'Updating',
    });
  });

  it('upgrades validation to strong_match only after session prep attaches a coordinate-ready manifest', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42, ctimeMs: 100 },
      now: 1600,
    });

    const prepared = updateGenomeSessionShellFromTabState({
      session: shell,
      tabState: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceSizeBytes: 1234,
        sourceMtimeMs: 42,
        sourceCtimeMs: 100,
        sourceExt: 'gbff',
        chrom: 'chr11',
        manifest: {
          chrom: 'chr11',
          fastaPath: '/Users/test/.waypoint/chr11.fa',
          faiPath: '/Users/test/.waypoint/chr11.fa.fai',
          gffPath: '/Users/test/.waypoint/chr11.gff3.gz',
          tbiPath: '/Users/test/.waypoint/chr11.gff3.gz.tbi',
          length: 135_086_622,
        },
        metadata: { length: 135_086_622, circular: false, featureCount: 1000 },
      },
    });

    expect(shell.validationState).toBe('metadata_match');
    expect(prepared.validationState).toBe('strong_match');
    expect(prepared.coordinateReady).toBe(true);
  });

  it('keeps a sequence-only assembly coordinate-ready without inventing an annotation track', () => {
    const manifest = {
      chrom: 'contig-1',
      fastaPath: '/Users/test/prepared/contig-1.fa',
      faiPath: '/Users/test/prepared/contig-1.fa.fai',
      gffPath: null,
      tbiPath: null,
      length: 12_345,
    };
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: manifest.fastaPath,
        workspaceRoot: '/Users/test',
        sourceExt: 'fa',
        chrom: manifest.chrom,
        manifest,
        intent: {
          kind: 'reference-assembly',
          annotationProductsReadiness: 'not-applicable',
          searchReadiness: 'not-applicable',
        },
      },
      resolvedSourcePath: manifest.fastaPath,
      stat: { size: 12_345, mtimeMs: 42 },
      now: 1700,
    });

    expect(shell.assemblyAnnotationProductsReadiness).toBe('not-applicable');
    expect(shell.assemblySearchReadiness).toBe('not-applicable');
    expect(shell.tracks.map((track) => track.kind)).toEqual(['sequence']);

    const prepared = updateGenomeSessionShellFromTabState({
      session: shell,
      tabState: {
        sourcePath: manifest.fastaPath,
        sourceExt: 'fa',
        chrom: manifest.chrom,
        manifest,
        metadata: { length: manifest.length, circular: false, featureCount: 0 },
      },
    });
    expect(prepared.coordinateReady).toBe(true);
    expect(prepared.tracks.map((track) => track.kind)).toEqual(['sequence']);
  });

  it('keeps tile placeholder responses bounded and explicitly best_available', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.fa',
        sourceExt: 'fa',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.fa',
      stat: { size: 2000, mtimeMs: 88 },
      now: 2000,
    });

    const tile = createPlaceholderTrackTile({
      session: shell,
      requestId: 'req-1',
      request: {
        trackId: 'chr11:annotations',
        chrom: 'chr11',
        start: 0,
        end: 1000,
        lod: 1,
        generation: 7,
        fidelity: 'summary',
        byteBudget: 4096,
      },
    });

    expect(tile).toMatchObject({
      sessionId: shell.sessionId,
      requestId: 'req-1',
      state: 'missing',
      fidelity: 'best_available',
      byteCount: 0,
      recordCount: 0,
      generation: 7,
    });
  });

  it('echoes request.laneEpoch onto placeholder tile responses', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.fa',
        sourceExt: 'fa',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.fa',
      stat: { size: 2000, mtimeMs: 88 },
      now: 2000,
    });
    const tile = createPlaceholderTrackTile({
      session: shell,
      requestId: 'req-1',
      request: {
        trackId: 'chr11:annotations',
        chrom: 'chr11',
        start: 0,
        end: 1000,
        lod: 1,
        generation: 7,
        fidelity: 'summary',
        byteBudget: 4096,
        laneEpoch: 'fp-chr11:chr11:lane-v1:gene,mRNA:all',
      },
    });
    expect(tile.laneEpoch).toBe('fp-chr11:chr11:lane-v1:gene,mRNA:all');
  });

  it('leaves laneEpoch undefined when the request did not specify one', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.fa',
        sourceExt: 'fa',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.fa',
      stat: { size: 2000, mtimeMs: 88 },
      now: 2000,
    });
    const tile = createPlaceholderTrackTile({
      session: shell,
      requestId: 'req-1',
      request: {
        trackId: 'chr11:annotations',
        chrom: 'chr11',
        start: 0,
        end: 1000,
        lod: 1,
        generation: 7,
        fidelity: 'summary',
      },
    });
    expect(tile.laneEpoch).toBeUndefined();
  });

  it('creates a redacted debug shape with open timings and request traces', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42 },
      now: 3000,
    });

    const snapshot = createDebugSnapshot(
      shell,
      {
        openAcceptedAt: 2950,
        shellReturnedAt: 3025,
        pendingRequests: 1,
        workerCount: 2,
        budgets: {
          maxSequenceWindowBases: 512,
          maxAnnotationViewportTileBases: 1024,
          maxAnnotationViewportTileBytes: 2048,
        },
        recentRequests: [
          {
            traceId: 'trace-1',
            requestId: 'tile-1',
            kind: 'annotation_tile',
            status: 'completed',
            startedAt: 3010,
            completedAt: 3020,
            durationMs: 10,
            trackId: 'chr11:annotations',
            chrom: 'chr11',
            start: 100,
            end: 200,
            lod: 4,
            generation: 7,
            fidelity: 'best_available',
            byteBudget: 4096,
            tileKey: 'provisional:/Users/test/chr11.gbff/chr11:annotations/chr11/100-200',
            tileState: 'ready',
            validationState: 'metadata_match',
            cacheState: 'hit',
            byteCount: 128,
            recordCount: 3,
          },
        ],
      },
      { homeDir: '/Users/test' }
    );

    expect(snapshot.sessionId).toBe(shell.sessionId);
    expect(snapshot.sourcePath).toBe('~/chr11.gbff');
    expect(snapshot.sourcePathRedacted).toBe('~/chr11.gbff');
    expect(snapshot.sourceFingerprint).toContain('provisional:~/chr11.gbff');
    expect(snapshot.open).toMatchObject({
      acceptedAt: 2950,
      shellCreatedAt: 3000,
      shellReturnedAt: 3025,
      elapsedToShellMs: 50,
      status: 'source_accepted',
    });
    expect(snapshot.budgets).toEqual({
      maxSequenceWindowBases: 512,
      maxAnnotationViewportTileBases: 1024,
      maxAnnotationViewportTileBytes: 2048,
    });
    expect(snapshot.queues).toEqual({
      pendingRequests: 1,
      recentRequestCount: 1,
      workerCount: 2,
    });
    expect(snapshot.recentRequests[0]).toMatchObject({
      traceId: 'trace-1',
      kind: 'annotation_tile',
      tileKey: 'provisional:~/chr11.gbff/chr11:annotations/chr11/100-200',
      tileState: 'ready',
      byteCount: 128,
      recordCount: 3,
    });
    expect(snapshot.trackStates).toEqual([
      { id: 'chr11:sequence', kind: 'sequence', state: 'metadata_pending', userState: 'Preparing' },
      {
        id: 'chr11:annotations',
        kind: 'annotation',
        state: 'building_cache',
        userState: 'Updating',
      },
    ]);
  });

  it('includes ctime in the provisional source fingerprint so same-size rewrites invalidate', () => {
    const base = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42, ctimeMs: 100, dev: 1, ino: 2 },
      now: 4000,
    });
    const rewrittenSameSizeAndMtime = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42, ctimeMs: 200, dev: 1, ino: 2 },
      now: 4001,
    });

    expect(rewrittenSameSizeAndMtime.sourceFingerprint).not.toBe(base.sourceFingerprint);
    expect(base.sourceFingerprint).toContain(':100:');
    expect(rewrittenSameSizeAndMtime.sourceFingerprint).toContain(':200:');
  });

  it('marks a single track as a visible error without tearing down the session shell', () => {
    const shell = createGenomeSessionShell({
      source: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceExt: 'gbff',
        intent: { kind: 'reference-single' },
      },
      resolvedSourcePath: '/Users/test/chr11.gbff',
      stat: { size: 1234, mtimeMs: 42 },
      now: 5000,
    });
    const prepared = updateGenomeSessionShellFromTabState({
      session: shell,
      tabState: {
        sourcePath: '/Users/test/chr11.gbff',
        sourceSizeBytes: 1234,
        sourceMtimeMs: 42,
        sourceExt: 'gbff',
        chrom: 'chr11',
        manifest: {
          chrom: 'chr11',
          fastaPath: '/Users/test/.waypoint/chr11.fa',
          faiPath: '/Users/test/.waypoint/chr11.fa.fai',
          gffPath: '/Users/test/.waypoint/chr11.gff3.gz',
          tbiPath: '/Users/test/.waypoint/chr11.gff3.gz.tbi',
          length: 135_086_622,
        },
        metadata: { length: 135_086_622, circular: false, featureCount: 1000 },
      },
    });

    const next = markGenomeSessionTrackError({
      session: prepared,
      kind: 'sequence',
      message: 'Reference index files are missing.',
    });

    expect(next.sessionId).toBe(prepared.sessionId);
    expect(next.coordinateReady).toBe(true);
    expect(next.tracks[0]).toMatchObject({
      kind: 'sequence',
      state: 'error',
      userState: 'Needs attention',
      message: 'Reference index files are missing.',
    });
    expect(next.tracks[1]).toMatchObject({
      kind: 'annotation',
      state: 'ready',
      userState: 'Showing overview',
    });
  });
});

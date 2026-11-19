import { describe, expect, it } from 'vitest';

import {
  PILEUP_PERFORMANCE_LIMITS,
  classifyPileupPerformance,
  pileupCoverageCoversViewport,
} from '../../../scripts/lib/pileup-performance.mjs';

function report(profile = 'portable-dense') {
  const generationKey = 'alignment-source-generation-1';
  const annotationSourceIdentity = `assembly-annotation-source-sha256.v1:${'b'.repeat(64)}`;
  const annotationSourceFingerprint = 'c'.repeat(24);
  const artifactKey = 'assembly-annotation-artifact.v4|theme:light|track:mRNA';
  const ownerKey = [
    'annotation-scene-owner.v3',
    annotationSourceFingerprint,
    'd'.repeat(64),
    artifactKey,
  ].join('\n');
  const annotation = (span: number) => ({
    expectation: {
      trackId: 'mRNA',
      coverageStartBp: 0,
      coverageEndBp: 600_000,
      intervals: [{ id: 'NM_fixture.1', startBp: 60_000, endBp: 200_000 }],
    },
    admitted: {
      readiness: 'ready',
      datasetContract: {
        datasetVersion: 'resolved-annotation-v4:structural-composite-kinds.v1',
        sourceSha256: 'b'.repeat(64),
      },
      artifact: { artifactKey, trackType: 'mRNA' },
      assetGeneration: { sourceFingerprint: annotationSourceFingerprint },
    },
    viewer: {
      visibleTypes: ['mRNA'],
      annotationAuthority: {
        admittedSourceIdentity: annotationSourceIdentity,
        stableSourceIdentity: annotationSourceIdentity,
      },
    },
    policy: {
      verdict: 'exactly-one',
      instanceId: 'current-renderer',
      renderer: {
        supported: true,
        genomeIdentity: annotationSourceIdentity,
        viewportStartBp: 60_000,
        viewportEndBp: 60_000 + span,
        annotation: {
          annotationPresentationOwnerViolations: [] as string[],
          annotationPresentationLayerTypes: ['mRNA'],
          annotationPresentationOwners: [
            {
              ownerId: 'prepacked-partitioned-vector-surface',
              visible: true,
              role: 'exact',
              layerTypes: ['mRNA'],
              coverageComplete: true,
            },
          ],
        },
      },
    },
    body: {
      verdict: 'exactly-one',
      instanceId: 'current-renderer',
      bodyAuthority: {
        contract: 'annotation-body-presentation-authority.v1',
        commitEpoch: 1,
        frameOwner: 'prepacked-vector',
        generation: {
          commitEpoch: 1,
          generationId: 'current-annotation-generation',
          productKind: 'prepacked-vector',
          orderedVisibleTrackIds: ['mRNA'],
          sourceFingerprint: annotationSourceFingerprint,
          placementFingerprint: `ap1:${'e'.repeat(24)}`,
          productFingerprints: [ownerKey],
          policy: { isoformMode: 'canonical', laneLimit: 2 },
        },
      },
    },
    operations: {
      verdict: 'exactly-one',
      instanceId: 'current-renderer',
      operationOracle: { rendererGeneration: 2 },
    },
    activeRenderer: {
      contract: 'pixi-linear-renderer-cold-gesture-snapshot.v1',
      supported: true,
      genomeIdentity: annotationSourceIdentity,
      viewportStartBp: 60_000,
      viewportEndBp: 60_000 + span,
      operation: { rendererGeneration: 2 },
      annotation: {
        contract: 'annotation-overlay-cold-gesture-snapshot.v1',
        genomeIdentity: annotationSourceIdentity,
        presentationVisible: true,
        soleOwnerCount: 1,
        soleOwnerId: 'prepacked-partitioned-vector-surface',
        soleOwnerRole: 'exact',
        soleOwnerCoverageComplete: true,
        soleOwnerContractValid: true,
        activeOwnerKey: ownerKey,
        activeArtifactKey: artifactKey,
        activeSourceIdentity: annotationSourceIdentity,
        activeSourceFingerprint: annotationSourceFingerprint,
        activePlacementFingerprint: `ap1:${'e'.repeat(24)}`,
        activeRuntimeIsoformMode: 'canonical',
        activeRuntimeLaneLimit: 2,
        prepackedRequestedResidentRosterReady: true,
        prepackedSubmittedInstanceCount: 3,
        prepackedSubmittedPartitionCount: 1,
        requestedResidentTracks: [
          {
            trackType: 'mRNA',
            ownerKey,
            prepared: true,
            admitted: true,
            presenting: true,
            coverageStartBp: 0,
            coverageEndBp: 600_000,
            visiblePartitionCount: 1,
            visibleInstanceCount: 3,
          },
        ],
      },
    },
    scene: {
      verdict: 'exactly-one',
      instanceId: 'current-renderer',
      owner: {
        ownerKey,
        ownerGeneration: 1,
        loaded: true,
        status: 'eligible',
        gpuPrepared: true,
        submittedPartitionCount: 1,
        submittedInstanceCount: 3,
        metadata: { genomeIdentity: annotationSourceIdentity, artifactKey, trackType: 'mRNA' },
        runtimePolicy: { isoformMode: 'canonical', laneLimit: 2 },
      },
    },
  });
  const phase = (label: string, kind: string, span: number) => ({
    label,
    kind,
    elapsedMs: kind === 'gesture' ? 200 : 600,
    viewport: {
      startBp: 60_000,
      endBp: 60_000 + span,
      sourceGenerationKey: generationKey,
      sourceFraction: 1,
      meshFraction: 1,
      recordCount: 20_000,
      truncated: false,
      pendingTiles: 0,
      rowsAlpha: span === 44_000 ? 0.6 : 1,
      densityAlpha: span === 44_000 ? 0.4 : 0,
      physicalReadPx: span === 44_000 ? 3 : 6,
      coverageStartBp: 59_000,
      coverageEndBp: 105_000,
    },
    presentation: {
      trackId: 'pileup-current-source',
      lifecycle: {
        status: { phase: 'ready', kind: 'reads' },
        sourceKey: `driver:${generationKey}:current`,
        generation: 1,
        requestSequence: 2,
        planKey: 'current-plan',
        currentPlanKey: 'current-plan',
        currentRange: { start: 60_000, end: 60_000 + span },
        lastPresentedRange: { start: 60_000, end: 60_000 + span },
        pendingPresentation: null,
      },
      gutter: { trackId: 'pileup-current-source', phase: 'ready', visible: true },
    },
    annotation: annotation(span),
    failures: [] as string[],
    cache: { bytes: 80 * 1024 * 1024, entries: 120 },
    cadence: {
      durationMs: 1_200,
      rafIntervalsMs: Array.from({ length: 72 }, () => 1_000 / 60),
      longTaskDurationsMs: [] as number[],
    },
    nativePresentation: {
      status: 'valid',
      refreshHz: 60,
      durationMs: 1_200,
      requestedDurationMs: 1_200,
      expectedFrameCount: 72,
      observedFrameCount: 72,
      targetMatched: true,
      droppedFrames: 0,
      partialFrames: 0,
      missingContentFrames: 0,
    },
  });
  return {
    schema: 'dnaforge.pileup-performance.v1',
    profile,
    failures: [] as string[],
    readiness: {
      ready: true,
      readyAtEpochMs: 1_790_000_000_000,
      samples: [{ startup: { pageLoaded: true, shellReady: true }, api: { status: 200 } }],
    },
    source: {
      commit: 'a'.repeat(40),
      runtimeCommit: 'a'.repeat(40),
      sourceModified: false,
      runtimeModified: false,
      fixtureId: profile === 'full-genome' ? 'hg002-grch38' : 'synthetic-dense-bam',
      generationKey,
      coldScope:
        profile === 'full-genome'
          ? 'process-cold-durable-cache-warm'
          : 'fresh-view-prepared-source',
      assemblyLengthBp: profile === 'full-genome' ? 3_088_269_832 : 600_000,
      chromosomeCount: profile === 'full-genome' ? 24 : 2,
      bamSizeBytes: profile === 'full-genome' ? 130_942_929_010 : 5_000_000,
    },
    phases: [
      phase('open-4kb', 'cold-open', 4_000),
      phase('pan-26612bp', 'gesture', 26_612),
      phase('blend-44000bp', 'gesture', 44_000),
      phase('reopen-26612bp', 'reopen', 26_612),
    ],
    resourceSamples: [0, 1, 2].map((cycle) => ({
      cycle,
      checkpoint: 'reopened-26612bp',
      warmed: true,
      gcPerformed: true,
      heapUsedBytes: 80 * 1024 * 1024 + cycle * 1024 * 1024,
      cacheBytes: 80 * 1024 * 1024,
      cacheEntries: 120,
      electronRssBytes: 400 * 1024 * 1024,
      sidecarRssBytes: 100 * 1024 * 1024,
    })),
  };
}

type Report = ReturnType<typeof report>;

function check(input: unknown, id: string) {
  const result = classifyPileupPerformance(input);
  const found = result.checks.find((entry: { id: string }) => entry.id === id);
  expect(found, `missing check ${id}`).toBeDefined();
  return { result, found };
}

describe('saved pileup performance qualification', () => {
  it('freezes the explicit loading, responsiveness and retained-resource limits', () => {
    expect(PILEUP_PERFORMANCE_LIMITS).toEqual({
      coldOpenMs: 5_000,
      gestureSettleMs: 1_000,
      maxRafGapMs: 50,
      maxLongTaskMs: 50,
      maxCacheBytes: 192 * 1024 * 1024,
      maxCacheEntries: 512,
      retainedHeapGrowthBytes: 64 * 1024 * 1024,
      minimumWarmedCheckpoints: 3,
    });
    expect(Object.isFrozen(PILEUP_PERFORMANCE_LIMITS)).toBe(true);
  });

  it('qualifies the portable workload without claiming full-genome presentation', () => {
    const input = report();
    input.phases.forEach((phase) => Object.assign(phase, { nativePresentation: null }));
    const { result, found } = check(input, 'native-presentation');
    expect(result.status).toBe('pass');
    expect(result.qualifiedForFullGenome).toBe(false);
    expect(found).toMatchObject({ status: 'unqualified', required: false });
  });

  it('requires every full-genome check for full-genome qualification', () => {
    const result = classifyPileupPerformance(report('full-genome'));
    expect(result.status).toBe('pass');
    expect(result.qualifiedForFullGenome).toBe(true);
    expect(result.checks.every((entry: { status: string }) => entry.status === 'pass')).toBe(true);
  });

  it.each([
    ['hidden mRNA', (r: Report) => (r.phases[1].annotation.viewer.visibleTypes = [])],
    ['pending preparation', (r: Report) => (r.phases[1].annotation.admitted.readiness = 'pending')],
    [
      'old source contract',
      (r: Report) =>
        (r.phases[1].annotation.admitted.datasetContract.datasetVersion =
          'resolved-annotation-v3:mapped-track-input.v1'),
    ],
    [
      'stale renderer source',
      (r: Report) => (r.phases[1].annotation.policy.renderer.genomeIdentity = 'old-source'),
    ],
    [
      'stale scene source',
      (r: Report) =>
        (r.phases[1].annotation.activeRenderer.annotation.activeSourceIdentity = 'old-source'),
    ],
    [
      'stale body source',
      (r: Report) =>
        (r.phases[1].annotation.body.bodyAuthority.generation.sourceFingerprint = 'old-source'),
    ],
    [
      'stale body product',
      (r: Report) =>
        (r.phases[1].annotation.body.bodyAuthority.generation.productFingerprints = [
          'old-product',
        ]),
    ],
    [
      'stale body commit',
      (r: Report) => (r.phases[1].annotation.body.bodyAuthority.generation.commitEpoch = 0),
    ],
    [
      'stale annotation viewport',
      (r: Report) => (r.phases[1].annotation.policy.renderer.viewportStartBp -= 1),
    ],
    [
      'competing renderer',
      (r: Report) => (r.phases[1].annotation.operations.instanceId = 'another-renderer'),
    ],
    [
      'hidden body owner',
      (r: Report) =>
        (r.phases[1].annotation.policy.renderer.annotation.annotationPresentationOwners[0].visible = false),
    ],
    [
      'incomplete body owner',
      (r: Report) =>
        (r.phases[1].annotation.policy.renderer.annotation.annotationPresentationOwners[0].coverageComplete = false),
    ],
    [
      'blank geometry',
      (r: Report) =>
        (r.phases[1].annotation.activeRenderer.annotation.prepackedSubmittedInstanceCount = 0),
    ],
    [
      'missing prepared scene',
      (r: Report) =>
        (r.phases[1].annotation.activeRenderer.annotation.requestedResidentTracks[0].prepared = false),
    ],
    [
      'conflicting annotation owners',
      (r: Report) =>
        r.phases[1].annotation.policy.renderer.annotation.annotationPresentationOwnerViolations.push(
          'competing-owners'
        ),
    ],
  ] as const)('rejects fast reads with incorrect annotations: %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    const { result, found } = check(input, 'annotations');
    expect(found.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  it('uses the actually presenting resident when the legacy singleton scene slot is empty', () => {
    const input = report();
    Object.assign(input.phases[1].annotation.scene.owner, {
      loaded: false,
      ownerKey: null,
      metadata: null,
      submittedInstanceCount: 0,
      submittedPartitionCount: 0,
    });
    expect(check(input, 'annotations').found.status).toBe('pass');
  });

  it.each([
    [
      'hidden renderer instance',
      (r: Report) => (r.phases[1].annotation.activeRenderer.operation.rendererGeneration = 1),
    ],
    [
      'stale resident coverage',
      (r: Report) =>
        (r.phases[1].annotation.activeRenderer.annotation.requestedResidentTracks[0].coverageEndBp = 70_000),
    ],
    [
      'unadmitted resident',
      (r: Report) =>
        (r.phases[1].annotation.activeRenderer.annotation.requestedResidentTracks[0].admitted = false),
    ],
    [
      'hidden resident',
      (r: Report) =>
        (r.phases[1].annotation.activeRenderer.annotation.requestedResidentTracks[0].presenting = false),
    ],
    [
      'stale admitted generation',
      (r: Report) =>
        (r.phases[1].annotation.admitted.assetGeneration.sourceFingerprint = 'old-source'),
    ],
  ] as const)('rejects a populated annotation census with %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    expect(check(input, 'annotations').found.status).toBe('fail');
  });

  it('cannot qualify missing annotation observations', () => {
    const input = report();
    Object.assign(input.phases[1], { annotation: undefined });
    expect(check(input, 'annotations').found.status).toBe('unqualified');
  });

  it('cannot infer empty annotations outside the queried source coverage', () => {
    const input = report();
    input.phases[1].annotation.expectation.coverageEndBp = 70_000;
    expect(check(input, 'annotations').found.status).toBe('unqualified');
  });

  it('cannot qualify a journey with no independently known positive annotation interval', () => {
    const input = report();
    input.phases.forEach((phase) => (phase.annotation.expectation.intervals = []));
    expect(check(input, 'annotations').found.status).toBe('unqualified');
  });

  it('accepts a complete empty annotation interval when other measured phases prove genes', () => {
    const input = report();
    const annotation = input.phases[1].annotation;
    annotation.expectation.intervals = [{ id: 'outside-window', startBp: 200_000, endBp: 210_000 }];
    annotation.activeRenderer.annotation.prepackedSubmittedInstanceCount = 0;
    annotation.activeRenderer.annotation.prepackedSubmittedPartitionCount = 0;
    annotation.activeRenderer.annotation.requestedResidentTracks[0].visibleInstanceCount = 0;
    annotation.activeRenderer.annotation.requestedResidentTracks[0].visiblePartitionCount = 0;
    annotation.policy.renderer.annotation.annotationPresentationOwners[0].visible = false;
    annotation.policy.renderer.annotation.annotationPresentationOwners[0].coverageComplete = false;
    expect(check(input, 'annotations').found.status).toBe('pass');
  });

  it('accepts a complete physical blend with current coverage on both flanks', () => {
    const { found } = check(report(), 'viewport');
    expect(found.status).toBe('pass');
  });

  it.each([
    ['left', 1],
    ['left', 4],
    ['right', 1],
    ['right', 4],
  ] as const)('accepts %s blend coverage with %i ULPs of camera roundoff', (edge, ulps) => {
    const input = report();
    const viewport = input.phases[2].viewport;
    Object.assign(viewport, { coverageStartBp: 60_000, coverageEndBp: 104_000 });
    if (edge === 'left') viewport.startBp -= ulps * 2 ** -37;
    else viewport.endBp += ulps * 2 ** -36;
    expect(check(input, 'viewport').found.status).toBe('pass');
    expect(pileupCoverageCoversViewport(viewport)).toBe(true);
  });

  it.each([
    ['left one-base gap', { coverageStartBp: 60_001 }, 'fail'],
    ['right one-base gap', { coverageEndBp: 103_999 }, 'fail'],
    ['left five-ULP gap', { coverageStartBp: 60_000 + 5 * 2 ** -37 }, 'fail'],
    ['right five-ULP gap', { coverageEndBp: 104_000 - 5 * 2 ** -36 }, 'fail'],
    ['missing left coverage', { coverageStartBp: undefined }, 'unqualified'],
    ['missing right coverage', { coverageEndBp: undefined }, 'unqualified'],
    ['NaN left coverage', { coverageStartBp: Number.NaN }, 'unqualified'],
    ['NaN right coverage', { coverageEndBp: Number.NaN }, 'unqualified'],
    ['reversed coverage', { coverageStartBp: 104_000, coverageEndBp: 60_000 }, 'unqualified'],
    ['different interval', { coverageStartBp: 160_000, coverageEndBp: 204_000 }, 'fail'],
  ] as const)('rejects %s at the blend coverage boundary', (_name, coverage, status) => {
    const input = report();
    Object.assign(input.phases[2].viewport, {
      coverageStartBp: 60_000,
      coverageEndBp: 104_000,
      ...coverage,
    });
    expect(check(input, 'viewport').found.status).toBe(status);
    expect(pileupCoverageCoversViewport(input.phases[2].viewport)).toBe(false);
  });

  it('keeps the absolute camera roundoff ceiling for blend coverage', () => {
    const input = report();
    const start = 2 ** 40;
    Object.assign(input.phases[2].viewport, {
      startBp: start,
      endBp: start + 44_000,
      coverageStartBp: start + 2 ** -12,
      coverageEndBp: start + 44_000,
    });
    expect(check(input, 'viewport').found.status).toBe('fail');
    expect(pileupCoverageCoversViewport(input.phases[2].viewport)).toBe(false);
  });

  it('requires the 44kb phase to actually exercise a physical blend', () => {
    const input = report();
    Object.assign(input.phases[2].viewport, {
      physicalReadPx: 6,
      rowsAlpha: 1,
      densityAlpha: 0,
    });
    expect(check(input, 'viewport').found.status).toBe('pass');
    expect(check(input, 'journey').found.status).toBe('unqualified');
  });

  it('does not treat configured hidden rows as incomplete spatial coverage', () => {
    const input = report();
    Object.assign(input.phases[1].viewport, { hiddenReadCount: 50_000, maxRows: 80 });
    expect(classifyPileupPerformance(input).status).toBe('pass');
  });

  it.each([
    ['partial source', (r: Report) => (r.phases[1].viewport.sourceFraction = 0.5)],
    ['partial mesh', (r: Report) => (r.phases[1].viewport.meshFraction = 0.5)],
    ['blank rows', (r: Report) => (r.phases[1].viewport.recordCount = 0)],
    ['stale source', (r: Report) => (r.phases[1].viewport.sourceGenerationKey = 'old-source')],
    ['sampled reads', (r: Report) => (r.phases[1].viewport.truncated = true)],
    ['pending reads', (r: Report) => (r.phases[1].viewport.pendingTiles = 1)],
    ['invisible rows', (r: Report) => (r.phases[1].viewport.rowsAlpha = 0)],
    ['residual readable density', (r: Report) => (r.phases[1].viewport.densityAlpha = 0.4)],
    ['absent blend density', (r: Report) => (r.phases[2].viewport.densityAlpha = 0)],
    ['short blend coverage', (r: Report) => (r.phases[2].viewport.coverageEndBp = 90_000)],
    ['failed tile request', (r: Report) => r.phases[1].failures.push('tile returned 500')],
  ] as const)('rejects fast but incorrect output: %s', (_name, mutate) => {
    const input = report();
    Object.assign(input.phases[1], {
      preparation: { rowsAssignmentBuilding: true, rowsMeshBuilding: true },
    });
    mutate(input);
    const { result, found } = check(input, 'viewport');
    expect(found.status).toBe('fail');
    expect(result.status).toBe('fail');
  });

  it.each([
    [
      'refreshing lifecycle',
      (r: Report) =>
        Object.assign(r.phases[1].presentation.lifecycle, {
          status: { phase: 'refreshing', hasLastGood: true },
        }),
    ],
    [
      'coverage-only acknowledgment',
      (r: Report) => (r.phases[1].presentation.lifecycle.status.kind = 'coverage'),
    ],
    [
      'stale lifecycle source',
      (r: Report) => (r.phases[1].presentation.lifecycle.sourceKey = 'old-source'),
    ],
    ['stale plan', (r: Report) => (r.phases[1].presentation.lifecycle.planKey = 'old-plan')],
    [
      'stale current range',
      (r: Report) => (r.phases[1].presentation.lifecycle.currentRange.start -= 1),
    ],
    [
      'stale presented range',
      (r: Report) => (r.phases[1].presentation.lifecycle.lastPresentedRange.end -= 1),
    ],
    [
      'pending acknowledgment',
      (r: Report) =>
        Object.assign(r.phases[1].presentation.lifecycle, {
          pendingPresentation: { requestSequence: 2 },
        }),
    ],
    [
      'refreshing rendered gutter',
      (r: Report) => (r.phases[1].presentation.gutter.phase = 'refreshing'),
    ],
    ['another lane gutter', (r: Report) => (r.phases[1].presentation.gutter.trackId = 'old-track')],
    ['hidden gutter', (r: Report) => (r.phases[1].presentation.gutter.visible = false)],
  ] as const)(
    'rejects complete meshes before current visible presentation: %s',
    (_name, mutate) => {
      const input = report();
      mutate(input);
      expect(check(input, 'viewport').found.status).toBe('pass');
      const { result, found } = check(input, 'presentation');
      expect(found?.status).toBe('fail');
      expect(result.status).toBe('fail');
    }
  );

  it.each([
    ['presentation', (r: Report) => Object.assign(r.phases[1], { presentation: null })],
    ['lifecycle', (r: Report) => Object.assign(r.phases[1].presentation, { lifecycle: null })],
    [
      'ready kind',
      (r: Report) =>
        Object.assign(r.phases[1].presentation.lifecycle, { status: { phase: 'ready' } }),
    ],
    [
      'request identity',
      (r: Report) => Object.assign(r.phases[1].presentation.lifecycle, { requestSequence: null }),
    ],
    [
      'current plan',
      (r: Report) => Object.assign(r.phases[1].presentation.lifecycle, { currentPlanKey: null }),
    ],
    [
      'presented range',
      (r: Report) =>
        Object.assign(r.phases[1].presentation.lifecycle, { lastPresentedRange: null }),
    ],
    ['rendered gutter', (r: Report) => Object.assign(r.phases[1].presentation, { gutter: null })],
  ] as const)('cannot qualify missing %s observations', (_name, mutate) => {
    const input = report();
    mutate(input);
    expect(check(input, 'presentation').found?.status).toBe('unqualified');
    expect(classifyPileupPerformance(input).status).toBe('unqualified');
  });

  it('qualifies complete visible presented reads during offscreen row and halo preparation', () => {
    const input = report('full-genome');
    Object.assign(input.phases[1], {
      preparation: {
        rowsAssignmentBuilding: true,
        rowsMeshBuilding: true,
        rowsMeshRecordCursor: 4_096,
        rowsMeshTargetRecordCount: 21_322,
        residentBandReady: false,
        residentReadyTileCount: 2,
        residentExpectedTileCount: 16,
      },
    });
    expect(input.phases[1].viewport.pendingTiles).toBe(0);
    expect(classifyPileupPerformance(input)).toMatchObject({
      status: 'pass',
      qualifiedForFullGenome: true,
    });
  });

  it.each([1, 4])('accepts %i ULPs of camera representation roundoff', (ulps) => {
    const input = report('full-genome');
    const phase = input.phases[1];
    const start = 1_809_290_000;
    const end = start + 26_612;
    const roundoff = ulps * 2 ** -22;
    Object.assign(phase.annotation.policy.renderer, {
      viewportStartBp: start + roundoff,
      viewportEndBp: end,
    });
    Object.assign(phase.annotation.activeRenderer, { viewportStartBp: start, viewportEndBp: end });
    Object.assign(phase.annotation.activeRenderer.annotation.requestedResidentTracks[0], {
      coverageStartBp: start - 1,
      coverageEndBp: end + 1,
    });
    phase.annotation.expectation.intervals = [{ id: 'NM_fixture.1', startBp: start, endBp: end }];
    Object.assign(phase.annotation.expectation, {
      coverageStartBp: start - 1,
      coverageEndBp: end + 1,
    });
    Object.assign(phase.viewport, { startBp: start, endBp: end });
    Object.assign(phase.presentation.lifecycle, {
      currentRange: { start, end: end + roundoff },
      lastPresentedRange: { start: start + roundoff, end },
    });
    expect(check(input, 'presentation').found.status).toBe('pass');
    expect(classifyPileupPerformance(input).status).toBe('pass');
  });

  it.each([5 * 2 ** -22, 0.001, 1])('rejects a stale genomic range shifted by %s bp', (shift) => {
    const input = report('full-genome');
    const phase = input.phases[1];
    const start = 1_809_290_000;
    const end = start + 26_612;
    Object.assign(phase.viewport, { startBp: start, endBp: end });
    Object.assign(phase.presentation.lifecycle, {
      currentRange: { start, end },
      lastPresentedRange: { start: start + shift, end },
    });
    expect(check(input, 'presentation').found.status).toBe('fail');
    expect(classifyPileupPerformance(input).status).toBe('fail');
  });

  it('rejects five ULPs at lower coordinates before the absolute ceiling applies', () => {
    const input = report('full-genome');
    const phase = input.phases[1];
    const start = 1_000_000;
    const end = start + 26_612;
    Object.assign(phase.viewport, { startBp: start, endBp: end });
    Object.assign(phase.presentation.lifecycle, {
      currentRange: { start, end },
      lastPresentedRange: { start, end: end + 5 * 2 ** -33 },
    });
    expect(check(input, 'presentation').found.status).toBe('fail');
  });

  it.each([
    ['slow cold open', 0, 5_001],
    ['slow gesture settlement', 1, 1_001],
    ['slow reopen', 3, 5_001],
  ] as const)('fails %s', (_name, phaseIndex, elapsedMs) => {
    const input = report();
    input.phases[phaseIndex].elapsedMs = elapsedMs;
    expect(check(input, 'loading').found.status).toBe('fail');
  });

  it('accepts values at the declared limits', () => {
    const input = report();
    input.phases.forEach((phase) => {
      phase.elapsedMs = phase.kind === 'gesture' ? 1_000 : 5_000;
      phase.cadence.rafIntervalsMs = Array.from({ length: 24 }, () => 50);
      phase.cadence.longTaskDurationsMs = [50];
    });
    input.resourceSamples[2].heapUsedBytes =
      input.resourceSamples[0].heapUsedBytes + 64 * 1024 * 1024;
    input.resourceSamples[2].cacheBytes = 192 * 1024 * 1024;
    input.resourceSamples[2].cacheEntries = 512;
    input.phases[0].cache.bytes = 192 * 1024 * 1024;
    input.phases[2].cache.entries = 512;
    expect(classifyPileupPerformance(input).status).toBe('pass');
  });

  it.each([false, true])(
    'keeps the verdict independent of receipt attribution (slow: %s)',
    (slow) => {
      const input = report();
      if (slow) input.phases[1].elapsedMs = 1_001;
      const original = classifyPileupPerformance(input);
      Object.assign(input.phases[1], { lastInputToAllAcknowledgedMs: 2_500 });
      Object.assign(input.phases[1].cadence, {
        wheel: { firstTrustedEventMs: 5, lastTrustedEventMs: 1_200 },
      });
      Object.assign(input.phases[1].cadence, {
        longAnimationFrames: {
          status: 'available',
          entries: [{ durationMs: 120 }],
          omittedEntries: 0,
        },
      });
      expect(classifyPileupPerformance(input)).toEqual(original);
      Object.assign(input.phases[1].cadence, {
        longAnimationFrames: { status: 'unsupported', entries: [], omittedEntries: 0 },
      });
      expect(classifyPileupPerformance(input)).toEqual(original);
    }
  );

  it.each([
    ['long animation gap', (r: Report) => (r.phases[1].cadence.rafIntervalsMs[10] = 51)],
    ['long task', (r: Report) => r.phases[1].cadence.longTaskDurationsMs.push(51)],
  ] as const)('fails %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    expect(check(input, 'js-cadence').found.status).toBe('fail');
  });

  it.each([
    ['missing cadence', (r: Report) => Object.assign(r.phases[1], { cadence: null })],
    ['empty frame samples', (r: Report) => (r.phases[1].cadence.rafIntervalsMs = [])],
    ['partly observed gesture', (r: Report) => (r.phases[1].cadence.rafIntervalsMs = [16, 16, 16])],
    [
      'missing long-task observer',
      (r: Report) => Object.assign(r.phases[1].cadence, { longTaskDurationsMs: null }),
    ],
  ] as const)('does not qualify %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    expect(check(input, 'js-cadence').found.status).toBe('unqualified');
    expect(classifyPileupPerformance(input).status).not.toBe('pass');
  });

  it.each([
    ['dropped frame', (r: Report) => (r.phases[1].nativePresentation.droppedFrames = 1)],
    ['partial frame', (r: Report) => (r.phases[1].nativePresentation.partialFrames = 1)],
    ['missing content', (r: Report) => (r.phases[1].nativePresentation.missingContentFrames = 1)],
  ] as const)('fails native %s', (_name, mutate) => {
    const input = report('full-genome');
    mutate(input);
    expect(check(input, 'native-presentation').found.status).toBe('fail');
    expect(classifyPileupPerformance(input).qualifiedForFullGenome).toBe(false);
  });

  it.each([
    [
      'missing native trace',
      (r: Report) => Object.assign(r.phases[1], { nativePresentation: null }),
    ],
    ['wrong target', (r: Report) => (r.phases[1].nativePresentation.targetMatched = false)],
    ['unsupported display', (r: Report) => (r.phases[1].nativePresentation.refreshHz = 30)],
    ['incomplete trace', (r: Report) => (r.phases[1].nativePresentation.observedFrameCount = 60)],
    ['short trace', (r: Report) => (r.phases[1].nativePresentation.durationMs = 1_000)],
    [
      'invented expected count',
      (r: Report) => (r.phases[1].nativePresentation.expectedFrameCount = 1),
    ],
    ['ambiguous native result', (r: Report) => (r.phases[1].nativePresentation.status = 'unknown')],
  ] as const)('does not qualify %s', (_name, mutate) => {
    const input = report('full-genome');
    mutate(input);
    expect(check(input, 'native-presentation').found.status).toBe('unqualified');
    expect(classifyPileupPerformance(input).status).not.toBe('pass');
  });

  it.each([
    ['cache bytes', (r: Report) => (r.resourceSamples[1].cacheBytes = 192 * 1024 * 1024 + 1)],
    ['cache entries', (r: Report) => (r.resourceSamples[1].cacheEntries = 513)],
  ] as const)('fails excessive %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    expect(check(input, 'cache').found.status).toBe('fail');
  });

  it.each([
    ['cold-open bytes', 0, 'bytes', 192 * 1024 * 1024 + 1, 'maxObservedBytes'],
    ['wide-window entries', 2, 'entries', 513, 'maxObservedEntries'],
    ['reopened bytes', 3, 'bytes', 192 * 1024 * 1024 + 1, 'maxObservedBytes'],
  ] as const)(
    'rejects excessive %s despite later warm checkpoints within budget',
    (_name, index, field, value, metric) => {
      const input = report();
      input.phases[index].cache[field] = value;
      const { result, found } = check(input, 'cache');
      expect(found.status).toBe('fail');
      expect(found.metrics[metric]).toBe(value);
      expect(result.status).toBe('fail');
    }
  );

  it.each([
    ['whole phase observation', (r: Report) => Object.assign(r.phases[1], { cache: null })],
    ['phase bytes', (r: Report) => Object.assign(r.phases[0].cache, { bytes: null })],
    ['phase entries', (r: Report) => Object.assign(r.phases[2].cache, { entries: null })],
  ] as const)('does not qualify a missing %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    const { result, found } = check(input, 'cache');
    expect(found.status).toBe('unqualified');
    expect(result.status).toBe('unqualified');
  });

  it('rejects a report-level failure even when every measured phase passed', () => {
    const input = report();
    input.failures.push('Runtime transport failed after the final phase.');
    expect(classifyPileupPerformance(input).status).toBe('fail');
  });

  it.each([null, undefined])(
    'requires report-level failure observations instead of %s',
    (value) => {
      const input = report();
      Object.assign(input, { failures: value });
      expect(classifyPileupPerformance(input).status).toBe('unqualified');
    }
  );

  it('fails retained heap growth even if the final sample shrinks', () => {
    const input = report();
    input.resourceSamples[1].heapUsedBytes =
      input.resourceSamples[0].heapUsedBytes + 64 * 1024 * 1024 + 1;
    expect(check(input, 'retained-heap').found.status).toBe('fail');
  });

  it.each([
    ['too few checkpoints', (r: Report) => r.resourceSamples.pop()],
    ['cold sample', (r: Report) => (r.resourceSamples[1].warmed = false)],
    ['uncollected heap', (r: Report) => (r.resourceSamples[1].gcPerformed = false)],
    ['different state', (r: Report) => (r.resourceSamples[1].checkpoint = 'whole-genome')],
    ['repeated cycle', (r: Report) => (r.resourceSamples[1].cycle = 0)],
    [
      'missing retained heap',
      (r: Report) => Object.assign(r.resourceSamples[1], { heapUsedBytes: null }),
    ],
  ] as const)('does not qualify retained memory with %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    expect(check(input, 'retained-heap').found.status).toBe('unqualified');
  });

  it.each([
    ['missing runtime identity', (r: Report) => (r.source.runtimeCommit = '')],
    ['different runtime source', (r: Report) => (r.source.runtimeCommit = 'b'.repeat(40))],
    ['missing source generation', (r: Report) => (r.source.generationKey = '')],
    ['missing fixture identity', (r: Report) => (r.source.fixtureId = '')],
    ['unknown profile', (r: Report) => (r.profile = 'automatic')],
    ['missing blend journey', (r: Report) => r.phases.splice(2, 1)],
    ['missing save/reopen journey', (r: Report) => r.phases.pop()],
  ] as const)('cannot pass with %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    expect(classifyPileupPerformance(input).status).not.toBe('pass');
  });

  it.each([
    ['missing readiness', (r: Report) => Object.assign(r, { readiness: null })],
    ['unready shell', (r: Report) => (r.readiness.samples[0].startup.shellReady = false)],
    ['unready API', (r: Report) => (r.readiness.samples[0].api.status = 503)],
  ] as const)('cannot qualify opening before %s', (_name, mutate) => {
    const input = report();
    mutate(input);
    expect(check(input, 'source').found.status).toBe('unqualified');
    expect(classifyPileupPerformance(input).status).toBe('unqualified');
  });

  it('cannot promote a portable or already-warm fixture into full-genome proof', () => {
    const input = report();
    input.profile = 'full-genome';
    expect(check(input, 'source').found.status).toBe('unqualified');
    expect(classifyPileupPerformance(input).qualifiedForFullGenome).toBe(false);
  });

  it.each([
    ['sourceModified', true],
    ['runtimeModified', true],
    ['sourceModified', null],
    ['runtimeModified', null],
  ] as const)('requires a measured clean %s flag instead of %s', (flag, value) => {
    const input = report('full-genome');
    Object.assign(input.source, { [flag]: value });
    const { result, found } = check(input, 'source');
    expect(found.status).toBe('unqualified');
    expect(result.status).toBe('unqualified');
    expect(result.qualifiedForFullGenome).toBe(false);
  });

  it('retains optional process memory as observations without inventing a budget verdict', () => {
    const input = report();
    Object.assign(input.resourceSamples[1], { electronRssBytes: null, sidecarRssBytes: null });
    const { found } = check(input, 'retained-heap');
    expect(found.status).toBe('pass');
    expect(found.metrics.processMemorySamples[1]).toEqual({
      cycle: 1,
      electronRssBytes: null,
      sidecarRssBytes: null,
    });
  });

  it('does not throw or pass on absent reports and malformed measurements', () => {
    for (const input of [null, undefined, {}, [], { schema: 'wrong' }]) {
      expect(() => classifyPileupPerformance(input)).not.toThrow();
      expect(classifyPileupPerformance(input).status).toBe('unqualified');
    }
    const input = report();
    Object.assign(input.phases[1], { elapsedMs: Number.NaN });
    expect(check(input, 'loading').found.status).toBe('unqualified');
  });

  it('handles malformed JSON values without coercing them into source or camera data', () => {
    const input = report();
    const invalidValue = { toString: null, valueOf: null };
    Object.assign(input.source, { commit: invalidValue });
    Object.assign(input.phases[1].viewport, { endBp: invalidValue });
    Object.assign(input.phases[2], { label: invalidValue });
    Object.assign(input.phases[2].viewport, { endBp: invalidValue });
    Object.assign(input.resourceSamples[0], { cycle: invalidValue });
    expect(() => classifyPileupPerformance(input)).not.toThrow();
    expect(classifyPileupPerformance(input).status).toBe('unqualified');
  });
});

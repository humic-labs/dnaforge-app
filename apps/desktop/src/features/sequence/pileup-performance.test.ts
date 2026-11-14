import { describe, expect, it } from 'vitest';

import {
  PILEUP_PERFORMANCE_LIMITS,
  classifyPileupPerformance,
} from '../../../scripts/lib/pileup-performance.mjs';

function report(profile = 'portable-dense') {
  const generationKey = 'alignment-source-generation-1';
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

  it('accepts a complete physical blend with current coverage on both flanks', () => {
    const { found } = check(report(), 'viewport');
    expect(found.status).toBe('pass');
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
    mutate(input);
    const { result, found } = check(input, 'viewport');
    expect(found.status).toBe('fail');
    expect(result.status).toBe('fail');
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

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { classifyChromiumSurfaceFrameBudget } from './chromium-surface-frame-budget.mjs';

function trace({
  frameCount = 599,
  droppedAt = null,
  partialAt = null,
  noUpdateEvery = 100,
  missingContentAt = null,
  frameSequenceGapAt = null,
  status = 'valid',
  boundaryDurationMs = 5_000,
} = {}) {
  const reporters = Array.from({ length: frameCount }, (_, index) => {
    const frameSequence =
      frameSequenceGapAt !== null && index >= frameSequenceGapAt ? index + 2 : index + 1;
    const state =
      index === droppedAt
        ? 'DROPPED'
        : index === partialAt
          ? 'PRESENTED_PARTIAL'
          : noUpdateEvery > 0 && index % noUpdateEvery === 0
            ? 'NO_UPDATE'
            : 'PRESENTED_ALL';
    return {
      pid: 41,
      surfaceId: '1',
      frameSource: 4_294_967_298,
      frameSequence,
      state,
      hasMissingContent: index === missingContentAt,
      beginTraceTimestampUs: 1_000_000 + index * (1_000_000 / 120),
      endTraceTimestampUs: 1_004_000 + index * (1_000_000 / 120),
    };
  });
  const stateCounts = {
    PRESENTED_ALL: reporters.filter((reporter) => reporter.state === 'PRESENTED_ALL').length,
    PRESENTED_PARTIAL: reporters.filter(
      (reporter) => reporter.state === 'PRESENTED_PARTIAL'
    ).length,
    DROPPED: reporters.filter((reporter) => reporter.state === 'DROPPED').length,
    NO_UPDATE: reporters.filter((reporter) => reporter.state === 'NO_UPDATE').length,
  };
  return {
    status,
    claimStatus:
      stateCounts.DROPPED === 0 &&
      stateCounts.PRESENTED_PARTIAL === 0 &&
      missingContentAt === null
        ? 'pass'
        : 'fail',
    failures: status === 'valid' ? [] : ['synthetic-invalid-trace'],
    claimFailures: [],
    target: { pid: 41, surfaceId: '1' },
    boundary: { durationMs: boundaryDurationMs },
    pipeline: {
      reporters,
      processReporters: [...reporters],
      stateCounts,
      missingContentCount: missingContentAt === null ? 0 : 1,
    },
    presentation: {
      windowCoverageFraction: 0.995,
      requiredWindowCoverageFraction: 0.95,
    },
  };
}

test('passes a complete 120 Hz surface with intentional no-update ticks and zero drops', () => {
  const result = classifyChromiumSurfaceFrameBudget(trace(), {
    requestedMeasurementDurationMs: 5_000,
    budgetMs: 8.3,
  });

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.expectedRefreshOutcomeCount, 600);
  assert.equal(result.refreshOutcomeCount, 599);
  assert.equal(result.refreshOutcomeCoverage, 0.9983);
  assert.equal(result.droppedFrameCount, 0);
  assert.equal(result.partialFrameCount, 0);
  assert.equal(result.frameSequenceGapCount, 0);
});

for (const frameSource of [Number.MAX_SAFE_INTEGER + 1, '', 1.5]) {
  test(`rejects an inexact or empty frame source: ${JSON.stringify(frameSource)}`, () => {
    const input = trace();
    for (const reporter of input.pipeline.reporters) reporter.frameSource = frameSource;
    const result = classifyChromiumSurfaceFrameBudget(input, {
      requestedMeasurementDurationMs: 5_000,
      budgetMs: 8.3,
    });

    assert.equal(result.status, 'invalid');
    assert.ok(result.failures.includes('surface-frame-source-missing-or-ambiguous'));
  });
}

test('retains exact large string frame sources and rejects distinct identities that would round together', () => {
  const input = trace();
  for (const reporter of input.pipeline.reporters) reporter.frameSource = '9007199254740992';
  const clean = classifyChromiumSurfaceFrameBudget(input, {
    requestedMeasurementDurationMs: 5_000,
    budgetMs: 8.3,
  });
  assert.equal(clean.status, 'pass');

  input.pipeline.reporters[300].frameSource = '9007199254740993';
  const ambiguous = classifyChromiumSurfaceFrameBudget(input, {
    requestedMeasurementDurationMs: 5_000,
    budgetMs: 8.3,
  });
  assert.equal(ambiguous.status, 'invalid');
  assert.ok(ambiguous.failures.includes('surface-frame-source-missing-or-ambiguous'));
});

test('derives expected refresh outcomes from the measured trace boundary', () => {
  const result = classifyChromiumSurfaceFrameBudget(
    trace({ frameCount: 606, boundaryDurationMs: 5_069.657 }),
    {
      requestedMeasurementDurationMs: 5_000,
      budgetMs: 8.3,
    }
  );

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.expectedRefreshOutcomeCount, 608);
  assert.equal(result.refreshOutcomeCount, 606);
  assert.equal(result.refreshOutcomeCoverage, 0.9967);
  assert.equal(result.requestedDurationCoverage, 1.0139);
});

test('fails when Chromium classifies one target-surface frame as dropped', () => {
  const result = classifyChromiumSurfaceFrameBudget(trace({ droppedAt: 300 }), {
    requestedMeasurementDurationMs: 5_000,
    budgetMs: 8.3,
  });

  assert.equal(result.status, 'fail');
  assert.ok(result.failures.includes('surface-pipeline-dropped:1'));
});

test('collapses forked reporters to one frame-sequence outcome when that tick fully presented', () => {
  const input = trace();
  input.pipeline.reporters.push({
    ...input.pipeline.reporters[300],
    state: 'DROPPED',
    beginTraceTimestampUs: input.pipeline.reporters[300].beginTraceTimestampUs,
    endTraceTimestampUs: input.pipeline.reporters[300].endTraceTimestampUs - 1_000,
  });

  const result = classifyChromiumSurfaceFrameBudget(input, {
    requestedMeasurementDurationMs: 5_000,
    budgetMs: 8.3,
  });

  assert.equal(result.status, 'pass', JSON.stringify(result));
  assert.equal(result.rawPipelineReporterCount, 600);
  assert.equal(result.refreshOutcomeCount, 599);
  assert.equal(result.frameSequenceDuplicateCount, 1);
  assert.equal(result.droppedFrameCount, 0);
});

test('fails partial presentation and missing content instead of counting them as clean frames', () => {
  const input = trace({ partialAt: 200, missingContentAt: 400 });
  Object.assign(input.pipeline.reporters[200], {
    reason: 'REASON_DISPLAY_COMPOSITOR',
    scrollState: 'SCROLL_MAIN_THREAD',
    hasHighLatency: true,
    highLatencyContributionStages: ['StartDrawToSwapStart'],
    checkerboardedNeedsRaster: true,
    checkerboardedNeedsRecord: false,
    surfaceFrameTraceId: 701,
    displayTraceId: 702,
  });
  const result = classifyChromiumSurfaceFrameBudget(
    input,
    {
      requestedMeasurementDurationMs: 5_000,
      budgetMs: 8.3,
    }
  );

  assert.equal(result.status, 'fail');
  assert.ok(result.failures.includes('surface-pipeline-presented-partial:1'));
  assert.ok(result.failures.includes('surface-pipeline-missing-content:1'));
  assert.deepEqual(
    result.failedOutcomes.map((outcome) => ({
      frameSequence: outcome.frameSequence,
      state: outcome.state,
      hasMissingContent: outcome.hasMissingContent,
      reporterCount: outcome.reporterCount,
    })),
    [
      {
        frameSequence: 201,
        state: 'PRESENTED_PARTIAL',
        hasMissingContent: false,
        reporterCount: 1,
      },
      {
        frameSequence: 401,
        state: 'NO_UPDATE',
        hasMissingContent: true,
        reporterCount: 1,
      },
    ]
  );
  assert.equal(result.failedOutcomes[0].reporters[0].state, 'PRESENTED_PARTIAL');
  assert.equal(result.failedOutcomes[0].reporters[0].beginTraceTimestampUs, 2_666_666.666666667);
  assert.deepEqual(
    {
      reason: result.failedOutcomes[0].reporters[0].reason,
      scrollState: result.failedOutcomes[0].reporters[0].scrollState,
      hasHighLatency: result.failedOutcomes[0].reporters[0].hasHighLatency,
      highLatencyContributionStages:
        result.failedOutcomes[0].reporters[0].highLatencyContributionStages,
      checkerboardedNeedsRaster:
        result.failedOutcomes[0].reporters[0].checkerboardedNeedsRaster,
      checkerboardedNeedsRecord:
        result.failedOutcomes[0].reporters[0].checkerboardedNeedsRecord,
      surfaceFrameTraceId: result.failedOutcomes[0].reporters[0].surfaceFrameTraceId,
      displayTraceId: result.failedOutcomes[0].reporters[0].displayTraceId,
    },
    {
      reason: 'REASON_DISPLAY_COMPOSITOR',
      scrollState: 'SCROLL_MAIN_THREAD',
      hasHighLatency: true,
      highLatencyContributionStages: ['StartDrawToSwapStart'],
      checkerboardedNeedsRaster: true,
      checkerboardedNeedsRecord: false,
      surfaceFrameTraceId: 701,
      displayTraceId: 702,
    }
  );
});

test('invalidates missing frame sequences and insufficient refresh-window coverage', () => {
  const missingSequenceTrace = trace({ frameSequenceGapAt: 300 });
  missingSequenceTrace.pipeline.processReporters.push({
    ...missingSequenceTrace.pipeline.reporters[299],
    surfaceId: 'other-surface',
    frameSequence: 301,
    state: 'NO_UPDATE',
    frameType: 'FORKED',
  });
  const missingSequence = classifyChromiumSurfaceFrameBudget(
    missingSequenceTrace,
    {
      requestedMeasurementDurationMs: 5_000,
      budgetMs: 8.3,
    }
  );
  const truncated = classifyChromiumSurfaceFrameBudget(trace({ frameCount: 300 }), {
    requestedMeasurementDurationMs: 5_000,
    budgetMs: 8.3,
  });

  assert.equal(missingSequence.status, 'invalid');
  assert.ok(missingSequence.failures.includes('surface-frame-sequence-gap:1'));
  assert.deepEqual(missingSequence.frameSequenceGaps, [
    {
      previousSequence: 300,
      missingSequence: 301,
      nextSequence: 302,
      sameProcessReporters: [
        {
          surfaceId: 'other-surface',
          state: 'NO_UPDATE',
          frameType: 'FORKED',
          affectsSmoothness: null,
          hasMissingContent: false,
          latencyMs: null,
        },
      ],
    },
  ]);
  assert.equal(truncated.status, 'invalid');
  assert.ok(truncated.failures.includes('surface-refresh-outcome-coverage-insufficient'));
});

test('rejects an invalid trace or unsupported nominal display budget', () => {
  const invalidTrace = classifyChromiumSurfaceFrameBudget(trace({ status: 'invalid' }), {
    requestedMeasurementDurationMs: 5_000,
    budgetMs: 8.3,
  });
  const invalidBudget = classifyChromiumSurfaceFrameBudget(trace(), {
    requestedMeasurementDurationMs: 5_000,
    budgetMs: 10,
  });

  assert.equal(invalidTrace.status, 'invalid');
  assert.ok(invalidTrace.failures.includes('synthetic-invalid-trace'));
  assert.equal(invalidBudget.status, 'invalid');
  assert.ok(invalidBudget.failures.includes('unsupported-display-budget'));
});

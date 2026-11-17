const BUDGET_TO_REFRESH_HZ = new Map([
  [8.3, 120],
  [16.7, 60],
]);
const MIN_REFRESH_OUTCOME_COVERAGE = 0.95;
const QUALIFIED_STATES = new Set([
  'PRESENTED_ALL',
  'PRESENTED_PARTIAL',
  'DROPPED',
  'NO_UPDATE',
]);

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function unique(values) {
  return [...new Set(values)];
}

function result(status, failures, metrics = {}) {
  return {
    status,
    reason:
      status === 'pass'
        ? null
        : status === 'fail'
          ? 'chromium-surface-frame-budget-failed'
          : 'chromium-surface-frame-budget-invalid',
    failures: unique(failures),
    ...metrics,
  };
}

export function classifyChromiumSurfaceFrameBudget(
  trace,
  {
    requestedMeasurementDurationMs,
    budgetMs,
    scoringWindowTraceTimestampsUs = null,
  } = {}
) {
  const invalidFailures = [];
  const refreshHz = BUDGET_TO_REFRESH_HZ.get(budgetMs);
  if (refreshHz === undefined) invalidFailures.push('unsupported-display-budget');
  if (!finitePositive(requestedMeasurementDurationMs)) {
    invalidFailures.push('requested-measurement-duration-invalid');
  }
  if (trace?.status !== 'valid') {
    invalidFailures.push(...(Array.isArray(trace?.failures) ? trace.failures : []));
    if (!Array.isArray(trace?.failures) || trace.failures.length === 0) {
      invalidFailures.push('surface-presentation-trace-invalid');
    }
  }

  const allReporters = Array.isArray(trace?.pipeline?.reporters)
    ? trace.pipeline.reporters
    : [];
  const traceBoundaryStartUs = trace?.boundary?.start?.traceTimestampUs;
  const traceBoundaryEndUs = trace?.boundary?.end?.traceTimestampUs;
  let scoringWindowStartUs = traceBoundaryStartUs;
  let scoringWindowEndUs = traceBoundaryEndUs;
  if (scoringWindowTraceTimestampsUs !== null) {
    scoringWindowStartUs = scoringWindowTraceTimestampsUs?.start;
    scoringWindowEndUs = scoringWindowTraceTimestampsUs?.end;
    if (
      !finitePositive(scoringWindowStartUs) ||
      !finitePositive(scoringWindowEndUs) ||
      !(scoringWindowEndUs > scoringWindowStartUs) ||
      !finitePositive(traceBoundaryStartUs) ||
      !finitePositive(traceBoundaryEndUs) ||
      scoringWindowStartUs < traceBoundaryStartUs ||
      scoringWindowEndUs > traceBoundaryEndUs
    ) {
      invalidFailures.push('surface-scoring-window-invalid');
    }
  }
  const reporters = scoringWindowTraceTimestampsUs === null
    ? allReporters
    : allReporters.filter(
        (reporter) =>
          reporter?.beginTraceTimestampUs >= scoringWindowStartUs &&
          reporter.beginTraceTimestampUs <= scoringWindowEndUs
      );
  if (reporters.length === 0) invalidFailures.push('surface-pipeline-reporters-missing');
  const targetPid = trace?.target?.pid;
  const targetSurfaceId = trace?.target?.surfaceId;
  if (!Number.isSafeInteger(targetPid)) invalidFailures.push('surface-target-process-invalid');
  if (
    (typeof targetSurfaceId !== 'string' || targetSurfaceId.length === 0) &&
    !Number.isSafeInteger(targetSurfaceId)
  ) {
    invalidFailures.push('surface-target-id-invalid');
  }

  const frameSources = unique(reporters.map((reporter) => reporter.frameSource));
  if (
    frameSources.length !== 1 ||
    !(
      (typeof frameSources[0] === 'string' && frameSources[0].length > 0) ||
      Number.isSafeInteger(frameSources[0])
    )
  ) {
    invalidFailures.push('surface-frame-source-missing-or-ambiguous');
  }
  if (
    reporters.some(
      (reporter) =>
        reporter.pid !== targetPid ||
        String(reporter.surfaceId) !== String(targetSurfaceId)
    )
  ) {
    invalidFailures.push('surface-reporter-target-mismatch');
  }
  if (reporters.some((reporter) => !QUALIFIED_STATES.has(reporter.state))) {
    invalidFailures.push('surface-reporter-state-invalid');
  }

  if (reporters.some((reporter) => !Number.isSafeInteger(reporter.frameSequence))) {
    invalidFailures.push('surface-frame-sequence-invalid');
  }
  const outcomeGroups = new Map();
  for (const reporter of reporters) {
    const key = `${String(reporter.frameSource)}:${String(reporter.frameSequence)}`;
    const group = outcomeGroups.get(key) ?? [];
    group.push(reporter);
    outcomeGroups.set(key, group);
  }
  const outcomes = [...outcomeGroups.values()].map((group) => {
    const states = new Set(group.map((reporter) => reporter.state));
    const state = states.has('DROPPED')
      ? 'DROPPED'
      : states.has('PRESENTED_PARTIAL')
        ? 'PRESENTED_PARTIAL'
        : states.has('PRESENTED_ALL')
          ? 'PRESENTED_ALL'
          : 'NO_UPDATE';
    return {
      frameSource: group[0]?.frameSource ?? null,
      frameSequence: group[0]?.frameSequence ?? null,
      state,
      hasMissingContent: group.some(
        (reporter) => reporter.hasMissingContent === true
      ),
      reporterCount: group.length,
      reporters: group.map((reporter) => ({
        id: reporter.id ?? null,
        idScope: reporter.idScope ?? null,
        state: reporter.state,
        latencyMs: reporter.latencyMs ?? null,
        affectsSmoothness: reporter.affectsSmoothness ?? null,
        frameType: reporter.frameType ?? null,
        reason: reporter.reason ?? null,
        scrollState: reporter.scrollState ?? null,
        hasHighLatency: reporter.hasHighLatency ?? null,
        highLatencyContributionStages: reporter.highLatencyContributionStages ?? [],
        checkerboardedNeedsRaster: reporter.checkerboardedNeedsRaster ?? null,
        checkerboardedNeedsRecord: reporter.checkerboardedNeedsRecord ?? null,
        surfaceFrameTraceId: reporter.surfaceFrameTraceId ?? null,
        displayTraceId: reporter.displayTraceId ?? null,
        beginTraceTimestampUs: reporter.beginTraceTimestampUs ?? null,
        endTraceTimestampUs: reporter.endTraceTimestampUs ?? null,
      })),
    };
  });
  const sequences = outcomes
    .map((outcome) => outcome.frameSequence)
    .filter(Number.isSafeInteger)
    .sort((left, right) => left - right);
  let frameSequenceGapCount = 0;
  const frameSequenceGaps = [];
  const frameSequenceDuplicateCount = reporters.length - outcomes.length;
  for (let index = 1; index < sequences.length; index += 1) {
    const delta = sequences[index] - sequences[index - 1];
    if (delta > 1) {
      frameSequenceGapCount += delta - 1;
      for (
        let missingSequence = sequences[index - 1] + 1;
        missingSequence < sequences[index] && frameSequenceGaps.length < 20;
        missingSequence += 1
      ) {
        const processReporters = Array.isArray(trace?.pipeline?.processReporters)
          ? trace.pipeline.processReporters
          : [];
        frameSequenceGaps.push({
          previousSequence: sequences[index - 1],
          missingSequence,
          nextSequence: sequences[index],
          sameProcessReporters: processReporters
            .filter(
              (reporter) =>
                reporter.frameSource === frameSources[0] &&
                reporter.frameSequence === missingSequence
            )
            .map((reporter) => ({
              surfaceId: reporter.surfaceId,
              state: reporter.state,
              frameType: reporter.frameType ?? null,
              affectsSmoothness: reporter.affectsSmoothness ?? null,
              hasMissingContent: reporter.hasMissingContent === true,
              latencyMs: reporter.latencyMs ?? null,
            })),
        });
      }
    }
  }
  if (frameSequenceGapCount > 0) {
    invalidFailures.push(`surface-frame-sequence-gap:${frameSequenceGapCount}`);
  }

  const traceBoundaryDurationMs =
    scoringWindowTraceTimestampsUs === null
      ? trace?.boundary?.durationMs
      : (scoringWindowEndUs - scoringWindowStartUs) / 1_000;
  const expectedRefreshOutcomeCount =
    refreshHz === undefined || !finitePositive(traceBoundaryDurationMs)
      ? null
      : Math.round((traceBoundaryDurationMs * refreshHz) / 1_000);
  const refreshOutcomeCount = outcomes.length;
  const refreshOutcomeCoverage =
    expectedRefreshOutcomeCount && expectedRefreshOutcomeCount > 0
      ? +(refreshOutcomeCount / expectedRefreshOutcomeCount).toFixed(4)
      : null;
  if (
    refreshOutcomeCoverage !== null &&
    refreshOutcomeCoverage < MIN_REFRESH_OUTCOME_COVERAGE
  ) {
    invalidFailures.push('surface-refresh-outcome-coverage-insufficient');
  }
  const firstOutcomeStartedAtUs = reporters.length > 0
    ? Math.min(...reporters.map((reporter) => reporter.beginTraceTimestampUs))
    : null;
  const lastOutcomeCompletedAtUs = reporters.length > 0
    ? Math.max(...reporters.map((reporter) => reporter.endTraceTimestampUs))
    : null;
  const surfaceWindowCoverage = scoringWindowTraceTimestampsUs === null
    ? trace?.presentation?.windowCoverageFraction ?? null
    : finitePositive(traceBoundaryDurationMs) &&
        finitePositive(firstOutcomeStartedAtUs) &&
        finitePositive(lastOutcomeCompletedAtUs)
      ? Math.max(
          0,
          Math.min(lastOutcomeCompletedAtUs, scoringWindowEndUs) -
            Math.max(firstOutcomeStartedAtUs, scoringWindowStartUs)
        ) / (traceBoundaryDurationMs * 1_000)
      : null;
  if (
    typeof surfaceWindowCoverage !== 'number' ||
    surfaceWindowCoverage <
      (trace?.presentation?.requiredWindowCoverageFraction ?? 0.95)
  ) {
    invalidFailures.push('surface-presentation-window-coverage-insufficient');
  }

  if (!finitePositive(traceBoundaryDurationMs)) {
    invalidFailures.push('surface-trace-boundary-duration-invalid');
  }
  const requestedDurationCoverage =
    finitePositive(traceBoundaryDurationMs) &&
    finitePositive(requestedMeasurementDurationMs)
      ? +(traceBoundaryDurationMs / requestedMeasurementDurationMs).toFixed(4)
      : null;
  if (
    requestedDurationCoverage !== null &&
    requestedDurationCoverage < MIN_REFRESH_OUTCOME_COVERAGE
  ) {
    invalidFailures.push('surface-trace-boundary-duration-insufficient');
  }
  const stateCounts = {
    PRESENTED_ALL: outcomes.filter((outcome) => outcome.state === 'PRESENTED_ALL')
      .length,
    PRESENTED_PARTIAL: outcomes.filter(
      (outcome) => outcome.state === 'PRESENTED_PARTIAL'
    ).length,
    DROPPED: outcomes.filter((outcome) => outcome.state === 'DROPPED').length,
    NO_UPDATE: outcomes.filter((outcome) => outcome.state === 'NO_UPDATE').length,
  };
  const missingContentCount = outcomes.filter(
    (outcome) => outcome.hasMissingContent === true
  ).length;
  const failedOutcomes = outcomes
    .filter(
      (outcome) =>
        outcome.state === 'DROPPED' ||
        outcome.state === 'PRESENTED_PARTIAL' ||
        outcome.hasMissingContent === true
    )
    .slice(0, 20);
  const metrics = {
    budgetMs,
    refreshHz: refreshHz ?? null,
    exactNominalRefreshPeriodMs: refreshHz ? 1_000 / refreshHz : null,
    traceBoundaryDurationMs: finitePositive(traceBoundaryDurationMs)
      ? traceBoundaryDurationMs
      : null,
    requestedDurationCoverage,
    expectedRefreshOutcomeCount,
    refreshOutcomeCount,
    refreshOutcomeCoverage,
    minimumRefreshOutcomeCoverage: MIN_REFRESH_OUTCOME_COVERAGE,
    frameSource: frameSources.length === 1 ? frameSources[0] : null,
    firstFrameSequence: sequences[0] ?? null,
    lastFrameSequence: sequences.at(-1) ?? null,
    frameSequenceGapCount,
    frameSequenceGaps,
    frameSequenceDuplicateCount,
    rawPipelineReporterCount: reporters.length,
    presentedAllFrameCount: stateCounts.PRESENTED_ALL,
    intentionalNoUpdateFrameCount: stateCounts.NO_UPDATE,
    droppedFrameCount: stateCounts.DROPPED,
    partialFrameCount: stateCounts.PRESENTED_PARTIAL,
    missingContentFrameCount: missingContentCount,
    failedOutcomes,
    surfaceWindowCoverage,
    scoringWindowTraceTimestampsUs:
      scoringWindowTraceTimestampsUs === null
        ? null
        : { start: scoringWindowStartUs, end: scoringWindowEndUs },
  };
  if (invalidFailures.length > 0) return result('invalid', invalidFailures, metrics);

  const productFailures = [];
  if (stateCounts.DROPPED > 0) {
    productFailures.push(`surface-pipeline-dropped:${stateCounts.DROPPED}`);
  }
  if (stateCounts.PRESENTED_PARTIAL > 0) {
    productFailures.push(
      `surface-pipeline-presented-partial:${stateCounts.PRESENTED_PARTIAL}`
    );
  }
  if (missingContentCount > 0) {
    productFailures.push(`surface-pipeline-missing-content:${missingContentCount}`);
  }
  if (productFailures.length > 0) return result('fail', productFailures, metrics);
  return result('pass', [], metrics);
}

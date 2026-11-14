export const PILEUP_PERFORMANCE_LIMITS = Object.freeze({
  coldOpenMs: 5_000,
  gestureSettleMs: 1_000,
  maxRafGapMs: 50,
  maxLongTaskMs: 50,
  maxCacheBytes: 192 * 1024 * 1024,
  maxCacheEntries: 512,
  retainedHeapGrowthBytes: 64 * 1024 * 1024,
  minimumWarmedCheckpoints: 3,
});

const profiles = new Set(['portable-dense', 'full-genome']);
const phaseKinds = new Set(['cold-open', 'gesture', 'reopen']);
const commitPattern = /^[a-f0-9]{40}$/u;
const limits = PILEUP_PERFORMANCE_LIMITS;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const positive = (value) => nonnegative(value) && value > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const fraction = (value) => nonnegative(value) && value <= 1;
const bounds = (start, end) => nonnegative(start) && nonnegative(end) && end > start;
const maximum = (values) =>
  values.length > 0 ? values.reduce((max, value) => Math.max(max, value)) : null;

function createCheck(id, required = true) {
  return { id, required, status: 'pass', failures: [], metrics: {} };
}

function invalidate(check, reason) {
  if (check.status !== 'fail') check.status = 'unqualified';
  check.failures.push(reason);
}

function fail(check, reason) {
  check.status = 'fail';
  check.failures.push(reason);
}

function classifySource(report) {
  const check = createCheck('source');
  if (report?.schema !== 'dnaforge.pileup-performance.v1')
    invalidate(check, 'unsupported-report-schema');
  if (!profiles.has(report?.profile)) invalidate(check, 'unsupported-profile');
  const source = object(report?.source) ? report.source : {};
  if (
    !text(source.commit) ||
    !text(source.runtimeCommit) ||
    !commitPattern.test(source.commit) ||
    !commitPattern.test(source.runtimeCommit)
  ) {
    invalidate(check, 'source-or-runtime-commit-missing');
  } else if (source.commit !== source.runtimeCommit) {
    invalidate(check, 'runtime-source-mismatch');
  }
  if (!text(source.fixtureId)) invalidate(check, 'fixture-identity-missing');
  if (!text(source.generationKey)) invalidate(check, 'alignment-generation-missing');
  if (
    !count(source.assemblyLengthBp) ||
    source.assemblyLengthBp === 0 ||
    !count(source.chromosomeCount) ||
    source.chromosomeCount === 0
  ) {
    invalidate(check, 'reference-identity-missing');
  }
  if (!count(source.bamSizeBytes) || source.bamSizeBytes === 0)
    invalidate(check, 'alignment-size-missing');
  if (report?.profile === 'full-genome') {
    if (source.coldScope !== 'process-cold-durable-cache-warm')
      invalidate(check, 'full-genome-process-cold-evidence-missing');
    if (
      source.assemblyLengthBp !== 3_088_269_832 ||
      source.chromosomeCount !== 24 ||
      !count(source.bamSizeBytes) ||
      source.bamSizeBytes < 100_000_000_000
    ) {
      invalidate(check, 'full-genome-fixture-not-qualified');
    }
  } else if (
    !['fresh-view-prepared-source', 'process-cold-durable-cache-warm'].includes(source.coldScope)
  ) {
    invalidate(check, 'cold-scope-missing');
  }
  check.metrics = {
    commit: source.commit ?? null,
    runtimeCommit: source.runtimeCommit ?? null,
    fixtureId: source.fixtureId ?? null,
    coldScope: source.coldScope ?? null,
    assemblyLengthBp: source.assemblyLengthBp ?? null,
    chromosomeCount: source.chromosomeCount ?? null,
    bamSizeBytes: source.bamSizeBytes ?? null,
  };
  return check;
}

function classifyJourney(phases) {
  const check = createCheck('journey');
  if (phases.length === 0) invalidate(check, 'measurements-missing');
  const labels = new Set();
  for (const phase of phases) {
    if (!object(phase) || !text(phase.label) || !phaseKinds.has(phase.kind)) {
      invalidate(check, 'phase-identity-invalid');
      continue;
    }
    if (labels.has(phase.label)) invalidate(check, `duplicate-phase:${phase.label}`);
    labels.add(phase.label);
  }
  if (!phases.some((phase) => phase?.kind === 'cold-open')) invalidate(check, 'cold-open-missing');
  if (!phases.some((phase) => phase?.kind === 'reopen'))
    invalidate(check, 'saved-view-reopen-missing');
  const hasSpan = (span, kind, mode) =>
    phases.some((phase) => {
      const viewport = phase?.viewport;
      return (
        (!kind || phase?.kind === kind) &&
        bounds(viewport?.startBp, viewport?.endBp) &&
        Math.abs(viewport.endBp - viewport.startBp - span) <= 2 &&
        (!mode ||
          (positive(viewport.physicalReadPx) &&
            (mode === 'readable'
              ? viewport.physicalReadPx >= 3.6
              : viewport.physicalReadPx >= 1.5 && viewport.physicalReadPx < 3.6)))
      );
    });
  if (!hasSpan(4_000)) invalidate(check, 'read-detail-precondition-missing');
  if (!hasSpan(26_612, 'gesture', 'readable'))
    invalidate(check, 'readable-gesture-span-missing:26612');
  if (!hasSpan(44_000, 'gesture', 'blend')) invalidate(check, 'blend-gesture-span-missing:44000');
  check.metrics = { phaseCount: phases.length, labels: [...labels] };
  return check;
}

function classifyViewport(phases, generationKey) {
  const check = createCheck('viewport');
  if (phases.length === 0) invalidate(check, 'viewport-observations-missing');
  for (const phase of phases) {
    const label = text(phase?.label) ? phase.label : 'unknown-phase';
    const viewport = object(phase?.viewport) ? phase.viewport : {};
    if (!bounds(viewport.startBp, viewport.endBp)) invalidate(check, `${label}:camera-invalid`);
    if (!text(viewport.sourceGenerationKey))
      invalidate(check, `${label}:source-generation-missing`);
    else if (viewport.sourceGenerationKey !== generationKey)
      fail(check, `${label}:stale-source-generation`);
    for (const name of ['sourceFraction', 'meshFraction']) {
      if (!fraction(viewport[name])) invalidate(check, `${label}:${name}-missing`);
      else if (viewport[name] < 0.999) fail(check, `${label}:${name}-incomplete`);
    }
    if (!count(viewport.recordCount)) invalidate(check, `${label}:record-count-missing`);
    else if (viewport.recordCount === 0) fail(check, `${label}:populated-window-is-blank`);
    if (typeof viewport.truncated !== 'boolean')
      invalidate(check, `${label}:truncation-state-missing`);
    else if (viewport.truncated) fail(check, `${label}:sampled-window`);
    if (!count(viewport.pendingTiles)) invalidate(check, `${label}:pending-tile-count-missing`);
    else if (viewport.pendingTiles !== 0) fail(check, `${label}:read-tiles-pending`);
    if (!Array.isArray(phase?.failures)) invalidate(check, `${label}:failure-observations-missing`);
    else if (phase.failures.length > 0) fail(check, `${label}:runtime-or-transport-errors`);
    if (
      !positive(viewport.physicalReadPx) ||
      viewport.physicalReadPx < 1.5 ||
      !fraction(viewport.rowsAlpha) ||
      !fraction(viewport.densityAlpha)
    ) {
      invalidate(check, `${label}:read-presentation-unqualified`);
      continue;
    }
    if (viewport.physicalReadPx >= 3.6) {
      if (viewport.rowsAlpha < 0.98 || viewport.densityAlpha > 0.02)
        fail(check, `${label}:readable-rows-not-current-owner`);
    } else {
      if (viewport.rowsAlpha <= 0.02 || viewport.densityAlpha <= 0.02)
        fail(check, `${label}:physical-blend-incomplete`);
      if (!bounds(viewport.coverageStartBp, viewport.coverageEndBp)) {
        invalidate(check, `${label}:blend-coverage-bounds-missing`);
      } else if (
        bounds(viewport.startBp, viewport.endBp) &&
        (viewport.coverageStartBp > viewport.startBp || viewport.coverageEndBp < viewport.endBp)
      ) {
        fail(check, `${label}:blend-coverage-misses-viewport`);
      }
    }
  }
  return check;
}

function classifyLoading(phases) {
  const check = createCheck('loading');
  check.metrics.phases = [];
  if (phases.length === 0) invalidate(check, 'loading-measurements-missing');
  for (const phase of phases) {
    const label = text(phase?.label) ? phase.label : 'unknown-phase';
    const limitMs = phase?.kind === 'gesture' ? limits.gestureSettleMs : limits.coldOpenMs;
    if (!nonnegative(phase?.elapsedMs)) invalidate(check, `${label}:elapsed-time-missing`);
    else if (phase.elapsedMs > limitMs) fail(check, `${label}:loading-budget-exceeded`);
    check.metrics.phases.push({ label, elapsedMs: phase?.elapsedMs ?? null, limitMs });
  }
  return check;
}

function classifyCadence(phases) {
  const check = createCheck('js-cadence');
  check.metrics.phases = [];
  if (phases.length === 0) invalidate(check, 'gesture-cadence-missing');
  for (const phase of phases) {
    const label = text(phase.label) ? phase.label : 'unknown-phase';
    const cadence = object(phase.cadence) ? phase.cadence : {};
    const intervals = cadence.rafIntervalsMs;
    const tasks = cadence.longTaskDurationsMs;
    if (
      !positive(cadence.durationMs) ||
      !Array.isArray(intervals) ||
      intervals.length < 2 ||
      !intervals.every(positive) ||
      !Array.isArray(tasks) ||
      !tasks.every(nonnegative)
    ) {
      invalidate(check, `${label}:cadence-telemetry-missing`);
      continue;
    }
    const observedMs = intervals.reduce((total, value) => total + value, 0);
    if (
      observedMs < cadence.durationMs - limits.maxRafGapMs ||
      observedMs > cadence.durationMs + limits.maxRafGapMs
    )
      invalidate(check, `${label}:cadence-window-incomplete`);
    const maxRafGapMs = maximum(intervals);
    const maxLongTaskMs = maximum(tasks) ?? 0;
    if (maxRafGapMs > limits.maxRafGapMs) fail(check, `${label}:animation-gap-budget-exceeded`);
    if (maxLongTaskMs > limits.maxLongTaskMs) fail(check, `${label}:long-task-budget-exceeded`);
    check.metrics.phases.push({
      label,
      durationMs: cadence.durationMs,
      observedMs,
      maxRafGapMs,
      maxLongTaskMs,
    });
  }
  return check;
}

function classifyNative(phases, required) {
  const check = createCheck('native-presentation', required);
  check.metrics.phases = [];
  if (phases.length === 0) invalidate(check, 'native-gesture-evidence-missing');
  for (const phase of phases) {
    const label = text(phase.label) ? phase.label : 'unknown-phase';
    const native = object(phase.nativePresentation) ? phase.nativePresentation : {};
    const counters = [
      'expectedFrameCount',
      'observedFrameCount',
      'droppedFrames',
      'partialFrames',
      'missingContentFrames',
    ];
    if (
      native.status !== 'valid' ||
      native.targetMatched !== true ||
      ![60, 120].includes(native.refreshHz) ||
      !positive(native.durationMs) ||
      !positive(native.requestedDurationMs) ||
      !counters.every((name) => count(native[name])) ||
      native.expectedFrameCount === 0
    ) {
      invalidate(check, `${label}:native-presentation-unqualified`);
      continue;
    }
    const expectedCount = Math.round((native.durationMs * native.refreshHz) / 1_000);
    if (
      native.expectedFrameCount !== expectedCount ||
      native.observedFrameCount / expectedCount < 0.95 ||
      native.durationMs / native.requestedDurationMs < 0.95 ||
      !positive(phase.cadence?.durationMs) ||
      Math.abs(native.requestedDurationMs - phase.cadence.durationMs) > limits.maxRafGapMs
    ) {
      invalidate(check, `${label}:native-measurement-window-incomplete`);
    }
    if (native.droppedFrames > 0) fail(check, `${label}:native-frame-dropped`);
    if (native.partialFrames > 0) fail(check, `${label}:native-frame-partially-presented`);
    if (native.missingContentFrames > 0) fail(check, `${label}:native-frame-content-missing`);
    check.metrics.phases.push({ label, ...native });
  }
  return check;
}

function classifyResources(rawSamples) {
  const cache = createCheck('cache');
  const heap = createCheck('retained-heap');
  const samples = Array.isArray(rawSamples) ? rawSamples : [];
  const validSamples = samples.filter(object);
  if (samples.length === 0 || validSamples.length !== samples.length)
    invalidate(cache, 'cache-observations-missing');
  if (samples.length < limits.minimumWarmedCheckpoints || validSamples.length !== samples.length)
    invalidate(heap, 'warmed-checkpoints-missing');
  let previousCycle = -1;
  const checkpoint = validSamples[0]?.checkpoint;
  if (!text(checkpoint)) invalidate(heap, 'checkpoint-identity-missing');
  for (const sample of validSamples) {
    if (!count(sample.cacheBytes) || !count(sample.cacheEntries))
      invalidate(cache, 'cache-telemetry-missing');
    else if (
      sample.cacheBytes > limits.maxCacheBytes ||
      sample.cacheEntries > limits.maxCacheEntries
    )
      fail(cache, 'settled-cache-budget-exceeded');
    if (
      !count(sample.cycle) ||
      sample.cycle <= previousCycle ||
      sample.checkpoint !== checkpoint ||
      sample.warmed !== true ||
      sample.gcPerformed !== true ||
      !count(sample.heapUsedBytes)
    )
      invalidate(heap, 'retained-heap-checkpoint-unqualified');
    if (count(sample.cycle)) previousCycle = sample.cycle;
  }
  const baselineBytes = validSamples[0]?.heapUsedBytes;
  const heapValues = validSamples.map((sample) => sample.heapUsedBytes).filter(count);
  const growthBytes =
    count(baselineBytes) && heapValues.length > 0 ? maximum(heapValues) - baselineBytes : null;
  if (growthBytes !== null && growthBytes > limits.retainedHeapGrowthBytes)
    fail(heap, 'retained-heap-growth-budget-exceeded');
  cache.metrics = {
    maxObservedBytes: maximum(validSamples.map((sample) => sample.cacheBytes).filter(count)),
    maxObservedEntries: maximum(validSamples.map((sample) => sample.cacheEntries).filter(count)),
    limitBytes: limits.maxCacheBytes,
    limitEntries: limits.maxCacheEntries,
  };
  heap.metrics = {
    checkpoint: checkpoint ?? null,
    samples: samples.length,
    baselineBytes: count(baselineBytes) ? baselineBytes : null,
    maxRetainedGrowthBytes: growthBytes,
    limitGrowthBytes: limits.retainedHeapGrowthBytes,
    processMemoryQualification: 'not-scored',
    processMemorySamples: validSamples.map((sample) => ({
      cycle: sample.cycle,
      electronRssBytes: count(sample.electronRssBytes) ? sample.electronRssBytes : null,
      sidecarRssBytes: count(sample.sidecarRssBytes) ? sample.sidecarRssBytes : null,
    })),
  };
  return [cache, heap];
}

export function classifyPileupPerformance(input) {
  const report = object(input) ? input : {};
  const phases = Array.isArray(report.phases) ? report.phases : [];
  const gestures = phases.filter((phase) => phase?.kind === 'gesture');
  const checks = [
    classifySource(report),
    classifyJourney(phases),
    classifyViewport(phases, report.source?.generationKey),
    classifyLoading(phases),
    classifyCadence(gestures),
    classifyNative(gestures, report.profile === 'full-genome'),
    ...classifyResources(report.resourceSamples),
  ];
  const required = checks.filter((check) => check.required);
  const status = required.some((check) => check.status === 'fail')
    ? 'fail'
    : required.some((check) => check.status !== 'pass')
      ? 'unqualified'
      : 'pass';
  return {
    schema: 'dnaforge.pileup-performance-result.v1',
    profile: profiles.has(report.profile) ? report.profile : null,
    status,
    qualifiedForFullGenome: report.profile === 'full-genome' && status === 'pass',
    checks,
  };
}

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

function equalCoordinate(left, right) {
  if (left === right) return true;
  const magnitude = Math.max(Math.abs(left), Math.abs(right));
  let exponent = Math.floor(Math.log2(magnitude));
  if (2 ** exponent > magnitude) exponent -= 1;
  const ulp = Math.max(Number.MIN_VALUE, 2 ** (exponent - 52));
  return Math.abs(left - right) <= Math.min(1e-6, ulp * 4);
}

export function pileupRangeMatchesViewport(range, viewport) {
  if (
    !object(range) ||
    !object(viewport) ||
    !bounds(range.start, range.end) ||
    !bounds(viewport.startBp, viewport.endBp)
  )
    return false;
  return (
    equalCoordinate(range.start, viewport.startBp) && equalCoordinate(range.end, viewport.endBp)
  );
}

export function pileupCoverageCoversViewport(viewport) {
  if (
    !object(viewport) ||
    !bounds(viewport.startBp, viewport.endBp) ||
    !bounds(viewport.coverageStartBp, viewport.coverageEndBp)
  )
    return false;
  return (
    (viewport.coverageStartBp <= viewport.startBp ||
      equalCoordinate(viewport.coverageStartBp, viewport.startBp)) &&
    (viewport.coverageEndBp >= viewport.endBp ||
      equalCoordinate(viewport.coverageEndBp, viewport.endBp))
  );
}

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
  for (const flag of ['sourceModified', 'runtimeModified']) {
    if (source[flag] !== false) invalidate(check, `${flag}:clean-source-not-qualified`);
  }
  const readiness = object(report?.readiness) ? report.readiness : {};
  const samples = Array.isArray(readiness.samples) ? readiness.samples : [];
  const ready = samples.at(-1);
  if (
    readiness.ready !== true ||
    !positive(readiness.readyAtEpochMs) ||
    ready?.startup?.pageLoaded !== true ||
    ready?.startup?.shellReady !== true ||
    ready?.api?.status !== 200
  )
    invalidate(check, 'native-startup-and-api-readiness-unqualified');
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
    sourceModified: typeof source.sourceModified === 'boolean' ? source.sourceModified : null,
    runtimeModified: typeof source.runtimeModified === 'boolean' ? source.runtimeModified : null,
    fixtureId: source.fixtureId ?? null,
    coldScope: source.coldScope ?? null,
    assemblyLengthBp: source.assemblyLengthBp ?? null,
    chromosomeCount: source.chromosomeCount ?? null,
    bamSizeBytes: source.bamSizeBytes ?? null,
  };
  return check;
}

function classifyJourney(phases, reportFailures) {
  const check = createCheck('journey');
  if (!Array.isArray(reportFailures)) invalidate(check, 'report-failure-observations-missing');
  else if (reportFailures.length > 0) fail(check, 'report-runtime-or-journey-errors');
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
        !pileupCoverageCoversViewport(viewport)
      ) {
        fail(check, `${label}:blend-coverage-misses-viewport`);
      }
    }
  }
  return check;
}

function classifyPresentation(phases, generationKey) {
  const check = createCheck('presentation');
  check.metrics.phases = [];
  if (phases.length === 0) invalidate(check, 'presentation-observations-missing');
  for (const phase of phases) {
    const label = text(phase?.label) ? phase.label : 'unknown-phase';
    const presentation = object(phase?.presentation) ? phase.presentation : {};
    const lifecycle = object(presentation.lifecycle) ? presentation.lifecycle : {};
    const status = object(lifecycle.status) ? lifecycle.status : {};
    const gutter = object(presentation.gutter) ? presentation.gutter : {};
    const viewport = object(phase?.viewport) ? phase.viewport : {};
    if (!text(presentation.trackId)) invalidate(check, `${label}:presentation-track-missing`);
    if (!text(status.phase)) invalidate(check, `${label}:lifecycle-status-missing`);
    else if (status.phase !== 'ready') fail(check, `${label}:current-reads-not-acknowledged`);
    else if (!text(status.kind)) invalidate(check, `${label}:lifecycle-ready-kind-missing`);
    else if (status.kind !== 'reads') fail(check, `${label}:current-reads-not-acknowledged`);
    if (!text(lifecycle.sourceKey)) invalidate(check, `${label}:lifecycle-source-missing`);
    else if (text(generationKey) && !lifecycle.sourceKey.includes(generationKey))
      fail(check, `${label}:lifecycle-source-stale`);
    if (
      !count(lifecycle.generation) ||
      lifecycle.generation === 0 ||
      !count(lifecycle.requestSequence) ||
      lifecycle.requestSequence === 0
    )
      invalidate(check, `${label}:lifecycle-request-identity-missing`);
    if (!text(lifecycle.planKey) || !text(lifecycle.currentPlanKey))
      invalidate(check, `${label}:lifecycle-plan-missing`);
    else if (lifecycle.planKey !== lifecycle.currentPlanKey)
      fail(check, `${label}:lifecycle-plan-stale`);
    for (const name of ['currentRange', 'lastPresentedRange']) {
      const range = object(lifecycle[name]) ? lifecycle[name] : {};
      if (!bounds(range.start, range.end)) invalidate(check, `${label}:${name}-missing`);
      else if (
        bounds(viewport.startBp, viewport.endBp) &&
        !pileupRangeMatchesViewport(range, viewport)
      )
        fail(check, `${label}:${name}-stale`);
    }
    if (lifecycle.pendingPresentation === undefined)
      invalidate(check, `${label}:presentation-pending-state-missing`);
    else if (lifecycle.pendingPresentation !== null)
      fail(check, `${label}:presentation-acknowledgment-pending`);
    if (!text(gutter.trackId) || !text(gutter.phase) || typeof gutter.visible !== 'boolean')
      invalidate(check, `${label}:rendered-gutter-observation-missing`);
    else if (gutter.trackId !== presentation.trackId || gutter.phase !== 'ready' || !gutter.visible)
      fail(check, `${label}:rendered-gutter-not-current-ready`);
    check.metrics.phases.push({
      label,
      lifecyclePhase: status.phase ?? null,
      lifecycleKind: status.kind ?? null,
      requestSequence: lifecycle.requestSequence ?? null,
      planKey: lifecycle.planKey ?? null,
      currentPlanKey: lifecycle.currentPlanKey ?? null,
      gutterPhase: gutter.phase ?? null,
    });
  }
  return check;
}

export function classifyPileupAnnotation(annotation, viewport) {
  const check = createCheck('annotation');
  if (!object(annotation)) {
    invalidate(check, 'annotation-observations-missing');
    return check;
  }
  if (!object(viewport) || !bounds(viewport.startBp, viewport.endBp)) {
    invalidate(check, 'annotation-viewport-missing');
    return check;
  }
  const expectation = annotation.expectation;
  if (
    expectation?.trackId !== 'mRNA' ||
    !Array.isArray(expectation.intervals) ||
    expectation.intervals.some(
      (interval) => !text(interval?.id) || !bounds(interval.startBp, interval.endBp)
    )
  ) {
    invalidate(check, 'annotation-source-expectation-missing');
    return check;
  }
  if (
    !bounds(expectation.coverageStartBp, expectation.coverageEndBp) ||
    expectation.coverageStartBp > viewport.startBp ||
    expectation.coverageEndBp < viewport.endBp
  ) {
    invalidate(check, 'annotation-source-expectation-does-not-cover-viewport');
    return check;
  }
  const expected = expectation.intervals.filter(
    (interval) => interval.startBp < viewport?.endBp && interval.endBp > viewport?.startBp
  );
  check.metrics.expectedTranscriptCount = expected.length;
  const admitted = annotation.admitted ?? {};
  const sourceSha256 = admitted.datasetContract?.sourceSha256;
  if (!text(sourceSha256) || !/^[a-f0-9]{64}$/u.test(sourceSha256))
    invalidate(check, 'annotation-admitted-source-missing');
  const sourceIdentity = text(sourceSha256)
    ? `assembly-annotation-source-sha256.v1:${sourceSha256}`
    : null;
  if (admitted.readiness !== 'ready') fail(check, 'annotation-products-not-ready');
  if (
    admitted.datasetContract?.datasetVersion !==
    'resolved-annotation-v4:structural-composite-kinds.v1'
  )
    fail(check, 'annotation-source-contract-stale');
  if (!Array.isArray(annotation.viewer?.visibleTypes))
    invalidate(check, 'annotation-visibility-missing');
  else if (!annotation.viewer.visibleTypes.includes('mRNA')) fail(check, 'annotation-mRNA-hidden');
  for (const field of ['admittedSourceIdentity', 'stableSourceIdentity']) {
    if (!text(annotation.viewer?.annotationAuthority?.[field]))
      invalidate(check, `annotation-${field}-missing`);
    else if (annotation.viewer.annotationAuthority[field] !== sourceIdentity)
      fail(check, `annotation-${field}-stale`);
  }
  const policy = annotation.policy;
  for (const name of ['policy', 'body', 'operations']) {
    const snapshot = annotation[name];
    if (!object(snapshot) || !text(snapshot.instanceId))
      invalidate(check, `annotation-${name}-snapshot-missing`);
    else if (snapshot.verdict !== 'exactly-one' || snapshot.instanceId !== policy?.instanceId)
      fail(check, `annotation-${name}-renderer-ambiguous-or-stale`);
  }
  const renderer = policy?.renderer;
  if (!object(renderer) || renderer.supported !== true)
    invalidate(check, 'annotation-renderer-snapshot-missing');
  else {
    if (renderer.genomeIdentity !== sourceIdentity) fail(check, 'annotation-renderer-source-stale');
    if (
      !pileupRangeMatchesViewport(
        { start: renderer.viewportStartBp, end: renderer.viewportEndBp },
        viewport
      )
    )
      fail(check, 'annotation-viewport-stale');
    const presentation = renderer.annotation;
    if (!Array.isArray(presentation?.annotationPresentationOwnerViolations))
      invalidate(check, 'annotation-owner-validation-missing');
    else if (presentation.annotationPresentationOwnerViolations.length > 0)
      fail(check, 'annotation-competing-owners');
    if (!Array.isArray(presentation?.annotationPresentationOwners))
      invalidate(check, 'annotation-presentation-owners-missing');
    else if (expected.length > 0) {
      const owners = presentation.annotationPresentationOwners.filter(
        (owner) => owner.visible && owner.layerTypes?.includes('mRNA')
      );
      if (owners.length !== 1 || owners[0].role !== 'exact' || owners[0].coverageComplete !== true)
        fail(check, 'annotation-visible-coverage-incomplete');
    }
  }
  const activeRenderer = annotation.activeRenderer;
  if (
    !object(activeRenderer) ||
    activeRenderer.supported !== true ||
    activeRenderer.contract !== 'pixi-linear-renderer-cold-gesture-snapshot.v1'
  ) {
    invalidate(check, 'annotation-active-renderer-census-missing');
    return check;
  }
  const actualGeneration = activeRenderer.operation?.rendererGeneration;
  const visibleGeneration = annotation.operations?.operationOracle?.rendererGeneration;
  if (!positive(actualGeneration) || !positive(visibleGeneration))
    invalidate(check, 'annotation-renderer-generation-missing');
  else if (actualGeneration !== visibleGeneration)
    fail(check, 'annotation-hidden-or-stale-renderer');
  if (
    activeRenderer.genomeIdentity !== sourceIdentity ||
    !pileupRangeMatchesViewport(
      { start: activeRenderer.viewportStartBp, end: activeRenderer.viewportEndBp },
      viewport
    )
  )
    fail(check, 'annotation-active-renderer-source-or-viewport-stale');
  const census = activeRenderer.annotation;
  const body = annotation.body?.bodyAuthority;
  const generation = body?.generation;
  if (
    !object(census) ||
    census.contract !== 'annotation-overlay-cold-gesture-snapshot.v1' ||
    !object(body) ||
    !object(generation)
  ) {
    fail(check, 'annotation-current-body-or-census-missing');
    return check;
  }
  if (census.genomeIdentity !== sourceIdentity || census.activeSourceIdentity !== sourceIdentity)
    fail(check, 'annotation-scene-source-stale');
  if (census.presentationVisible !== true) fail(check, 'annotation-body-hidden');
  if (
    !text(admitted.artifact?.artifactKey) ||
    !admitted.artifact.artifactKey.startsWith('assembly-annotation-artifact.v4|')
  )
    invalidate(check, 'annotation-admitted-artifact-missing');
  else if (census.activeArtifactKey !== admitted.artifact.artifactKey)
    fail(check, 'annotation-scene-artifact-stale');
  const ownerParts = text(census.activeOwnerKey) ? census.activeOwnerKey.split('\n') : [];
  if (
    ownerParts.length !== 4 ||
    ownerParts[0] !== 'annotation-scene-owner.v3' ||
    !/^[a-f0-9]{24}$/u.test(ownerParts[1]) ||
    !/^[a-f0-9]{64}$/u.test(ownerParts[2]) ||
    ownerParts[3] !== census.activeArtifactKey
  )
    invalidate(check, 'annotation-scene-product-identity-missing');
  if (
    body.contract !== 'annotation-body-presentation-authority.v1' ||
    !text(generation.generationId) ||
    !positive(body.commitEpoch)
  )
    invalidate(check, 'annotation-body-authority-missing');
  if (generation.commitEpoch !== body.commitEpoch || generation.productKind !== body.frameOwner)
    fail(check, 'annotation-body-generation-stale');
  if (!generation.orderedVisibleTrackIds?.includes('mRNA'))
    fail(check, 'annotation-current-mRNA-body-missing');
  if (!text(admitted.assetGeneration?.sourceFingerprint))
    invalidate(check, 'annotation-admitted-generation-missing');
  if (
    generation.sourceFingerprint !== ownerParts[1] ||
    generation.sourceFingerprint !== census.activeSourceFingerprint ||
    generation.sourceFingerprint !== admitted.assetGeneration?.sourceFingerprint ||
    generation.placementFingerprint !== census.activePlacementFingerprint
  )
    fail(check, 'annotation-body-source-stale');
  if (
    generation.policy?.isoformMode !== census.activeRuntimeIsoformMode ||
    generation.policy?.laneLimit !== census.activeRuntimeLaneLimit
  )
    fail(check, 'annotation-body-policy-stale');
  if (
    expected.length > 0 &&
    (census.soleOwnerCount !== 1 ||
      census.soleOwnerRole !== 'exact' ||
      census.soleOwnerCoverageComplete !== true ||
      census.soleOwnerContractValid !== true)
  )
    fail(check, 'annotation-visible-census-incomplete');
  if (body.frameOwner === 'prepacked-vector') {
    if (
      !Array.isArray(generation.productFingerprints) ||
      !generation.productFingerprints.includes(census.activeOwnerKey)
    )
      fail(check, 'annotation-body-product-stale');
    const residents = Array.isArray(census.requestedResidentTracks)
      ? census.requestedResidentTracks.filter((resident) => resident?.trackType === 'mRNA')
      : [];
    const resident = residents[0];
    if (
      residents.length !== 1 ||
      census.prepackedRequestedResidentRosterReady !== true ||
      resident.prepared !== true ||
      resident.admitted !== true ||
      resident.ownerKey !== census.activeOwnerKey
    )
      fail(check, 'annotation-resident-not-admitted');
    if (
      !bounds(resident?.coverageStartBp, resident?.coverageEndBp) ||
      resident.coverageStartBp > viewport.startBp ||
      resident.coverageEndBp < viewport.endBp
    )
      fail(check, 'annotation-resident-coverage-incomplete');
    if (
      !count(census.prepackedSubmittedInstanceCount) ||
      !count(census.prepackedSubmittedPartitionCount)
    )
      invalidate(check, 'annotation-geometry-observation-missing');
    else if (
      expected.length > 0 &&
      (resident?.presenting !== true ||
        !positive(resident?.visibleInstanceCount) ||
        !positive(resident?.visiblePartitionCount) ||
        census.prepackedSubmittedInstanceCount === 0 ||
        census.prepackedSubmittedPartitionCount === 0 ||
        census.soleOwnerId !== 'prepacked-partitioned-vector-surface')
    )
      fail(check, 'annotation-populated-window-is-blank');
  } else if (body.frameOwner === 'compiled-broad') {
    const broad = renderer?.annotation?.compiledBroad;
    if (!object(broad)) invalidate(check, 'annotation-compiled-body-observations-missing');
    else {
      if (
        !Array.isArray(generation.productFingerprints) ||
        !generation.productFingerprints.includes(broad.manifestFingerprint) ||
        broad.provenanceValid !== true ||
        broad.provenanceManifestFingerprint !== broad.manifestFingerprint ||
        broad.provenanceSourceFingerprint !== generation.sourceFingerprint ||
        broad.provenancePlacementFingerprint !== generation.placementFingerprint ||
        broad.provenancePrepackedOwnerKey !== census.activeOwnerKey ||
        broad.provenancePrepackedArtifactKey !== census.activeArtifactKey
      )
        fail(check, 'annotation-compiled-product-stale');
      if (
        broad.activeIsoformMode !== generation.policy?.isoformMode ||
        broad.activeLaneLimit !== generation.policy?.laneLimit
      )
        fail(check, 'annotation-compiled-policy-stale');
      if (
        broad.missingCellCount !== 0 ||
        broad.lastFailure !== null ||
        broad.gpuPreuploadFailureCount !== 0
      )
        fail(check, 'annotation-compiled-coverage-incomplete');
      if (
        expected.length > 0 &&
        (broad.presenting !== true ||
          !positive(broad.submittedCellCount) ||
          !positive(broad.presentedQuadCount) ||
          census.soleOwnerId !== 'compiled-broad-raster-surface')
      )
        fail(check, 'annotation-populated-window-is-blank');
    }
  } else fail(check, 'annotation-current-prepared-body-missing');
  check.metrics = {
    ...check.metrics,
    sourceIdentity,
    sourceFingerprint: generation.sourceFingerprint,
    ownerKey: census.activeOwnerKey,
    bodyKind: body.frameOwner,
    submittedInstanceCount: census.prepackedSubmittedInstanceCount,
  };
  return check;
}

function classifyAnnotations(phases) {
  const check = createCheck('annotations');
  check.metrics.phases = [];
  for (const phase of phases) {
    const result = classifyPileupAnnotation(phase?.annotation, phase?.viewport);
    for (const reason of result.failures) {
      (result.status === 'fail' ? fail : invalidate)(
        check,
        `${text(phase?.label) ? phase.label : 'unknown-phase'}:${reason}`
      );
    }
    check.metrics.phases.push({ label: phase?.label, ...result.metrics });
  }
  if (!check.metrics.phases.some((phase) => phase.expectedTranscriptCount > 0))
    invalidate(check, 'known-positive-annotation-phase-missing');
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

function classifyResources(rawSamples, phases) {
  const cache = createCheck('cache');
  const heap = createCheck('retained-heap');
  const samples = Array.isArray(rawSamples) ? rawSamples : [];
  const validSamples = samples.filter(object);
  const observations = [
    ...phases.map((phase) => ({
      label: text(phase?.label) ? phase.label : 'unknown-phase',
      bytes: phase?.cache?.bytes,
      entries: phase?.cache?.entries,
    })),
    ...validSamples.map((sample) => ({
      label: count(sample.cycle) ? `warm-cycle-${sample.cycle}` : 'unknown-warm-cycle',
      bytes: sample.cacheBytes,
      entries: sample.cacheEntries,
    })),
  ];
  if (phases.length === 0) invalidate(cache, 'phase-cache-observations-missing');
  if (samples.length === 0 || validSamples.length !== samples.length)
    invalidate(cache, 'cache-observations-missing');
  if (samples.length < limits.minimumWarmedCheckpoints || validSamples.length !== samples.length)
    invalidate(heap, 'warmed-checkpoints-missing');
  let previousCycle = -1;
  const checkpoint = validSamples[0]?.checkpoint;
  if (!text(checkpoint)) invalidate(heap, 'checkpoint-identity-missing');
  for (const observation of observations) {
    if (!count(observation.bytes) || !count(observation.entries))
      invalidate(cache, `${observation.label}:cache-telemetry-missing`);
    else if (
      observation.bytes > limits.maxCacheBytes ||
      observation.entries > limits.maxCacheEntries
    )
      fail(cache, `${observation.label}:settled-cache-budget-exceeded`);
  }
  for (const sample of validSamples) {
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
    maxObservedBytes: maximum(observations.map((sample) => sample.bytes).filter(count)),
    maxObservedEntries: maximum(observations.map((sample) => sample.entries).filter(count)),
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
    classifyJourney(phases, report.failures),
    classifyViewport(phases, report.source?.generationKey),
    classifyPresentation(phases, report.source?.generationKey),
    classifyAnnotations(phases),
    classifyLoading(phases),
    classifyCadence(gestures),
    classifyNative(gestures, report.profile === 'full-genome'),
    ...classifyResources(report.resourceSamples, phases),
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

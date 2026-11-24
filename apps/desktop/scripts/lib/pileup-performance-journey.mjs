import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createDensePileupFixture } from './pileup-performance-fixture.mjs';
import {
  classifyPileupAnnotation,
  pileupCoverageCoversViewport,
  pileupRangeMatchesViewport,
} from './pileup-performance.mjs';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const viewer = (page) => page.getByTestId('indexed-genome-visible-viewer');
const repository = fileURLToPath(new URL('../../../../', import.meta.url));

async function sourceIdentity(page, apiPort) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const sourceModified = Boolean(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim()
  );
  const runtime = await page.evaluate(async () => {
    const { APP_BUILD } = await import('/src/lib/app-build.ts');
    return { build: APP_BUILD, provenance: await window.electronAPI.runtime.getProvenance() };
  });
  assert.equal(
    runtime.provenance.kind,
    'electron-main',
    'The journey requires the native desktop runtime.'
  );
  assert.equal(
    Number(new URL(runtime.provenance.apiUrl).port),
    apiPort,
    'The runtime uses another sidecar.'
  );
  return {
    commit,
    sourceModified,
    runtimeCommit: runtime.build.sourceCommit,
    runtimeModified: runtime.build.sourceModified,
    runtimeProvenance: runtime.provenance,
  };
}

async function poll(read, accepts, timeoutMs, description) {
  const started = performance.now();
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(50);
  } while (performance.now() - started < timeoutMs);
  throw new Error(`${description}: ${JSON.stringify(value)}`);
}

async function nativeReadiness(page, apiPort) {
  const started = performance.now();
  const result = { startedAtEpochMs: Date.now(), ready: false, samples: [] };
  const deadline = started + 60_000;
  do {
    const startup = page.evaluate(async () => {
      if (typeof window.electronAPI?.startup?.getState !== 'function')
        throw new Error('The native startup state API is unavailable.');
      const state = await window.electronAPI.startup.getState();
      return {
        observedAtEpochMs: performance.timeOrigin + performance.now(),
        loadId: state?.loadId ?? null,
        pageLoaded: state?.pageLoaded === true,
        shellReady: state?.shellReady === true,
      };
    });
    const api = (async () => {
      const requestedAtEpochMs = Date.now();
      const response = await fetch(`http://127.0.0.1:${apiPort}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return { requestedAtEpochMs, observedAtEpochMs: Date.now(), status: response.status };
    })();
    let timeout;
    const settled = await Promise.race([
      Promise.allSettled([startup, api]),
      new Promise((resolve) => {
        timeout = setTimeout(
          () => resolve(null),
          Math.max(1, Math.min(5000, deadline - performance.now()))
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (!settled) {
      result.samples.push({
        observedAtEpochMs: Date.now(),
        error: 'Readiness readback timed out.',
      });
      break;
    }
    const value = (entry) =>
      entry.status === 'fulfilled' ? entry.value : { error: String(entry.reason) };
    const sample = {
      observedAtEpochMs: Date.now(),
      startup: value(settled[0]),
      api: value(settled[1]),
    };
    result.samples.push(sample);
    if (sample.startup.pageLoaded && sample.startup.shellReady && sample.api.status === 200) {
      result.ready = true;
      result.readyAtEpochMs = sample.observedAtEpochMs;
      break;
    }
    await delay(250);
  } while (performance.now() < deadline);
  return { ...result, finishedAtEpochMs: Date.now(), elapsedMs: performance.now() - started };
}

async function mountWorkspace(page, workspaceRoot) {
  await page.evaluate(async (root) => {
    if (!window.__test?.mountFolderInPlace) throw new Error('Workspace admission is unavailable.');
    if (!window.__test.getWorkspaceRootPaths().includes(root)) {
      await window.__test.mountFolderInPlace(root);
    }
    if (!window.__test.getWorkspaceRootPaths().includes(root)) {
      throw new Error(`The native workspace did not admit ${root}.`);
    }
  }, workspaceRoot);
}

async function createFixtureWorkspace(page) {
  return page.evaluate(async () => {
    if (!window.__test?.createEmptyWorkspace || !window.__test.getWorkspaceRootPaths) {
      throw new Error('Native project creation is unavailable.');
    }
    const previous = new Set(window.__test.getWorkspaceRootPaths());
    await window.__test.createEmptyWorkspace();
    const added = window.__test.getWorkspaceRootPaths().filter((root) => !previous.has(root));
    if (added.length !== 1)
      throw new Error(`Project creation returned ${added.length} new native workspace roots.`);
    return added[0];
  });
}

async function frame(page, start, span, lane) {
  await poll(
    () =>
      page.evaluate((trackId) => {
        const renderer = window.__webglRenderer;
        return {
          indexed: Boolean(renderer && window.__webglRendererByProduct?.indexed === renderer),
          track: Boolean(renderer?.getTrackDiagnostics?.(trackId)),
          camera: typeof window.__webglFireCameraChange === 'function',
          invalidation: typeof window.__webglRequestRender === 'function',
        };
      }, lane.trackId),
    (state) => Object.values(state).every(Boolean),
    30_000,
    'The active indexed renderer did not become ready for its admitted read lane'
  );
  await page.evaluate(
    ({ start, span }) => {
      if (!window.__test?.workspaceViewer?.setViewport) {
        throw new Error('The indexed viewport precondition bridge is unavailable.');
      }
      window.__test.workspaceViewer.setViewport({ start, end: start + span });
    },
    { start, span }
  );
  await page.evaluate(() => {
    window.__webglFireCameraChange('zoom');
    window.__webglRequestRender();
  });
  await poll(
    () =>
      page.evaluate(() => {
        const mapper = window.__webglRenderer?.getCurrentPathMapper?.();
        return mapper ? [mapper.model.viewStartBp, mapper.model.viewEndBp] : null;
      }),
    (value) => value && Math.abs(value[0] - start) <= 2 && Math.abs(value[1] - start - span) <= 2,
    5000,
    'The actual camera did not accept the setup viewport'
  );
}

async function activeLane(page, bamPath) {
  return page.evaluate(async (sourcePath) => {
    const { alignedReadSourceGenerationKey } =
      await import('/src/shared/aligned-read-source-generation.ts');
    const store = window.__laneContractStore?.getState();
    const selected = document
      .querySelector('[role="tab"][data-tab-id][aria-selected="true"]')
      ?.getAttribute('data-tab-id');
    const lanes = store?.lanesByOwnerId[selected] ?? [];
    const lane = lanes.find(
      (candidate) => candidate.visible && candidate.dataset?.source?.bamPath === sourcePath
    );
    if (!lane) return null;
    const source = lane.dataset.source;
    const tab = Object.values(window.__test.getCanvasStore().panels)
      .flatMap((panel) => panel.tabs)
      .find((candidate) => candidate.id === selected);
    const chromosomes = tab?.indexedGenome?.assembly?.chromosomes;
    return {
      trackId: lane.dataset.trackId,
      label: lane.dataset.label,
      generationKey: source.generation ? alignedReadSourceGenerationKey(source.generation) : null,
      assemblyId: lane.assemblyId,
      sourcePath: source.bamPath,
      assemblyLengthBp: chromosomes?.reduce((total, chromosome) => total + chromosome.length, 0),
      chromosomeCount: chromosomes?.length,
      bamSizeBytes: source.generation?.alignment?.size,
    };
  }, bamPath);
}

async function observation(page, lane, readLengthBp, receipt = {}) {
  receipt.evaluation = {
    startMs: performance.now(),
    endMs: null,
    outcome: null,
  };
  let result;
  try {
    result = await page.evaluate(
      ({ lane, readLengthBp }) => {
        const renderer = window.__webglRenderer;
        const mapper = renderer?.getCurrentPathMapper?.();
        const diagnostic = renderer?.getTrackDiagnostics?.(lane.trackId);
        const driver = window.__tileEngineDebug?.()?.[lane.trackId];
        if (!mapper || !diagnostic || !driver) return null;
        const composition = driver.readComposition;
        const startBp = mapper.model.viewStartBp;
        const endBp = mapper.model.viewEndBp;
        const physicalReadPx = readLengthBp * mapper.pixelsPerBp;
        const rowsAlpha = diagnostic.renderedReadRowsAlpha;
        const densityAlpha = diagnostic.renderedReadDensityAlpha;
        const lifecycle = driver.alignedReadLifecycle ?? null;
        const gutter = document.querySelector(
          `[data-testid=${JSON.stringify(`aligned-read-gutter-status-${lane.trackId}`)}]`
        );
        const gutterObservation = gutter
          ? {
              trackId: gutter
                .getAttribute('data-testid')
                .slice('aligned-read-gutter-status-'.length),
              phase: gutter.getAttribute('data-status-phase'),
              visible: gutter.getClientRects().length > 0,
              text: gutter.textContent,
            }
          : null;
        const selectedTabId = document
          .querySelector('[role="tab"][data-tab-id][aria-selected="true"]')
          ?.getAttribute('data-tab-id');
        const tab = Object.values(window.__test.getCanvasStore().panels)
          .flatMap((panel) => panel.tabs)
          .find((candidate) => candidate.id === selectedTabId);
        const indexedGenome = tab?.indexedGenome;
        const snapshot = (name) =>
          typeof window[name] === 'function' ? window[name]() : (window[name] ?? null);
        const annotation = {
          admitted: {
            readiness: document
              .querySelector('[data-testid="indexed-genome-tab"]')
              ?.getAttribute('data-session-assembly-annotation-products-readiness'),
            datasetContract: indexedGenome?.assemblySearchSource?.datasetContract ?? null,
            artifact: indexedGenome?.assemblySearchSource?.artifact ?? null,
            assetGeneration: indexedGenome?.assemblyAssetGeneration ?? null,
          },
          viewer: {
            visibleTypes: window.__indexedGenomeViewerDebug?.visibleTypes ?? null,
            annotationAuthority: window.__indexedGenomeViewerDebug?.annotationAuthority ?? null,
          },
          policy: snapshot('__webglAnnotationPolicyReadinessSnapshot'),
          body: snapshot('__webglAnnotationBodyPresentationAuthoritySnapshot'),
          scene: snapshot('__webglPrepackedAnnotationSceneOwnerSnapshot'),
          operations: snapshot('__webglRendererOperationSnapshot'),
          activeRenderer: renderer.getColdGestureSnapshot?.(lane.trackId) ?? null,
        };
        const checks = {
          sourceComplete: diagnostic.readSourceWindowCoversViewport === true,
          meshComplete: diagnostic.rowsMeshViewportCoverageFraction >= 0.999,
          currentGeneration:
            Boolean(lane.generationKey) &&
            String(diagnostic.rowsMeshGenerationKey).includes(lane.generationKey),
          untruncated: diagnostic.readSourceTruncated === false,
          tilesComplete:
            composition?.readyCoversViewport === true &&
            composition?.readCoversViewport === true &&
            composition?.errorTileCount === 0,
          visible:
            diagnostic.rowsMeshVisible === true &&
            diagnostic.rowsVertexCount > 0 &&
            rowsAlpha > 0.02,
          densityMatchesScale: physicalReadPx >= 3.6 ? densityAlpha <= 0.02 : densityAlpha > 0.02,
          lifecycleReady: lifecycle?.status?.phase === 'ready' && lifecycle.status.kind === 'reads',
          lifecycleCurrentSource:
            typeof lifecycle?.sourceKey === 'string' &&
            Boolean(lane.generationKey) &&
            lifecycle.sourceKey.includes(lane.generationKey),
          lifecycleCurrentRequest:
            Number.isSafeInteger(lifecycle?.generation) &&
            lifecycle.generation > 0 &&
            Number.isSafeInteger(lifecycle?.requestSequence) &&
            lifecycle.requestSequence > 0,
          lifecycleCurrentPlan:
            typeof lifecycle?.planKey === 'string' &&
            lifecycle.planKey.length > 0 &&
            lifecycle.planKey === lifecycle.currentPlanKey,
          presentationCommitted: lifecycle?.pendingPresentation === null,
          gutterReady: gutterObservation?.phase === 'ready' && gutterObservation.visible,
        };
        const unavailableFields = [];
        const primitive = (field, value, type) => {
          if (typeof value === type && (type !== 'number' || Number.isFinite(value))) {
            if (type === 'string' && value.length === 0) {
              unavailableFields.push({ field, reason: 'empty-string' });
            }
            return value;
          }
          unavailableFields.push({
            field,
            reason:
              value === undefined
                ? 'not-exposed'
                : value === null
                  ? 'null'
                  : typeof value === 'number' && !Number.isFinite(value)
                    ? 'non-finite-number'
                    : 'unexpected-type',
          });
          return null;
        };
        const recordsTiming = diagnostic.recordsCommitTiming;
        let recordsCommitTiming = null;
        if (recordsTiming && typeof recordsTiming === 'object' && !Array.isArray(recordsTiming)) {
          recordsCommitTiming = {
            recordCount: primitive(
              'recordsCommitTiming.recordCount',
              recordsTiming.recordCount,
              'number'
            ),
            totalMs: primitive('recordsCommitTiming.totalMs', recordsTiming.totalMs, 'number'),
            assignMs: primitive('recordsCommitTiming.assignMs', recordsTiming.assignMs, 'number'),
            assignRecordsProcessed: primitive(
              'recordsCommitTiming.assignRecordsProcessed',
              recordsTiming.assignRecordsProcessed,
              'number'
            ),
            assignmentPending: primitive(
              'recordsCommitTiming.assignmentPending',
              recordsTiming.assignmentPending,
              'boolean'
            ),
            finishAssignmentMs: primitive(
              'recordsCommitTiming.finishAssignmentMs',
              recordsTiming.finishAssignmentMs,
              'number'
            ),
            beginRetainMs: primitive(
              'recordsCommitTiming.beginRetainMs',
              recordsTiming.beginRetainMs,
              'number'
            ),
            extentMs: primitive('recordsCommitTiming.extentMs', recordsTiming.extentMs, 'number'),
            occupancyMs: primitive(
              'recordsCommitTiming.occupancyMs',
              recordsTiming.occupancyMs,
              'number'
            ),
            rowHeightFieldMs: primitive(
              'recordsCommitTiming.rowHeightFieldMs',
              recordsTiming.rowHeightFieldMs,
              'number'
            ),
            collapsedFieldMs: primitive(
              'recordsCommitTiming.collapsedFieldMs',
              recordsTiming.collapsedFieldMs,
              'number'
            ),
            rowAssignmentMapMs: primitive(
              'recordsCommitTiming.rowAssignmentMapMs',
              recordsTiming.rowAssignmentMapMs,
              'number'
            ),
            retainScheduled: primitive(
              'recordsCommitTiming.retainScheduled',
              recordsTiming.retainScheduled,
              'boolean'
            ),
            exactDerivedBuilt: primitive(
              'recordsCommitTiming.exactDerivedBuilt',
              recordsTiming.exactDerivedBuilt,
              'boolean'
            ),
            metadataOnly: primitive(
              'recordsCommitTiming.metadataOnly',
              recordsTiming.metadataOnly,
              'boolean'
            ),
          };
        } else {
          unavailableFields.push({
            field: 'recordsCommitTiming',
            reason: recordsTiming === null ? 'not-yet-observed' : 'not-exposed-as-object',
          });
        }
        const paintedTiming = diagnostic.paintTiming;
        let paintTiming = null;
        if (paintedTiming && typeof paintedTiming === 'object' && !Array.isArray(paintedTiming)) {
          paintTiming = {
            totalMs: primitive('paintTiming.totalMs', paintedTiming.totalMs, 'number'),
            coverageMs: primitive('paintTiming.coverageMs', paintedTiming.coverageMs, 'number'),
            recordsMs: primitive('paintTiming.recordsMs', paintedTiming.recordsMs, 'number'),
            retainMs: primitive('paintTiming.retainMs', paintedTiming.retainMs, 'number'),
            readRowsMeshMs: primitive(
              'paintTiming.readRowsMeshMs',
              paintedTiming.readRowsMeshMs,
              'number'
            ),
            densityMs: primitive('paintTiming.densityMs', paintedTiming.densityMs, 'number'),
            overflowMs: primitive('paintTiming.overflowMs', paintedTiming.overflowMs, 'number'),
          };
        } else {
          unavailableFields.push({
            field: 'paintTiming',
            reason: paintedTiming === null ? 'not-yet-observed' : 'not-exposed-as-object',
          });
        }
        const retainedPreparation = {
          recordsCommitTiming,
          paintTiming,
          diagnosticCounters: {
            rowsAssignmentBuildRecordsLastFrame: primitive(
              'diagnosticCounters.rowsAssignmentBuildRecordsLastFrame',
              diagnostic.rowsAssignmentBuildRecordsLastFrame,
              'number'
            ),
            rowsAssignmentBuildChunkCount: primitive(
              'diagnosticCounters.rowsAssignmentBuildChunkCount',
              diagnostic.rowsAssignmentBuildChunkCount,
              'number'
            ),
            rowsMeshBuildRecordsLastFrame: primitive(
              'diagnosticCounters.rowsMeshBuildRecordsLastFrame',
              diagnostic.rowsMeshBuildRecordsLastFrame,
              'number'
            ),
            rowsMeshBuildChunkCount: primitive(
              'diagnosticCounters.rowsMeshBuildChunkCount',
              diagnostic.rowsMeshBuildChunkCount,
              'number'
            ),
            rowsMeshBuildRecordCursor: primitive(
              'diagnosticCounters.rowsMeshBuildRecordCursor',
              diagnostic.rowsMeshBuildRecordCursor,
              'number'
            ),
            rowsMeshBuildRecordCount: primitive(
              'diagnosticCounters.rowsMeshBuildRecordCount',
              diagnostic.rowsMeshBuildRecordCount,
              'number'
            ),
            rowsMeshBuildTargetMatchesRecordsKey: primitive(
              'diagnosticCounters.rowsMeshBuildTargetMatchesRecordsKey',
              diagnostic.rowsMeshBuildTargetMatchesRecordsKey,
              'boolean'
            ),
          },
          identity: {
            expectedLaneTrackId: primitive('identity.expectedLaneTrackId', lane.trackId, 'string'),
            expectedGenerationKey: primitive(
              'identity.expectedGenerationKey',
              lane.generationKey,
              'string'
            ),
            rowsMeshGenerationKey: primitive(
              'identity.rowsMeshGenerationKey',
              diagnostic.rowsMeshGenerationKey,
              'string'
            ),
            sourceKey: primitive('identity.sourceKey', lifecycle?.sourceKey, 'string'),
            generation: primitive('identity.generation', lifecycle?.generation, 'number'),
            requestSequence: primitive(
              'identity.requestSequence',
              lifecycle?.requestSequence,
              'number'
            ),
            planKey: primitive('identity.planKey', lifecycle?.planKey, 'string'),
            currentPlanKey: primitive(
              'identity.currentPlanKey',
              lifecycle?.currentPlanKey,
              'string'
            ),
            sourceGenerationKey: null,
            presentationOwnerKey: null,
          },
          unavailableFields,
        };
        unavailableFields.push(
          {
            field: 'identity.sourceGenerationKey',
            reason: 'not-exposed-through-existing-observation',
          },
          {
            field: 'identity.presentationOwnerKey',
            reason: 'not-exposed-through-existing-observation',
          }
        );
        return {
          viewport: {
            startBp,
            endBp,
            sourceGenerationKey: checks.currentGeneration
              ? lane.generationKey
              : diagnostic.rowsMeshGenerationKey,
            sourceFraction: diagnostic.readSourceWindowCoverageFraction,
            meshFraction: diagnostic.rowsMeshViewportCoverageFraction,
            recordCount: diagnostic.rowsMeshRecordCount,
            truncated: diagnostic.readSourceTruncated,
            pendingTiles: composition?.pendingTileCount,
            rowsAlpha,
            densityAlpha,
            physicalReadPx,
            coverageStartBp: diagnostic.coverageSignalStartBp,
            coverageEndBp: diagnostic.coverageSignalEndBp,
          },
          checks,
          presentation: { trackId: lane.trackId, lifecycle, gutter: gutterObservation },
          annotation,
          preparation: {
            rowsAssignmentBuilding: diagnostic.rowsAssignmentBuildInProgress,
            rowsMeshBuilding: diagnostic.rowsMeshBuildInProgress,
            rowsMeshRecordCursor: diagnostic.rowsMeshBuildRecordCursor,
            rowsMeshTargetRecordCount: diagnostic.rowsMeshBuildRecordCount,
            corridorFloorState: driver.coverageCorridorFloor?.state,
            residentBandReady: composition?.stableBandReady,
            residentReadyTileCount: composition?.readyBandTileCount,
            residentExpectedTileCount: composition?.expectedBandTileCount,
            lifecyclePhase: lifecycle?.status?.phase,
            lifecycleRequestSequence: lifecycle?.requestSequence,
            lifecyclePlanKey: lifecycle?.planKey,
            lifecycleCurrentPlanKey: lifecycle?.currentPlanKey,
            presentationPending: lifecycle?.pendingPresentation != null,
            gutterPhase: gutterObservation?.phase,
          },
          sourceWindow: {
            startBp: diagnostic.readSourceWindowStartBp,
            endBp: diagnostic.readSourceWindowEndBp,
          },
          cache: { bytes: driver.cache?.byteSize, entries: driver.cache?.entries },
          errors: [
            ...(driver.cache?.errors ?? []).map((entry) => entry.reason ?? 'Alignment tile failed'),
            ...(driver.aln?.error ? [`${driver.aln.error} failed alignment tiles`] : []),
          ],
          retainedPreparation,
        };
      },
      { lane: { trackId: lane.trackId, generationKey: lane.generationKey }, readLengthBp }
    );
    receipt.evaluation.outcome = 'fulfilled';
  } catch (error) {
    receipt.evaluation.outcome = 'rejected';
    throw error;
  } finally {
    receipt.evaluation.endMs = performance.now();
  }
  if (!result) return null;
  result.checks.densityCoversViewport =
    result.viewport.densityAlpha <= 0.02 || pileupCoverageCoversViewport(result.viewport);
  result.annotation.expectation = lane.annotationExpectation ?? null;
  const annotations = classifyPileupAnnotation(result.annotation, result.viewport);
  result.checks.annotationsCurrent = annotations.status === 'pass';
  result.annotation.failures = annotations.failures;
  const lifecycle = result.presentation.lifecycle;
  result.checks.lifecycleCurrentRange = pileupRangeMatchesViewport(
    lifecycle?.currentRange,
    result.viewport
  );
  result.checks.lifecyclePresentedRange = pileupRangeMatchesViewport(
    lifecycle?.lastPresentedRange,
    result.viewport
  );
  return result;
}

async function visibleFlanks(page, lane, viewport) {
  if (viewport.physicalReadPx < 3.6) return null;
  return page.evaluate(
    async ({ lane, viewport }) => {
      if (typeof window.__webglRenderNowForTests !== 'function') {
        throw new Error('The indexed renderer diagnostic frame bridge is unavailable.');
      }
      window.__dna119ExposePileupRows = true;
      try {
        window.__webglRenderNowForTests();
        const diagnostic = window.__webglRenderer.getTrackDiagnostics(lane.trackId);
        const samples = diagnostic?.visibleReadSamples ?? [];
        const span = viewport.endBp - viewport.startBp;
        return {
          left: samples.some((read) => read.start < viewport.startBp + span * 0.1),
          right: samples.some((read) => read.end > viewport.endBp - span * 0.1),
          sampleCount: samples.length,
        };
      } finally {
        window.__dna119ExposePileupRows = false;
        window.__webglRenderNowForTests();
      }
    },
    { lane, viewport }
  );
}

async function complete(page, lane, readLengthBp, started, failures, target = {}, collector = {}) {
  let latest = null;
  let previous = null;
  const settlement = [];
  const deadline = performance.now() + 10_000;
  Object.assign(collector, {
    clock: 'nodeMonotonicMs',
    polls: [],
    attempts: 0,
    completed: 0,
    absent: 0,
    rejected: 0,
    unchanged: 0,
    signatureChanges: 0,
    distinctSignatures: 0,
  });
  const signatures = new Set();
  do {
    const poll = {
      index: collector.attempts + 1,
      startMs: performance.now(),
      endMs: null,
      outcome: null,
      evaluation: null,
      signatureChanged: null,
      retainedPreparation: null,
    };
    collector.polls.push(poll);
    collector.attempts += 1;
    try {
      latest = await observation(page, lane, readLengthBp, poll);
      poll.outcome = latest ? 'observed' : 'absent';
    } catch (error) {
      poll.outcome = 'rejected';
      collector.rejected += 1;
      throw error;
    } finally {
      poll.endMs = performance.now();
    }
    collector.completed += 1;
    if (!latest) collector.absent += 1;
    poll.retainedPreparation = latest?.retainedPreparation
      ? structuredClone(latest.retainedPreparation)
      : null;
    if (latest) {
      latest.checks.cameraAtTarget =
        (!Number.isFinite(target.startBp) ||
          Math.abs(latest.viewport.startBp - target.startBp) <= 2) &&
        (!Number.isFinite(target.spanBp) ||
          Math.abs(latest.viewport.endBp - latest.viewport.startBp - target.spanBp) <= 2);
      const state = {
        checks: latest.checks,
        preparation: latest.preparation,
        sourceFraction: latest.viewport.sourceFraction,
        meshFraction: latest.viewport.meshFraction,
        pendingTiles: latest.viewport.pendingTiles,
        recordCount: latest.viewport.recordCount,
      };
      const signature = JSON.stringify(state);
      poll.signatureChanged = signature !== previous;
      signatures.add(signature);
      collector.distinctSignatures = signatures.size;
      if (signature !== previous) {
        collector.signatureChanges += 1;
        settlement.push({ elapsedMs: performance.now() - started, ...state });
        previous = signature;
      } else {
        collector.unchanged += 1;
      }
    }
    if (latest && Object.values(latest.checks).every(Boolean) && latest.errors.length === 0) {
      return {
        ...latest,
        elapsedMs: performance.now() - started,
        settlement,
        observationRetention: collector,
      };
    }
    await delay(50);
  } while (performance.now() < deadline);
  failures.push(`Viewport did not settle: ${JSON.stringify(latest?.checks ?? null)}`);
  return {
    ...(latest ?? { viewport: {} }),
    elapsedMs: performance.now() - started,
    settlement,
    observationRetention: collector,
  };
}

async function saveView(page, fixture, name) {
  const managed = await page.evaluate(() => {
    const selected = document
      .querySelector('[role="tab"][data-tab-id][aria-selected="true"]')
      ?.getAttribute('data-tab-id');
    return Object.values(window.__test.getCanvasStore().panels)
      .flatMap((panel) => panel.tabs)
      .some((tab) => tab.id === selected && tab.trackView);
  });
  if (managed) {
    await page.getByRole('button', { name: 'Track view actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Save As…', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Save view', exact: true }).click();
  }
  const dialog = page.getByTestId('track-view-save-dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByTestId(`track-view-picker-folder-${fixture.workspaceRoot}`).click();
  await dialog.getByRole('textbox', { name: 'Track view name' }).fill(name);
  await dialog.getByRole('button', { name: 'Save Track view', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const savedViewPath = path.join(fixture.workspaceRoot, `${name}.dnaforge-track-view.json`);
  const document = JSON.parse(await readFile(savedViewPath, 'utf8'));
  assert.ok(
    document.bamTracks?.some((track) => track.admittedSource),
    'The saved file has no admitted BAM source.'
  );
  return savedViewPath;
}

async function closeView(page, { tabId, discardChanges = false } = {}) {
  const candidate = page.locator(
    tabId
      ? `[role="tab"][data-tab-id=${JSON.stringify(tabId)}]`
      : '[role="tab"][data-tab-id][aria-selected="true"]'
  );
  const id = await candidate.getAttribute('data-tab-id');
  assert.ok(id, 'The saved view has no active tab.');
  const tab = page.locator(`[role="tab"][data-tab-id=${JSON.stringify(id)}]`);
  await tab.hover();
  await page.getByTestId(`tab-close-${id}`).click();
  const confirmation = page.getByRole('dialog', { name: 'Do you want to save changes?' });
  const closed = await poll(
    async () => ({
      removed: (await tab.count()) === 0,
      confirmation: await confirmation.isVisible(),
    }),
    (state) => state.removed || state.confirmation,
    5000,
    'Closing the saved view did not remove its tab or show a decision'
  );
  if (closed.confirmation) {
    assert.ok(discardChanges, 'The saved copy unexpectedly still has unsaved changes.');
    await confirmation.getByRole('button', { name: "Don't Save", exact: true }).click();
  }
  await tab.waitFor({ state: 'detached' });
  return id;
}

async function savedFileRow(page, fixture, savedViewPath) {
  const tree = page.getByRole('tree', { name: 'Project files' });
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await tree.waitFor({ state: 'visible' });
  const root = tree.locator(`[data-entry-path=${JSON.stringify(fixture.workspaceRoot)}]`);
  if ((await root.count()) && (await root.getAttribute('aria-expanded')) === 'false')
    await root.click();
  const row = tree.locator(`[data-entry-path=${JSON.stringify(savedViewPath)}]`);
  await row.waitFor({ state: 'visible', timeout: 15_000 });
  return row;
}

async function waitForViewer(page) {
  await poll(
    async () => {
      const errors = await page
        .locator('[data-testid="sequence-error"]:visible, [data-testid="toast-error"]:visible')
        .allTextContents();
      if (errors.length) throw new Error(`The saved view failed to open: ${errors.join('\n')}`);
      return viewer(page).isVisible();
    },
    Boolean,
    15_000,
    'The saved file did not open an indexed genome viewer'
  );
}

async function admitPortable(page, fixture) {
  await mountWorkspace(page, fixture.workspaceRoot);
  await page.evaluate(async (fixture) => {
    await window.electronAPI.fs.stat(fixture.bamPath);
    await window.electronAPI.fs.stat(fixture.indexPath);
    const imported = await window.electronAPI.referenceAssets.importLocal({
      operationId: crypto.randomUUID(),
      themeMode: 'light',
      sourcePath: fixture.referencePath,
    });
    if (imported.status !== 'ready')
      throw new Error(`Reference admission returned ${imported.status}.`);
    const { openAssembly } = await import('/src/features/sequence/openAssembly.ts');
    const tabId = await openAssembly(imported.entry);
    if (!tabId) throw new Error('Reference admission did not open a viewer.');
    const state = window.__test.getCanvasStore();
    const tab = Object.values(state.panels)
      .flatMap((panel) => panel.tabs)
      .find((tab) => tab.id === tabId);
    const assembly = tab?.indexedGenome?.assembly;
    if (!assembly) throw new Error('The opened reference has no assembly.');
    const { assemblyContigNaming } = await import('/src/shared/genome/contig-name-map.ts');
    const { attachAlignedReadRequest } =
      await import('/src/features/sequence/attach-aligned-read-request.ts');
    const attached = await attachAlignedReadRequest({
      request: {
        contract: 'dnaforge.track-admission-request.v1',
        assemblyId: assembly.assemblyId,
        source: { kind: 'local-file', path: fixture.bamPath },
        index: { kind: 'local-file', path: fixture.indexPath },
        formatId: 'bam',
        scientificKind: 'reads',
        ingress: { kind: 'automation' },
      },
      genome: {
        laneOwnerId: tabId,
        assemblyId: assembly.assemblyId,
        displayName: assembly.displayName,
        references: assemblyContigNaming(assembly.chromosomes),
      },
    });
    await attached.coverage;
  }, fixture);
  await viewer(page).waitFor({ state: 'visible', timeout: 30_000 });
  const lane = await poll(
    () => activeLane(page, fixture.bamPath),
    Boolean,
    10_000,
    'BAM admission created no visible lane'
  );
  assert.ok(lane.generationKey, 'The admitted BAM has no current source generation.');
  lane.annotationExpectation = fixture.annotationExpectation;
  const readAnnotationSelection = () =>
    page.evaluate(async () => {
      const selectedTabId = document
        .querySelector('[role="tab"][data-tab-id][aria-selected="true"]')
        ?.getAttribute('data-tab-id');
      const tab = Object.values(window.__test.getCanvasStore().panels)
        .flatMap((panel) => panel.tabs)
        .find((candidate) => candidate.id === selectedTabId);
      const root = document
        .querySelector('[data-testid="indexed-genome-visible-viewer"]')
        ?.closest('[data-testid="indexed-genome-tab"]');
      const state = {
        assemblyId: tab?.indexedGenome?.assembly?.assemblyId ?? null,
        readiness: root?.getAttribute('data-session-assembly-annotation-products-readiness'),
        trackIds: tab?.indexedGenome?.assemblyAnnotationTrackTypes ?? [],
        pickerOpen: Boolean(document.querySelector('[data-testid="annotation-type-picker"]')),
        mRNAPressed: document
          .querySelector('[data-testid="annotation-type-mRNA"]')
          ?.getAttribute('aria-pressed'),
      };
      try {
        const { getTrackViewControl } =
          await import('/src/features/sequence/track-view-control.ts');
        const current = selectedTabId ? getTrackViewControl(selectedTabId)?.inspect() : null;
        return {
          ...state,
          referenceAssemblyId: current?.document.reference.assemblyId ?? null,
          annotation: current?.document.annotation ?? null,
        };
      } catch (error) {
        return { ...state, error: String(error) };
      }
    });
  const annotationSelectionReady = (state) =>
    state.assemblyId === lane.assemblyId &&
    state.referenceAssemblyId === lane.assemblyId &&
    state.readiness === 'ready' &&
    state.trackIds.includes('mRNA') &&
    state.annotation?.orderedTrackIds.includes('mRNA');
  const onlyMRNASelected = (state) =>
    annotationSelectionReady(state) &&
    state.annotation.visibilityByTrackId.mRNA === true &&
    Object.entries(state.annotation.visibilityByTrackId).every(
      ([trackId, visible]) => trackId === 'mRNA' || visible === false
    );
  await poll(
    readAnnotationSelection,
    annotationSelectionReady,
    10_000,
    'The admitted annotation catalog and Track view session did not become ready'
  );
  await page.getByTestId('annotation-type-picker-summary').click();
  await page.getByTestId('annotation-type-preset-none').click();
  await poll(
    readAnnotationSelection,
    (state) =>
      annotationSelectionReady(state) &&
      state.mRNAPressed === 'false' &&
      state.annotation.visibilityByTrackId.mRNA === false &&
      Object.values(state.annotation.visibilityByTrackId).every((visible) => visible === false),
    10_000,
    'The None preset did not clear the requested annotation selection'
  );
  await page.getByTestId('annotation-type-mRNA').click();
  await poll(
    readAnnotationSelection,
    (state) => state.mRNAPressed === 'true' && onlyMRNASelected(state),
    10_000,
    'The mRNA toggle did not reach the requested Track view selection'
  );
  await page.keyboard.press('Escape');
  await poll(
    readAnnotationSelection,
    (state) => !state.pickerOpen && onlyMRNASelected(state),
    10_000,
    'The requested mRNA selection did not persist after closing the picker'
  );
  await frame(page, fixture.locusStart, 4000, lane);
  const failures = [];
  await complete(page, lane, fixture.readLengthBp, performance.now(), failures);
  assert.equal(failures.length, 0, failures.join('\n'));
  const savedViewPath = await saveView(page, fixture, 'Dense alignment performance');
  const savedDocument = JSON.parse(await readFile(savedViewPath, 'utf8'));
  assert.ok(
    Math.abs(savedDocument.viewport.start0 - fixture.locusStart) <= 2 &&
      Math.abs(savedDocument.viewport.end0 - fixture.locusStart - 4000) <= 2,
    `The prepared saved view captured the wrong viewport: ${JSON.stringify(savedDocument.viewport)}`
  );
  await closeView(page);
  return { ...fixture, savedViewPath };
}

export async function startCadence(page) {
  return page.evaluate(() => {
    const started = performance.now();
    const hasLongTasks = PerformanceObserver.supportedEntryTypes.includes('longtask');
    const capture = {
      started,
      previous: started,
      rafIntervalsMs: [],
      longTaskDurationsMs: hasLongTasks ? [] : null,
      longAnimationFrames: { status: 'unsupported', entries: [], omittedEntries: 0 },
      frameObserver: null,
      recordFrames: null,
      raf: 0,
      observer: null,
      wheel: {
        eventCount: 0,
        deltaY: 0,
        untrustedCount: 0,
        firstTrustedEventMs: null,
        lastTrustedEventMs: null,
      },
      onWheel: null,
    };
    capture.onWheel = (event) => {
      capture.wheel.eventCount += 1;
      capture.wheel.deltaY += event.deltaY;
      if (!event.isTrusted) capture.wheel.untrustedCount += 1;
      else {
        const elapsed = performance.now() - started;
        capture.wheel.firstTrustedEventMs ??= elapsed;
        capture.wheel.lastTrustedEventMs = elapsed;
      }
    };
    document.addEventListener('wheel', capture.onWheel, { capture: true, passive: true });
    const tick = () => {
      const time = performance.now();
      capture.rafIntervalsMs.push(time - capture.previous);
      capture.previous = time;
      capture.raf = requestAnimationFrame(tick);
    };
    capture.raf = requestAnimationFrame(tick);
    if (hasLongTasks) {
      capture.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime >= started) capture.longTaskDurationsMs.push(entry.duration);
        }
      });
      capture.observer.observe({ type: 'longtask' });
    }
    if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
      const filename = (source) => {
        try {
          const url = new URL(source);
          const name = url.pathname.split('/').at(-1);
          return url.origin === location.origin &&
            /^https?:$/.test(url.protocol) &&
            /^\/(?:src|assets|node_modules|@fs)\//.test(url.pathname) &&
            /^[A-Za-z0-9_$.-]{1,120}\.(?:[cm]?[jt]sx?)$/.test(name)
            ? name
            : null;
        } catch {
          return null;
        }
      };
      capture.recordFrames = (entries) => {
        for (const entry of entries) {
          if (entry.startTime < started) continue;
          if (capture.longAnimationFrames.entries.length === 8) {
            capture.longAnimationFrames.omittedEntries += 1;
            continue;
          }
          capture.longAnimationFrames.entries.push({
            startMs: entry.startTime - started,
            durationMs: entry.duration,
            blockingDurationMs: entry.blockingDuration,
            omittedScripts: Math.max(0, entry.scripts.length - 4),
            scripts: entry.scripts.slice(0, 4).map((script) => {
              const name = filename(script.sourceURL);
              return {
                filename: name,
                functionName:
                  name !== null &&
                  typeof script.sourceFunctionName === 'string' &&
                  /^[A-Za-z_$][\w$.]{0,119}$/.test(script.sourceFunctionName)
                    ? script.sourceFunctionName
                    : null,
                durationMs: script.duration,
              };
            }),
          });
        }
      };
      try {
        capture.frameObserver = new PerformanceObserver((list) => {
          capture.recordFrames(list.getEntries());
        });
        capture.frameObserver.observe({ type: 'long-animation-frame' });
        capture.longAnimationFrames.status = 'available';
      } catch {
        capture.frameObserver?.disconnect();
        capture.frameObserver = null;
        capture.longAnimationFrames.status = 'unavailable';
      }
    }
    window.__pileupPerformanceCapture = capture;
    return performance.timeOrigin + started;
  });
}

export async function stopCadence(page, expectedDeltaY) {
  return page.evaluate(async (expectedDeltaY) => {
    const capture = window.__pileupPerformanceCapture;
    if (!capture) throw new Error('The gesture cadence recorder is absent.');
    const deliveryStarted = performance.now();
    const deadline = deliveryStarted + 1000;
    while (
      Math.abs(capture.wheel.deltaY - expectedDeltaY) > 0.001 &&
      performance.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const ended = performance.now();
    cancelAnimationFrame(capture.raf);
    for (const entry of capture.observer?.takeRecords() ?? []) {
      if (entry.startTime >= capture.started) capture.longTaskDurationsMs.push(entry.duration);
    }
    capture.observer?.disconnect();
    capture.recordFrames?.(capture.frameObserver?.takeRecords() ?? []);
    capture.frameObserver?.disconnect();
    document.removeEventListener('wheel', capture.onWheel, true);
    if (ended > capture.previous) capture.rafIntervalsMs.push(ended - capture.previous);
    delete window.__pileupPerformanceCapture;
    return {
      durationMs: ended - capture.started,
      rafIntervalsMs: capture.rafIntervalsMs,
      longTaskDurationsMs: capture.longTaskDurationsMs,
      longAnimationFrames: capture.longAnimationFrames,
      endedAtEpochMs: performance.timeOrigin + ended,
      wheelDeliveryWaitMs: ended - deliveryStarted,
      wheel: capture.wheel,
    };
  }, expectedDeltaY);
}

async function wheelGesture(page, cdp, { deltaY, modifiers = 0 }, collector = {}) {
  Object.assign(collector, {
    clock: 'nodeMonotonicMs',
    lastDispatchMs: null,
    acknowledgment: null,
    cadenceStop: null,
  });
  const box = await viewer(page).locator('canvas').first().boundingBox();
  assert.ok(box, 'The indexed canvas has no visible bounds.');
  const x = box.x + box.width * 0.5;
  const y = box.y + box.height * 0.5;
  await page.mouse.move(x, y);
  const inputStartEpochMs = await startCadence(page);
  const started = performance.now();
  const requests = [];
  let finalInput = started;
  for (let index = 0; index < 120; index += 1) {
    const scheduled = started + index * 10;
    if (performance.now() < scheduled) await delay(scheduled - performance.now());
    finalInput = performance.now();
    requests.push(
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY,
        modifiers,
      })
    );
  }
  collector.lastDispatchMs = finalInput;
  collector.acknowledgment = { startMs: performance.now(), endMs: null, outcome: null };
  try {
    await Promise.all(requests);
    collector.acknowledgment.outcome = 'fulfilled';
  } catch (error) {
    collector.acknowledgment.outcome = 'rejected';
    throw error;
  } finally {
    collector.acknowledgment.endMs = performance.now();
  }
  collector.cadenceStop = { startMs: performance.now(), endMs: null, outcome: null };
  let cadence;
  try {
    cadence = await stopCadence(page, deltaY * 120);
    collector.cadenceStop.outcome = 'fulfilled';
  } catch (error) {
    collector.cadenceStop.outcome = 'rejected';
    throw error;
  } finally {
    collector.cadenceStop.endMs = performance.now();
  }
  return {
    finalInput,
    lastInputToAllAcknowledgedMs: collector.acknowledgment.endMs - finalInput,
    inputStartEpochMs,
    inputEndEpochMs: cadence.endedAtEpochMs,
    cadence,
    requestedWheel: { eventCount: 120, deltaY: deltaY * 120, modifiers },
    inputRetention: collector,
  };
}

export { wheelGesture };

export async function runPileupPerformanceJourney({
  page,
  output,
  apiPort,
  profile = 'portable-dense',
  fixture,
  nativeTrace,
}) {
  assert.ok(path.isAbsolute(output), 'Performance evidence needs an absolute output directory.');
  assert.ok(
    ['portable-dense', 'full-genome'].includes(profile),
    'Unknown pileup performance profile.'
  );
  assert.ok(Number.isInteger(apiPort) && apiPort > 0, 'The running sidecar API port is required.');
  assert.ok(
    profile !== 'full-genome' || fixture?.savedViewPath,
    'Full-genome qualification requires a saved view fixture.'
  );
  await mkdir(output, { recursive: true });
  const report = {
    schema: 'dnaforge.pileup-performance.v1',
    profile,
    source: {},
    phases: [],
    resourceSamples: [],
    diagnostics: {
      consoleMessages: [],
      httpFailures: [],
      requestFailures: [],
      openings: [],
      inputs: [],
      observations: [],
    },
  };
  const errors = [];
  let preparing = !fixture?.savedViewPath;
  let scope = 'preparation';
  const onError = (error) => errors.push(`Renderer: ${error.message}`);
  const onRequestFailure = (request) => {
    report.diagnostics.requestFailures.push({
      atEpochMs: Date.now(),
      scope,
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText,
    });
    if (request.failure()?.errorText !== 'net::ERR_ABORTED') {
      errors.push(`${request.url()}: ${request.failure()?.errorText}`);
    }
  };
  const onResponse = (response) => {
    if (response.status() >= 400) {
      const preparationPending =
        preparing &&
        response.status() === 425 &&
        new URL(response.url()).pathname === '/tiles/coverage-corridor-floor';
      report.diagnostics.httpFailures.push({
        atEpochMs: Date.now(),
        scope,
        disposition: preparationPending ? 'preparation-pending' : 'failure',
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
      });
      if (!preparationPending) errors.push(`${response.url()}: HTTP ${response.status()}`);
    }
  };
  const onConsole = (message) => {
    if (['error', 'warning'].includes(message.type())) {
      report.diagnostics.consoleMessages.push({
        atEpochMs: Date.now(),
        scope,
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    }
  };
  page.on('pageerror', onError);
  page.on('requestfailed', onRequestFailure);
  page.on('response', onResponse);
  page.on('console', onConsole);
  const cdp = await page.context().newCDPSession(page);
  let activeTrace = null;
  const previousDebug = await page.evaluate(() => {
    const previous = {
      rows: window.__dna119ExposePileupRows,
      coverage: window.__dna119MeasurePileupCoverage,
    };
    window.__dna119ExposePileupRows = false;
    window.__dna119MeasurePileupCoverage = false;
    return previous;
  });
  const flush = () =>
    writeFile(
      path.join(output, 'pileup-performance-journey.json'),
      JSON.stringify(report, null, 2)
    );
  try {
    const identity = await sourceIdentity(page, apiPort);
    report.readiness = await nativeReadiness(page, apiPort);
    await flush();
    assert.equal(
      report.readiness.ready,
      true,
      'The native desktop and task API did not become ready.'
    );
    const supplied = Boolean(fixture?.savedViewPath);
    if (!fixture) {
      const workspaceRoot = await createFixtureWorkspace(page);
      fixture = {
        ...(await createDensePileupFixture(path.join(workspaceRoot, 'pileup-performance-fixture'))),
        workspaceRoot,
      };
    }
    fixture = { readLengthBp: 150, ...fixture };
    if (!supplied) fixture = await admitPortable(page, fixture);
    await writeFile(path.join(output, 'fixture.json'), JSON.stringify(fixture, null, 2));
    preparing = false;
    scope = 'between-phases';
    assert.ok(
      fixture.workspaceRoot &&
        fixture.bamPath &&
        Number.isFinite(fixture.locusStart) &&
        fixture.annotationExpectation?.trackId === 'mRNA' &&
        Array.isArray(fixture.annotationExpectation.intervals),
      'The saved fixture needs workspaceRoot, bamPath, locusStart and independently known annotationExpectation intervals.'
    );
    if (supplied) await mountWorkspace(page, fixture.workspaceRoot);
    if (nativeTrace) {
      assert.equal(typeof nativeTrace.start, 'function', 'Native tracing needs a start callback.');
      assert.equal(typeof nativeTrace.stop, 'function', 'Native tracing needs a stop callback.');
      await nativeTrace.beginJourney?.({ page, cdp });
    }
    report.source = {
      ...identity,
      fixtureId: fixture.fixtureId ?? path.basename(fixture.savedViewPath),
      coldScope: fixture.coldScope ?? 'fresh-view-prepared-source',
    };
    let lane;
    const record = async (phase) => {
      phase.sourceCommit = identity.commit;
      phase.runtimeCommit = identity.runtimeCommit;
      if (
        phase.kind === 'gesture' &&
        (phase.cadence.wheel.untrustedCount > 0 ||
          phase.cadence.wheel.eventCount === 0 ||
          Math.abs(phase.cadence.wheel.deltaY - phase.requestedWheel.deltaY) > 0.001)
      ) {
        phase.failures.push('The trusted wheel events did not deliver the requested total delta.');
      }
      phase.failures.push(...errors.filter((error) => !phase.failures.includes(error)));
      report.phases.push(phase);
      await flush();
      scope = 'between-phases';
    };
    const beginInput = async (label, options) => {
      scope = label;
      if (nativeTrace) {
        activeTrace = { label, token: await nativeTrace.start({ label, page, cdp }) };
      }
      const inputRetention = { label };
      report.diagnostics.inputs.push(inputRetention);
      return wheelGesture(page, cdp, options, inputRetention);
    };
    const finishInput = async (input) => {
      if (!activeTrace) return input;
      const { label, token } = activeTrace;
      activeTrace = null;
      const nativePresentation = await nativeTrace.stop({ label, token, page, cdp, ...input });
      return { ...input, nativePresentation };
    };
    const open = async (label, kind, savedViewPath) => {
      scope = label;
      const row = await savedFileRow(page, fixture, savedViewPath);
      const firstError = errors.length;
      const started = performance.now();
      const opening = {
        label,
        kind,
        startedAtEpochMs: Date.now(),
        stages: [],
        retention: {
          filesPanel: {
            clock: 'nodeMonotonicMs',
            branch: 'unresolved',
            isVisible: null,
            click: null,
            hidden: null,
            clickDisposition: 'not-reached',
            hiddenDisposition: 'not-reached',
          },
          observation: {},
        },
      };
      report.diagnostics.openings.push(opening);
      const mark = (stage) =>
        opening.stages.push({
          stage,
          atEpochMs: Date.now(),
          elapsedMs: performance.now() - started,
        });
      mark('before-dblclick');
      await row.dblclick();
      mark('after-dblclick');
      await waitForViewer(page);
      mark('viewer-visible');
      const files = page.getByRole('tree', { name: 'Project files' });
      const filesPanel = opening.retention.filesPanel;
      filesPanel.isVisible = {
        startMs: performance.now(),
        endMs: null,
        outcome: null,
        value: null,
      };
      let filesVisible;
      try {
        filesVisible = await files.isVisible();
        filesPanel.isVisible.value = filesVisible;
        filesPanel.isVisible.outcome = 'fulfilled';
      } catch (error) {
        filesPanel.isVisible.outcome = 'rejected';
        throw error;
      } finally {
        filesPanel.isVisible.endMs = performance.now();
      }
      if (filesVisible) {
        filesPanel.branch = 'hide';
        filesPanel.clickDisposition = 'executed';
        filesPanel.click = { startMs: performance.now(), endMs: null, outcome: null };
        try {
          await page.getByTestId('files-button').click();
          filesPanel.click.outcome = 'fulfilled';
        } catch (error) {
          filesPanel.click.outcome = 'rejected';
          throw error;
        } finally {
          filesPanel.click.endMs = performance.now();
        }
        filesPanel.hiddenDisposition = 'executed';
        filesPanel.hidden = { startMs: performance.now(), endMs: null, outcome: null };
        try {
          await files.waitFor({ state: 'hidden' });
          filesPanel.hidden.outcome = 'fulfilled';
        } catch (error) {
          filesPanel.hidden.outcome = 'rejected';
          throw error;
        } finally {
          filesPanel.hidden.endMs = performance.now();
        }
      } else {
        filesPanel.branch = 'already-hidden';
        filesPanel.clickDisposition = 'not-taken';
        filesPanel.hiddenDisposition = 'not-taken';
      }
      mark('files-hidden');
      lane = await poll(
        () => activeLane(page, fixture.bamPath),
        (value) => Boolean(value?.generationKey),
        10_000,
        'The reopened BAM lane is absent'
      );
      lane.annotationExpectation = fixture.annotationExpectation;
      mark('lane-ready');
      const failures = [];
      const state = await complete(
        page,
        lane,
        fixture.readLengthBp,
        started,
        failures,
        {
          startBp: fixture.locusStart,
          spanBp: kind === 'cold-open' ? 4000 : 26612,
        },
        opening.retention.observation
      );
      mark(failures.length === 0 ? 'first-complete' : 'completion-timeout');
      const bam = await stat(fixture.bamPath);
      assert.equal(
        lane.bamSizeBytes,
        bam.size,
        'The admitted BAM generation no longer matches its file.'
      );
      assert.ok(
        lane.assemblyLengthBp > 0 && lane.chromosomeCount > 0,
        'The opened viewer has no reference assembly identity.'
      );
      if (!report.source.generationKey) {
        Object.assign(report.source, {
          generationKey: lane.generationKey,
          assemblyLengthBp: lane.assemblyLengthBp,
          chromosomeCount: lane.chromosomeCount,
          bamSizeBytes: bam.size,
        });
      } else if (
        report.source.assemblyLengthBp !== lane.assemblyLengthBp ||
        report.source.chromosomeCount !== lane.chromosomeCount ||
        report.source.bamSizeBytes !== bam.size
      ) {
        failures.push('The reopened saved view changed its reference or BAM identity.');
      }
      failures.push(...errors.slice(firstError), ...(state.errors ?? []));
      await record({ label, kind, ...state, opening, failures });
    };
    const gesture = async (label, direction) => {
      const firstError = errors.length;
      const before = await observation(page, lane, fixture.readLengthBp);
      let input = await beginInput(label, { deltaY: direction * 25 });
      const failures = [];
      const span = before.viewport.endBp - before.viewport.startBp;
      const observationRetention = {};
      report.diagnostics.observations.push({ label, observationRetention });
      const state = await complete(
        page,
        lane,
        fixture.readLengthBp,
        input.finalInput,
        failures,
        {
          startBp: before.viewport.startBp + direction * span * 3,
          spanBp: span,
        },
        observationRetention
      );
      input = await finishInput(input);
      const movement = Math.abs(state.viewport.startBp - before.viewport.startBp);
      if (movement < span * 2)
        failures.push(`The wheel gesture moved only ${movement} bp for a ${span} bp viewport.`);
      if (Math.abs(state.viewport.endBp - state.viewport.startBp - span) > 2)
        failures.push('A pan changed the viewport span.');
      if (
        label.startsWith('pan-') &&
        direction > 0 &&
        !(
          state.viewport.startBp >= before.sourceWindow.endBp ||
          state.viewport.endBp <= before.sourceWindow.startBp
        )
      ) {
        failures.push('The gesture did not leave the initially loaded read interval.');
      }
      if (direction < 0 && Math.abs(state.viewport.startBp - fixture.locusStart) > 2) {
        failures.push('The return gesture did not restore the original camera.');
      }
      failures.push(...errors.slice(firstError), ...(state.errors ?? []));
      const { finalInput, ...timing } = input;
      await record({ label, kind: 'gesture', ...state, ...timing, failures });
    };
    await open('cold-open-4000bp', 'cold-open', fixture.savedViewPath);
    for (const span of [26612, 44000]) {
      const before = await observation(page, lane, fixture.readLengthBp);
      let input = await beginInput(`zoom-${span}bp`, {
        deltaY: Math.log(span / (before.viewport.endBp - before.viewport.startBp)) / 0.008 / 120,
        modifiers: 2,
      });
      const failures = [];
      const observationRetention = {};
      report.diagnostics.observations.push({ label: `zoom-${span}bp`, observationRetention });
      const state = await complete(
        page,
        lane,
        fixture.readLengthBp,
        input.finalInput,
        failures,
        {
          spanBp: span,
        },
        observationRetention
      );
      input = await finishInput(input);
      if (Math.abs(state.viewport.endBp - state.viewport.startBp - span) > 2) {
        failures.push(`The native wheel zoom did not reach ${span} bp.`);
      }
      const { finalInput, ...timing } = input;
      await record({ label: `zoom-${span}bp`, kind: 'gesture', ...state, ...timing, failures });
      await frame(page, fixture.locusStart, span, lane);
      const preconditionFailures = [];
      const preconditionRetention = {};
      report.diagnostics.observations.push({
        label: `pan-${span}bp-precondition`,
        observationRetention: preconditionRetention,
      });
      await complete(
        page,
        lane,
        fixture.readLengthBp,
        performance.now(),
        preconditionFailures,
        undefined,
        preconditionRetention
      );
      assert.equal(preconditionFailures.length, 0, preconditionFailures.join('\n'));
      await gesture(`pan-${span}bp-away`, 1);
      await gesture(`pan-${span}bp-return`, -1);
    }
    await frame(page, fixture.locusStart, 26612, lane);
    const sourceTabId = await page
      .locator('[role="tab"][data-tab-id][aria-selected="true"]')
      .getAttribute('data-tab-id');
    const savedViewPath = await saveView(page, fixture, `Warm alignment performance ${Date.now()}`);
    const savedTabId = await closeView(page);
    if (
      sourceTabId !== savedTabId &&
      (await page.locator(`[role="tab"][data-tab-id=${JSON.stringify(sourceTabId)}]`).count())
    ) {
      await closeView(page, { tabId: sourceTabId, discardChanges: true });
    }
    await open('reopen-26612bp', 'reopen', savedViewPath);
    for (let cycle = 0; cycle < 4; cycle += 1) {
      await gesture(`warm-${cycle}-26612bp-away`, 1);
      await gesture(`warm-${cycle}-26612bp-return`, -1);
      if (cycle === 0) continue;
      await cdp.send('HeapProfiler.collectGarbage');
      const heap = await cdp.send('Runtime.getHeapUsage');
      const state = await observation(page, lane, fixture.readLengthBp);
      report.resourceSamples.push({
        cycle,
        checkpoint: 'warm-return-26612bp',
        warmed:
          Math.abs(state.viewport.startBp - fixture.locusStart) <= 2 &&
          Math.abs(state.viewport.endBp - fixture.locusStart - 26612) <= 2,
        gcPerformed: true,
        heapUsedBytes: heap.usedSize,
        cacheBytes: state.cache.bytes,
        cacheEntries: state.cache.entries,
        viewport: state.viewport,
      });
      await flush();
    }
    await nativeTrace?.finishJourney?.({ page, cdp });
    for (const phase of report.phases) {
      scope = `evidence:${phase.label}`;
      try {
        await frame(
          page,
          phase.viewport.startBp,
          phase.viewport.endBp - phase.viewport.startBp,
          lane
        );
        const failures = [];
        const observationRetention = {};
        report.diagnostics.observations.push({
          label: phase.label,
          stage: 'evidence',
          observationRetention,
        });
        const state = await complete(
          page,
          lane,
          fixture.readLengthBp,
          performance.now(),
          failures,
          {
            startBp: phase.viewport.startBp,
            spanBp: phase.viewport.endBp - phase.viewport.startBp,
          },
          observationRetention
        );
        phase.failures.push(...failures);
        phase.evidence = {
          stage: 'post-measurement-replay',
          viewport: state.viewport,
          annotation: state.annotation,
          visibleFlanks: await visibleFlanks(page, lane, state.viewport),
          screenshot: `${phase.label}.png`,
        };
        if (
          phase.evidence.visibleFlanks &&
          (!phase.evidence.visibleFlanks.left || !phase.evidence.visibleFlanks.right)
        ) {
          phase.failures.push(
            'Visible readable rows do not reach both viewport flanks during evidence replay.'
          );
        }
        await page.screenshot({ path: path.join(output, phase.evidence.screenshot) });
      } catch (error) {
        phase.failures.push(`Evidence capture failed: ${error.message}`);
        throw error;
      } finally {
        await flush();
      }
    }
    report.failures = errors;
    await flush();
    return report;
  } catch (error) {
    report.failures = [...errors, String(error?.stack ?? error)];
    report.diagnostics.failureUiText = await page
      .locator('body')
      .innerText()
      .catch(() => null);
    await flush();
    await page.screenshot({ path: path.join(output, 'journey-failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (activeTrace) {
      await nativeTrace.stop({ ...activeTrace, page, cdp, aborted: true }).catch(() => {});
    }
    try {
      await nativeTrace?.finishJourney?.({ page, cdp });
    } catch (error) {
      report.failures = [...(report.failures ?? errors), `Native capture: ${String(error)}`];
    }
    await flush();
    await page
      .evaluate((previous) => {
        const capture = window.__pileupPerformanceCapture;
        if (capture) {
          cancelAnimationFrame(capture.raf);
          capture.observer?.disconnect();
          capture.frameObserver?.disconnect();
          document.removeEventListener('wheel', capture.onWheel, true);
          delete window.__pileupPerformanceCapture;
        }
        if (previous.rows === undefined) delete window.__dna119ExposePileupRows;
        else window.__dna119ExposePileupRows = previous.rows;
        if (previous.coverage === undefined) delete window.__dna119MeasurePileupCoverage;
        else window.__dna119MeasurePileupCoverage = previous.coverage;
      }, previousDebug)
      .catch(() => {});
    page.off('pageerror', onError);
    page.off('requestfailed', onRequestFailure);
    page.off('response', onResponse);
    page.off('console', onConsole);
    await cdp.detach();
  }
}

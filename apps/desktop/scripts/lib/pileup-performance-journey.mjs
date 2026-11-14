import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createDensePileupFixture } from './pileup-performance-fixture.mjs';

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

async function mountWorkspace(page, workspaceRoot) {
  await page.evaluate(async (root) => {
    if (!window.__test?.mountFolderInPlace) throw new Error('Workspace admission is unavailable.');
    await window.__test.mountFolderInPlace(root);
  }, workspaceRoot);
}

async function frame(page, start, span) {
  await page.evaluate(
    ({ start, span }) => {
      if (!window.__test?.workspaceViewer?.setViewport) {
        throw new Error('The indexed viewport precondition bridge is unavailable.');
      }
      window.__test.workspaceViewer.setViewport({ start, end: start + span });
      window.__webglFireCameraChange?.('zoom');
      if (typeof window.__webglRequestRender !== 'function') {
        throw new Error('The indexed renderer invalidation bridge is unavailable.');
      }
      window.__webglRequestRender();
    },
    { start, span }
  );
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

async function observation(page, lane, readLengthBp) {
  return page.evaluate(
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
        settled:
          diagnostic.rowsMeshBuildInProgress === false &&
          diagnostic.rowsAssignmentBuildInProgress === false,
        visible:
          diagnostic.rowsMeshVisible === true && diagnostic.rowsVertexCount > 0 && rowsAlpha > 0.02,
        stableBand: composition?.stableBandReady === true,
        densityMatchesScale: physicalReadPx >= 3.6 ? densityAlpha <= 0.02 : densityAlpha > 0.02,
        densityCoversViewport:
          densityAlpha <= 0.02 ||
          (diagnostic.coverageSignalStartBp <= startBp && diagnostic.coverageSignalEndBp >= endBp),
      };
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
        sourceWindow: {
          startBp: diagnostic.readSourceWindowStartBp,
          endBp: diagnostic.readSourceWindowEndBp,
        },
        cache: { bytes: driver.cache?.byteSize, entries: driver.cache?.entries },
        errors: [
          ...(driver.cache?.errors ?? []).map((entry) => entry.reason ?? 'Alignment tile failed'),
          ...(driver.aln?.error ? [`${driver.aln.error} failed alignment tiles`] : []),
        ],
      };
    },
    { lane, readLengthBp }
  );
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

async function complete(page, lane, readLengthBp, started, failures, target = {}) {
  let latest = null;
  const deadline = performance.now() + 10_000;
  do {
    latest = await observation(page, lane, readLengthBp);
    if (latest) {
      latest.checks.cameraAtTarget =
        (!Number.isFinite(target.startBp) ||
          Math.abs(latest.viewport.startBp - target.startBp) <= 2) &&
        (!Number.isFinite(target.spanBp) ||
          Math.abs(latest.viewport.endBp - latest.viewport.startBp - target.spanBp) <= 2);
    }
    if (latest && Object.values(latest.checks).every(Boolean) && latest.errors.length === 0) {
      return { ...latest, elapsedMs: performance.now() - started };
    }
    await delay(50);
  } while (performance.now() < deadline);
  failures.push(`Viewport did not settle: ${JSON.stringify(latest?.checks ?? null)}`);
  return { ...(latest ?? { viewport: {} }), elapsedMs: performance.now() - started };
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

async function closeView(page) {
  const tab = page.locator('[role="tab"][data-tab-id][aria-selected="true"]');
  const id = await tab.getAttribute('data-tab-id');
  assert.ok(id, 'The saved view has no active tab.');
  await tab.hover();
  await page.getByTestId(`tab-close-${id}`).click();
  await viewer(page).waitFor({ state: 'detached' });
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
  await frame(page, fixture.locusStart, 4000);
  const failures = [];
  await complete(page, lane, fixture.readLengthBp, performance.now(), failures);
  assert.equal(failures.length, 0, failures.join('\n'));
  const savedViewPath = await saveView(page, fixture, 'Dense alignment performance');
  await closeView(page);
  return { ...fixture, savedViewPath };
}

async function startCadence(page) {
  return page.evaluate(() => {
    const started = performance.now();
    const hasLongTasks = PerformanceObserver.supportedEntryTypes.includes('longtask');
    const capture = {
      started,
      previous: started,
      rafIntervalsMs: [],
      longTaskDurationsMs: hasLongTasks ? [] : null,
      raf: 0,
      observer: null,
      wheel: { eventCount: 0, deltaY: 0, untrustedCount: 0 },
      onWheel: null,
    };
    const canvas = document.querySelector('[data-testid="indexed-genome-visible-viewer"] canvas');
    capture.onWheel = (event) => {
      if (event.target !== canvas) return;
      capture.wheel.eventCount += 1;
      capture.wheel.deltaY += event.deltaY;
      if (!event.isTrusted) capture.wheel.untrustedCount += 1;
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
    window.__pileupPerformanceCapture = capture;
    return performance.timeOrigin + started;
  });
}

async function stopCadence(page) {
  return page.evaluate(() => {
    const capture = window.__pileupPerformanceCapture;
    if (!capture) throw new Error('The gesture cadence recorder is absent.');
    const ended = performance.now();
    cancelAnimationFrame(capture.raf);
    for (const entry of capture.observer?.takeRecords() ?? []) {
      if (entry.startTime >= capture.started) capture.longTaskDurationsMs.push(entry.duration);
    }
    capture.observer?.disconnect();
    document.removeEventListener('wheel', capture.onWheel, true);
    if (ended > capture.previous) capture.rafIntervalsMs.push(ended - capture.previous);
    delete window.__pileupPerformanceCapture;
    return {
      durationMs: ended - capture.started,
      rafIntervalsMs: capture.rafIntervalsMs,
      longTaskDurationsMs: capture.longTaskDurationsMs,
      endedAtEpochMs: performance.timeOrigin + ended,
      wheel: capture.wheel,
    };
  });
}

async function wheelGesture(page, cdp, { deltaY, modifiers = 0 }) {
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
  await Promise.all(requests);
  const cadence = await stopCadence(page);
  return {
    finalInput,
    inputStartEpochMs,
    inputEndEpochMs: cadence.endedAtEpochMs,
    cadence,
    requestedWheel: { eventCount: 120, deltaY: deltaY * 120, modifiers },
  };
}

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
    diagnostics: { consoleMessages: [], httpFailures: [], requestFailures: [] },
  };
  const errors = [];
  const onError = (error) => errors.push(`Renderer: ${error.message}`);
  const onRequestFailure = (request) => {
    report.diagnostics.requestFailures.push({
      atEpochMs: Date.now(),
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText,
    });
    if (/\/tiles\//u.test(request.url()) && request.failure()?.errorText !== 'net::ERR_ABORTED') {
      errors.push(`${request.url()}: ${request.failure()?.errorText}`);
    }
  };
  const onResponse = (response) => {
    if (response.status() >= 400) {
      report.diagnostics.httpFailures.push({
        atEpochMs: Date.now(),
        url: response.url(),
        method: response.request().method(),
        status: response.status(),
      });
      if (/\/tiles\//u.test(response.url()))
        errors.push(`${response.url()}: HTTP ${response.status()}`);
    }
  };
  const onConsole = (message) => {
    if (['error', 'warning'].includes(message.type())) {
      report.diagnostics.consoleMessages.push({
        atEpochMs: Date.now(),
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
    if (nativeTrace) {
      assert.equal(typeof nativeTrace.start, 'function', 'Native tracing needs a start callback.');
      assert.equal(typeof nativeTrace.stop, 'function', 'Native tracing needs a stop callback.');
    }
    const supplied = Boolean(fixture?.savedViewPath);
    fixture = {
      readLengthBp: 150,
      ...(fixture ?? (await createDensePileupFixture(path.join(output, 'fixture')))),
    };
    if (!supplied) fixture = await admitPortable(page, fixture);
    assert.ok(
      fixture.workspaceRoot && fixture.bamPath && Number.isFinite(fixture.locusStart),
      'The saved fixture needs workspaceRoot, bamPath and locusStart.'
    );
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
      try {
        phase.visibleFlanks = await visibleFlanks(page, lane, phase.viewport);
        if (phase.visibleFlanks && (!phase.visibleFlanks.left || !phase.visibleFlanks.right)) {
          phase.failures.push('Visible readable rows do not reach both viewport flanks.');
        }
        await page.screenshot({ path: path.join(output, `${phase.label}.png`) });
      } catch (error) {
        phase.failures.push(`Evidence capture failed: ${error.message}`);
        throw error;
      } finally {
        await flush();
      }
    };
    const beginInput = async (label, options) => {
      if (nativeTrace) {
        activeTrace = { label, token: await nativeTrace.start({ label, page, cdp }) };
      }
      return wheelGesture(page, cdp, options);
    };
    const finishInput = async (input) => {
      if (!activeTrace) return input;
      const { label, token } = activeTrace;
      activeTrace = null;
      const nativePresentation = await nativeTrace.stop({ label, token, page, cdp, ...input });
      return { ...input, nativePresentation };
    };
    const open = async (label, kind, savedViewPath) => {
      const row = await savedFileRow(page, fixture, savedViewPath);
      const firstError = errors.length;
      const started = performance.now();
      await row.dblclick();
      await waitForViewer(page);
      const files = page.getByRole('tree', { name: 'Project files' });
      if (await files.isVisible()) {
        await page.getByTestId('files-button').click();
        await files.waitFor({ state: 'hidden' });
      }
      lane = await poll(
        () => activeLane(page, fixture.bamPath),
        (value) => Boolean(value?.generationKey),
        10_000,
        'The reopened BAM lane is absent'
      );
      const failures = [];
      const state = await complete(page, lane, fixture.readLengthBp, started, failures, {
        startBp: fixture.locusStart,
        spanBp: kind === 'cold-open' ? 4000 : 26612,
      });
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
      await record({ label, kind, ...state, failures });
    };
    const gesture = async (label, direction) => {
      const firstError = errors.length;
      const before = await observation(page, lane, fixture.readLengthBp);
      let input = await beginInput(label, { deltaY: direction * 25 });
      const failures = [];
      const span = before.viewport.endBp - before.viewport.startBp;
      const state = await complete(page, lane, fixture.readLengthBp, input.finalInput, failures, {
        startBp: before.viewport.startBp + direction * span * 3,
        spanBp: span,
      });
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
      const state = await complete(page, lane, fixture.readLengthBp, input.finalInput, failures, {
        spanBp: span,
      });
      input = await finishInput(input);
      if (Math.abs(state.viewport.endBp - state.viewport.startBp - span) > 2) {
        failures.push(`The native wheel zoom did not reach ${span} bp.`);
      }
      const { finalInput, ...timing } = input;
      await record({ label: `zoom-${span}bp`, kind: 'gesture', ...state, ...timing, failures });
      await frame(page, fixture.locusStart, span);
      const preconditionFailures = [];
      await complete(page, lane, fixture.readLengthBp, performance.now(), preconditionFailures);
      assert.equal(preconditionFailures.length, 0, preconditionFailures.join('\n'));
      await gesture(`pan-${span}bp-away`, 1);
      await gesture(`pan-${span}bp-return`, -1);
    }
    await frame(page, fixture.locusStart, 26612);
    const savedViewPath = await saveView(page, fixture, `Warm alignment performance ${Date.now()}`);
    await closeView(page);
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
    await page
      .evaluate((previous) => {
        const capture = window.__pileupPerformanceCapture;
        if (capture) {
          cancelAnimationFrame(capture.raf);
          capture.observer?.disconnect();
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

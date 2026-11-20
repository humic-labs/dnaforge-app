import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { createPileupNativeTrace } from './lib/pileup-native-trace.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({
  options: {
    session: { type: 'string' },
    out: { type: 'string' },
    profile: { type: 'boolean' },
    video: { type: 'boolean' },
  },
});
const session = await realpath(values.session);
const out = path.resolve(values.out);
assert.ok(out !== root && !out.startsWith(root + path.sep));
await mkdir(out);
const env = await readFile(path.join(root, 'apps/desktop/.env.local'), 'utf8');
const port = (key) => Number(env.match(new RegExp(`^${key}=(\\d+)$`, 'm'))?.[1]);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port('DESKTOP_DEBUG_PORT')}`);
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url() === `http://127.0.0.1:${port('DESKTOP_DEV_PORT')}/`);
const receipt = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  trackedDiffSha256: createHash('sha256')
    .update(execFileSync('git', ['diff', 'HEAD'], { cwd: root }))
    .digest('hex'),
  driverSha256: createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  phases: {},
  failures: [],
};
const durationMs = 1500;
const inputHz = 60;
const count = Math.round((durationMs * inputHz) / 1000);
let initialSize;
let dragging = false;
let adjacentFixture;

async function runPhase(label, sendInput) {
  const output = path.join(out, label);
  await mkdir(output);
  const cdp = await page.context().newCDPSession(page);
  const trace = createPileupNativeTrace({ output, refreshHz: 60 });
  const frames = [];
  const writes = [];
  if (values.video) {
    cdp.on('Page.screencastFrame', (event) => {
      const name = `frame-${String(frames.length).padStart(4, '0')}.jpg`;
      frames.push({ name, time: event.metadata.timestamp });
      writes.push(writeFile(path.join(output, name), Buffer.from(event.data, 'base64')));
      void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  } else await trace.beginJourney({ page, cdp });
  if (values.profile) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  const token = !values.video && (await trace.start({ label, page, cdp }));
  const first = values.video
    ? null
    : await page.evaluate(() => {
        const pane = document.querySelector('[data-testid="sequence-minimap"]');
        const wrap = document.querySelector('[data-testid="sequence-scroll-container"]');
        const observer = new ResizeObserver(() => {
          const mapper = window.__webglRenderer?.getCurrentPathMapper();
          const length = window.__webglGenome?.length;
          const host = pane.querySelector('canvas');
          if (mapper && length && host) {
            const midpoint = (mapper.backboneAt(0).y + mapper.backboneAt(length / 2).y) / 2;
            const rect = pane.getBoundingClientRect();
            window.__resizeCenters.push([
              performance.timeOrigin + performance.now(),
              midpoint + host.getBoundingClientRect().top - rect.top - rect.height / 2,
            ]);
          }
          window.__resizeObservations.push([
            performance.timeOrigin + performance.now(),
            pane.clientWidth,
            pane.clientHeight,
            wrap.clientWidth,
            wrap.clientHeight,
          ]);
        });
        window.__resizeObservations = [];
        window.__resizeCenters = [];
        window.__resizeObserver = observer;
        observer.observe(pane);
        observer.observe(wrap);
        return window.__sequenceViewerDiagnostics.layoutGeometry().summary.cpr;
      });
  const start = performance.now();
  const inputStartEpochMs = performance.timeOrigin + start;
  const requests = [];
  for (let i = 1; i <= count; i++) {
    await sleep(Math.max(0, start + (i * durationMs) / count - performance.now()));
    requests.push(sendInput(i / count));
  }
  const inputEndEpochMs = performance.timeOrigin + performance.now();
  await Promise.all(requests);
  if (values.video) {
    await cdp.send('Page.stopScreencast');
    await Promise.all(writes);
    await writeFile(path.join(output, 'frames.json'), JSON.stringify(frames));
    await writeFile(
      path.join(output, 'video.ffconcat'),
      'ffconcat version 1.0\n' +
        frames
          .map(
            (f, i) =>
              `file ${f.name}\nduration ${Math.max(0.001, (frames[i + 1]?.time ?? f.time + 1 / 60) - f.time)}`
          )
          .join('\n')
    );
    assert.ok(frames.length > 1, 'No resize motion captured');
    await cdp.detach();
    return;
  }
  await trace.stop({
    label,
    token,
    page,
    cdp,
    inputStartEpochMs,
    inputEndEpochMs,
    cadence: { durationMs },
  });
  if (values.profile)
    await writeFile(
      path.join(output, 'renderer.cpuprofile'),
      JSON.stringify((await cdp.send('Profiler.stop')).profile)
    );
  await trace.finishJourney({ page, cdp });
  const geometry = await page.evaluate(() => {
    window.__resizeObserver.disconnect();
    const samples = window.__resizeObservations;
    const centers = window.__resizeCenters;
    delete window.__resizeCenters;
    delete window.__resizeObserver;
    delete window.__resizeObservations;
    const pane = document.querySelector('[data-testid="sequence-minimap"]').getBoundingClientRect();
    const canvas = document
      .querySelector('[data-testid="webgl-render-host"] canvas')
      .getBoundingClientRect();
    const mapper = window.__webglRenderer.getCurrentPathMapper();
    const ys = Array.from(
      { length: 128 },
      (_, i) => mapper.backboneAt((i * window.__webglGenome.length) / 128).y
    );
    return {
      samples,
      centers,
      wrap: window.__sequenceViewerDiagnostics.layoutGeometry().summary.cpr,
      widthError: Math.abs(canvas.width - pane.width),
      heightError: Math.abs(canvas.height - pane.height),
      centerError: Math.abs(
        (Math.max(...ys) + Math.min(...ys)) / 2 + canvas.top - pane.top - pane.height / 2
      ),
    };
  });
  const {
    parsed,
    result,
    scoringWindowTraceTimestampsUs: bounds,
  } = JSON.parse(await readFile(path.join(output, `${label}.presentation.json`), 'utf8'));
  const native =
    parsed.presentation?.nativeTimestampsUs?.filter((t) => t >= bounds.start && t <= bounds.end) ??
    [];
  const intervals = native
    .slice(1)
    .map((t, i) => (t - native[i]) / 1000)
    .sort((a, b) => a - b);
  const completeFrames = [
    ...new Set(
      parsed.pipeline.reporters
        .filter(
          ({ state, hasMissingContent, endTraceTimestampUs }) =>
            state === 'PRESENTED_ALL' &&
            !hasMissingContent &&
            endTraceTimestampUs >= bounds.start &&
            endTraceTimestampUs <= bounds.end
        )
        .map(({ endTraceTimestampUs }) => endTraceTimestampUs)
    ),
  ].sort((a, b) => a - b);
  const completeIntervalsMs = completeFrames
    .slice(1)
    .map((time, i) => (time - completeFrames[i]) / 1000);
  const expected = Math.round(((inputEndEpochMs - inputStartEpochMs) * 60) / 1000);
  geometry.samples = geometry.samples.filter(
    ([t]) => t >= inputStartEpochMs && t <= inputEndEpochMs
  );
  geometry.centers = geometry.centers.filter(
    ([time]) => time >= inputStartEpochMs && time <= inputEndEpochMs
  );
  const phase = {
    inputCount: count,
    requestedInputHz: inputHz,
    observedRefreshHz: (result.refreshOutcomeCount * 1000) / result.traceBoundaryDurationMs,
    completeRefreshes: result.presentedAllFrameCount,
    intentionalNoUpdate: result.intentionalNoUpdateFrameCount,
    inputDurationMs: inputEndEpochMs - inputStartEpochMs,
    firstWrap: first,
    ...geometry,
    liveCenterErrorMax: Math.max(...geometry.centers.map(([, offset]) => Math.abs(offset))),
    traceStatus: result.status,
    traceFailures: result.failures,
    distinctSizes: new Set(geometry.samples.map(([, ...size]) => size.join(','))).size,
    expected,
    presented: native.length,
    completePresentations: completeFrames.length,
    completeIntervalMaxMs: completeIntervalsMs.length ? Math.max(...completeIntervalsMs) : null,
    completeGapsOverBudget: completeIntervalsMs.filter((interval) => interval > 16.7).length,
    intervalP95Ms: intervals[Math.floor(intervals.length * 0.95)],
    intervalMaxMs: intervals.at(-1),
    dropped: result.droppedFrameCount,
    partial: result.partialFrameCount,
  };
  receipt.phases[label] = phase;
  if (
    result.status !== 'pass' ||
    native.length < expected - 1 ||
    phase.distinctSizes < expected - 1 ||
    phase.intervalMaxMs > 16.7 ||
    phase.completePresentations < expected - 1 ||
    phase.completeGapsOverBudget > 0 ||
    phase.widthError > 2 ||
    phase.heightError > 2 ||
    phase.centerError > 4 ||
    !geometry.centers.length ||
    phase.liveCenterErrorMax > 4 ||
    (!label.endsWith('height') && first === phase.wrap)
  )
    receipt.failures.push(label);
  console.log(
    label,
    JSON.stringify({ ...phase, samples: phase.samples.length, centers: phase.centers.length })
  );
  await cdp.detach();
}

try {
  assert.ok(page);
  const provenance = await page.evaluate(() => window.electronAPI.runtime.getProvenance());
  assert.equal(await realpath(provenance.projectRoot), root);
  assert.equal(await realpath(provenance.userDataPath), path.join(session, 'profile'));
  assert.ok(
    (await page.evaluate(() => window.__test.getWorkspaceRootPaths())).includes(
      path.join(session, 'workspace')
    )
  );
  receipt.display = await page.evaluate(() => ({
    devicePixelRatio,
    width: screen.width,
    height: screen.height,
  }));
  receipt.electronVersion = provenance.appVersion;
  initialSize = await page.evaluate(() => window.electronAPI.window.getSize());
  await page.evaluate(() => {
    window.__webglExposeForTests = true;
    window.__webglPreserveDrawingBufferForTests = false;
    window.__test.closeAllTabs();
  });
  const entry = await page.evaluate(
    (file) => '[data-testid="file-tree-item"][data-entry-path=' + CSS.escape(file) + ']',
    path.join(session, 'workspace', 'pUC19')
  );
  await page.locator(entry).dblclick();
  await expect(page.locator('[role=tab][data-tab-label=pUC19][aria-selected=true]')).toBeVisible();
  await page.getByTestId('sequence-renderer-visibility-map').click();
  await page.waitForFunction(() => window.__webglReady && window.__webglGenome?.length === 2686);
  await page.evaluate(() => window.electronAPI.window.setSize(1250, 820));
  const cdp = await page.context().newCDPSession(page);
  async function drag(label, divider, shiftX, shiftY) {
    await expect(divider).toBeVisible();
    const box = await divider.boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    dragging = true;
    await runPhase(label, (p) =>
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x + shiftX * p,
        y: y + shiftY * p,
        button: 'left',
        buttons: 1,
      })
    );
    await page.mouse.up();
    dragging = false;
  }
  for (const [axis, label, handle, shiftX, shiftY] of [
    ['vertical', 'pane-height', 'sequence-minimap-resize-handle', 0, -100],
    ['horizontal', 'pane-width', 'sequence-map-side-resize-handle', 140, 0],
  ]) {
    await page.getByTestId('sequence-map-placement-' + axis).click();
    const layout = page.getByTestId('sequence-map-surface-layout');
    await expect(layout).toHaveAttribute(
      'data-map-placement',
      axis === 'vertical' ? 'bottom' : 'right'
    );
    const pane = await layout.getByTestId('sequence-minimap').boundingBox();
    const area = await layout.boundingBox();
    const divider = layout.getByTestId(handle);
    const initial = await divider.boundingBox();
    await page.mouse.move(initial.x + initial.width / 2, initial.y + initial.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      initial.x + initial.width / 2 + (shiftX ? pane.width - area.width / 2 : 0),
      initial.y + initial.height / 2 + (shiftY ? pane.height - area.height / 2 : 0),
      { steps: 2 }
    );
    await page.mouse.up();
    await drag(label, divider, shiftX, shiftY);
  }
  await page.getByTestId('sequence-map-placement-vertical').click();
  await runPhase('native-window', (p) =>
    page.evaluate(
      ([w, h]) => window.electronAPI.window.setSize(w, h),
      [Math.round(1250 - p * 240), Math.round(820 - p * 150)]
    )
  );
  await page.evaluate(() => window.electronAPI.window.setSize(1400, 900));
  const filename = `adjacent-${crypto.randomUUID()}.html`;
  const file = path.join(session, 'workspace', filename);
  await writeFile(file, '<!doctype html><title>Sequence notes</title><h1>Sequence notes</h1>', {
    flag: 'wx',
  });
  adjacentFixture = file;
  await page.evaluate((filePath) => window.__test.openFile(filePath), file);
  const notes = page
    .getByTestId('html-viewer-iframe')
    .contentFrame()
    .getByRole('heading', { name: 'Sequence notes' });
  await expect(notes).toBeVisible();
  const sequenceTab = page.locator('[role=tab][data-tab-label=pUC19]');
  for (const [direction, axis, shiftX, shiftY] of [
    ['Right', 'width', 120, 0],
    ['Down', 'height', 0, -120],
  ]) {
    await sequenceTab.click({ button: 'right' });
    await page.getByText('Split ' + direction, { exact: true }).click();
    const divider = page.locator('[data-group][id^=group-] > [data-separator]').last();
    await expect(notes).toBeVisible();
    await drag('tab-' + axis, divider, shiftX, shiftY);
    await sequenceTab.click({ button: 'right' });
    await page.getByText('Join All Panes', { exact: true }).click();
  }
  await cdp.detach();
} catch (error) {
  receipt.failures.push(String(error.stack ?? error));
} finally {
  if (dragging) await page.mouse.up();
  if (adjacentFixture) await unlink(adjacentFixture);
  if (initialSize)
    await page.evaluate(
      ({ width, height }) => window.electronAPI.window.setSize(width, height),
      initialSize
    );
  await writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
if (receipt.failures.length) {
  console.error(receipt.failures);
  process.exitCode = 1;
}

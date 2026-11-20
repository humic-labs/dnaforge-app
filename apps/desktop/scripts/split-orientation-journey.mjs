import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({
  options: { session: { type: 'string' }, out: { type: 'string' }, first: { type: 'boolean' } },
});
const session = realpathSync(values.session);
const out = path.resolve(values.out);
assert.ok(!out.startsWith(root + path.sep) && out !== root);
mkdirSync(out, { recursive: true });
const settings = readFileSync(path.join(root, 'apps/desktop/.env.local'), 'utf8');
const port = (name) => Number(settings.match(new RegExp('^' + name + '=(\\d+)$', 'm'))[1]);
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port('DESKTOP_DEBUG_PORT'));
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((p) => new URL(p.url()).port === String(port('DESKTOP_DEV_PORT')));
const receipt = { switches: [], images: [], failures: [] };
async function paintedTracks(filename, bounds, viewportWidth) {
  const [x, y, width, height] = bounds.map(Math.floor);
  const { data, info } = await sharp(path.join(out, filename))
    .resize({ width: viewportWidth })
    .extract({ left: x + 12, top: y + 12, width: width - 24, height: height - 24 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  for (let i = 0; i < mask.length; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    mask[i] = Number(b - r > 48 && b - g > 20);
  }
  return mask;
}

function difference(a, b) {
  let changed = 0;
  let painted = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) painted++;
    if (a[i] !== b[i]) changed++;
  }
  return changed / Math.max(1, painted);
}

let cdp;
try {
  const source = await page.evaluate(() => window.electronAPI.runtime.getProvenance());
  assert.equal(realpathSync(source.projectRoot), root);
  assert.equal(realpathSync(source.userDataPath), path.join(session, 'profile'));
  receipt.version = source.appVersion;
  const workspace = path.join(session, 'workspace');
  const roots = await page.evaluate(() => window.__test.getWorkspaceRootPaths());
  assert.ok(roots.includes(workspace), 'Expected the disposable project in Files');
  await page.evaluate(() => {
    window.__test.closeAllTabs();
    window.__webglExposeForTests = true;
    window.__webglPreserveDrawingBufferForTests = false;
  });
  const entrySelector = await page.evaluate(
    (entryPath) => '[data-testid="file-tree-item"][data-entry-path=' + CSS.escape(entryPath) + ']',
    path.join(workspace, 'pUC19')
  );
  await page.locator(entrySelector).dblclick();
  await page.locator('[role="tab"][data-tab-label="pUC19"][aria-selected="true"]').waitFor();

  await page.getByTestId('sequence-renderer-visibility-map').click();
  await page.waitForFunction(() => window.__webglReady && window.__webglGenome?.length === 2686);
  cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (frame) => {
    const name = 'frame-' + String(receipt.images.length).padStart(4, '0') + '.png';
    writeFileSync(path.join(out, name), Buffer.from(frame.data, 'base64'));
    receipt.images.push({ name, time: frame.metadata.timestamp * 1000 });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  const layout = page.getByTestId('sequence-map-surface-layout');
  const controls = {
    map: 'sequence-renderer-visibility-map',
    sequence: 'sequence-renderer-visibility-sequence',
    horizontal: 'sequence-map-placement-horizontal',
    vertical: 'sequence-map-placement-vertical',
  };
  const nextMode = (mode, control) => {
    if (control === 'horizontal') return mode === 'right' ? 'left' : 'right';
    if (control === 'vertical') return mode === 'bottom' ? 'top' : 'bottom';
    return control;
  };
  const modes = ['map', 'sequence', 'bottom', 'top', 'right', 'left'];
  const remaining = new Set(
    modes.flatMap((mode) =>
      Object.keys(controls)
        .filter((control) => nextMode(mode, control) !== mode)
        .map((control) => mode + '/' + control)
    )
  );
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="sequence-renderer-visibility-map"]').dataset.active ===
      'true'
  );
  let mode = 'map';
  while (remaining.size) {
    const queue = [{ mode, path: [] }];
    const visited = new Set();
    let control;
    while (!control) {
      const current = queue.shift();
      assert.ok(current);
      if (visited.has(current.mode)) continue;
      visited.add(current.mode);
      for (const candidate of ['vertical', 'horizontal', 'sequence', 'map']) {
        const next = nextMode(current.mode, candidate);
        const path = [...current.path, candidate];
        if (remaining.has(current.mode + '/' + candidate)) {
          control = path[0];
          break;
        }
        if (!visited.has(next)) queue.push({ mode: next, path });
      }
    }
    remaining.delete(mode + '/' + control);
    const target = nextMode(mode, control);
    const name = String(receipt.switches.length).padStart(2, '0') + '-' + mode + '-' + target;
    const beforeFile = name + '-before.png';
    await page.screenshot({ path: path.join(out, beforeFile) });
    await page.evaluate(
      ({ button, target }) => {
        const byId = (id) => document.querySelector('[data-testid="' + id + '"]');
        const size = (element) => {
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return [box.x, box.y, box.width, box.height];
        };
        const measure = () => {
          const pane = byId('sequence-minimap');
          const host = byId('webgl-render-host');
          const mapCanvas = host?.querySelector('canvas');
          const wrapCanvas = byId('sequence-canvas-main');
          const state = window.__webglState;
          const mapper = window.__webglRenderer?.getCurrentPathMapper();
          const points = Array.from({ length: 128 }, (_, i) =>
            mapper?.backboneAt(((window.__webglGenome?.length ?? 0) * i) / 128)
          ).filter(Boolean);
          const xs = points.map((p) => p.x);
          const ys = points.map((p) => p.y);
          return {
            time: performance.timeOrigin + performance.now(),
            mode:
              byId('sequence-renderer-visibility-map').dataset.active === 'true'
                ? 'map'
                : byId('sequence-renderer-visibility-sequence').dataset.active === 'true'
                  ? 'sequence'
                  : byId('sequence-map-surface-layout').dataset.mapPlacement,
            wrapPane: size(byId('sequence-viewer-container')),
            wrapCanvas: size(wrapCanvas),
            wrapBitmap: wrapCanvas && [wrapCanvas.width, wrapCanvas.height],
            basesPerRow: window.__sequenceViewerDiagnostics?.layoutGeometry().summary.cpr ?? null,
            mapPane: size(pane),
            mapCanvas: size(mapCanvas),
            mapBitmap: mapCanvas && [mapCanvas.width, mapCanvas.height],
            renderSize: state && [state.width, state.height],
            backbone: points.length
              ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
              : null,
          };
        };
        const first = measure();
        const samples = [];
        const trace = { target, first, samples, inputTime: null, complete: false };
        window.__splitOrientationTrace = trace;
        byId(button).addEventListener(
          'click',
          () => {
            trace.inputTime = performance.timeOrigin + performance.now();
            function record() {
              samples.push(measure());
              if (samples.length < 20) requestAnimationFrame(record);
              else trace.complete = true;
            }
            requestAnimationFrame(record);
          },
          { capture: true, once: true }
        );
      },
      { button: controls[control], target }
    );
    await page.getByTestId(controls[control]).click();
    await page.waitForFunction(() => window.__splitOrientationTrace.complete);
    const trace = await page.evaluate(() => window.__splitOrientationTrace);
    receipt.switches.push(trace);
    const final = trace.samples.at(-1);
    assert.equal(final.mode, target);
    const frames = trace.samples;
    const activeKeys = ['wrapPane', 'mapPane'];
    if (target !== 'map') {
      assert.ok(final.basesPerRow > 0 && final.wrapCanvas, 'Expected wrapped sequence canvas');
      activeKeys.push('wrapCanvas', 'wrapBitmap', 'basesPerRow');
    }
    if (target !== 'sequence') {
      assert.ok(final.mapCanvas && final.backbone?.length === 4, 'Expected map backbone');
      activeKeys.push('mapCanvas', 'mapBitmap', 'renderSize', 'backbone');
    }
    trace.sourceMode = mode;
    for (const key of activeKeys) {
      const reference = [].concat(final[key]);
      const mismatch = frames.find((sample) => {
        const current = [].concat(sample[key]);
        return (
          current.length !== reference.length ||
          current.some(
            (v, i) => Math.abs(v - reference[i]) > 1 || (v === null) !== (reference[i] === null)
          )
        );
      });
      if (mismatch)
        receipt.failures.push({
          target,
          key,
          msAfterClick: mismatch.time - trace.inputTime,
          actual: mismatch[key],
          expected: final[key],
        });
    }
    const afterFile = name + '-after.png';
    await page.screenshot({ path: path.join(out, afterFile) });
    const viewportWidth = await page.evaluate(() => innerWidth);
    const box = await layout.boundingBox();
    const bounds = [box.x, box.y, box.width, box.height];
    const before = await paintedTracks(beforeFile, bounds, viewportWidth);
    const after = await paintedTracks(afterFile, bounds, viewportWidth);
    assert.ok(after.reduce((a, b) => a + b, 0) > 100, 'Expected painted pUC19 map annotations');
    const images = receipt.images.filter((image) => image.time >= trace.inputTime);
    trace.presentations = [];
    let switched = false;
    for (const image of images) {
      const mask = await paintedTracks(image.name, bounds, viewportWidth);
      const from = difference(mask, before);
      const to = difference(mask, after);
      trace.presentations.push({
        image: image.name,
        msAfterClick: image.time - trace.inputTime,
        from,
        to,
      });
      if (!switched && from < 0.12) continue;
      if (!switched) trace.firstChangedPresentationMs = image.time - trace.inputTime;
      switched = true;
      if (to <= 0.12) trace.firstCorrectPresentationMs ??= image.time - trace.inputTime;
      if (to > 0.12) {
        receipt.failures.push({
          target,
          image: image.name,
          msAfterClick: image.time - trace.inputTime,
          changedTrackFraction: to,
        });
      }
    }
    if (!switched)
      receipt.failures.push({ source: mode, target, error: 'Missing changed presentation' });
    console.log(
      name,
      JSON.stringify({
        issues: receipt.failures.length,
        latencyMs: trace.firstCorrectPresentationMs,
      })
    );
    mode = target;
    if (values.first) break;
  }
  assert.deepEqual(receipt.failures, []);
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  if (cdp) await cdp.send('Page.stopScreencast');
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(receipt.error?.slice(0, 900) ?? 'All composition controls passed');
  await browser.close();
}

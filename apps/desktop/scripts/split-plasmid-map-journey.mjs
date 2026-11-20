import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({ options: { session: { type: 'string' }, out: { type: 'string' } } });
const session = realpathSync(values.session);
const out = path.resolve(values.out);
assert.ok(out !== root && !out.startsWith(root + path.sep), 'Keep captures outside the checkout');
mkdirSync(out);
const settings = readFileSync(path.join(root, 'apps/desktop/.env.local'), 'utf8');
const port = (key) => Number(settings.match(new RegExp('^' + key + '=(\\d+)$', 'm'))?.[1]);
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port('DESKTOP_DEBUG_PORT'));
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url() === 'http://127.0.0.1:' + port('DESKTOP_DEV_PORT') + '/');
const receipt = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  observations: [],
  failures: [],
};
let originalSize;
let dragging = false;

function measure() {
  const byId = (id) => document.querySelector('[data-testid="' + id + '"]');
  const pane = byId('sequence-minimap').getBoundingClientRect();
  const upper = document
    .querySelector('[data-sequence-map-surface="sequence"]')
    .getBoundingClientRect();
  const host = byId('webgl-render-host');
  const canvas = host.querySelector('canvas').getBoundingClientRect();
  const mapper = window.__webglRenderer.getCurrentPathMapper();
  const points = Array.from({ length: 512 }, (_, i) =>
    mapper.backboneAt((window.__webglGenome.length * i) / 512)
  );
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    sequenceWidth: upper.width,
    sequenceBottom: upper.bottom,
    paneTop: pane.top,
    width: pane.width,
    height: pane.height,
    hostWidth: host.clientWidth,
    hostHeight: host.clientHeight,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    centerY: canvas.top - pane.top + (Math.min(...ys) + Math.max(...ys)) / 2,
    stadiumWidth: Math.max(...xs) - Math.min(...xs),
    morph: window.__webglState.morph,
    bases: window.__webglGenome.length,
  };
}

async function capture(name) {
  let result;
  let previous;
  let stableSince;
  await expect
    .poll(
      async () => {
        result = await page.evaluate(measure);
        const current = JSON.stringify(result);
        if (previous !== current) stableSince = Date.now();
        previous = current;
        return Date.now() - stableSince;
      },
      { intervals: [40], timeout: 5000 }
    )
    .toBeGreaterThan(180);
  await page.screenshot({ path: path.join(out, name + '.png') });
  receipt.observations.push({ name, ...result });
  assert.equal(result.bases, 2686);
  assert.equal(result.morph, 0);
  assert.ok(Math.abs(result.sequenceBottom - result.paneTop) < 10, 'Expected stacked panes');
  for (const key of ['width', 'canvasWidth', 'hostWidth']) {
    if (Math.abs(result[key] - result.sequenceWidth) > 2)
      receipt.failures.push(
        name + ': ' + key + ' ' + result[key] + ' vs sequence width ' + result.sequenceWidth
      );
  }
  for (const key of ['canvasHeight', 'hostHeight']) {
    if (Math.abs(result[key] - result.height) > 2)
      receipt.failures.push(
        name + ': ' + key + ' ' + result[key] + ' vs pane height ' + result.height
      );
  }
  if (Math.abs(result.centerY - result.height / 2) > 4)
    receipt.failures.push(
      name + ': stadium center ' + result.centerY + ' vs pane center ' + result.height / 2
    );
  return result;
}

async function resize(width, height) {
  await page.evaluate(([w, h]) => window.electronAPI.window.setSize(w, h), [width, height]);
  await expect
    .poll(() => page.evaluate(() => window.electronAPI.window.getSize()))
    .toEqual({ width, height });
}

try {
  assert.ok(page, 'Expected the configured native renderer');
  const provenance = await page.evaluate(() => window.electronAPI.runtime.getProvenance());
  assert.equal(realpathSync(provenance.projectRoot), root);
  assert.equal(realpathSync(provenance.userDataPath), path.join(session, 'profile'));
  const workspace = path.join(session, 'workspace');
  const roots = await page.evaluate(() => window.__test.getWorkspaceRootPaths());
  assert.ok(roots.includes(workspace), 'Expected this session’s workspace to be open');
  receipt.runtime = { appVersion: provenance.appVersion, rendererPort: provenance.desktopDevPort };
  originalSize = await page.evaluate(() => window.electronAPI.window.getSize());
  await resize(1200, 800);
  const name = 'plasmid-' + randomUUID();
  copyFileSync(
    path.join(root, 'test-fixtures/sequences/circular/pUC19.gb'),
    path.join(workspace, name + '.gb')
  );
  await page.evaluate(() => {
    window.__webglExposeForTests = true;
  });
  await page.locator('[data-testid="file-tree-item"][data-entry-name="' + name + '"]').dblclick();
  await page.getByTestId('sequence-map-placement-vertical').click();
  await expect(page.getByTestId('sequence-map-topology-slider')).toHaveAttribute(
    'aria-valuetext',
    'Stadium map'
  );
  await page.waitForFunction(
    () => window.__webglReady && window.__webglRenderer?.getCurrentPathMapper()
  );
  const initial = await capture('initial');
  const divider = await page.getByTestId('sequence-minimap-resize-handle').boundingBox();
  const x = divider.x + divider.width / 2;
  const y = divider.y + divider.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  dragging = true;
  await page.mouse.move(x, y + initial.height - 220, { steps: 12 });
  const held = await capture('dragging');
  assert.ok(Math.abs(held.height - 220) <= 2, 'Divider must move to the short-pane height');
  await page.mouse.up();
  dragging = false;
  await capture('released');
  await resize(1000, 800);
  const narrow = await capture('narrow');
  await resize(1380, 800);
  const wide = await capture('wide');
  assert.ok(
    wide.sequenceWidth - narrow.sequenceWidth > 300,
    'Native resize must change the split width'
  );
  if (wide.stadiumWidth - narrow.stadiumWidth < 0.65 * (wide.sequenceWidth - narrow.sequenceWidth))
    receipt.failures.push('Painted stadium span failed to follow the resized pane');
  assert.deepEqual(receipt.failures, []);
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  try {
    if (dragging) await page.mouse.up();
    if (originalSize) await resize(originalSize.width, originalSize.height);
  } finally {
    writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    console.log(receipt.error ?? 'Split map resize passed');
    await browser.close();
  }
}

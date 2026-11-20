import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { values } = parseArgs({ options: { session: { type: 'string' }, out: { type: 'string' } } });
const session = realpathSync(values.session);
const out = path.resolve(values.out);
assert(!out.startsWith(root + path.sep) && out !== root);
mkdirSync(out, { recursive: true });
const settings = readFileSync(path.join(root, 'apps/desktop/.env.local'), 'utf8');
const port = (name) => Number(settings.match(new RegExp('^' + name + '=(\\d+)$', 'm'))[1]);
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port('DESKTOP_DEBUG_PORT'));
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => new URL(candidate.url()).port === String(port('DESKTOP_DEV_PORT')));
const report = { frames: [], measurements: [], failures: [] };
const png = (name) => path.join(out, name);

async function pixels(name, width) {
  return sharp(png(name)).resize({ width }).removeAlpha().raw().toBuffer();
}

function baseInk(data, index) {
  const [r, g, b] = data.subarray(index, index + 3);
  return Math.max(r, g, b) < 150 && Math.max(r, g, b) - Math.min(r, g, b) < 28;
}

function baseRows(data, width, rect) {
  const pixels = [];
  for (let y = Math.ceil(rect.y + 48); y < Math.floor(rect.y + rect.height - 8); y++) {
    const row = [];
    let runs = 0,
      last = false;
    for (let x = Math.ceil(rect.x + 45); x < Math.floor(rect.x + rect.width - 12); x++) {
      const offset = 3 * (y * width + x);
      const ink = baseInk(data, offset);
      if (ink) row.push(offset);
      if (ink && !last) runs++;
      last = ink;
    }
    if (runs >= 24) pixels.push(...row);
  }
  return pixels;
}

function circle(data, width, pane, ring) {
  const columns = new Map();
  for (let y = Math.ceil(pane.y + 50); y < Math.floor(pane.y + pane.height - 48); y++) {
    for (let x = Math.ceil(pane.x + 1); x < Math.floor(pane.x + pane.width - 1); x++) {
      const i = 3 * (y * width + x);
      if (ring.every((value, channel) => Math.abs(data[i + channel] - value) <= 3))
        columns.set(x, (columns.get(x) ?? 0) + 1);
    }
  }
  const xs = [...columns.keys()].filter((x) => columns.get(x) >= 4);
  if (xs.length < 12) return null;
  const left = Math.min(...xs),
    right = Math.max(...xs);
  return { left, right, center: (left + right) / 2 };
}

let cdp;
try {
  const provenance = await page.evaluate(() => window.electronAPI.runtime.getProvenance());
  assert.equal(realpathSync(provenance.projectRoot), root);
  assert.equal(realpathSync(provenance.userDataPath), path.join(session, 'profile'));
  report.provenance = provenance;
  const entry = page.locator(
    '[data-testid=file-tree-item][data-entry-path=' +
      JSON.stringify(path.join(session, 'workspace', 'pUC19')) +
      ']'
  );
  const map = page.getByTestId('sequence-renderer-visibility-map');
  await page.evaluate(() => {
    window.__test.closeAllTabs();
    delete window.__webglExposeForTests;
    delete window.__webglPreserveDrawingBufferForTests;
  });
  if (!(await entry.isVisible())) await page.getByTestId('files-button').click();
  await entry.dblclick();
  await map.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid=sequence-renderer-visibility-map]')?.dataset.active ===
      'true'
  );
  await page.waitForTimeout(550);
  await page.screenshot({ path: png('map-only.png') });
  cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (f) => {
    const name = 'frame-' + String(report.frames.length).padStart(4, '0') + '.png';
    writeFileSync(png(name), Buffer.from(f.data, 'base64'));
    report.frames.push({ name, time: f.metadata.timestamp * 1000 });
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.evaluate(() => window.__test.closeAllTabs());
  await page.getByTestId('sequence-map-surface-layout').waitFor({ state: 'detached' });
  await entry.dblclick();
  await page.getByTestId('webgl-render-host').locator('canvas').waitFor();
  assert.equal(await map.getAttribute('data-active'), 'true');
  const button = page.getByTestId('sequence-map-placement-horizontal');
  await button.evaluate((el) => {
    window.__coldSplitInput = {};
    for (const type of ['pointerdown', 'click'])
      el.addEventListener(
        type,
        (e) => {
          window.__coldSplitInput[type] = performance.timeOrigin + e.timeStamp;
        },
        { capture: true, once: true }
      );
  });
  const box = await button.boundingBox();
  assert(box);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(400);
  const layout = page.getByTestId('sequence-map-surface-layout');
  assert.equal(await layout.getAttribute('data-map-placement'), 'right');
  await page.screenshot({ path: png('side-by-side.png') });
  report.input = await page.evaluate(() => window.__coldSplitInput);
  const width = await page.evaluate(() => innerWidth);
  const pane = await page.getByTestId('sequence-minimap').boundingBox();
  const wrap = await page.getByTestId('sequence-viewer-container').boundingBox();
  report.panes = { map: pane, wrap };
  const final = await pixels('side-by-side.png', width);
  const text = baseRows(final, width, wrap);
  assert(text.length >= 500, 'Expected individually visible wrapped base glyphs');
  const ring = [171, 177, 187];
  const settled = circle(final, width, pane, ring);
  assert(settled, 'Expected a visible gray pUC19 source ring');
  const center = pane.x + pane.width / 2;
  assert(Math.abs(settled.center - center) <= 2, 'Settled circle is off center');
  const before = await pixels('map-only.png', width);
  const firstComposed = (data) => text.filter((i) => baseInk(data, i)).length / text.length;
  assert(firstComposed(before) < 0.1, 'Map-only screenshot already contains the wrapped base rows');
  for (const frame of report.frames
    .filter((f) => f.time >= report.input.pointerdown)
    .sort((a, b) => a.time - b.time)) {
    const data = await pixels(frame.name, width);
    const rowCoverage = firstComposed(data);
    const painted = circle(data, width, pane, ring);
    const xError = painted ? painted.center - center : null;
    const circleReady =
      painted !== null &&
      Math.abs(xError) <= 2 &&
      Math.abs(painted.right - painted.left - (settled.right - settled.left)) <= 3;
    report.measurements.push({
      frame: frame.name,
      afterPointerDownMs: frame.time - report.input.pointerdown,
      afterClickMs: frame.time - report.input.click,
      rowCoverage,
      circle: painted,
      xError,
      circleReady,
    });
  }
  const afterClick = report.measurements.filter((f) => f.afterClickMs >= 0);
  for (const [key, ok] of [
    ['bases', (f) => f.rowCoverage >= 0.9],
    ['circle', (f) => f.circleReady],
  ]) {
    const first = afterClick.find(ok);
    report[key] = {
      firstVisibleAfterPointerDownMs: first?.afterPointerDownMs ?? null,
      firstVisibleAfterClickMs: first?.afterClickMs ?? null,
    };
    if (!first || first.afterClickMs > 1000 / 60)
      report.failures.push(key + ' missing from the first 60 Hz interval after click');
  }
  const changed = afterClick.findIndex((f) => f.rowCoverage >= 0.15 || f.circleReady);
  if (changed < 0 || afterClick.slice(changed).some((f) => f.rowCoverage < 0.9 || !f.circleReady))
    report.failures.push('Incomplete composition after the first visible change');
  console.log(
    JSON.stringify({
      bases: report.bases,
      circle: report.circle,
      measurements: afterClick.slice(0, 6),
      failures: report.failures,
    })
  );
  assert.deepEqual(report.failures, []);
} catch (e) {
  report.error = e.message;
  process.exitCode = 1;
  console.error(e.message);
} finally {
  if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  writeFileSync(png('receipt.json'), JSON.stringify(report, null, 2));
  await browser.close();
}

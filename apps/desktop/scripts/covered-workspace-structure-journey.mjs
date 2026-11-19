import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : null;
assert.ok(out, 'Pass --out with an evidence directory outside the checkout.');
assert.ok(!out.startsWith(`${root}${path.sep}`), 'Keep evidence outside the checkout.');
const workspace = path.join(out, 'workspace');
mkdirSync(path.join(workspace, 'structures'), { recursive: true });
const fixture = path.join(root, 'test-fixtures/structure-complexes/rcsb/1A8O.cif');
copyFileSync(fixture, path.join(workspace, 'structures/covered.cif'));

const settings = Object.fromEntries(
  readFileSync(path.join(root, 'apps/desktop/.env.local'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => line.split('='))
);
const rendererPort = Number(settings.DESKTOP_DEV_PORT);
const debugPort = Number(settings.DESKTOP_DEBUG_PORT) || rendererPort + 7800;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith(`http://127.0.0.1:${rendererPort}/`));
assert.ok(page, `No renderer page on port ${rendererPort}.`);
const cdp = await page.context().newCDPSession(page);
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const receipt = { source: fixture, startedAt: new Date().toISOString(), steps: {} };
const capture = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  return `${name}.png`;
};
const show = async (testId) => {
  await page.click(`[data-testid="${testId}"]`);
  await page.waitForTimeout(800);
};
const tool = (name, input, context) =>
  page.evaluate(
    async ({ name, input, context }) =>
      (await import('/src/features/agent-bridge/structure-tools/index.ts'))[name](input, context),
    { name, input, context }
  );
const workspaceState = () =>
  page.evaluate(() => {
    const surface = document.querySelector('[data-testid="explorer-workspace-surface"]');
    const canvases = [...(surface?.querySelectorAll('canvas') ?? [])];
    return {
      covered: surface?.style.contentVisibility === 'hidden',
      paintedCanvases: canvases.filter((canvas) => canvas.checkVisibility()).length,
      largestCanvasWidth: Math.max(0, ...canvases.map((canvas) => canvas.width)),
      visibility: document.visibilityState,
    };
  });
const listed = async (structureViewId) =>
  (await tool('handleMolListStructures')).structures.find(
    (structure) => structure.structureViewId === structureViewId
  );
const agentImage = async (structureViewId, name) => {
  const shot = await tool('handleMolCaptureScreenshot', { structureViewId });
  assert.equal(shot.ok, true, `${name}: ${JSON.stringify(shot.error ?? shot)}`);
  const bytes = Buffer.from(shot.data, 'base64');
  writeFileSync(path.join(out, `${name}.png`), bytes);
  return {
    file: `${name}.png`,
    width: shot.width,
    height: shot.height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};

await show('home-button');
const coveredBefore = await workspaceState();
assert.equal(coveredBefore.covered, true, 'Home must cover the workspace.');
receipt.steps.home = { ...coveredBefore, capture: await capture('home-before-open') };

const opened = await tool(
  'handleMolOpenTab',
  {
    structure: { kind: 'file', path: 'structures/covered.cif' },
    label: 'Covered workspace structure',
  },
  { folders: [{ name: 'journey', path: workspace }] }
);
assert.equal(opened.ok, true, JSON.stringify(opened));
const { structureViewId } = opened;
const openedAt = Date.now();
let ready = await listed(structureViewId);
while (ready?.viewerStatus !== 'active' && Date.now() - openedAt < 10_000) {
  await page.waitForTimeout(250);
  ready = await listed(structureViewId);
}
assert.equal(
  ready?.viewerStatus,
  'active',
  `Viewer did not start while covered: ${JSON.stringify(ready ?? null)}`
);
receipt.steps.ready = {
  structureViewId,
  secondsToActive: (Date.now() - openedAt) / 1000,
  chains: ready.chains.length,
};

const scene = await tool('handleMolGetScene', { structureViewId });
assert.notEqual(scene.ok, false, JSON.stringify(scene.error ?? scene));
const beforeEdit = await agentImage(structureViewId, 'agent-covered-before-edit');
const recolor = await tool('handleMolSetColor', { structureViewId, colorMode: 'element' });
assert.notEqual(recolor.ok, false, JSON.stringify(recolor.error ?? recolor));
await page.waitForTimeout(1000);
const afterEdit = await agentImage(structureViewId, 'agent-covered-after-edit');
assert.notEqual(
  beforeEdit.sha256,
  afterEdit.sha256,
  'The agent edit must change the rendered image.'
);
const camera = (await listed(structureViewId)).camera;
receipt.steps.agentWorkWhileCovered = { beforeEdit, afterEdit };

for (const view of ['home-button', 'reference-picker-open', 'settings-button']) {
  await show(view);
  const state = await workspaceState();
  assert.equal(state.covered, true, `${view} must cover the workspace.`);
  assert.equal(state.paintedCanvases, 0, `${view} must not paint the structure.`);
  receipt.steps[view] = { ...state, capture: await capture(`${view}-while-structure-runs`) };
}

await show('files-button');
const shown = await workspaceState();
const returned = await listed(structureViewId);
assert.equal(shown.covered, false);
assert.ok(
  shown.paintedCanvases > 0 && shown.largestCanvasWidth > 0,
  'Files must paint the structure.'
);
assert.equal(returned?.viewerStatus, 'active');
assert.deepEqual(returned.camera, camera, 'Returning to Files must keep the camera.');
receipt.steps.files = { ...shown, capture: await capture('files-after-return') };

assert.deepEqual(pageErrors, []);
receipt.finishedAt = new Date().toISOString();
receipt.passed = true;
writeFileSync(path.join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(
  JSON.stringify({ passed: true, secondsToActive: receipt.steps.ready.secondsToActive, out })
);
await browser.close();

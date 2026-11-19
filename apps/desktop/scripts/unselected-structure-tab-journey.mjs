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
const fixtures = {
  background: '1A8O.cif',
  selected: '1EHZ.cif',
  third: '1FS0.cif',
  fourth: '6MX1.cif',
};
for (const [name, file] of Object.entries(fixtures))
  copyFileSync(
    path.join(root, 'test-fixtures/structure-complexes/rcsb', file),
    path.join(workspace, `structures/${name}.cif`)
  );
const folders = [{ name: 'journey', path: workspace }];

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

const receipt = { fixtures, startedAt: new Date().toISOString(), steps: {} };
const capture = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  return `${name}.png`;
};
const tool = (name, input, context) =>
  page.evaluate(
    async ({ name, input, context }) =>
      (await import('/src/features/agent-bridge/structure-tools/index.ts'))[name](input, context),
    { name, input, context }
  );
const listed = async (structureViewId) =>
  (await tool('handleMolListStructures')).structures.find(
    (structure) => structure.structureViewId === structureViewId
  );
const stateOf = async (structureViewId) =>
  (await tool('handleMolGetState', { structureViewId })).structures?.find(
    (structure) => structure.structureViewId === structureViewId
  );
const personView = () =>
  page.evaluate(async () => {
    const { useCanvasStore } = await import('/src/features/canvas/store.ts');
    const panels = Object.values(useCanvasStore.getState().panels);
    const stage = document.querySelector('[data-testid="agent-structure-stage"]');
    return {
      selectedTabs: panels.map((panel) => panel.activeTabId),
      selectedLabels: panels.map(
        (panel) => panel.tabs.find((tab) => tab.id === panel.activeTabId)?.label ?? null
      ),
      backgroundHosts: stage?.childElementCount ?? 0,
      backgroundCanvases: stage?.querySelectorAll('canvas').length ?? 0,
      stageOpacity: stage ? getComputedStyle(stage).opacity : null,
    };
  });
const open = async (name, label) => {
  const opened = await tool(
    'handleMolOpenTab',
    { structure: { kind: 'file', path: `structures/${name}.cif` }, label },
    { folders }
  );
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const startedAt = Date.now();
  let entry = await listed(opened.structureViewId);
  while (entry?.viewerStatus !== 'active' && Date.now() - startedAt < 20_000) {
    await page.waitForTimeout(250);
    entry = await listed(opened.structureViewId);
  }
  assert.equal(entry?.viewerStatus, 'active', `${label} did not open: ${JSON.stringify(entry)}`);
  return opened.structureViewId;
};
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
const succeeded = (result, label) => {
  assert.notEqual(result.ok, false, `${label}: ${JSON.stringify(result.error ?? result)}`);
  return true;
};

await page.click('[data-testid="files-button"]');
await page.waitForTimeout(600);
const background = await open('background', 'Background structure');
const selected = await open('selected', 'Selected structure');
const before = await personView();
assert.deepEqual(before.selectedLabels.includes('Selected structure'), true);
assert.equal(before.backgroundHosts, 0);
const {
  structures: [detail],
} = await tool('handleMolGetState', { structureViewId: background, detail: 'full' });
const waiting = {
  viewerStatus: detail?.viewerStatus,
  inactiveReason: detail?.inactiveReason,
  reactivation: detail?.reactivation,
};
receipt.steps.opened = { background, selected, before, waiting, capture: await capture('opened') };

const startedAt = Date.now();
const scene = await tool('handleMolGetScene', { structureViewId: background });
succeeded(scene, 'mol_get_scene on the unselected tab');
const secondsToBackgroundScene = (Date.now() - startedAt) / 1000;
assert.equal(waiting.viewerStatus, 'inactive');
assert.match(waiting.inactiveReason ?? '', /background/u);
assert.equal(waiting.reactivation, undefined, 'Agents must not be told to switch the tab.');
const beforeEdit = await agentImage(background, 'agent-background-before-edit');
succeeded(
  await tool('handleMolSetColor', { structureViewId: background, colorMode: 'element' }),
  'mol_set_color'
);
await page.waitForTimeout(1000);
succeeded(
  await tool('handleMolSelectResidues', {
    structureViewId: background,
    selection: 'chain A and name CA',
  }),
  'mol_select_residues'
);
succeeded(
  await tool('handleMolFocus', {
    structureViewId: background,
    selection: 'chain A and name CA',
  }),
  'mol_focus'
);
await page.waitForTimeout(600);
const afterEdit = await agentImage(background, 'agent-background-after-edit');
assert.notEqual(beforeEdit.sha256, afterEdit.sha256, 'The agent edit must change the image.');
const backgroundState = await stateOf(background);
assert.equal(backgroundState?.viewerStatus, 'active');
assert.ok(backgroundState.chainCount > 0);
const during = await personView();
assert.deepEqual(during.selectedTabs, before.selectedTabs, 'The selected tab must not change.');
assert.equal(during.backgroundHosts, 1);
assert.equal(during.stageOpacity, '0');
receipt.steps.agentWorkOnUnselectedTab = {
  secondsToBackgroundScene,
  beforeEdit,
  afterEdit,
  chainCount: backgroundState.chainCount,
  colorMode: backgroundState.colorMode,
  during,
  capture: await capture('person-view-during-agent-work'),
};

const backgroundTabId = await page.evaluate(async (label) => {
  const { useCanvasStore } = await import('/src/features/canvas/store.ts');
  return Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((tab) => tab.label === label)?.id;
}, 'Background structure');
await page.click(`[data-testid="tab-${backgroundTabId}"]`);
await page.waitForTimeout(800);
let shown = await listed(background);
for (let i = 0; shown?.viewerStatus !== 'active' && i < 60; i += 1) {
  await page.waitForTimeout(250);
  shown = await listed(background);
}
const afterSelect = await personView();
assert.ok(afterSelect.selectedLabels.includes('Background structure'));
assert.equal(shown?.viewerStatus, 'active');
assert.equal((await stateOf(background))?.colorMode, 'element', 'The agent edit must persist.');
receipt.steps.personSelectsEditedTab = {
  afterSelect,
  capture: await capture('person-selects-background'),
};

const third = await open('third', 'Third structure');
const fourth = await open('fourth', 'Fourth structure');
const budget = [];
for (const [label, id] of [
  ['background', background],
  ['selected', selected],
  ['third', third],
]) {
  const image = await agentImage(id, `agent-budget-${label}`);
  const view = await personView();
  assert.ok(view.backgroundHosts <= 2, `At most two background renderers: ${view.backgroundHosts}`);
  assert.deepEqual(view.selectedLabels.includes('Fourth structure'), true);
  budget.push({ label, image, backgroundHosts: view.backgroundHosts });
}
receipt.steps.budget = { fourth, budget };

const parallelTargets = { background, selected, third };
const parallel = await Promise.all(
  Object.entries(parallelTargets).flatMap(([label, id]) => [
    tool('handleMolGetScene', { structureViewId: id }).then((result) => ({ label, id, result })),
    tool('handleMolCaptureScreenshot', { structureViewId: id }).then((result) => ({
      label,
      id,
      result,
    })),
  ])
);
for (const { label, id, result } of parallel) {
  succeeded(result, `parallel command on ${label}`);
  if (result.structureViewId)
    assert.equal(result.structureViewId, id, `${label} answered for ${id}`);
}
const afterParallel = await personView();
assert.ok(afterParallel.backgroundHosts <= 2, 'Parallel work keeps at most two renderers.');
assert.ok(afterParallel.selectedLabels.includes('Fourth structure'));
receipt.steps.parallel = { calls: parallel.length, afterParallel };

await page.waitForTimeout(62_000);
const idle = await personView();
assert.equal(idle.backgroundHosts, 0, 'Idle background renderers must be released.');
receipt.steps.idleRelease = idle;

assert.deepEqual(pageErrors, []);
receipt.finishedAt = new Date().toISOString();
receipt.passed = true;
writeFileSync(path.join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, secondsToBackgroundScene, out }));
await browser.close();

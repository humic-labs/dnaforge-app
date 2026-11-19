import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : null;
assert.ok(out, 'Pass --out with an evidence directory outside the checkout.');
assert.ok(!out.startsWith(`${root}${path.sep}`), 'Keep evidence outside the checkout.');
mkdirSync(out, { recursive: true });

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

const receipt = { startedAt: new Date().toISOString(), steps: {} };
const capture = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(path.join(out, `${name}.png`), Buffer.from(data, 'base64'));
  return `${name}.png`;
};
const tool = (name, input, withContext = false) =>
  page.evaluate(
    async ({ name, input, withContext }) => {
      const tools = await import('/src/features/agent-bridge/structure-tools/index.ts');
      return withContext
        ? tools[name](input, { abortSignal: new AbortController().signal, folders: [] })
        : tools[name](input);
    },
    { name, input, withContext }
  );
const succeeded = (result, label) => {
  assert.notEqual(result.ok, false, `${label}: ${JSON.stringify(result.error ?? result)}`);
  return result;
};
const layout = () =>
  page.evaluate(async () => {
    const { useCanvasStore } = await import('/src/features/canvas/store.ts');
    const panels = Object.values(useCanvasStore.getState().panels);
    const inspectionTab = panels
      .flatMap((panel) => panel.tabs.map((tab) => ({ panel, tab })))
      .find(({ tab }) => tab.structureInspection);
    return {
      selectedTabs: panels.map((panel) => panel.activeTabId),
      inspectionPanelId: inspectionTab?.panel.id ?? null,
      inspectionTabId: inspectionTab?.tab.id ?? null,
      displayedView: inspectionTab?.tab.structureInspection?.viewSettings?.structureViewId ?? null,
    };
  });
const statusOf = async (structureViewId) =>
  (await tool('handleMolListStructures')).structures?.find(
    (structure) => structure.structureViewId === structureViewId
  )?.viewerStatus;
const detailOf = async (structureViewId) =>
  (await tool('handleMolGetState', { structureViewId, detail: 'full' })).structures?.[0];
const waitFor = async (predicate, label, ms = 90_000) => {
  const startedAt = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return { value, seconds: (Date.now() - startedAt) / 1000 };
    assert.ok(Date.now() - startedAt < ms, `${label} did not happen within ${ms / 1000} s.`);
    await page.waitForTimeout(500);
  }
};

await page.evaluate(() => window.__scenarios.applyDevScenarioPreset('structure-thrl'));
await page.waitForTimeout(4000);
const documentId = await page.evaluate(async () => {
  const { useCanvasStore } = await import('/src/features/canvas/store.ts');
  return Object.values(useCanvasStore.getState().panels)
    .flatMap((panel) => panel.tabs)
    .find((tab) => tab.type === 'sequence')?.entityId;
});
assert.ok(documentId, 'The thrL scenario did not open its sequence.');
const inspect = async (annotationIndex) => {
  succeeded(
    await tool('handleMolOpenDrawer', { documentId, annotationIndex }, true),
    'mol_open_drawer'
  );
  const opened = await waitFor(
    () =>
      page.evaluate(async () => {
        const { useStructureDrawerStore } =
          await import('/src/features/structure-drawer/state/use-structure-drawer-store.ts');
        const { openStructureInspection } =
          await import('/src/features/structure-drawer/structure-inspection.ts');
        const request = useStructureDrawerStore.getState().request;
        if (!request?.translation) return null;
        return { error: openStructureInspection(request) ?? null, cds: request.cdsLabel ?? null };
      }),
    'Opening the protein inspection'
  );
  assert.equal(opened.value.error, null, opened.value.error);
  const shown = await waitFor(async () => {
    const view = (await layout()).displayedView;
    return view && (await statusOf(view)) === 'active' ? view : null;
  }, 'The inspected protein becoming active');
  return { cds: opened.value.cds, structureViewId: shown.value, seconds: shown.seconds };
};

const first = await inspect(0);
receipt.steps.firstProtein = { ...first, capture: await capture('first-protein') };
const { inspectionPanelId } = await layout();
await page.evaluate(async (panelId) => {
  const { useCanvasStore } = await import('/src/features/canvas/store.ts');
  useCanvasStore.getState().openTab(panelId, {
    type: 'page',
    entityId: 'person-notes',
    label: 'Person notes',
  });
}, inspectionPanelId);
await page.waitForTimeout(800);
const beforeUnselected = await layout();
const unselectedDetail = await detailOf(first.structureViewId);
assert.equal(unselectedDetail.viewerStatus, 'inactive');
assert.match(unselectedDetail.inactiveReason ?? '', /background/u);
assert.equal(unselectedDetail.reactivation, undefined);
succeeded(await tool('handleMolGetScene', { structureViewId: first.structureViewId }), 'scene');
const unselectedShot = succeeded(
  await tool('handleMolCaptureScreenshot', { structureViewId: first.structureViewId }),
  'screenshot of the unselected inspection'
);
writeFileSync(
  path.join(out, 'agent-unselected-inspection.png'),
  Buffer.from(unselectedShot.data, 'base64')
);
assert.deepEqual((await layout()).selectedTabs, beforeUnselected.selectedTabs);
receipt.steps.unselectedInspection = {
  reason: unselectedDetail.inactiveReason,
  capture: await capture('inspection-unselected'),
};

await page.evaluate(async (panelId) => {
  const { useCanvasStore } = await import('/src/features/canvas/store.ts');
  const state = useCanvasStore.getState();
  const tab = state.panels[panelId].tabs.find((candidate) => candidate.structureInspection);
  state.setActiveTab(panelId, tab.id);
}, inspectionPanelId);
const second = await inspect(1);
assert.notEqual(second.structureViewId, first.structureViewId);
const beforeRetained = await layout();
const retainedDetail = await detailOf(first.structureViewId);
assert.match(retainedDetail.inactiveReason ?? '', /background/u);
const scene = succeeded(
  await tool('handleMolGetScene', { structureViewId: first.structureViewId, includeScene: true }),
  'scene of the retained protein'
);
const retainedShot = succeeded(
  await tool('handleMolCaptureScreenshot', { structureViewId: first.structureViewId }),
  'screenshot of the retained protein'
);
writeFileSync(
  path.join(out, 'agent-retained-protein.png'),
  Buffer.from(retainedShot.data, 'base64')
);
const edited = JSON.parse(scene.scene);
edited.metadata = { ...(edited.metadata ?? {}), title: 'Edited while retained' };
const recolor = (node) => {
  if (node.kind === 'color' && node.params?.color === '#3388ff') node.params.color = '#d1495b';
  (node.children ?? []).forEach(recolor);
};
recolor(edited.root);
succeeded(
  await tool('handleMolApplyScene', {
    structureViewId: first.structureViewId,
    scene: JSON.stringify(edited),
    expectedSceneSha256: scene.sceneSha256,
  }),
  'scene edit on the retained protein'
);
const afterEdit = await tool('handleMolGetScene', { structureViewId: first.structureViewId });
const afterRetained = await layout();
assert.deepEqual(afterRetained.selectedTabs, beforeRetained.selectedTabs);
assert.equal(
  afterRetained.displayedView,
  second.structureViewId,
  'The displayed protein must not change.'
);
receipt.steps.retainedProtein = {
  second,
  editedSceneSha256: afterEdit.sceneSha256,
  capture: await capture('second-protein-displayed'),
};

const returned = await inspect(0);
assert.equal(returned.structureViewId, first.structureViewId);
const shownScene = await tool('handleMolGetScene', {
  structureViewId: first.structureViewId,
  includeScene: true,
});
assert.equal(shownScene.sceneSha256, afterEdit.sceneSha256, 'The person must see the agent edit.');
assert.ok(shownScene.scene.includes('#d1495b'), 'The person must see the agent recolor.');
receipt.steps.personReturns = {
  seconds: returned.seconds,
  capture: await capture('person-returns'),
};

assert.deepEqual(pageErrors, []);
receipt.finishedAt = new Date().toISOString();
receipt.passed = true;
writeFileSync(path.join(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, out }));
await browser.close();

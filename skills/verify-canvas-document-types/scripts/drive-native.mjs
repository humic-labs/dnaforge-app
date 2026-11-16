#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { finalizeJourneyRecording } from '../../../apps/desktop/scripts/lib/native-journey-recording.mjs';
import { reloadNativePage } from '../../../apps/desktop/scripts/lib/native-journey-readiness.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(values.out && isAbsolute(values.out), 'Use --out with an absolute evidence directory');
const out = values.out;
mkdirSync(join(out, 'frames'), { recursive: true });
const root = resolve(
  process.env.DNAFORGE_VERIFY_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
);
const appDir = join(root, 'apps/desktop');
const receipt = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  steps: [],
  frames: [],
  pageErrors: [],
  failedResponses: [],
  requestFailures: [],
  consoleErrors: [],
};
writeFileSync(join(out, 'source.patch'), execFileSync('git', ['diff', '--binary'], { cwd: root }));
let browser;
let cdp;
try {
  const status = execFileSync(
    process.execPath,
    ['scripts/dev-single-instance-guard.cjs', '--status'],
    { cwd: appDir, encoding: 'utf8', timeout: 15000 }
  );
  writeFileSync(join(out, 'doctor.txt'), status);
  assert.match(status, /^ELECTRON_DEV_(?:HEALTHY|ATTACHED)$/mu);
  const renderer = status.match(/Desktop renderer:\s*(http:\/\/[^\s]+)/u)?.[1];
  const endpoint = status.match(/DevTools\/CDP:\s*(http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
  assert.ok(renderer && endpoint);
  browser = await chromium.connectOverCDP(endpoint);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => new URL(p.url()).origin === new URL(renderer).origin);
  assert.ok(page);
  receipt.renderer = renderer;
  page.on('pageerror', (error) => receipt.pageErrors.push(error.message));
  page.on('requestfailed', (request) =>
    receipt.requestFailures.push({
      url: request.url(),
      error: request.failure()?.errorText,
    })
  );
  page.on('console', (message) => {
    if (message.type() === 'error') receipt.consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && new URL(response.url()).hostname === '127.0.0.1')
      receipt.failedResponses.push({ url: response.url(), status: response.status() });
  });
  cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (frame) => {
    const file = `frames/${String(receipt.frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(out, file), Buffer.from(frame.data, 'base64'));
    receipt.frames.push({ file, timestamp: frame.metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  const snapshot = () =>
    page.evaluate(async () => {
      const { useCanvasStore } = await import('/src/features/canvas/store.ts');
      const { resolveTabEditor } = await import('/src/features/canvas/tab-editor.ts');
      const { saveTargetForTab } =
        await import('/src/features/canvas/artifact-document-lifecycle.ts');
      const state = useCanvasStore.getState();
      return {
        layout: state.layout,
        panels: Object.fromEntries(
          Object.entries(state.panels).map(([id, panel]) => [
            id,
            {
              ...panel,
              tabs: panel.tabs.map((tab) => ({
                ...tab,
                editor: resolveTabEditor(tab),
                saveTarget: saveTargetForTab(tab),
              })),
            },
          ])
        ),
      };
    });
  const tabs = async () => Object.values((await snapshot()).panels).flatMap((p) => p.tabs);
  const step = async (name) => {
    const screenshot = `${String(receipt.steps.length + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: join(out, screenshot) });
    receipt.steps.push({ name, screenshot, state: await snapshot() });
  };
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Manage projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const projectName = `Canvas verification ${Date.now()}`;
  await page.getByLabel('New project name', { exact: true }).fill(projectName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByTestId('project-root-name').filter({ hasText: projectName })
  ).toBeVisible();
  const workspace = await page.evaluate(async (name) => {
    const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
    return useWorkspaceStore.getState().folders.find((folder) => folder.name === name).path;
  }, projectName);
  receipt.workspace = workspace;
  const sequencePath = join(workspace, 'Canvas sequence.gb');
  const textPath = join(workspace, 'Canvas notes.txt');
  copyFileSync(join(root, 'test-fixtures/sequences/circular/pUC19.gb'), sequencePath);
  writeFileSync(textPath, 'Canvas baseline notes.\n');
  const treeFile = (file) =>
    page
      .getByTestId('file-tree-item')
      .filter({ has: page.locator(`[data-entry-path=${JSON.stringify(file)}]`) });
  const sequenceItem = page
    .locator(
      [join(workspace, 'Canvas sequence'), sequencePath]
        .map((path) => `[data-testid="file-tree-item"][data-entry-path=${JSON.stringify(path)}]`)
        .join(', ')
    )
    .first();
  await expect(sequenceItem).toBeVisible({ timeout: 30000 });
  const previousTabIds = new Set((await tabs()).map((tab) => tab.id));
  const openedSequence = async () =>
    Object.values((await snapshot()).panels)
      .flatMap((panel) => panel.tabs.filter((tab) => tab.id === panel.activeTabId))
      .find((tab) => tab.type === 'sequence' && !previousTabIds.has(tab.id));
  await expect(async () => {
    if (await openedSequence()) return;
    await sequenceItem.dblclick({ timeout: 2000 });
    await expect.poll(openedSequence, { timeout: 2000 }).toBeTruthy();
  }).toPass({ timeout: 60000, intervals: [250, 500, 1000] });
  await expect(page.getByTestId('sequence-loaded')).toBeVisible({ timeout: 60000 });
  const sequence = await openedSequence();
  assert.ok(sequence?.sequenceDocument);
  assert.notEqual(sequence.entityId, sequencePath);
  await step('opened-native-sequence');
  const textItem = page.locator(
    `[data-testid="file-tree-item"][data-entry-path=${JSON.stringify(textPath)}]`
  );
  await textItem.dblclick();
  await expect(page.getByTestId('text-viewer-tab')).toBeVisible();
  const editor = page.getByRole('textbox', {
    name: 'Code editor for Canvas notes.txt',
    exact: true,
  });
  await editor.click();
  await page.keyboard.press('Meta+A');
  await page.keyboard.insertText('Canvas saved through its file owner.\n');
  await page.keyboard.press('Meta+S');
  await expect
    .poll(() => readFileSync(textPath, 'utf8'))
    .toBe('Canvas saved through its file owner.\n');
  const text = (await tabs()).find((tab) => tab.entityId === textPath);
  assert.deepEqual(text.saveTarget, { kind: 'file', filePath: textPath });
  await step('edited-and-saved-text-to-native-file');
  await page.getByTestId(`tab-${text.id}`).click({ button: 'right' });
  await page
    .getByTestId('tab-context-menu')
    .getByRole('button', { name: 'Split Right', exact: true })
    .click();
  await expect.poll(async () => Object.keys((await snapshot()).panels).length).toBe(2);
  await step('split-text-into-second-pane');
  await page.getByTestId(`tab-${text.id}`).click({ button: 'right' });
  await page
    .getByTestId('tab-context-menu')
    .getByRole('button', { name: 'Join All Panes', exact: true })
    .click();
  await expect.poll(async () => Object.keys((await snapshot()).panels).length).toBe(1);
  await page
    .getByTestId(`tab-${text.id}`)
    .getByRole('button', { name: 'Close Canvas notes.txt', exact: true })
    .click();
  await expect
    .poll(async () => (await tabs()).some((tab) => tab.entityId === textPath))
    .toBe(false);
  await textItem.dblclick();
  await expect.poll(async () => (await tabs()).some((tab) => tab.entityId === textPath)).toBe(true);
  await step('moved-closed-and-reopened-text-through-file-tree');
  const restoreDeadline = Date.now() + 60000;
  await reloadNativePage(page, {
    timeoutMs: restoreDeadline - Date.now(),
    observe: ({ phase, startup }) => {
      receipt[`${phase}Reload`] = startup;
    },
  });
  await expect(page.getByTestId('text-viewer-tab')).toBeVisible({
    timeout: Math.max(1, restoreDeadline - Date.now()),
  });
  const restored = await tabs();
  assert.deepEqual(
    restored.find((tab) => tab.id === sequence.id).sequenceDocument,
    sequence.sequenceDocument
  );
  assert.equal(restored.find((tab) => tab.id === sequence.id).entityId, sequence.entityId);
  assert.deepEqual(restored.find((tab) => tab.entityId === textPath).saveTarget, text.saveTarget);
  assert.equal(readFileSync(textPath, 'utf8'), 'Canvas saved through its file owner.\n');
  await step('restored-document-identities-and-saved-content');
  receipt.fileContent = readFileSync(textPath, 'utf8');
  assert.deepEqual(receipt.pageErrors, []);
  assert.deepEqual(receipt.failedResponses, []);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  try {
    finalizeJourneyRecording(out, receipt);
    if (receipt.status !== 'passed') process.exitCode = 1;
    if (receipt.mediaError) console.error(receipt.mediaError);
  } finally {
    await browser?.close();
  }
}
console.log(`CANVAS_DOCUMENT_${receipt.status.toUpperCase()} ${join(out, 'receipt.json')}`);
if (receipt.error) console.error(receipt.error);

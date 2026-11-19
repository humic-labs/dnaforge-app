import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { finalizeJourneyRecording } from './lib/native-journey-recording.mjs';

const { values } = parseArgs({
  options: { out: { type: 'string' }, phase: { type: 'string', default: 'transitions' } },
});
assert.ok(values.out, 'Use --out with an absolute durable evidence directory');
assert.ok(['transitions', 'restored'].includes(values.phase));
const out = resolve(values.out);
const stage = join(out, values.phase);
mkdirSync(join(stage, 'frames'), { recursive: true });
const root = resolve(
  process.env.DNAFORGE_VERIFY_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
);
const appDir = join(root, 'apps/desktop');
const receipt = {
  phase: values.phase,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  steps: [],
  pageErrors: [],
  frames: [],
};
let browser;
let cdp;
try {
  const status = execFileSync(
    process.execPath,
    ['scripts/dev-single-instance-guard.cjs', '--status'],
    { cwd: appDir, encoding: 'utf8', timeout: 15000 }
  );
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
  cdp = await page.context().newCDPSession(page);
  cdp.on('Page.screencastFrame', (frame) => {
    const file = `frames/${String(receipt.frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(stage, file), Buffer.from(frame.data, 'base64'));
    receipt.frames.push({ file, timestamp: frame.metadata.timestamp });
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, everyNthFrame: 1 });
  const name = `Track session ${Date.now()}`;
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Manage projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('New project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByTestId('project-root-name').filter({ hasText: name })).toBeVisible();
  const workspace = await page.evaluate(async (name) => {
    const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
    return useWorkspaceStore.getState().folders.find(f => f.name === name).path;
  }, name);
  const sourcePath = join(stage, 'reference.fa');
  writeFileSync(sourcePath, `>chr1\n${'ACGT'.repeat(1000)}\n`);
  const saved = await page.evaluate(async ({ workspace, sourcePath }) => {
    const { platform } = await import('/src/platform/index.ts');
    const imported = await platform().referenceAssets.importLocal({ operationId: crypto.randomUUID(), sourcePath, themeMode: 'light' });
    if (imported.status !== 'ready') throw new Error(JSON.stringify(imported));
    const saved = await platform().trackViews.command({ operation: 'create', project: workspace, referenceId: imported.entry.id, requestId: crypto.randomUUID(), name: 'Session baseline', path: 'Session baseline.dnaforge-track-view.json', viewport: { chrom: 'chr1', start0: 100, end0: 800 }, tracks: [] });
    const { openTrackView } = await import('/src/features/sequence/open-track-view.ts');
    const tabId = await openTrackView(saved.path);
    return { ...saved, tabId };
  }, { workspace, sourcePath });
  const agent = (operation) => page.evaluate(async ({ operation, workspace }) => {
    const { createAppViewsTool } = await import('/src/features/ai/tools/app-views.ts');
    return createAppViewsTool([{ name: 'Session project', path: workspace }]).execute({ operation }, { toolCallId: crypto.randomUUID(), messages: [] });
  }, { operation, workspace });
  const inspect = () => agent({ kind: 'inspect', tabId: saved.tabId });
  const step = async (name, extra = {}) => {
    const screenshot = `${String(receipt.steps.length + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: join(stage, screenshot) });
    receipt.steps.push({ name, screenshot, state: await inspect(), file: JSON.parse(readFileSync(saved.path, 'utf8')), ...extra });
  };
  await expect.poll(async () => (await inspect()).ok, { timeout: 60000 }).toBe(true);
  await step('opened-native-reference-and-saved-view');
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect.poll(async () => (await inspect()).dirty).toBe(false);
  await page.getByRole('button', { name: 'Track view actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Track view name', exact: true }).fill('Human rename');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect.poll(() => JSON.parse(readFileSync(saved.path, 'utf8')).name).toBe('Human rename');
  await step('human-renamed-native-file');
  const before = await inspect();
  const renamed = await agent({ kind: 'rename', tabId: saved.tabId, name: 'Agent rename', expectedRevision: before.revision });
  assert.equal(renamed.ok, true, JSON.stringify(renamed));
  await step('agent-renamed-same-native-file', { renamed });
  const stale = await agent({ kind: 'save', tabId: saved.tabId, name: 'Stale change', expectedRevision: before.revision });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_VIEW');
  await page.getByRole('button', { name: 'Track view actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save As…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Track view name', exact: true }).fill('Cancelled copy');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await step('cancelled-copy-without-changing-file');
  const copy = await agent({ kind: 'duplicate', tabId: saved.tabId, name: 'Independent copy', expectedRevision: (await inspect()).revision, destinationProject: workspace, path: 'Independent copy.dnaforge-track-view.json' });
  assert.equal(copy.ok, true, JSON.stringify(copy));
  assert.notEqual(copy.viewId, saved.viewId);
  assert.equal(JSON.parse(readFileSync(copy.path, 'utf8')).name, 'Independent copy');
  await step('agent-created-independent-copy', { copy });
  await page.reload();
  await expect.poll(async () => (await inspect()).ok, { timeout: 60000 }).toBe(true);
  assert.equal((await inspect()).document.name, 'Agent rename');
  await step('reopened-with-persisted-baseline');
  receipt.workspace = workspace;
  receipt.saved = saved;
  assert.deepEqual(receipt.pageErrors, []);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
  try {
    finalizeJourneyRecording(stage, receipt);
    if (receipt.status !== 'passed') process.exitCode = 1;
    if (receipt.mediaError) console.error(receipt.mediaError);
  } finally {
    await browser?.close();
  }
}
console.log(`TRACK_VIEW_SESSION_${receipt.status.toUpperCase()} ${join(stage, 'receipt.json')}`);
if (receipt.error) console.error(receipt.error);

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
  const observe = () =>
    page.evaluate(async () => ({
      folders: await window.__test.getWorkspaceFoldersForTest(),
      preference:
        (
          await window.electronAPI.db.select('SELECT value FROM settings WHERE key=?', [
            'current_workspace_path',
          ])
        )[0]?.value ?? null,
      projects: await window.electronAPI.db.select(
        'SELECT path,name,archived_at,trashed_at FROM workspaces'
      ),
    }));
  const step = async (name) => {
    const observed = await observe();
    const screenshot = `${String(receipt.steps.length + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: join(stage, screenshot) });
    receipt.steps.push({ name, at: new Date().toISOString(), screenshot, observed });
    return observed;
  };
  async function create(name) {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Manage projects', exact: true }).click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.getByLabel('New project name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('project-root-name').filter({ hasText: name })).toBeVisible();
    await expect
      .poll(async () => (await observe()).folders.some((f) => f.name === name))
      .toBe(true);
    const folder = (await observe()).folders.find((f) => f.name === name);
    await expect.poll(async () => (await observe()).preference).toBe(folder.path);
    return folder;
  }
  async function archive(folder, refusal = false) {
    await page.keyboard.press('Escape');
    await page
      .locator(
        `[data-testid="project-root-menu-button"][data-project-path=${JSON.stringify(folder.path)}]`
      )
      .click();
    await page.getByText('Archive project…', { exact: true }).click();
    if (refusal) {
      await expect(
        page.getByText(/can.t archive your only project|at least one.*open/i).last()
      ).toBeVisible();
      assert.ok((await observe()).folders.some((f) => f.path === folder.path));
    } else {
      const confirm = page.getByRole('button', { name: 'Archive', exact: true });
      if (await confirm.isVisible()) await confirm.click();
      await expect
        .poll(async () => (await observe()).folders.some((f) => f.path === folder.path))
        .toBe(false);
    }
  }
  if (values.phase === 'transitions') {
    await page.keyboard.press('Escape');
    const suffix = Date.now();
    const first = await create(`Session A ${suffix}`);
    await step('created-first-project-and-selected-it');
    for (const folder of (await observe()).folders.filter((f) => !f.pinned && f.path !== first.path))
      await archive(folder);
    const second = await create(`Session B ${suffix}`);
    await step('created-second-project-and-selected-it');
    await archive(second);
    await expect.poll(async () => (await observe()).preference).toBe(first.path);
    await step('removed-current-project-and-selected-remainder');
    await archive(first, true);
    const final = await step('refused-removal-of-last-project');
    assert.deepEqual(
      final.folders.filter((f) => !f.pinned).map((f) => f.path),
      [first.path]
    );
    writeFileSync(join(out, 'expected.json'), JSON.stringify({ first, second }, null, 2));
  } else {
    const expected = JSON.parse(readFileSync(join(out, 'expected.json'), 'utf8'));
    await expect.poll(async () => (await observe()).preference).toBe(expected.first.path);
    const observed = await step('restored-registered-active-project-and-preference');
    assert.ok(observed.folders.some((f) => f.path === expected.first.path));
    assert.ok(!observed.folders.some((f) => f.path === expected.second.path));
    assert.ok(observed.projects.find((p) => p.path === expected.second.path)?.archived_at);
  }
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
console.log(`WORKSPACE_SESSION_${receipt.status.toUpperCase()} ${join(stage, 'receipt.json')}`);
if (receipt.error) console.error(receipt.error);

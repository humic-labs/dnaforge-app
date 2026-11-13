#!/usr/bin/env node
import { chromium, expect } from 'playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    cdp: { type: 'string' },
    runtime: { type: 'string' },
    python: { type: 'string' },
    output: { type: 'string' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'Usage: node apps/desktop/scripts/verify-annotation-jobs-live.mjs --cdp URL --runtime NAME [--python PATH] [--output DIR]'
  );
  console.log(
    'Requires the matching running development app with DevPanel mutation enabled and installed annotation tools/reference data. Uses a fresh pUC19 fixture, real computation, CLI observation, native save and Git.'
  );
  process.exit(0);
}
if (!values.cdp || !values.runtime)
  throw new Error('Select the exact app with --cdp and its managed --runtime.');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const python =
  values.python ??
  join(root, 'apps/api/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const output = resolve(
  values.output ??
    join(root, 'test-results/annotation-jobs-live', new Date().toISOString().replaceAll(':', '-'))
);
mkdirSync(output, { recursive: true });
const cli = (...args) =>
  JSON.parse(
    execFileSync(
      python,
      ['-m', 'src.managed_operations_cli', '--runtime', values.runtime, ...args, '--json'],
      {
        cwd: join(root, 'apps/api'),
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, PYTHONPATH: join(root, 'packages/annotation/src') },
      }
    )
  );
const guardStatus = execFileSync(
  process.execPath,
  [join(root, 'apps/desktop/scripts/dev-single-instance-guard.cjs'), '--status'],
  {
    cwd: join(root, 'apps/desktop'),
    encoding: 'utf8',
    timeout: 10000,
  }
);
const guardedCdp = /DevTools\/CDP:\s*(http:\/\/127\.0\.0\.1:\d+)/.exec(guardStatus)?.[1];
const runtimes = cli('runtimes').runtimes.filter(
  (candidate) => candidate.id === values.runtime || candidate.name === values.runtime
);
if (!guardedCdp || new URL(values.cdp).origin !== guardedCdp || runtimes.length !== 1)
  throw new Error('The selected renderer and managed runtime must both belong to this checkout.');
const evidence = { startedAt: new Date().toISOString(), runtime: values.runtime, cdp: values.cdp };
const browser = await chromium.connectOverCDP(values.cdp);
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((candidate) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(candidate.url()));
if (!page) {
  await browser.close();
  throw new Error('No development renderer found at the selected CDP endpoint.');
}

try {
  const rendererApi = await page.evaluate(() => window.electronAPI.config.getApiUrl());
  if (new URL(rendererApi).port !== new URL(runtimes[0].url).port)
    throw new Error('The selected managed runtime is not this renderer’s execution owner.');
  await page.reload();
  await page.getByTestId('jobs-button').waitFor({ state: 'visible', timeout: 20000 });
  const catalog = cli('catalog');
  evidence.ownerInstanceId = catalog.owner_instance_id;
  const scenario = page.getByTestId('devpanel-jobs-annotation-workspace');
  try {
    await scenario.click({ trial: true, timeout: 500 });
  } catch {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+.' : 'Control+Shift+.');
  }
  await scenario.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+.' : 'Control+Shift+.');
  await page.getByTestId('sequence-viewer-container').waitFor({ state: 'visible', timeout: 15000 });
  let folder;
  await expect
    .poll(
      async () => {
        const folders = await page.evaluate(() => window.__test.getWorkspaceFoldersForTest());
        folder = folders.find((candidate) => candidate.name === 'Jobs annotation proof');
        return Boolean(folder);
      },
      { timeout: 15000 }
    )
    .toBe(true);
  if (!folder) throw new Error('The real fixture workspace was not mounted.');
  const sourcePath = join(folder.path, 'pUC19.gb');
  evidence.sourcePath = sourcePath;
  evidence.sourceBeforeSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  const beforeIds = new Set(cli('list').operations.map((operation) => operation.id));
  const drawerTab = page.locator('button[role="tab"]').filter({ hasText: /plannotate/i });
  if (!(await drawerTab.isVisible())) await page.getByTestId('toolbar-auto-annotate').click();
  await drawerTab.click();
  const run = page.getByRole('button', { name: /^(Run pLannotate|Retry)$/ });
  await expect(run).toBeEnabled({ timeout: 15000 });
  await run.click();
  let operation;
  await expect
    .poll(
      () => {
        operation = cli('list').operations.find((candidate) => !beforeIds.has(candidate.id));
        return Boolean(operation);
      },
      { timeout: 10000, intervals: [200, 500, 1000] }
    )
    .toBe(true);
  evidence.admitted = operation;
  if (
    operation.subject.scope_id !== catalog.scope_id ||
    !['queued', 'running'].includes(operation.state)
  )
    throw new Error('The selected CLI did not observe this UI run before it settled.');
  const documentId = operation.subject.subject_id;
  await page
    .locator('[role="tab"][data-tab-id]')
    .filter({ hasText: /pUC19/ })
    .locator('button')
    .click();
  await expect(page.getByTestId('sequence-viewer-container')).toHaveCount(0);
  evidence.afterClose = cli('get', operation.id);
  if (!['queued', 'running'].includes(evidence.afterClose.state))
    throw new Error('The operation settled before the closed-view observation.');
  console.log(
    `All sequence views closed; CLI still observes ${operation.id} as ${evidence.afterClose.state}.`
  );
  if (!(await page.getByTestId('jobs-sidebar').isVisible()))
    await page.getByTestId('jobs-button').click();
  const row = page.getByTestId(`job-row-${operation.id}`);
  await expect(row).toBeVisible();
  await expect
    .poll(
      () => {
        evidence.terminal = cli('get', operation.id);
        return ['succeeded', 'failed', 'canceled', 'interrupted'].includes(evidence.terminal.state);
      },
      { timeout: 90000, intervals: [500, 1000, 2000] }
    )
    .toBe(true);
  if (evidence.terminal.state !== 'succeeded')
    throw new Error(JSON.stringify(evidence.terminal.error));
  await row.getByRole('button', { name: 'Open result', exact: true }).click();
  await page.getByTestId('sequence-viewer-container').waitFor({ state: 'visible', timeout: 15000 });
  const apply = page.getByRole('button', { name: /^Apply \(\d+\)$/ });
  await expect(apply).toBeEnabled({ timeout: 15000 });
  evidence.applyLabel = await apply.innerText();
  const expectedAnnotations = Number(/\((\d+)\)/.exec(evidence.applyLabel)[1]);
  await expect(async () => {
    const dismiss = page.getByTestId('toast-dismiss');
    if (await dismiss.count()) await dismiss.first().click({ timeout: 1000 });
    await apply.click({ trial: true, timeout: 1000 });
  }).toPass({ timeout: 10000, intervals: [100, 250, 500] });
  await apply.click();
  await expect
    .poll(() => readFileSync(sourcePath, 'utf8').includes(operation.id), { timeout: 15000 })
    .toBe(true);
  await expect(apply).toHaveCount(0, { timeout: 15000 });
  await expect
    .poll(
      () =>
        execFileSync('git', ['-C', folder.path, 'show', 'HEAD:pUC19.gb'], {
          encoding: 'utf8',
        }).includes(operation.id),
      { timeout: 15000 }
    )
    .toBe(true);
  evidence.gitCommit = execFileSync('git', ['-C', folder.path, 'log', '-1', '--format=%H %s'], {
    encoding: 'utf8',
  }).trim();
  evidence.sourceAfterSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  await page.reload();
  await page.getByTestId('sequence-viewer-container').waitFor({ state: 'visible', timeout: 15000 });
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ documentId, operationId }) =>
            window.__test
              .getSequenceStore()
              .savedSequences[
                documentId
              ]?.annotations?.filter((annotation) => annotation.qualifiers?.dnaforge_operation_id?.includes(operationId))
              .length,
          { documentId, operationId: operation.id }
        ),
      { timeout: 15000 }
    )
    .toBe(expectedAnnotations);
  evidence.reopenedAppliedAnnotations = expectedAnnotations;
  evidence.completedAt = new Date().toISOString();
  await page.screenshot({ path: join(output, 'reopened.png') });
  console.log(
    `PASS: real execution, closed-view lifetime, CLI identity, Jobs recovery, native save, Git and reopen. Receipt: ${join(output, 'receipt.json')}`
  );
} catch (error) {
  evidence.failure = String(error);
  await page.screenshot({ path: join(output, 'failure.png') });
  console.error(String(error));
  process.exitCode = 1;
} finally {
  writeFileSync(join(output, 'receipt.json'), JSON.stringify(evidence, null, 2));
  await browser.close();
}

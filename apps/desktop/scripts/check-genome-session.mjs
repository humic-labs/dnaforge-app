import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { finalizeJourneyRecording } from './lib/native-journey-recording.mjs';

const { values } = parseArgs({
  options: { out: { type: 'string' } },
});
assert.ok(values.out, 'Use --out with an absolute durable evidence directory');
const out = resolve(values.out);
const stage = out;
mkdirSync(join(stage, 'frames'), { recursive: true });
const root = resolve(
  process.env.DNAFORGE_VERIFY_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
);
const appDir = join(root, 'apps/desktop');
const receipt = {
  workflow: 'genome-session',
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
  page.on('response', (response) => {
    if (response.status() >= 400 && /\/(genome|tiles)\//u.test(response.url()))
      receipt.pageErrors.push(`${response.status()} ${response.url()}`);
  });
  const surface = page.getByTestId('indexed-genome-tab');
  const observe = async () => {
    const attributes = await surface.evaluate((element) =>
      Object.fromEntries(
        [...element.attributes]
          .filter((attribute) => attribute.name.startsWith('data-'))
          .map((attribute) => [attribute.name, attribute.value])
      )
    );
    const shell = await page.evaluate(async (sessionId) => {
      const { platform } = await import('/src/platform/index.ts');
      return platform().genome.getSession(sessionId);
    }, attributes['data-session-id']);
    return {
      attributes,
      shell,
      range: await page.getByTestId('indexed-genome-live-range').innerText(),
    };
  };
  const capture = async (name) => {
    const observed = await observe();
    const screenshot = `${String(receipt.steps.length + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: join(stage, screenshot) });
    receipt.steps.push({ name, at: new Date().toISOString(), screenshot, observed });
    return observed;
  };
  const ready = async () => {
    await expect(surface).toHaveAttribute('data-coordinate-ready', 'true', { timeout: 60000 });
    await expect(surface).toHaveAttribute('data-session-open-ready', 'true', { timeout: 60000 });
    await expect(page.getByLabel('Go to coordinate', { exact: true })).toBeEnabled({
      timeout: 60000,
    });
    await expect(page.getByTestId('indexed-genome-loading')).toHaveCount(0);
    assert.ok(
      await page.getByTestId('indexed-genome-runtime-area').locator('canvas').count(),
      'The real renderer has a canvas'
    );
  };
  const projectName = `Genome session ${Date.now()}`;
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Manage projects', exact: true }).click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('New project name', { exact: true }).fill(projectName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.getByTestId('project-root-name').filter({ hasText: projectName })
  ).toBeVisible();
  const project = await page.evaluate(
    async (name) =>
      (await window.__test.getWorkspaceFoldersForTest()).find((folder) => folder.name === name)
        ?.path,
    projectName
  );
  assert.ok(project);
  const fasta = join(stage, 'session-reference.fa');
  writeFileSync(fasta, `>chr1\n${'ACGT'.repeat(250)}\n>chr2\n${'AGCT'.repeat(500)}\n`);
  const signal = join(project, 'session-signal.bw');
  copyFileSync(join(root, 'test-fixtures/indexed/palette-signal.bw'), signal);
  const saved = await page.evaluate(
    async ({ project, fasta, signal }) => {
      const { platform } = await import('/src/platform/index.ts');
      const { createTrackViewsTool } = await import('/src/features/ai/tools/track-views.ts');
      const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
      const imported = await platform().referenceAssets.importLocal({
        operationId: crypto.randomUUID(),
        sourcePath: fasta,
        themeMode: 'light',
      });
      if (imported.status !== 'ready') throw new Error(JSON.stringify(imported));
      const saved = await createTrackViewsTool(useWorkspaceStore.getState().folders).execute(
        {
          operation: 'create',
          project,
          referenceId: imported.entry.id,
          requestId: crypto.randomUUID(),
          name: 'Genome session acceptance',
          path: 'Genome session acceptance.dnaforge-track-view.json',
          viewport: { chrom: 'chr1', start0: 0, end0: 500 },
          tracks: [
            {
              source: { kind: 'path', path: signal },
              format: 'bigwig',
              label: 'Session signal',
              color: '#d97706',
              heightPx: 120,
              range: { min: 0, max: 12 },
            },
          ],
        },
        { toolCallId: crypto.randomUUID(), messages: [] }
      );
      if (!saved.ok) throw new Error(JSON.stringify(saved));
      return saved;
    },
    { project, fasta, signal }
  );
  receipt.fixture = { project, fasta, signal, saved };
  const row = page.locator(`[data-entry-path=${JSON.stringify(saved.path)}]`).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.dblclick();
  await ready();
  const cold = await capture('cold-native-reference-open');
  await page.getByLabel('Go to coordinate', { exact: true }).fill('1501');
  await page.getByLabel('Go to coordinate', { exact: true }).press('Enter');
  await expect.poll(async () => (await observe()).range).not.toBe(cold.range);
  await page.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect
    .poll(() => JSON.parse(readFileSync(saved.path, 'utf8')).viewport.start0)
    .toBeGreaterThan(0);
  const positioned = await capture('viewport-command-presented-and-saved');
  await page.getByRole('button', { name: 'Close Genome session acceptance', exact: true }).click();
  await expect(surface).toHaveCount(0);
  await row.dblclick();
  await ready();
  const warm = await capture('warm-reopen-restores-viewport-and-track-readiness');
  assert.notEqual(warm.shell.sessionId, cold.shell.sessionId);
  assert.equal(warm.range, positioned.range);
  assert.equal(
    warm.attributes['data-sequence-track-state'],
    cold.attributes['data-sequence-track-state']
  );
  assert.equal(warm.attributes['data-assembly-source-readiness'], 'ready');
  assert.equal(warm.shell.preparationError, undefined);
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
console.log(`GENOME_SESSION_${receipt.status.toUpperCase()} ${join(stage, 'receipt.json')}`);
if (receipt.error) console.error(receipt.error);

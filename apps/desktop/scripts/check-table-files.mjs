import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60_000 });

const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(values.out, 'Use --out with a new durable evidence directory');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const workspaceRoot = join(out, 'workspace');
mkdirSync(workspaceRoot, { recursive: true });
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(appDir, '../..');
const receipt = {
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(),
  workspaceRoot,
  steps: [],
  pageErrors: [],
  consoleErrors: [],
};
let browser;
let page;
let recording;
const frames = [];

async function capture(name, details = {}) {
  const file = `${String(receipt.steps.length + 1).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: join(out, file) });
  receipt.steps.push({ name, details, file, at: new Date().toISOString() });
}

function tableBlocks(node) {
  return [
    ...(node.type === 'embed' && node.attrs?.type === 'table' ? [node.attrs] : []),
    ...(node.content ?? []).flatMap(tableBlocks),
  ];
}

try {
  const status = execFileSync(
    process.execPath,
    ['scripts/dev-single-instance-guard.cjs', '--status'],
    {
      cwd: appDir,
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.match(status, /^ELECTRON_DEV_(?:HEALTHY|ATTACHED|STARTING)$/mu);
  const renderer = status.match(/Desktop renderer:\s*(http:\/\/[^\s]+)/u)?.[1];
  const cdp = status.match(/DevTools\/CDP:\s*(http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
  assert.ok(renderer && cdp, 'The guard must identify this checkout renderer');
  browser = await chromium.connectOverCDP(cdp);
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => new URL(candidate.url()).origin === new URL(renderer).origin);
  assert.ok(page, 'No page belongs to this checkout');
  receipt.runtime = await page.evaluate(() => window.electronAPI.runtime.getProvenance());
  assert.equal(receipt.runtime.projectRoot, root);
  receipt.startup = await page.evaluate(() => window.electronAPI.startup.getState());
  assert.equal(receipt.startup.pageLoaded, true);
  assert.equal(receipt.startup.shellReady, true);
  assert.ok(typeof receipt.startup.loadId === 'string' && receipt.startup.loadId.length);
  receipt.launcherStatus = status.split('\n')[0];
  mkdirSync(join(out, 'frames'), { recursive: true });
  recording = await page.context().newCDPSession(page);
  recording.on('Page.screencastFrame', (event) => {
    const file = `frame-${String(frames.length).padStart(6, '0')}.jpg`;
    writeFileSync(join(out, 'frames', file), Buffer.from(event.data, 'base64'));
    frames.push({
      file,
      timestamp: event.metadata.timestamp,
      receivedAt: new Date().toISOString(),
    });
    void recording.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await recording.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 80,
    maxWidth: 1280,
    maxHeight: 800,
  });
  await page.waitForFunction(() => window.__test?.mountFolderInPlace);
  page.on('pageerror', (error) => receipt.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') receipt.consoleErrors.push(message.text());
  });
  const modifier = await page.evaluate(() =>
    /mac/i.test(navigator.platform) ? 'Meta' : 'Control'
  );
  await page.evaluate((path) => window.__test.mountFolderInPlace(path), workspaceRoot);
  const title = 'Referenceable table acceptance';
  const packageRoot = join(workspaceRoot, title);
  const headPath = join(packageRoot, '.forge', 'table.json');
  receipt.packageRoot = packageRoot;
  receipt.headPath = headPath;
  const project = page.locator(`[data-workspace-root-path=${JSON.stringify(workspaceRoot)}]`);
  if (!(await project.isVisible())) await page.getByTestId('files-button').click();
  const entry = project.locator(`[data-entry-path=${JSON.stringify(workspaceRoot)}]`);
  await expect(entry).toBeVisible();
  if ((await entry.getAttribute('aria-expanded')) === 'false') await entry.click();
  await capture('files-before-table');
  const previousTabs = await page.evaluate(() =>
    Object.values(window.__test.getCanvasStore().panels).flatMap((panel) =>
      panel.tabs.map((tab) => tab.id)
    )
  );
  await entry.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New…', exact: true }).hover();
  await page
    .getByTestId('explorer-add-picker')
    .getByRole('menuitem', { name: 'Table', exact: true })
    .click();
  await page
    .getByRole('menu', { name: 'Table actions', exact: true })
    .getByRole('menuitem', { name: 'Create', exact: true })
    .click();
  const name = project.getByTestId('file-tree-rename-input');
  await expect(name).toBeFocused();
  await name.fill(title);
  await name.press('Enter');
  await expect(name).toHaveCount(0);
  await expect
    .poll(async () =>
      page.evaluate(
        (previous) =>
          Object.values(window.__test.getCanvasStore().panels)
            .flatMap((panel) => panel.tabs)
            .some(
              (tab) =>
                tab.type === 'table' &&
                !previous.includes(tab.id) &&
                tab.tableDocument?.backing.kind === 'rich-file'
            ),
        previousTabs
      )
    )
    .toBe(true);
  const createdTab = await page.evaluate(
    (previous) =>
      Object.values(window.__test.getCanvasStore().panels)
        .flatMap((panel) => panel.tabs)
        .find((tab) => tab.type === 'table' && !previous.includes(tab.id)),
    previousTabs
  );
  assert.ok(createdTab, 'A new independent table tab must exist');
  receipt.tab = createdTab;
  const grid = page
    .getByTestId(`tab-content-container-${createdTab.entityId}`)
    .getByTestId('table-grid');
  await expect(grid).toHaveCount(1);
  await expect(grid).not.toHaveAttribute('data-read-only', 'true');
  const inspect = () =>
    page.evaluate(
      async (path) =>
        (await import('/src/platform/index.ts')).platform().fs.fileDocument({
          target: { path },
          projection: 'document',
          operation: { kind: 'inspect' },
        }),
      headPath
    );
  await expect.poll(async () => (await inspect()).ready).toBe(true);
  const baseline = await inspect();
  receipt.before = baseline;
  assert.equal(baseline.tableDocument.status, 'active');
  const originalHeadBytes = readFileSync(headPath, 'utf8');
  const originalHead = JSON.parse(originalHeadBytes);
  writeFileSync(join(out, 'created-head.json'), originalHeadBytes);
  await capture('created-table-open', { tableId: originalHead.id });
  const cell = grid.locator('[data-cell-position="0,0"]');
  await cell.dblclick();
  await cell.locator('input').fill('durable-referenceable-table');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveText('durable-referenceable-table');
  await expect.poll(async () => (await inspect()).dirty).toBe(true);
  await page.keyboard.press(`${modifier}+S`);
  await expect
    .poll(async () => {
      const snapshot = await inspect();
      return (
        !snapshot.dirty &&
        !snapshot.saving &&
        JSON.parse(snapshot.content).snapshot.data.cells[0][0].value
      );
    })
    .toBe('durable-referenceable-table');
  const saved = await inspect();
  receipt.saved = saved;
  const savedBytes = readFileSync(headPath, 'utf8');
  const head = JSON.parse(savedBytes);
  assert.equal(head.id, originalHead.id);
  assert.equal(head.snapshot.data.cells[0][0].value, 'durable-referenceable-table');
  const immutable = readFileSync(
    join(packageRoot, '.forge', 'table-revisions', `${head.snapshotSha256}.json`),
    'utf8'
  );
  assert.deepEqual(JSON.parse(immutable), head.snapshot);
  assert.equal(createHash('sha256').update(immutable).digest('hex'), head.snapshotSha256);
  writeFileSync(join(out, 'saved-head.json'), savedBytes);
  writeFileSync(join(out, 'saved-snapshot.json'), immutable);
  await capture('table-saved', {
    documentId: saved.documentId,
    tableId: head.id,
    snapshotSha256: head.snapshotSha256,
  });
  await page.getByTestId(`tab-close-${createdTab.id}`).click();
  await expect(page.getByTestId(`tab-close-${createdTab.id}`)).toHaveCount(0);
  const tableEntry = project.locator(`[data-entry-path=${JSON.stringify(packageRoot)}]`);
  await expect(tableEntry).toBeVisible();
  await tableEntry.dblclick();
  await expect(grid).toHaveCount(1);
  await expect(grid.locator('[data-cell-position="0,0"]')).toHaveText(
    'durable-referenceable-table'
  );
  await expect(grid).not.toHaveAttribute('data-read-only', 'true');
  assert.equal((await inspect()).documentId, saved.documentId);
  assert.equal(readFileSync(headPath, 'utf8'), savedBytes);
  await capture('table-reopened-from-files');
  assert.deepEqual(receipt.pageErrors, []);
  assert.deepEqual(receipt.consoleErrors, []);
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error.stack ?? String(error);
  if (page) await capture('failed').catch(() => {});
  process.exitCode = 1;
} finally {
  if (recording) {
    await recording.send('Page.stopScreencast').catch(() => {});
    writeFileSync(join(out, 'frames', 'manifest.json'), JSON.stringify(frames, null, 2));
    const timeline = frames
      .flatMap((frame, index) => [
        `file '${frame.file}'`,
        `duration ${index + 1 < frames.length ? Math.max(0.025, frames[index + 1].timestamp - frame.timestamp) : 1}`,
      ])
      .join('\n');
    if (frames.length) {
      writeFileSync(
        join(out, 'frames', 'timeline.txt'),
        `${timeline}\nfile '${frames.at(-1).file}'\n`
      );
      try {
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            join(out, 'frames', 'timeline.txt'),
            '-vf',
            'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=10,format=yuv420p',
            '-movflags',
            '+faststart',
            join(out, 'native-table-journey.mp4'),
          ],
          { timeout: 30_000 }
        );
        receipt.recording = {
          file: 'native-table-journey.mp4',
          originalFrames: frames.length,
          manifest: 'frames/manifest.json',
        };
      } catch (error) {
        receipt.recording = { originalFrames: frames.length, encodingError: String(error) };
      }
    }
    await recording.detach().catch(() => {});
  }
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser?.close();
}
console.log(`TABLE_FILES_${receipt.status.toUpperCase()} ${join(out, 'receipt.json')}`);
if (receipt.error) console.error(receipt.error);

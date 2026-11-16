import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';

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
  assert.match(status, /^ELECTRON_DEV_(?:HEALTHY|ATTACHED)$/mu);
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
  const pageId = await page.evaluate(async (workspaceRoot) => {
    const before = new Set(Object.keys(window.__test.getPageStore().pages));
    await window.__test.createNotebookArtifact({
      workspaceRoot,
      parentPath: workspaceRoot,
      artifactTitle: 'Independent table acceptance',
      artifactFileName: 'Independent table acceptance',
    });
    const created = Object.keys(window.__test.getPageStore().pages).filter((id) => !before.has(id));
    if (created.length !== 1) throw new Error('Expected exactly one new notebook');
    return created[0];
  }, workspaceRoot);
  receipt.pageId = pageId;
  const inspect = () =>
    page.evaluate(
      (documentId) =>
        window.electronAPI.notebook.execute({
          documentId,
          operation: { kind: 'inspect-copy' },
        }),
      pageId
    );
  const notebook = page.locator(`[data-page-id=${JSON.stringify(pageId)}]`);
  const editor = notebook.locator('.tiptap[contenteditable="true"]');
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.type('/table');
  await expect(
    page.locator('[data-tippy-root]').getByRole('button', { name: /Table$/ })
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(notebook.getByLabel('rows', { exact: true })).toBeFocused();
  await page.keyboard.type('3');
  await page.keyboard.press('Tab');
  await expect(notebook.getByLabel('cols', { exact: true })).toBeFocused();
  await page.keyboard.type('3');
  await page.keyboard.press('Enter');
  const sourceGrid = notebook.getByTestId('table-grid');
  await expect(sourceGrid.getByLabel('Table keyboard navigation', { exact: true })).toBeFocused();
  await page.keyboard.type('baseline-retained');
  await page.keyboard.press('Enter');
  await page.keyboard.press(`${modifier}+S`);
  await expect
    .poll(async () => {
      const snapshot = await inspect();
      return (
        !snapshot.dirty &&
        !snapshot.saving &&
        tableBlocks(snapshot.copy.content)[0]?.data.cells?.[0]?.[0]?.value
      );
    })
    .toBe('baseline-retained');
  const baseline = await inspect();
  receipt.before = baseline;
  await capture('saved-inline-table', { table: tableBlocks(baseline.copy.content)[0] });
  const previousTabs = await page.evaluate(() =>
    Object.values(window.__test.getCanvasStore().panels).flatMap((panel) =>
      panel.tabs.map((tab) => tab.id)
    )
  );
  await notebook.hover();
  await notebook.getByRole('button', { name: 'Open in panel', exact: true }).click();
  const tabs = await page.evaluate(() =>
    Object.entries(window.__test.getCanvasStore().panels).flatMap(([panelId, panel]) =>
      panel.tabs.map((tab) => ({ ...tab, panelId }))
    )
  );
  const sourceTab = tabs.find((tab) => tab.type === 'page' && tab.entityId === pageId);
  const expandedTab = tabs.find((tab) => tab.type === 'table' && !previousTabs.includes(tab.id));
  assert.ok(sourceTab && expandedTab, 'Both notebook and expanded table tabs must exist');
  receipt.tabs = { sourceTab, expandedTab };
  await capture('expanded-with-notebook');
  await page.getByTestId(`tab-close-${sourceTab.id}`).click();
  await expect(notebook).toHaveCount(0);
  const grid = page.getByTestId('table-grid').filter({ visible: true });
  await expect(grid).toHaveCount(1);
  await capture('notebook-closed', { native: await inspect() });
  await expect(grid).not.toHaveAttribute('data-read-only', 'true');
  const cell = grid.locator('[data-cell-position="0,1"]');
  await cell.dblclick();
  const input = cell.locator('input');
  await expect(input).toBeFocused();
  await input.fill('detached-edit-durable');
  await page.keyboard.press('Enter');
  await expect(cell).toHaveText('detached-edit-durable');
  await page.keyboard.press(`${modifier}+S`);
  await expect
    .poll(async () => {
      const snapshot = await inspect();
      const table = tableBlocks(snapshot.copy.content)[0];
      return !snapshot.dirty && !snapshot.saving && table?.data.cells?.[0]?.[1]?.value;
    })
    .toBe('detached-edit-durable');
  const saved = await inspect();
  receipt.saved = saved;
  assert.equal(
    tableBlocks(saved.copy.content)[0].refId,
    tableBlocks(baseline.copy.content)[0].refId
  );
  assert.equal(tableBlocks(saved.copy.content)[0].data.cells[0][0].value, 'baseline-retained');
  assert.ok(saved.path);
  const packagePaths = await page.evaluate(
    async (packageRoot) =>
      (await import('/src/db/notebook-package.ts')).notebookPackagePaths(packageRoot),
    saved.path
  );
  receipt.savedPackage = packagePaths;
  const bytes = readFileSync(packagePaths.markdownPath, 'utf8');
  assert.ok(bytes.includes('baseline-retained') && bytes.includes('detached-edit-durable'));
  writeFileSync(join(out, 'saved-notebook.md'), bytes);
  await capture('detached-edit-saved', { revision: saved.revision, path: saved.path });
  const project = page.locator(`[data-workspace-root-path=${JSON.stringify(workspaceRoot)}]`);
  if (!(await project.isVisible())) await page.getByTestId('files-button').click();
  const entry = project.locator(`[data-entry-path=${JSON.stringify(workspaceRoot)}]`);
  if ((await entry.getAttribute('aria-expanded')) === 'false') await entry.click();
  await project.locator(`[data-entry-path=${JSON.stringify(saved.path)}]`).dblclick();
  await expect(notebook.getByTestId('table-grid')).toBeVisible();
  await expect(notebook.locator('[data-cell-position="0,1"]')).toHaveText('detached-edit-durable');
  assert.deepEqual(tableBlocks((await inspect()).copy.content), tableBlocks(saved.copy.content));
  await capture('notebook-reopened');
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
console.log(`TABLE_DOCUMENTS_${receipt.status.toUpperCase()} ${join(out, 'receipt.json')}`);
if (receipt.error) console.error(receipt.error);

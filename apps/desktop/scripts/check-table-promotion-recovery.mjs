import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60_000 });

const { values } = parseArgs({
  options: { out: { type: 'string' }, mode: { type: 'string' }, source: { type: 'string' } },
});
assert.ok(values.out, 'Use --out with a new durable evidence directory');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
assert.ok(['prepare', 'verify'].includes(values.mode), 'Use --mode prepare or verify');
const prior = values.source ? JSON.parse(readFileSync(resolve(values.source), 'utf8')) : null;
if (values.mode === 'verify') assert.equal(prior?.status, 'passed');
const workspaceRoot = prior?.workspaceRoot ?? join(out, 'workspace');
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
  page.setDefaultTimeout(15_000);
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
  if (values.mode === 'prepare') {
    await page.evaluate((path) => window.__test.mountFolderInPlace(path), workspaceRoot);
    const pageId = await page.evaluate(async (workspaceRoot) => {
      const before = new Set(Object.keys(window.__test.getPageStore().pages));
      await window.__test.createNotebookArtifact({
        workspaceRoot,
        parentPath: workspaceRoot,
        artifactTitle: 'Independent table acceptance',
        artifactFileName: 'Independent table acceptance',
      });
      const created = Object.keys(window.__test.getPageStore().pages).filter(
        (id) => !before.has(id)
      );
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

    const title = 'Recoverable table acceptance';
    const packageRoot = join(workspaceRoot, title);
    mkdirSync(packageRoot);
    chmodSync(packageRoot, 0o555);
    try {
      const staleRecovery = page.locator(
        '[data-toast-definition="unsaved-draft-recovery-available"]'
      );
      receipt.dismissedExistingRecoveryNotices = [];
      const noticeCount = await staleRecovery.count();
      assert.ok(noticeCount <= 20, 'Unexpected number of existing recovery notices');
      for (let remaining = noticeCount; remaining > 0; remaining -= 1) {
        const notice = staleRecovery.last();
        receipt.dismissedExistingRecoveryNotices.push(await notice.innerText());
        await notice.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
        await expect(staleRecovery).toHaveCount(remaining - 1);
      }
      await notebook.hover({ position: { x: 16, y: 16 } });
      await notebook.getByRole('button', { name: 'Save as table file…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Save as table file', exact: true });
      await dialog.getByLabel('Table name', { exact: true }).fill(title);
      await dialog.getByRole('button', { name: 'Save as table file', exact: true }).click();
      await expect(dialog.getByRole('alert')).toBeVisible();
      receipt.expectedFailure = await dialog.getByRole('alert').innerText();
      assert.ok(receipt.expectedFailure.length);
      await expect
        .poll(() => receipt.consoleErrors.some((line) => line.includes('Table extraction failed')))
        .toBe(true);
      const current = await inspect();
      assert.equal(current.dirty, false);
      assert.deepEqual(tableBlocks(current.copy.content), tableBlocks(baseline.copy.content));
      assert.equal(existsSync(join(packageRoot, '.forge', 'table.json')), false);
      const intents = readdirSync(join(workspaceRoot, '.forge', 'table-transitions')).filter(
        (name) => name.endsWith('.json')
      );
      assert.equal(intents.length, 1);
      const intentBytes = readFileSync(
        join(workspaceRoot, '.forge', 'table-transitions', intents[0]),
        'utf8'
      );
      const intent = JSON.parse(intentBytes);
      receipt.promotionId = intent.promotionId;
      receipt.tableId = intent.tableId;
      receipt.packageRoot = packageRoot;
      receipt.pageId = pageId;
      receipt.before = current;
      receipt.intentFile = intents[0];
      writeFileSync(join(out, 'durable-intent.json'), intentBytes);
      await capture('write-failure-visible-source-retained', {
        message: receipt.expectedFailure,
        promotionId: intent.promotionId,
      });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    } finally {
      chmodSync(packageRoot, 0o755);
      receipt.permissionRestored = true;
    }
  } else {
    assert.notEqual(
      receipt.runtime.pid,
      prior.runtime.pid,
      'Recovery requires a new native process'
    );
    receipt.previousPid = prior.runtime.pid;
    const tabs = await page.evaluate(() =>
      Object.values(window.__test.getCanvasStore().panels).flatMap((panel) => panel.tabs)
    );
    const sourceTab = tabs.find((tab) => tab.type === 'page' && tab.entityId === prior.pageId);
    assert.ok(sourceTab, 'The source notebook must restore after restart');
    await page.getByTestId(`tab-${sourceTab.id}`).click();
    const notebook = page.locator(`[data-page-id=${JSON.stringify(prior.pageId)}]`);
    const inspect = () =>
      page.evaluate(
        (documentId) =>
          window.electronAPI.notebook.execute({ documentId, operation: { kind: 'inspect-copy' } }),
        prior.pageId
      );
    assert.deepEqual(
      tableBlocks((await inspect()).copy.content),
      tableBlocks(prior.before.copy.content)
    );
    const finish = notebook.getByRole('button', { name: 'Finish saving table', exact: true });
    await expect(finish).toBeVisible();
    await capture('restart-discovered-recoverable-table');
    await finish.click();
    const refs = (node) => [
      ...(node.type === 'embed' && node.attrs?.type === 'table-reference'
        ? [node.attrs.data.reference]
        : []),
      ...(node.content ?? []).flatMap(refs),
    ];
    await expect.poll(async () => refs((await inspect()).copy.content).length).toBe(1);
    const source = await inspect();
    assert.equal(source.dirty, false);
    const reference = refs(source.copy.content)[0];
    assert.equal(reference.documentId, prior.tableId);
    const headBytes = readFileSync(join(prior.packageRoot, '.forge', 'table.json'), 'utf8');
    const head = JSON.parse(headBytes);
    assert.equal(head.id, prior.tableId);
    assert.equal(head.status, 'active');
    assert.equal(head.snapshot.data.cells[0][0].value, 'baseline-retained');
    const durableBytes = readFileSync(
      join(workspaceRoot, '.forge', 'table-transitions', prior.intentFile),
      'utf8'
    );
    assert.equal(
      durableBytes,
      readFileSync(join(dirname(resolve(values.source)), 'durable-intent.json'), 'utf8')
    );
    const list = await page.evaluate(
      async (workspaceRoot) =>
        (await import('/src/platform/index.ts'))
          .platform()
          .fs.tableDocument({ kind: 'list-promotions', workspaceRoot }),
      workspaceRoot
    );
    assert.deepEqual(list, { kind: 'promotions', promotions: [] });
    receipt.reference = reference;
    receipt.source = source;
    receipt.tableId = head.id;
    receipt.promotionId = prior.promotionId;
    writeFileSync(join(out, 'recovered-head.json'), headBytes);
    await capture('recovered-same-table-after-native-restart');
  }
  assert.deepEqual(receipt.pageErrors, []);
  if (values.mode === 'verify') assert.deepEqual(receipt.consoleErrors, []);
  receipt.mode = values.mode;
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
console.log(
  `TABLE_PROMOTION_RECOVERY_${receipt.status.toUpperCase()} ${join(out, 'receipt.json')}`
);
if (receipt.error) console.error(receipt.error);

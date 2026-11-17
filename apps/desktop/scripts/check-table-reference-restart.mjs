import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, expect as baseExpect } from '@playwright/test';
const expect = baseExpect.configure({ timeout: 60_000 });

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    source: { type: 'string' },
    mode: { type: 'string' },
    prepared: { type: 'string' },
  },
});
assert.ok(values.out, 'Use --out with a new durable evidence directory');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
assert.ok(values.source, 'Use --source with a passing references receipt');
assert.ok(['prepare', 'verify'].includes(values.mode), 'Use --mode prepare or verify');
const source = JSON.parse(readFileSync(resolve(values.source), 'utf8'));
assert.equal(source.status, 'passed');
const workspaceRoot = source.workspaceRoot;
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
  if (values.mode === 'verify') {
    assert.ok(values.prepared, 'Use --prepared with the pre-restart receipt');
    const prepared = JSON.parse(readFileSync(resolve(values.prepared), 'utf8'));
    assert.equal(prepared.status, 'passed');
    assert.notEqual(
      receipt.runtime.pid,
      prepared.runtime.pid,
      'Verification requires a new native process'
    );
    receipt.previousPid = prepared.runtime.pid;
  }
  const tabs = await page.evaluate(() =>
    Object.values(window.__test.getCanvasStore().panels).flatMap((panel) => panel.tabs)
  );
  const targetTab = tabs.find((tab) => tab.type === 'page' && tab.entityId === source.targetId);
  assert.ok(targetTab, 'The notebook with saved references must survive native restart');
  await page.getByTestId(`tab-${targetTab.id}`).click();
  const target = page.locator(`[data-page-id=${JSON.stringify(source.targetId)}]`);
  const live = target.locator(
    `[data-table-document=${JSON.stringify(source.currentKey)}][data-table-presentation="embed"]`
  );
  const pin = target.locator(
    `[data-table-document=${JSON.stringify(source.pinnedKey)}][data-table-presentation="embed"]`
  );
  const link = target.locator(
    `[data-table-document=${JSON.stringify(source.currentKey)}][data-table-presentation="link"]`
  );
  await expect(live.locator('[data-cell-position="0,1"]')).toHaveText(source.expectedLive);
  await expect(live.getByTestId('table-grid')).not.toHaveAttribute('data-read-only', 'true');
  await expect(pin.locator('[data-cell-position="0,1"]')).toHaveText(source.expectedPinned);
  await expect(pin.getByTestId('table-grid')).toHaveAttribute('data-read-only', 'true');
  await expect(link.getByRole('button', { name: 'Open table', exact: true })).toBeVisible();
  const snapshot = await page.evaluate(
    (documentId) =>
      window.electronAPI.notebook.execute({ documentId, operation: { kind: 'inspect-copy' } }),
    source.targetId
  );
  assert.equal(snapshot.dirty, false);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot.copy.content)), source.target.copy.content);
  const movedHead = readFileSync(join(source.movedRoot, '.forge', 'table.json'), 'utf8');
  assert.equal(
    movedHead,
    readFileSync(join(dirname(resolve(values.source)), 'moved-saved-head.json'), 'utf8')
  );
  const current = await page.evaluate(
    async (reference) =>
      (await import('/src/platform/index.ts'))
        .platform()
        .fs.tableDocument({ kind: 'resolve', reference }),
    source.reference
  );
  const pinned = await page.evaluate(
    async (reference) =>
      (await import('/src/platform/index.ts'))
        .platform()
        .fs.tableDocument({ kind: 'resolve', reference }),
    source.pinnedReference
  );
  assert.equal(current.kind, 'resolved');
  assert.equal(current.table.owner.path, join(source.movedRoot, '.forge', 'table.json'));
  assert.equal(pinned.kind, 'resolved');
  assert.equal(pinned.table.readOnly, true);
  assert.equal(pinned.table.owner.snapshot.data.cells[0][1].value, source.expectedPinned);
  receipt.current = current;
  receipt.pinned = pinned;
  receipt.notebook = snapshot;
  receipt.mode = values.mode;
  await capture(`${values.mode}-moved-live-pin-restored`);
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
console.log(
  `TABLE_REFERENCES_RESTART_${receipt.status.toUpperCase()} ${join(out, 'receipt.json')}`
);
if (receipt.error) console.error(receipt.error);

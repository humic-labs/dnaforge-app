import assert from 'node:assert/strict';
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
  const initialSaveStartedAt = Date.now();
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
  receipt.initialSaveElapsedMs = Date.now() - initialSaveStartedAt;
  const baseline = await inspect();
  receipt.before = baseline;
  await capture('saved-inline-table', { table: tableBlocks(baseline.copy.content)[0] });
  const tabs = () =>
    page.evaluate(() =>
      Object.entries(window.__test.getCanvasStore().panels).flatMap(([panelId, panel]) =>
        panel.tabs.map((tab) => ({ ...tab, panelId }))
      )
    );
  const activate = async (type, entityId) => {
    const tab = (await tabs()).find((tab) => tab.type === type && tab.entityId === entityId);
    assert.ok(tab, `No ${type} tab for ${entityId}`);
    await page.getByTestId(`tab-${tab.id}`).click();
    return tab;
  };
  const inspectNotebook = (documentId) =>
    page.evaluate(
      (documentId) =>
        window.electronAPI.notebook.execute({ documentId, operation: { kind: 'inspect-copy' } }),
      documentId
    );
  const targetTitle = 'Linked notebook acceptance';
  const targetId = await page.evaluate(
    async ({ workspaceRoot, title }) => {
      const previous = new Set(Object.keys(window.__test.getPageStore().pages));
      await window.__test.createNotebookArtifact({
        workspaceRoot,
        parentPath: workspaceRoot,
        artifactTitle: title,
        artifactFileName: title,
      });
      const added = Object.keys(window.__test.getPageStore().pages).filter(
        (id) => !previous.has(id)
      );
      if (added.length !== 1) throw new Error('Expected one target notebook');
      return added[0];
    },
    { workspaceRoot, title: targetTitle }
  );
  receipt.targetId = targetId;
  await activate('page', pageId);
  const staleRecovery = page.locator('[data-toast-definition="unsaved-draft-recovery-available"]');
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
  const extractDialog = page.getByRole('dialog', { name: 'Save as table file', exact: true });
  await expect(extractDialog).toBeVisible();
  await extractDialog.getByLabel('Table name', { exact: true }).fill('Extracted acceptance table');
  const extractionStartedAt = Date.now();
  await extractDialog.getByRole('button', { name: 'Save as table file', exact: true }).click();
  await expect(extractDialog).toHaveCount(0);
  const references = (node) => [
    ...(node.type === 'embed' && node.attrs?.type === 'table-reference' ? [node.attrs.data] : []),
    ...(node.content ?? []).flatMap(references),
  ];
  await expect.poll(async () => references((await inspect()).copy.content).length).toBe(1);
  const migrated = await inspect();
  assert.equal(migrated.dirty, false);
  const reference = references(migrated.copy.content)[0].reference;
  assert.equal(reference.backing.kind, 'rich-file');
  assert.equal(reference.binding.kind, 'current');
  const resolveTable = () =>
    page.evaluate(
      async (reference) =>
        (await import('/src/platform/index.ts'))
          .platform()
          .fs.tableDocument({ kind: 'resolve', reference }),
      reference
    );
  const resolved = await resolveTable();
  receipt.extractionElapsedMs = Date.now() - extractionStartedAt;
  assert.equal(resolved.kind, 'resolved');
  assert.equal(resolved.table.owner.kind, 'file');
  const nativeFileId = resolved.table.owner.documentId;
  const packageRoot = dirname(dirname(resolved.table.owner.path));
  receipt.reference = reference;
  receipt.nativeFileId = nativeFileId;
  receipt.packageRoot = packageRoot;
  const inspectFile = () =>
    page.evaluate(
      async (documentId) =>
        (await import('/src/platform/index.ts')).platform().fs.fileDocument({
          target: { documentId },
          projection: 'document',
          operation: { kind: 'inspect' },
        }),
      nativeFileId
    );
  const packageHead = () =>
    JSON.parse(readFileSync(join(packageRoot, '.forge', 'table.json'), 'utf8'));
  assert.equal(packageHead().snapshot.data.cells[0][0].value, 'baseline-retained');
  const currentKey = await page.evaluate(
    async (reference) =>
      (await import('/src/shared/table-document-reference.ts')).tableDocumentKey(reference),
    reference
  );
  receipt.currentKey = currentKey;
  const placement = (parent, key, display = 'embed') =>
    parent.locator(
      `[data-table-document=${JSON.stringify(key)}][data-table-presentation=${JSON.stringify(display)}]`
    );
  const sourcePlacement = placement(notebook, currentKey);
  await expect(sourcePlacement.getByTestId('table-grid')).toBeVisible();
  await expect(sourcePlacement.locator('[data-cell-position="0,0"]')).toHaveText(
    'baseline-retained'
  );
  await capture('migrated-live-placement', { reference, native: await inspectFile() });
  await sourcePlacement.getByRole('button', { name: 'Open in tab', exact: true }).click();
  await expect
    .poll(async () =>
      (await tabs()).some((tab) => tab.type === 'table' && tab.entityId === currentKey)
    )
    .toBe(true);
  const tableTab = await activate('table', currentKey);
  receipt.tableTab = tableTab;
  const fullTable = page.locator(`[data-panel-content=${JSON.stringify(tableTab.panelId)}]`);
  const edit = async (grid, row, col, value) => {
    const cell = grid.locator(`[data-cell-position="${row},${col}"]`);
    await cell.dblclick();
    await cell.locator('input').fill(value);
    await page.keyboard.press('Enter');
    await expect(cell).toHaveText(value);
  };
  const fileValue = async () => {
    const copy = await inspectFile();
    return !copy.dirty && !copy.saving && JSON.parse(copy.content).snapshot.data.cells[0][1].value;
  };
  await edit(fullTable.getByTestId('table-grid'), 0, 1, 'live-edit-one');
  await page.keyboard.press(`${modifier}+S`);
  await expect.poll(fileValue).toBe('live-edit-one');
  const insert = async (binding, display) => {
    await activate('table', currentKey);
    await fullTable.getByRole('button', { name: 'Insert in notebook…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Insert in notebook', exact: true });
    await dialog.getByLabel('Notebook', { exact: true }).selectOption(targetId);
    await dialog.getByLabel('Reference', { exact: true }).selectOption({ label: binding });
    await dialog.getByLabel('Display', { exact: true }).selectOption({ label: display });
    await dialog.getByRole('button', { name: 'Insert reference', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  const target = page.locator(`[data-page-id=${JSON.stringify(targetId)}]`);
  const saveTarget = async () => {
    await activate('page', targetId);
    await target.locator('.tiptap[contenteditable="true"]').focus();
    await page.keyboard.press(`${modifier}+S`);
    await expect.poll(async () => (await inspectNotebook(targetId)).dirty).toBe(false);
  };
  await insert('Live table', 'Embed');
  await expect
    .poll(async () => references((await inspectNotebook(targetId)).copy.content).length)
    .toBe(1);
  await saveTarget();
  const live = placement(target, currentKey);
  await expect(live.getByTestId('table-grid')).toBeVisible();
  await expect(live.locator('[data-cell-position="0,1"]')).toHaveText('live-edit-one');
  await insert('Saved version', 'Embed');
  await expect
    .poll(async () => references((await inspectNotebook(targetId)).copy.content).length)
    .toBe(2);
  await saveTarget();
  const savedReferences = references((await inspectNotebook(targetId)).copy.content);
  const pinnedReference = savedReferences.find(
    (value) => value.reference.binding.kind === 'saved-version'
  ).reference;
  const pinnedKey = await page.evaluate(
    async (reference) =>
      (await import('/src/shared/table-document-reference.ts')).tableDocumentKey(reference),
    pinnedReference
  );
  receipt.pinnedReference = pinnedReference;
  receipt.pinnedKey = pinnedKey;
  const pinned = placement(target, pinnedKey);
  await expect(pinned.getByTestId('table-grid')).toHaveAttribute('data-read-only', 'true');
  await expect(pinned.locator('[data-cell-position="0,1"]')).toHaveText('live-edit-one');
  await insert('Live table', 'Link');
  await expect
    .poll(async () => references((await inspectNotebook(targetId)).copy.content).length)
    .toBe(3);
  await saveTarget();
  const link = placement(target, currentKey, 'link');
  await expect(link.getByRole('button', { name: 'Open table', exact: true })).toBeVisible();
  await expect(link.getByTestId('table-grid')).toHaveCount(0);
  await capture('live-pinned-and-link-placements');
  const targetSavedBefore = await inspectNotebook(targetId);
  await edit(live.getByTestId('table-grid'), 0, 1, 'embed-edited-twice');
  await page.keyboard.press(`${modifier}+S`);
  await expect.poll(fileValue).toBe('embed-edited-twice');
  assert.equal((await inspectNotebook(targetId)).dirty, false);
  assert.deepEqual(
    references((await inspectNotebook(targetId)).copy.content),
    references(targetSavedBefore.copy.content)
  );
  await expect(pinned.locator('[data-cell-position="0,1"]')).toHaveText('live-edit-one');
  await activate('table', currentKey);
  await expect(fullTable.locator('[data-cell-position="0,1"]')).toHaveText('embed-edited-twice');
  await capture('shared-live-edit-pin-retained');
  const movedRoot = join(dirname(packageRoot), 'Moved acceptance table');
  const moved = await page.evaluate(
    async ({ workspaceRoot, oldPath, newPath }) =>
      (await import('/src/platform/index.ts'))
        .platform()
        .workspace.relocateEntityFile({ workspaceRoot, oldPath, newPath }),
    { workspaceRoot, oldPath: packageRoot, newPath: movedRoot }
  );
  assert.equal(moved.newPath, movedRoot);
  await expect
    .poll(async () => (await inspectFile()).path)
    .toBe(join(movedRoot, '.forge', 'table.json'));
  await edit(fullTable.getByTestId('table-grid'), 0, 1, 'saved-after-move');
  await page.keyboard.press(`${modifier}+S`);
  await expect.poll(fileValue).toBe('saved-after-move');
  const movedBytes = readFileSync(join(movedRoot, '.forge', 'table.json'), 'utf8');
  assert.equal(JSON.parse(movedBytes).id, reference.documentId);
  assert.equal(JSON.parse(movedBytes).snapshot.data.cells[0][0].value, 'baseline-retained');
  writeFileSync(join(out, 'moved-saved-head.json'), movedBytes);
  await activate('page', targetId);
  await expect(live.locator('[data-cell-position="0,1"]')).toHaveText('saved-after-move');
  await expect(pinned.locator('[data-cell-position="0,1"]')).toHaveText('live-edit-one');
  await capture('moved-table-current-and-pin');
  receipt.movedRoot = movedRoot;
  receipt.expectedLive = 'saved-after-move';
  receipt.expectedPinned = 'live-edit-one';
  receipt.source = await inspect();
  receipt.target = await inspectNotebook(targetId);
  receipt.file = await inspectFile();
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
console.log(`TABLE_REFERENCES_${receipt.status.toUpperCase()} ${join(out, 'receipt.json')}`);
if (receipt.error) console.error(receipt.error);

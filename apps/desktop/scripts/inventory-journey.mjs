import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const stage = args.includes('--stage') ? option('--stage') : 'doctor';
assert.ok(
  ['doctor', 'before', 'journey', 'reopen'].includes(stage),
  'Choose doctor, before, journey or reopen.'
);
const out = args.includes('--out') ? path.resolve(option('--out')) : null;
assert.ok(out, 'Pass --out with an evidence directory outside the checkout.');
assert.ok(!out.startsWith(`${root}${path.sep}`), 'Keep evidence outside the checkout.');
mkdirSync(out, { recursive: true });
const settings = Object.fromEntries(
  readFileSync(path.join(root, 'apps/desktop/.env.local'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => line.split('='))
);
const rendererPort = Number(settings.DESKTOP_DEV_PORT);
const debugPort = Number(settings.DESKTOP_DEBUG_PORT);
assert.ok(rendererPort && debugPort, 'Configure explicit renderer and debug ports.');
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
  cwd: root,
  encoding: 'utf8',
})
  .split('\0')
  .filter((file) => /inventory|feature-registry|shared\/activity-view/u.test(file));
const source = [...new Set(files)].sort().map((file) => ({
  file,
  sha256: createHash('sha256')
    .update(readFileSync(path.join(root, file)))
    .digest('hex'),
}));
const receipt = {
  schema: 'dnaforge.inventory-desktop-journey.v1',
  stage,
  status: 'running',
  startedAt: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source,
  observations: [],
};
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
let page;
let recording;

async function startRecording() {
  const directory = path.join(out, 'original-frames');
  mkdirSync(directory, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const frames = [];
  session.on('Page.screencastFrame', (event) => {
    const file = path.join(directory, `${String(frames.length).padStart(6, '0')}.png`);
    writeFileSync(file, Buffer.from(event.data, 'base64'));
    frames.push({ file, timestamp: event.metadata.timestamp ?? Date.now() / 1000 });
    void session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
  });
  await session.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return { session, frames };
}

async function stopRecording() {
  if (!recording) return;
  await recording.session.send('Page.stopScreencast');
  await recording.session.detach();
  const frames = recording.frames;
  writeFileSync(path.join(out, 'original-frame-timestamps.json'), JSON.stringify(frames, null, 2));
  if (frames.length < 2) throw new Error('The interaction video did not capture enough frames.');
  const quote = (file) => file.replaceAll("'", "'\\''");
  const concat =
    frames
      .map((frame, index) => {
        const next = frames[index + 1];
        const duration = next ? Math.max(0.001, next.timestamp - frame.timestamp) : 1;
        return `file '${quote(frame.file)}'\nduration ${duration}\n`;
      })
      .join('') + `file '${quote(frames.at(-1).file)}'\n`;
  writeFileSync(path.join(out, 'frames.concat'), concat);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    path.join(out, 'frames.concat'),
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    path.join(out, 'inventory-journey.mp4'),
  ]);
  receipt.video = { file: 'inventory-journey.mp4', originalFrames: frames.length };
}

async function capture(name, value) {
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  receipt.observations.push({ name, value });
  await page.waitForTimeout(500);
}

async function choose(scope, label, name) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function inventoryRead(scope) {
  return page.evaluate(
    async (input) => ({
      state: await window.electronAPI.inventory.inspect(input),
      history: await window.electronAPI.inventory.history({ ...input, limit: 100 }),
    }),
    scope
  );
}

async function openInventory(projectName) {
  const banner = page.getByRole('button', { name: 'Not now', exact: true });
  if (await banner.isVisible()) await banner.click();
  await page.getByTestId('inventory-button').click();
  await page.getByTestId('inventory-panel').waitFor();
  await choose(page, 'Inventory project', projectName);
  await expect(page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
}

try {
  page = browser
    .contexts()[0]
    .pages()
    .find((candidate) => {
      const url = new URL(candidate.url());
      return ['localhost', '127.0.0.1'].includes(url.hostname) && Number(url.port) === rendererPort;
    });
  assert.ok(page, 'The task renderer must be running on its configured port.');
  await page.waitForFunction(() => window.electronAPI?.runtime?.getProvenance);
  const runtime = await page.evaluate(async () => ({
    profile: window.electronAPI.runtime.getProfile(),
    provenance: await window.electronAPI.runtime.getProvenance(),
  }));
  assert.equal(runtime.profile.kind, 'scenario-e2e');
  assert.equal(path.resolve(runtime.provenance.projectRoot), root);
  receipt.runtime = runtime;
  if (stage === 'before') {
    await page.waitForFunction(() => window.__test?.setWorkspaceFoldersForTest);
    await expect(page.getByTestId('inventory-button')).toHaveCount(0);
    await page.screenshot({ path: path.join(out, 'before-inventory-workspace.png') });
    receipt.observations.push({ name: 'inventory activity absent', count: 0 });
  }
  if (stage === 'journey') {
    const projects = await page.evaluate(() => window.electronAPI.inventory.projects());
    const project = projects.find(
      (candidate) => candidate.name === 'My Project' && !candidate.pinned
    );
    assert.ok(project, 'Use the owned isolated profile’s writable My Project.');
    assert.ok(
      project.path.startsWith(`${runtime.provenance.userDataPath}/`),
      'The fixture project must belong to this isolated profile.'
    );
    const content = readFileSync(
      path.join(root, 'test-fixtures/sequences/circular/pUC19.gb'),
      'utf8'
    );
    const imported = await page.evaluate(
      async (input) => {
        const { platform } = await import('/src/platform/index.ts');
        return platform().workspace.registerImportedSequenceFromContent(input);
      },
      { content, fileName: 'inventory-acceptance-pUC19.gb', targetRoot: project.path }
    );
    assert.equal(imported.registered, true, JSON.stringify(imported));
    const materialId = imported.entityIds[0];
    const materialPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: materialId, limit: 100 }
    );
    const material = materialPage.items.find((item) => item.id === materialId);
    assert.ok(material, 'The native material picker must admit the imported scientific record.');
    const scope = { project: project.projectId, inventoryId: project.defaultInventoryId };
    assert.equal((await inventoryRead(scope)).state, null, 'Use a fresh inventory fixture.');
    receipt.fixture = {
      project,
      material,
      imported,
      sourceSha256: createHash('sha256').update(content).digest('hex'),
    };
    recording = await startRecording();
    await openInventory(project.name);
    await capture('01-empty-inventory', await page.getByTestId('inventory-panel').innerText());

    async function addLocation(name, positions, parent) {
      await page.getByRole('button', { name: 'Add location', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add location', exact: true });
      await dialog.getByLabel('Location name', { exact: true }).fill(name);
      await dialog.getByLabel('Position names', { exact: true }).fill(positions);
      if (parent) await choose(dialog, 'Location', parent);
      await dialog.getByRole('button', { name: 'Add location', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await addLocation('Freezer acceptance', 'Shelf 1');
    await addLocation('Box acceptance', 'A1, A2', 'Freezer acceptance');
    const hierarchy = await inventoryRead(scope);
    const box = Object.values(hierarchy.state.storage).find(
      (item) => item.name === 'Box acceptance'
    );
    assert.ok(box);
    await page.getByRole('treeitem').filter({ hasText: 'Box acceptance' }).click();
    await expect(page.getByTestId('inventory-positions')).toBeVisible();
    await capture('02-hierarchy', hierarchy);

    await page
      .getByTestId('inventory-panel')
      .locator('header')
      .getByRole('button', { name: 'Receive stock', exact: true })
      .click();
    const receive = page.getByRole('dialog', { name: 'Receive stock', exact: true });
    await receive.getByLabel('Find material', { exact: true }).fill(materialId);
    await choose(
      receive,
      'Material',
      new RegExp(material.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
    await receive.getByLabel('Container name', { exact: true }).fill('Tube acceptance');
    await choose(receive, 'Location', 'Freezer acceptance / Box acceptance');
    await choose(receive, 'Position', 'A1');
    await receive.getByLabel('Quantity', { exact: true }).fill('100');
    await capture('03-receive-form', { quantity: '100', unit: 'uL', position: 'A1' });
    await receive.getByRole('button', { name: 'Receive stock', exact: true }).click();
    await expect(receive).toBeHidden();
    const received = await inventoryRead(scope);
    const stock = Object.values(received.state.stocks).find(
      (item) => item.materialId === materialId
    );
    assert.ok(stock);
    assert.deepEqual(stock.quantity, { kind: 'known', value: '100', unit: 'uL' });
    assert.deepEqual(received.state.vessels[stock.vesselId].placement, {
      kind: 'located',
      storageId: box.id,
      slotId: 'A1',
    });
    await capture('04-received', received);

    const row = page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stock.id}"]`);
    await row.click();
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    const move = page.getByRole('dialog', { name: 'Move container', exact: true });
    await choose(move, 'Location', 'Freezer acceptance / Box acceptance');
    await choose(move, 'Position', 'A2');
    await move.getByRole('button', { name: 'Move container', exact: true }).click();
    await expect(move).toBeHidden();
    assert.deepEqual((await inventoryRead(scope)).state.vessels[stock.vesselId].placement, {
      kind: 'located',
      storageId: box.id,
      slotId: 'A2',
    });
    await capture('05-moved', await inventoryRead(scope));

    await page.getByRole('button', { name: 'Use stock', exact: true }).click();
    const use = page.getByRole('dialog', { name: 'Use stock', exact: true });
    await use.getByLabel('Quantity', { exact: true }).fill('20');
    await use.getByLabel('Reason', { exact: true }).fill('Inventory acceptance experiment');
    await capture('06-use-form', { quantity: '20', unit: 'uL' });
    await use.getByRole('button', { name: 'Use stock', exact: true }).click();
    await expect(use).toBeHidden();
    const used = await inventoryRead(scope);
    assert.deepEqual(used.state.stocks[stock.id].quantity, {
      kind: 'known',
      value: '80',
      unit: 'uL',
    });
    assert.equal(
      used.history
        .flatMap((entry) => entry.request.commands)
        .filter((command) => command.kind === 'consume').length,
      1
    );
    await expect(row).toContainText('80 µL');
    await page.getByRole('button', { name: 'History', exact: true }).last().click();
    await expect(page.getByTestId('inventory-history')).toContainText('Used 20 µL');
    await capture('07-used-history', used);
    receipt.expected = {
      scope,
      stockId: stock.id,
      vesselId: stock.vesselId,
      boxId: box.id,
      state: used.state,
      history: used.history,
    };
    writeFileSync(
      path.join(out, 'reopen-fixture.json'),
      JSON.stringify({ project, ...receipt.expected }, null, 2)
    );
  }
  if (stage === 'reopen') {
    assert.ok(args.includes('--fixture'), 'Pass --fixture from the completed journey.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(
      fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`),
      'Reopen the original isolated profile.'
    );
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const readback = await inventoryRead(fixture.scope);
    assert.deepEqual(readback.state, fixture.state);
    assert.deepEqual(readback.history, fixture.history);
    const row = page
      .getByTestId('inventory-stock-table')
      .locator(`[data-stock-id="${fixture.stockId}"]`);
    await expect(row).toContainText('80 µL');
    await expect(row).toContainText('Box acceptance');
    await expect(row).not.toContainText('Loading material');
    await row.click();
    await page.getByRole('button', { name: 'History', exact: true }).last().click();
    await expect(page.getByTestId('inventory-history')).toContainText('Used 20 µL');
    await capture('08-reopened', readback);
  }
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.failure = error instanceof Error ? error.stack : String(error);
  if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  try {
    await stopRecording();
  } catch (error) {
    receipt.status = 'failed';
    receipt.videoFailure = String(error);
    process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ stage, status: receipt.status, out, failure: receipt.failure }));

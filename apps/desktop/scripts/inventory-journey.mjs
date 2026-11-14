import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { runInventoryCompositionJourney } from './journeys/inventory-composition.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const stage = args.includes('--stage') ? option('--stage') : 'doctor';
assert.ok(
  [
    'doctor',
    'before',
    'journey',
    'reopen',
    'materials',
    'material-reopen',
    'lineage',
    'layouts',
    'composition',
    'composition-reopen',
  ].includes(stage),
  'Choose a mapped inventory journey stage.'
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
const files = execFileSync(
  'git',
  [
    'ls-files',
    '-co',
    '--exclude-standard',
    '-z',
    '--',
    ':(glob)**/*inventory*',
    'apps/desktop/src/features/inventory',
    'apps/desktop/src/feature-registry',
    'apps/desktop/src/shared/activity-view.ts',
    'apps/desktop/src/main/features/native-documents.ts',
    'apps/desktop/src/main/native-document-command-server.ts',
    'apps/desktop/src/main/agent-grant-authority.ts',
    'apps/desktop/src/preload',
    'apps/desktop/src/platform',
    'apps/api/src/native_workflow_tools.py',
    'packages/core/agent-tools/renderer-tool-manifest.json',
  ],
  {
    cwd: root,
    encoding: 'utf8',
  }
)
  .split('\0')
  .filter(Boolean);
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
  if (stage === 'materials') {
    assert.ok(args.includes('--fixture'), 'Pass the earlier native journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    const { project, scope } = fixture;
    assert.ok(
      project.path.startsWith(`${runtime.provenance.userDataPath}/`),
      'Use the original isolated profile.'
    );
    const initial = await inventoryRead(scope);
    assert.equal(initial.state.stocks[fixture.stockId].quantity.value, '80');
    const materialId = initial.state.stocks[fixture.stockId].materialId;
    const materialPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: materialId, limit: 100 }
    );
    const material = materialPage.items.find((item) => item.id === materialId);
    assert.ok(material);
    receipt.fixture = { project, material, initial };
    recording = await startRecording();
    await openInventory(project.name);
    await capture('01-before-material-operations', initial);
    let readback = initial;
    let lot = Object.values(initial.state.lots).find(
      (item) => item.name === 'Supplier lot acceptance'
    );
    let stock = Object.values(initial.state.stocks).find(
      (item) => item.source.kind === 'lot' && item.source.lotId === lot?.id
    );
    let aliquot = Object.values(initial.state.stocks).find(
      (item) => initial.state.vessels[item.vesselId].name === 'Aliquot acceptance'
    );
    const poolBefore = Object.values(initial.state.lots).find(
      (item) => item.name === 'Pooled acceptance'
    );
    let pooled = Object.values(initial.state.stocks).find(
      (item) => item.source.kind === 'lot' && item.source.lotId === poolBefore?.id
    );
    let dialog;
    const row = (id) =>
      page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`);
    if (args.includes('--resume')) {
      assert.ok(
        lot && stock && aliquot && pooled,
        'Resume only after the captured successful pooling checkpoint.'
      );
      assert.equal(initial.state.stocks[stock.id].quantity.value, '65');
      assert.equal(initial.state.stocks[aliquot.id].quantity.value, '15');
      assert.equal(initial.state.stocks[pooled.id].quantity.value, '20');
    } else {
      await page.getByRole('button', { name: 'Add lot', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Add lot or preparation', exact: true });
      await dialog.getByLabel('Batch name', { exact: true }).fill('Supplier lot acceptance');
      await dialog.getByLabel('Find output material', { exact: true }).fill(materialId);
      await choose(dialog, 'Output material', new RegExp(material.name));
      await dialog.getByLabel('Supplier', { exact: true }).fill('Synthetic supplier');
      await dialog.getByLabel('Supplier lot number', { exact: true }).fill('ACCEPTANCE-123');
      await dialog.getByRole('button', { name: 'Add lot or preparation', exact: true }).click();
      await expect(dialog).toBeHidden();
      readback = await inventoryRead(scope);
      lot = Object.values(readback.state.lots).find(
        (item) => item.name === 'Supplier lot acceptance'
      );
      assert.ok(lot);
      await page
        .getByTestId('inventory-panel')
        .locator('header')
        .getByRole('button', { name: 'Receive stock', exact: true })
        .click();
      dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
      await dialog.getByLabel('Find material', { exact: true }).fill(materialId);
      await choose(dialog, 'Material', new RegExp(material.name));
      await choose(dialog, 'Lot or preparation', 'Supplier lot acceptance');
      await dialog.getByLabel('Container name', { exact: true }).fill('Supplier tube acceptance');
      await dialog.getByLabel('Quantity', { exact: true }).fill('100');
      await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
      await expect(dialog).toBeHidden();
      readback = await inventoryRead(scope);
      stock = Object.values(readback.state.stocks).find(
        (item) => item.source.kind === 'lot' && item.source.lotId === lot.id
      );
      assert.ok(stock);

      await row(stock.id).click();
      await page.getByRole('button', { name: 'Container limits', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Container limits', exact: true });
      await dialog.getByLabel('Capacity (µL)', { exact: true }).fill('200');
      await dialog.getByLabel('Dead volume (µL)', { exact: true }).fill('10');
      await dialog
        .getByLabel('Reason', { exact: true })
        .fill('Verified synthetic container specification');
      await dialog.getByRole('button', { name: 'Container limits', exact: true }).click();
      await expect(dialog).toBeHidden();
      await capture('02-received-lot-and-limits', await inventoryRead(scope));
      await page.getByRole('button', { name: 'Transfer or aliquot', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Transfer or aliquot', exact: true });
      await dialog.getByLabel('Source amount (µL)', { exact: true }).fill('20');
      await dialog
        .getByLabel('Destination container name', { exact: true })
        .fill('Aliquot acceptance');
      await dialog.getByLabel('Reason', { exact: true }).fill('Prepare working aliquot');
      await dialog.getByRole('button', { name: 'Transfer or aliquot', exact: true }).click();
      await expect(dialog).toBeHidden();
      readback = await inventoryRead(scope);
      aliquot = Object.values(readback.state.stocks).find(
        (item) => readback.state.vessels[item.vesselId].name === 'Aliquot acceptance'
      );
      assert.ok(aliquot);
      assert.equal(readback.state.stocks[stock.id].quantity.value, '80');
      assert.equal(aliquot.quantity.value, '20');
      assert.deepEqual(aliquot.source, stock.source);
      await capture('03-aliquot-conserved', readback);
      await row(aliquot.id).click();
      await page.getByRole('button', { name: 'Pool stocks', exact: true }).click();
      dialog = page.getByRole('dialog', { name: 'Pool stocks', exact: true });
      await dialog.getByLabel('Source amount (µL)', { exact: true }).fill('5');
      await choose(dialog, 'Second stock', /^Supplier tube acceptance/);
      await dialog.getByLabel('Second amount (µL)', { exact: true }).fill('15');
      await dialog.getByLabel('Output batch name', { exact: true }).fill('Pooled acceptance');
      await dialog.getByLabel('Find output material', { exact: true }).fill(materialId);
      await choose(dialog, 'Output material', new RegExp(material.name));
      await dialog
        .getByLabel('Destination container name', { exact: true })
        .fill('Pooled tube acceptance');
      await dialog.getByLabel('Reason', { exact: true }).fill('Pool working preparations');
      await dialog.getByRole('button', { name: 'Pool stocks', exact: true }).click();
      await expect(dialog).toBeHidden();
      readback = await inventoryRead(scope);
      const pooledLot = Object.values(readback.state.lots).find(
        (item) => item.name === 'Pooled acceptance'
      );
      pooled = Object.values(readback.state.stocks).find(
        (item) => item.source.kind === 'lot' && item.source.lotId === pooledLot?.id
      );
      assert.ok(pooled);
      assert.equal(pooled.quantity.value, '20');
      assert.equal(readback.state.stocks[stock.id].quantity.value, '65');
      assert.equal(readback.state.stocks[aliquot.id].quantity.value, '15');
      assert.equal(pooledLot.origin.inputs.length, 2);
      await capture('04-pooled-conserved', readback);
    }
    const water = await page.evaluate(async () => {
      const { platform } = await import('/src/platform/index.ts');
      await platform().lims.defineSchema({
        kind: 'entity',
        name: 'inventory-buffer-acceptance',
        displayName: 'Inventory buffer acceptance',
        fields: [{ key: 'description', label: 'Description', type: 'text' }],
      });
      return platform().lims.registerEntity({
        kind: 'inventory-buffer-acceptance',
        name: 'Water acceptance',
        fields: { description: 'Synthetic water inventory acceptance fixture' },
      });
    });
    const waterPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: water.id, limit: 100 }
    );
    assert.ok(
      waterPage.items.some((item) => item.id === water.id),
      'The tracked diluent fixture must be a real admitted material.'
    );
    await page
      .getByTestId('inventory-panel')
      .locator('header')
      .getByRole('button', { name: 'Receive stock', exact: true })
      .click();
    dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
    await dialog.getByLabel('Find material', { exact: true }).fill(water.id);
    await choose(dialog, 'Material', /^Water acceptance/);
    await dialog.getByLabel('Container name', { exact: true }).fill('Water tube acceptance');
    await dialog.getByLabel('Quantity', { exact: true }).fill('100');
    await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
    await expect(dialog).toBeHidden();
    await row(pooled.id).click();
    await page.getByRole('button', { name: 'Dilute stock', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Dilute stock', exact: true });
    await dialog.getByLabel('Sample amount (µL)', { exact: true }).fill('10');
    await choose(dialog, 'Tracked diluent', /^Water tube acceptance/);
    await dialog.getByLabel('Diluent amount (µL)', { exact: true }).fill('30');
    await dialog.getByLabel('Output batch name', { exact: true }).fill('Diluted acceptance');
    await dialog.getByLabel('Find output material', { exact: true }).fill(materialId);
    await choose(dialog, 'Output material', new RegExp(material.name));
    await dialog
      .getByLabel('Destination container name', { exact: true })
      .fill('Diluted tube acceptance');
    await dialog.getByLabel('Reason', { exact: true }).fill('Prepare diluted working solution');
    await dialog.getByRole('button', { name: 'Dilute stock', exact: true }).click();
    await expect(dialog).toBeHidden();
    readback = await inventoryRead(scope);
    const dilutedLot = Object.values(readback.state.lots).find(
      (item) => item.name === 'Diluted acceptance'
    );
    const diluted = Object.values(readback.state.stocks).find(
      (item) => item.source.kind === 'lot' && item.source.lotId === dilutedLot?.id
    );
    assert.ok(diluted);
    assert.equal(diluted.quantity.value, '40');
    assert.equal(readback.state.stocks[pooled.id].quantity.value, '10');
    const waterStock = Object.values(readback.state.stocks).find(
      (item) => item.materialId === water.id
    );
    assert.equal(waterStock.quantity.value, '70');
    assert.equal(dilutedLot.origin.sample.quantity.value, '10');
    assert.equal(dilutedLot.origin.diluent.quantity.value, '30');
    await row(diluted.id).click();
    await page.getByRole('button', { name: 'History', exact: true }).last().click();
    await expect(page.getByTestId('inventory-history')).toContainText(
      'Diluted stock into Diluted acceptance'
    );
    await capture('05-diluted-conserved-and-history', readback);
    receipt.expected = {
      state: readback.state,
      history: readback.history,
      water,
      lotId: lot.id,
      stockId: stock.id,
      aliquotId: aliquot.id,
      pooledId: pooled.id,
      dilutedId: diluted.id,
    };
    writeFileSync(
      path.join(out, 'material-reopen-fixture.json'),
      JSON.stringify({ project, scope, ...receipt.expected }, null, 2)
    );
  }

  if (stage === 'composition') {
    assert.ok(args.includes('--fixture'), 'Pass the material journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    receipt.expected = await runInventoryCompositionJourney({
      page,
      expect,
      choose,
      inventoryRead,
      capture,
      fixture,
    });
    writeFileSync(
      path.join(out, 'composition-reopen-fixture.json'),
      JSON.stringify(receipt.expected, null, 2)
    );
  }
  if (stage === 'composition-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the completed composition fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    assert.ok(fixture.project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    recording = await startRecording();
    await openInventory(fixture.project.name);
    const after = await inventoryRead(fixture.scope);
    assert.deepEqual(after.state, fixture.state);
    assert.deepEqual(after.history, fixture.history);
    await page
      .getByTestId('inventory-stock-table')
      .locator(`[data-stock-id="${fixture.stockId}"]`)
      .click();
    await expect(page.getByTestId('inventory-stock-composition')).toContainText('1/3 ng/µL');
    await expect(page.getByTestId('inventory-lot-contributions')).toContainText('1 ng/µL');
    await capture('05-reopened-exact-composition-and-input-history', after);
  }
  if (stage === 'layouts') {
    assert.ok(args.includes('--fixture'), 'Pass the workspace journey fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    const { project, scope } = fixture;
    assert.ok(project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    const initial = await inventoryRead(scope);
    const materialId = initial.state.stocks[fixture.stockId].materialId;
    const materialPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: materialId, limit: 100 }
    );
    const material = materialPage.items.find((item) => item.id === materialId);
    assert.ok(material);
    recording = await startRecording();
    await openInventory(project.name);
    async function addLayout(name, kind) {
      await page.getByRole('button', { name: 'Add location', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add location', exact: true });
      await dialog.getByLabel('Location name', { exact: true }).fill(name);
      await choose(dialog, 'Position layout', kind);
      if (kind === 'Ordered stack')
        await dialog.getByLabel('Stack capacity', { exact: true }).fill('2');
      else {
        await dialog.getByLabel('Rows', { exact: true }).fill('2');
        await dialog.getByLabel('Columns', { exact: true }).fill('3');
      }
      await choose(dialog, 'Location', 'Top level');
      await dialog.getByRole('button', { name: 'Add location', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await addLayout('Plate stack acceptance', 'Ordered stack');
    await addLayout('Well plate acceptance', 'Well plate');
    await addLayout('Top plate acceptance', 'Well plate');
    await addLayout('Tube box acceptance', 'Tube box');
    let readback = await inventoryRead(scope);
    const named = (name) =>
      Object.values(readback.state.storage).find((item) => item.name === name);
    const plate = named('Well plate acceptance');
    const top = named('Top plate acceptance');
    const stack = named('Plate stack acceptance');
    const box = named('Tube box acceptance');
    assert.ok(plate && top && stack && box);
    const wells = Object.values(readback.state.vessels).filter(
      (item) => item.kind === 'fixed-well' && item.placement.storageId === plate.id
    );
    assert.equal(wells.length, 6);
    await page.getByRole('treeitem').filter({ hasText: 'Well plate acceptance' }).click();
    await expect(page.getByTestId('inventory-positions').locator('[data-position-id]')).toHaveCount(
      6
    );
    await capture('01-permanent-six-well-plate', readback);
    await page.getByTestId('inventory-positions').locator('[data-position-id="A1"]').click();
    let dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
    await dialog.getByLabel('Find material', { exact: true }).fill(materialId);
    await choose(dialog, 'Material', new RegExp(material.name));
    await dialog.getByLabel('Quantity', { exact: true }).fill('25');
    await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
    await expect(dialog).toBeHidden();
    readback = await inventoryRead(scope);
    const well = wells.find((item) => item.placement.slotId === 'A1');
    const stock = Object.values(readback.state.stocks).find((item) => item.vesselId === well.id);
    assert.ok(stock);
    await page
      .getByTestId('inventory-stock-table')
      .locator(`[data-stock-id="${stock.id}"]`)
      .click();
    await expect(
      page.getByTestId('inventory-detail-drawer').getByRole('button', { name: 'Move', exact: true })
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId('inventory-detail-drawer')
        .getByRole('button', { name: 'Dispose container', exact: true })
    ).toHaveCount(0);
    await expect(page.getByTestId('inventory-detail-drawer')).toContainText(
      'This well moves with its plate'
    );
    await capture('02-fixed-well-stock-and-actions', readback);
    await page.getByRole('button', { name: 'Close stock details', exact: true }).click();
    async function moveIntoStack(name) {
      await page.getByRole('treeitem').filter({ hasText: name }).click();
      await page.getByRole('button', { name: 'Move location', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Move location', exact: true });
      await choose(dialog, 'Location', 'Plate stack acceptance');
      await dialog.getByRole('button', { name: 'Move location', exact: true }).click();
      await expect(dialog).toBeHidden();
    }
    await moveIntoStack('Well plate acceptance');
    await moveIntoStack('Top plate acceptance');
    readback = await inventoryRead(scope);
    assert.deepEqual(readback.state.vessels[well.id].placement, well.placement);
    assert.deepEqual(readback.state.storage[plate.id].placement, {
      kind: 'located',
      storageId: stack.id,
      slotId: '1',
    });
    assert.deepEqual(readback.state.storage[top.id].placement, {
      kind: 'located',
      storageId: stack.id,
      slotId: '2',
    });
    await page.getByRole('treeitem').filter({ hasText: 'Plate stack acceptance' }).first().click();
    await capture('03-ordered-two-plate-stack', readback);
    await page.getByRole('treeitem').filter({ hasText: 'Well plate acceptance' }).click();
    await page.getByRole('button', { name: 'Move location', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Move location', exact: true });
    await choose(dialog, 'Location', 'Top level');
    await dialog.getByRole('button', { name: 'Move location', exact: true }).click();
    await expect(dialog.getByTestId('inventory-refused')).toContainText('top item');
    assert.deepEqual(await inventoryRead(scope), readback);
    await capture('04-buried-plate-removal-refused', await dialog.innerText());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .getByTestId('inventory-refused')
      .getByRole('button', { name: 'Edit change', exact: true })
      .click();
    await page.getByRole('treeitem').filter({ hasText: 'Top plate acceptance' }).click();
    await page.getByRole('button', { name: 'Move location', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Move location', exact: true });
    await choose(dialog, 'Location', 'Top level');
    await dialog.getByRole('button', { name: 'Move location', exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('treeitem').filter({ hasText: 'Well plate acceptance' }).click();
    await page.getByRole('button', { name: 'Dispose plate', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Dispose', exact: true });
    await dialog.getByLabel('Reason', { exact: true }).fill('Dispose completed acceptance plate');
    await dialog.getByRole('button', { name: 'Dispose', exact: true }).click();
    await expect(dialog).toBeHidden();
    readback = await inventoryRead(scope);
    assert.equal(readback.state.storage[plate.id].lifecycle, 'disposed');
    for (const old of wells) assert.equal(readback.state.vessels[old.id].lifecycle, 'disposed');
    assert.equal(readback.state.stocks[stock.id].quantity.value, '25');
    await page.getByRole('button', { name: 'Disposed', exact: true }).click();
    await expect(
      page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stock.id}"]`)
    ).toContainText('25 µL');
    await capture('05-aggregate-disposal-retains-history', readback);
    receipt.expected = {
      state: readback.state,
      history: readback.history,
      plateId: plate.id,
      stockId: stock.id,
      wellIds: wells.map((item) => item.id),
      stackId: stack.id,
    };
  }

  if (stage === 'lineage') {
    assert.ok(args.includes('--fixture'), 'Pass the material workflow fixture.');
    const fixture = JSON.parse(readFileSync(path.resolve(option('--fixture')), 'utf8'));
    const { project, scope } = fixture;
    assert.ok(project.path.startsWith(`${runtime.provenance.userDataPath}/`));
    const before = await inventoryRead(scope);
    const source = before.state.stocks[fixture.stockId];
    const aliquot = before.state.stocks[fixture.aliquotId];
    const materialPage = await page.evaluate(
      (input) => window.electronAPI.inventory.materials(input),
      { project: project.projectId, query: source.materialId, limit: 100 }
    );
    const material = materialPage.items.find((item) => item.id === source.materialId);
    assert.ok(material);
    recording = await startRecording();
    await openInventory(project.name);
    const row = (id) =>
      page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`);
    await row(source.id).click();
    await page.getByRole('button', { name: 'Record preparation', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Add lot or preparation', exact: true });
    await dialog.getByLabel('Batch name', { exact: true }).fill('Preparation acceptance');
    await dialog.getByLabel('Find output material', { exact: true }).fill(source.materialId);
    await choose(dialog, 'Output material', new RegExp(material.name));
    await choose(dialog, 'Batch origin', 'Internal preparation');
    await dialog
      .getByLabel('Preparation method', { exact: true })
      .fill('Synthetic preparation with a recorded source identity');
    await dialog.getByRole('button', { name: 'Add lot or preparation', exact: true }).click();
    await expect(dialog).toBeHidden();
    let after = await inventoryRead(scope);
    const preparation = Object.values(after.state.lots).find(
      (lot) => lot.name === 'Preparation acceptance'
    );
    assert.ok(preparation);
    assert.deepEqual(after.state.stocks[source.id].quantity, source.quantity);
    assert.deepEqual(preparation.origin.inputs[0].source, source.source);
    await capture('01-preparation-without-implied-withdrawal', after);
    await page.getByRole('button', { name: 'Assign lot', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Assign lot', exact: true });
    await choose(dialog, 'Lot or preparation', 'Preparation acceptance');
    await dialog.getByLabel('Reason', { exact: true }).fill('Explicit attribution correction');
    await dialog.getByRole('button', { name: 'Assign lot', exact: true }).click();
    await expect(dialog).toBeHidden();
    after = await inventoryRead(scope);
    assert.deepEqual(after.state.stocks[source.id].source, { kind: 'lot', lotId: preparation.id });
    assert.deepEqual(after.state.stocks[aliquot.id].source, aliquot.source);
    assert.deepEqual(after.state.lots[preparation.id].origin.inputs[0].source, source.source);
    await capture('02-attributed-without-rewriting-aliquot', after);
    await page.getByRole('button', { name: 'Transfer or aliquot', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Transfer or aliquot', exact: true });
    await dialog.getByLabel('Source amount (µL)', { exact: true }).fill('1');
    await choose(dialog, 'Transfer destination', 'Existing compatible stock');
    await choose(dialog, 'Existing stock', /^Aliquot acceptance/);
    await dialog
      .getByLabel('Reason', { exact: true })
      .fill('Attempt incompatible attribution transfer');
    await dialog.getByRole('button', { name: 'Transfer or aliquot', exact: true }).click();
    await expect(dialog.getByTestId('inventory-refused')).toContainText('same material and lot');
    assert.deepEqual(await inventoryRead(scope), after);
    await capture('03-incompatible-transfer-refused', await dialog.innerText());
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .getByTestId('inventory-refused')
      .getByRole('button', { name: 'Edit change', exact: true })
      .click();
    receipt.expected = { state: after.state, history: after.history };
  }

  if (stage === 'material-reopen') {
    assert.ok(args.includes('--fixture'), 'Pass the completed material journey fixture.');
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
      .locator(`[data-stock-id="${fixture.dilutedId}"]`);
    await expect(row).toContainText('40 µL');
    await row.click();
    await expect(page.getByTestId('inventory-detail-drawer')).toContainText('Diluted acceptance');
    await page.getByRole('button', { name: 'History', exact: true }).last().click();
    await expect(page.getByTestId('inventory-history')).toContainText(
      'Diluted stock into Diluted acceptance'
    );
    await capture('06-materials-reopened', readback);
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

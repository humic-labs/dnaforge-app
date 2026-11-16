import { inventoryFixtureMetadataDefaults } from './inventory-fixture-metadata.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const columns =
  'source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot';
const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const skipReason = 'Synthetic explicit exclusion; this source row must not create or delete stock.';

async function open(ctx, project) {
  await ctx.page.getByTestId('inventory-button').click();
  await ctx.choose(ctx.page, 'Inventory project', project.name);
  await ctx.expect(ctx.page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
}

export async function previewInventoryReceiveTable(ctx, fixture, sourceText) {
  const { page, expect, choose } = ctx;
  await button(page.getByTestId('inventory-panel').locator('header'), 'Import table').click();
  const form = dialog(page, 'Receive inventory table');
  await form.getByLabel('Source namespace', { exact: true }).fill(fixture.namespace);
  await form.locator('summary').filter({ hasText: 'Paste or inspect table text' }).click();
  await form.getByLabel('Table source text', { exact: true }).fill(sourceText);
  assert.equal(
    await form.getByLabel('Table source text', { exact: true }).inputValue(),
    sourceText
  );
  await button(form, 'Preview table').click();
  await expect(form.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  for (const [key, materialId] of Object.entries(fixture.materials)) {
    await form.getByLabel('Search table scientific records', { exact: true }).fill(materialId);
    await choose(form, `Scientific record for ${key}`, new RegExp(materialId));
  }
  await choose(form, 'Location for freezer', new RegExp(fixture.box.id));
  await choose(form, 'Location for bench', 'Explicitly unplaced');
  await form.getByLabel('Search table destination vessels', { exact: true }).fill(fixture.well.id);
  await choose(
    form,
    'Existing vessel for well',
    new RegExp(fixture.well.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
  await form.getByLabel('Skip table source skipped-1', { exact: true }).check();
  await form.getByLabel('Skip reason for table source skipped-1', { exact: true }).fill(skipReason);
  await button(form, 'Preview table').click();
  await expect(form.getByTestId('inventory-table-import')).not.toHaveAttribute(
    'data-preview-state',
    'previewing'
  );
  return form;
}

export async function runInventoryTableJourney(ctx) {
  const { page, expect, choose, inventoryRead, capture, fixture: input, evidenceDirectory } = ctx;
  const project = input.project;
  const scope = input.scope;
  await open(ctx, project);
  const initial = await inventoryRead(scope);
  assert.deepEqual(initial.state, {
    ...input.state,
    ...inventoryFixtureMetadataDefaults(input.state),
  });
  assert.deepEqual(initial.history, input.history);
  await capture('01-before-canonical-table-receiving', initial);
  const materials = [
    ...new Set(Object.values(initial.state.stocks).map((stock) => stock.materialId)),
  ];
  assert.ok(
    materials.length >= 2,
    'Use two genuine scientific records already bound to this owned project.'
  );
  for (const [name, plate] of [
    ['Table receiving acceptance box', false],
    ['Table receiving acceptance plate', true],
  ]) {
    if (
      Object.values((await inventoryRead(scope)).state.storage).some((item) => item.name === name)
    )
      continue;
    await button(page.getByTestId('inventory-panel').locator('header'), 'Add location').click();
    const form = dialog(page, 'Add location');
    await form.getByLabel('Location name', { exact: true }).fill(name);
    if (plate) {
      await choose(form, 'Position layout', 'Well plate');
      await form.getByLabel('Rows', { exact: true }).fill('1');
      await form.getByLabel('Columns', { exact: true }).fill('1');
    } else await form.getByLabel('Position names', { exact: true }).fill('A, B, C');
    await button(form, 'Add location').click();
    await expect(form).toBeHidden();
  }
  const prepared = await inventoryRead(scope);
  const box = Object.values(prepared.state.storage).find(
    (item) => item.name === 'Table receiving acceptance box'
  );
  const plate = Object.values(prepared.state.storage).find(
    (item) => item.name === 'Table receiving acceptance plate'
  );
  const well = Object.values(prepared.state.vessels).find(
    (item) => item.kind === 'fixed-well' && item.placement.storageId === plate.id
  );
  assert.ok(box && plate && well);
  const rows = [
    '0007,"Table tube, alpha\nsecond line",sample,known,80,uL,usable,new,,freezer,A',
    '0008,Table zero tube,water,known,0,uL,quarantined,new,,bench,',
    '0009,,water,unknown,,,usable,existing,well,,',
    'skipped-1,Explicitly skipped tube,water,known,5,uL,usable,new,,bench,',
  ];
  const sourceText = '\uFEFF' + columns + '\n' + rows.join('\n') + '\n';
  const namespace = 'synthetic:desktop:stock-register:stable';
  const fixture = {
    project,
    scope,
    box,
    plate,
    well,
    materials: { sample: materials[0], water: materials[1] },
    namespace,
    rows,
    sourceText,
    prepared,
    initial,
  };
  writeFileSync(path.join(evidenceDirectory, 'source.csv'), sourceText);
  writeFileSync(
    path.join(evidenceDirectory, 'prepared-table-fixture.json'),
    JSON.stringify(fixture, null, 2)
  );
  await button(page.getByTestId('inventory-panel').locator('header'), 'Import table').click();
  let form = dialog(page, 'Receive inventory table');
  await form.getByLabel('Source namespace', { exact: true }).fill(namespace);
  await form.locator('summary').filter({ hasText: 'Paste or inspect table text' }).click();
  await form.getByLabel('Table source text', { exact: true }).fill(sourceText);
  assert.equal(
    await form.getByLabel('Table source text', { exact: true }).inputValue(),
    sourceText
  );
  await button(form, 'Preview table').click();
  await expect(form.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  assert.deepEqual(await inventoryRead(scope), prepared);
  await capture('02-unresolved-table-has-zero-inventory-effects', prepared);
  await button(form, 'Cancel').click();
  form = await previewInventoryReceiveTable(ctx, fixture, sourceText);
  await expect(form.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  await expect(
    form.getByTestId('inventory-table-rows').locator('[data-row-kind="create"]')
  ).toHaveCount(3);
  await expect(
    form.getByTestId('inventory-table-rows').locator('[data-row-kind="skipped"]')
  ).toHaveCount(1);
  const planDigest = await form
    .getByTestId('inventory-table-preview')
    .getAttribute('data-plan-digest');
  assert.match(planDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await inventoryRead(scope), prepared);
  await form.getByTestId('inventory-table-preview').scrollIntoViewIfNeeded();
  await capture('03-explicit-atomic-table-plan-with-three-stocks-and-one-skip', {
    fixture,
    planDigest,
  });
  await button(form, 'Receive table stocks').click();
  await expect(form).toBeHidden();
  const received = await inventoryRead(scope);
  assert.equal(received.state.revision, prepared.state.revision + 1);
  assert.equal(received.history.length, prepared.history.length + 1);
  const accepted = received.history.at(-1);
  assert.equal(accepted.request.kind, 'receive-table');
  assert.equal(accepted.request.sourceText, sourceText);
  assert.equal(accepted.request.expectedPlanDigest, planDigest);
  assert.deepEqual(accepted.request.options.skips, [{ sourceId: 'skipped-1', reason: skipReason }]);
  const binding = (id) =>
    Object.values(received.state.tableBindings).find(
      (item) => item.namespace === namespace && item.sourceId === id
    );
  const active = binding('0007');
  assert.ok(active && binding('0008') && binding('0009'));
  assert.equal(binding('skipped-1'), undefined);
  assert.equal(received.state.vessels[active.vesselId].name, 'Table tube, alpha\nsecond line');
  assert.deepEqual(received.state.stocks[active.stockId].quantity, {
    kind: 'known',
    value: '80',
    unit: 'uL',
  });
  assert.deepEqual(received.state.stocks[binding('0008').stockId].quantity, {
    kind: 'known',
    value: '0',
    unit: 'uL',
  });
  assert.deepEqual(received.state.stocks[binding('0009').stockId].quantity, { kind: 'unknown' });
  assert.equal(binding('0009').vesselId, well.id);
  await capture('04-received-once-with-stable-identities-known-zero-and-unknown', received);
  await page
    .getByTestId('inventory-stock-table')
    .locator(`[data-stock-id="${active.stockId}"]`)
    .click();
  await button(page, 'Use stock').click();
  const use = dialog(page, 'Use stock');
  await use.getByLabel('Quantity', { exact: true }).fill('10');
  await use
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic real desktop use after table receiving');
  await button(use, 'Use stock').click();
  await expect(use).toBeHidden();
  await button(page, 'Close stock details').click();
  const afterUse = await inventoryRead(scope);
  assert.deepEqual(afterUse.state.stocks[active.stockId].quantity, {
    kind: 'known',
    value: '70',
    unit: 'uL',
  });
  assert.deepEqual(afterUse.state.tableBindings, received.state.tableBindings);
  const reordered = columns + '\n' + [...rows].reverse().join('\n') + '\n';
  form = await previewInventoryReceiveTable(ctx, fixture, reordered);
  await expect(form.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  await expect(
    form.getByTestId('inventory-table-rows').locator('[data-row-kind="unchanged"]')
  ).toHaveCount(3);
  assert.deepEqual(await inventoryRead(scope), afterUse);
  await capture('05-reordered-source-keeps-consumed-stock-without-duplicates', afterUse);
  await button(form, 'Cancel').click();
  form = await previewInventoryReceiveTable(ctx, fixture, sourceText.replace(',80,uL,', ',90,uL,'));
  await expect(form.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  await expect(button(form, 'Receive table stocks')).toBeDisabled();
  assert.deepEqual(await inventoryRead(scope), afterUse);
  await capture('06-changed-row-requires-reconciliation-with-zero-effects', afterUse);
  await button(form, 'Cancel').click();
  await button(page.getByTestId('inventory-panel').locator('header'), 'History').click();
  const drawer = page.getByTestId('inventory-detail-drawer');
  const history = drawer
    .getByTestId('inventory-history')
    .locator(`[data-operation-id="${accepted.receipt.operationId}"]`);
  await expect(history).toContainText('Received inventory table');
  await history.locator('summary').click();
  assert.equal(
    await history.getByLabel('Retained receive table', { exact: true }).inputValue(),
    sourceText
  );
  await capture('07-retained-original-table-and-explicit-native-operation', { accepted });
  await button(drawer, 'Close stock details').click();
  const artifact = await page.evaluate(
    (input) => window.electronAPI.inventory.exportSnapshot({ ...input, format: 'native-v1' }),
    scope
  );
  assert.equal(hash(artifact.sourceText), artifact.sourceSha256);
  const exportedRequest = JSON.parse(artifact.sourceText)
    .content.history.map((row) => JSON.parse(row.requestJson))
    .find((request) => request.operationId === accepted.receipt.operationId);
  assert.deepEqual(exportedRequest, accepted.request);
  writeFileSync(
    path.join(evidenceDirectory, 'table-inventory.dnaforge-inventory.json'),
    artifact.sourceText
  );
  return {
    ...fixture,
    state: afterUse.state,
    history: afterUse.history,
    active,
    accepted,
    reordered,
    artifact,
    nativeDialogQualified: false,
  };
}

export async function runInventoryTableReopen(ctx) {
  const { fixture, inventoryRead, capture, expect, page } = ctx;
  await open(ctx, fixture.project);
  const actual = await inventoryRead(fixture.scope);
  assert.deepEqual(actual.state, {
    ...fixture.state,
    ...inventoryFixtureMetadataDefaults(fixture.state),
  });
  assert.deepEqual(actual.history, fixture.history);
  const artifact = await page.evaluate(
    (input) => window.electronAPI.inventory.exportSnapshot({ ...input, format: 'native-v1' }),
    fixture.scope
  );
  assert.equal(artifact.sourceText, fixture.artifact.sourceText);
  await capture('08-reopened-exact-table-state-history-and-archive-bytes', actual);
  const form = await previewInventoryReceiveTable(ctx, fixture, fixture.reordered);
  await expect(form.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(fixture.scope), actual);
  await capture('09-reopened-table-lifetime-bindings-still-prevent-duplicates', actual);
  await button(form, 'Cancel').click();
  return { ...fixture, ...actual, artifact };
}

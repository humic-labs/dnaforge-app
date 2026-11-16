import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inventoryFixtureMetadataDefaults } from './inventory-fixture-metadata.mjs';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const headers = [
  'source_id',
  'name',
  'layout_kind',
  'positions',
  'rows',
  'columns',
  'capacity',
  'parent_kind',
  'parent_key',
  'slot',
];
const csv = (value) => (/[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const source = (rows) =>
  '\uFEFF' + headers.join(',') + '\n' + rows.map((row) => row.map(csv).join(',')).join('\n') + '\n';

async function closeDrawer(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}

async function hierarchyDraft(ctx, fixture, sourceText) {
  const { page, choose, expect } = ctx;
  await closeDrawer(page);
  await button(page.getByTestId('inventory-panel').locator('header'), 'Import locations').click();
  const form = dialog(page, 'Import inventory hierarchy');
  await form.getByLabel('Hierarchy source namespace', { exact: true }).fill(fixture.namespace);
  await form.locator('summary').filter({ hasText: 'Paste or inspect hierarchy text' }).click();
  await form.getByLabel('Hierarchy table text', { exact: true }).fill(sourceText);
  assert.equal(
    await form.getByLabel('Hierarchy table text', { exact: true }).inputValue(),
    sourceText
  );
  await button(form, 'Preview hierarchy').click();
  await expect(form.getByTestId('inventory-hierarchy-import')).not.toHaveAttribute(
    'data-preview-state',
    'previewing'
  );
  if (fixture.externalParent) {
    await form
      .getByLabel('Search hierarchy parents', { exact: true })
      .fill(fixture.externalParent.id);
    await choose(form, 'Parent for existing-box', new RegExp(escaped(fixture.externalParent.id)));
    await button(form, 'Preview hierarchy').click();
    await expect(form.getByTestId('inventory-hierarchy-import')).not.toHaveAttribute(
      'data-preview-state',
      'previewing'
    );
  }
  return form;
}

export async function runInventoryHierarchyJourney(ctx) {
  const { page, expect, choose, inventoryRead, capture, evidenceDirectory, fixture: input } = ctx;
  const { project, scope } = input;
  const initial = await inventoryRead(scope);
  assert.deepEqual(initial.state, {
    ...input.state,
    ...inventoryFixtureMetadataDefaults(input.state),
  });
  assert.deepEqual(initial.history, input.history);
  const rows = [
    ['aa-top', 'Imported top plate', 'fixed-well', '', '1', '2', '', 'source', 'stack', '2'],
    ['plate', 'Imported nested plate', 'fixed-well', '', '2', '2', '', 'source', 'box', 'A1'],
    ['box', 'Imported grid box', 'grid', '', '2', '2', '', 'source', 'shelf', 'BoxA'],
    [
      'tube-box',
      'Imported tube box',
      'removable-tube',
      '',
      '2',
      '2',
      '',
      'source',
      'shelf',
      'TubeBox',
    ],
    [
      'external-child',
      'Imported external-parent child',
      'named',
      '["X"]',
      '',
      '',
      '',
      'existing',
      'existing-box',
      'C',
    ],
    ['zz-bottom', 'Imported bottom plate', 'fixed-well', '', '1', '2', '', 'source', 'stack', '1'],
    [
      'shelf',
      'Imported shelf',
      'named',
      '["BoxA","BoxB","Stack","TubeBox"]',
      '',
      '',
      '',
      'source',
      'freezer',
      'Shelf1',
    ],
    ['stack', 'Imported ordered stack', 'stack', '', '', '', '2', 'source', 'shelf', 'Stack'],
    ['freezer', 'Imported freezer label', 'named', '["Shelf1"]', '', '', '', 'root', '', ''],
  ];
  const namespace = 'synthetic:desktop:hierarchy:stable';
  const sourceText = source(rows);
  const fixture = {
    project,
    scope,
    rows,
    namespace,
    sourceText,
    externalParent: input.box,
    initial,
  };
  writeFileSync(path.join(evidenceDirectory, 'hierarchy.csv'), sourceText);
  await capture('01-before-hierarchy-import-with-existing-stock-and-source-history', initial);
  const form = await hierarchyDraft(ctx, fixture, sourceText);
  await expect(form.getByTestId('inventory-hierarchy-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  await expect(
    form.getByTestId('inventory-hierarchy-rows').locator('[data-row-kind="create"]')
  ).toHaveCount(9);
  await form.getByTestId('inventory-hierarchy-preview').scrollIntoViewIfNeeded();
  const digest = await form
    .getByTestId('inventory-hierarchy-preview')
    .getAttribute('data-plan-digest');
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await inventoryRead(scope), initial);
  await capture('02-explicit-shuffled-hierarchy-and-ordered-stack-plan-with-zero-effects', {
    rows,
    digest,
  });
  await button(form, 'Import hierarchy').click();
  await expect(form).toBeHidden();
  const imported = await inventoryRead(scope);
  assert.equal(imported.state.revision, initial.state.revision + 1);
  const accepted = imported.history.at(-1);
  assert.equal(accepted.request.kind, 'import-hierarchy');
  assert.equal(accepted.request.sourceText, sourceText);
  assert.equal(accepted.request.expectedPlanDigest, digest);
  const bindings = Object.values(imported.state.hierarchyBindings).filter(
    (binding) => binding.namespace === namespace
  );
  assert.equal(bindings.length, 9);
  const id = (sourceId) => bindings.find((binding) => binding.sourceId === sourceId).storageId;
  const wells = Object.values(imported.state.vessels).filter(
    (vessel) => vessel.kind === 'fixed-well' && vessel.placement.storageId === id('plate')
  );
  assert.equal(wells.length, 4);
  const well = wells.find((value) => value.placement.slotId === 'A1');
  assert.ok(well);
  assert.deepEqual(imported.state.storage[id('zz-bottom')].placement, {
    kind: 'located',
    storageId: id('stack'),
    slotId: '1',
  });
  assert.deepEqual(imported.state.storage[id('aa-top')].placement, {
    kind: 'located',
    storageId: id('stack'),
    slotId: '2',
  });
  assert.deepEqual(imported.state.storage[id('external-child')].placement, {
    kind: 'located',
    storageId: input.box.id,
    slotId: 'C',
  });
  await page.getByRole('treeitem').filter({ hasText: 'Imported ordered stack' }).first().click();
  await expect(page.getByTestId('inventory-positions')).toContainText('Imported top plate');
  await expect(page.getByTestId('inventory-positions')).toContainText('Imported bottom plate');
  await capture('03-imported-stack-order-and-permanent-well-ownership', imported);
  await button(page, 'All stock').click();
  await button(page.getByTestId('inventory-panel').locator('header'), 'Import table').click();
  let receive = dialog(page, 'Receive inventory table');
  const materialId = initial.state.stocks[input.active.stockId].materialId;
  const receiveText =
    'source_id,name,material_key,quantity_kind,quantity,unit,quality,vessel_kind,vessel_key,location_key,slot\nprimer-unknown,,sample,unknown,,,usable,existing,well,,\nprimer-tube,Imported hierarchy stock tube,sample,known,10,uL,usable,new,,tube-box,A1\n';
  await receive
    .getByLabel('Source namespace', { exact: true })
    .fill('synthetic:desktop:hierarchy:stocks');
  await receive.locator('summary').filter({ hasText: 'Paste or inspect table text' }).click();
  await receive.getByLabel('Table source text', { exact: true }).fill(receiveText);
  await button(receive, 'Preview table').click();
  await expect(receive.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  await receive.getByLabel('Search table scientific records', { exact: true }).fill(materialId);
  await choose(receive, 'Scientific record for sample', new RegExp(escaped(materialId)));
  await choose(receive, 'Location for tube-box', new RegExp(escaped(id('tube-box'))));
  await receive.getByLabel('Search table destination vessels', { exact: true }).fill(well.id);
  await choose(receive, 'Existing vessel for well', new RegExp(escaped(well.id)));
  await button(receive, 'Preview table').click();
  await expect(receive.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  await receive.getByTestId('inventory-table-preview').scrollIntoViewIfNeeded();
  assert.deepEqual(await inventoryRead(scope), imported);
  await capture('04-explicit-separate-stock-stage-into-created-well-and-tube-box', imported);
  await button(receive, 'Receive table stocks').click();
  await expect(receive).toBeHidden();
  const received = await inventoryRead(scope);
  const wellStock = Object.values(received.state.stocks).find(
    (stock) => stock.vesselId === well.id
  );
  assert.deepEqual(wellStock.quantity, { kind: 'unknown' });
  assert.equal(received.state.revision, imported.state.revision + 1);
  const checkpoint = {
    fixture,
    imported,
    received,
    accepted,
    bindings,
    well,
    wellStock,
    receiveText,
  };
  writeFileSync(
    path.join(evidenceDirectory, 'hierarchy-resume-fixture.json'),
    JSON.stringify({ project, scope, hierarchyCheckpoint: checkpoint }, null, 2)
  );
  return finishInventoryHierarchyJourney(ctx, checkpoint);
}

async function finishInventoryHierarchyJourney(ctx, checkpoint) {
  const { page, expect, choose, inventoryRead, capture, evidenceDirectory } = ctx;
  const { fixture, imported, accepted, bindings, well, wellStock, receiveText } = checkpoint;
  const { scope, rows, sourceText } = fixture;
  const id = (sourceId) => bindings.find((binding) => binding.sourceId === sourceId).storageId;
  await page.getByRole('treeitem').filter({ hasText: 'Imported grid box' }).first().click();
  await button(page, 'Move location').click();
  const move = dialog(page, 'Move location');
  await choose(move, 'Location', 'Imported freezer label / Shelf1 / Imported shelf');
  await choose(move, 'Position', 'BoxB');
  await button(move, 'Move location').click();
  await expect(move).toBeHidden();
  await closeDrawer(page);
  const afterMove = await inventoryRead(scope);
  assert.deepEqual(afterMove.state.hierarchyBindings, imported.state.hierarchyBindings);
  assert.deepEqual(afterMove.state.storage[id('box')].placement, {
    kind: 'located',
    storageId: id('shelf'),
    slotId: 'BoxB',
  });
  let compare = await hierarchyDraft(ctx, fixture, source([...rows].reverse()));
  await expect(compare.getByTestId('inventory-hierarchy-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(scope), afterMove);
  await capture('05-reordered-hierarchy-reimport-keeps-later-box-movement', afterMove);
  await button(compare, 'Cancel').click();
  compare = await hierarchyDraft(
    ctx,
    fixture,
    source(
      rows.map((row) =>
        row[0] === 'box'
          ? row.map((value, index) => (index === 1 ? 'Changed source box name' : value))
          : row
      )
    )
  );
  await expect(compare.getByTestId('inventory-hierarchy-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  await expect(button(compare, 'Import hierarchy')).toBeDisabled();
  assert.deepEqual(await inventoryRead(scope), afterMove);
  await capture('06-changed-hierarchy-source-requires-explicit-reconciliation', afterMove);
  await button(compare, 'Cancel').click();
  await button(page.getByTestId('inventory-panel').locator('header'), 'History').click();
  const drawer = page.getByTestId('inventory-detail-drawer');
  const history = drawer
    .getByTestId('inventory-history')
    .locator(`[data-operation-id="${accepted.receipt.operationId}"]`);
  await expect(history).toContainText('Imported inventory hierarchy');
  await history.locator('summary').click();
  assert.equal(
    await history.getByLabel('Retained hierarchy source', { exact: true }).inputValue(),
    sourceText
  );
  await capture('07-retained-original-hierarchy-source-and-one-native-operation', { accepted });
  await closeDrawer(page);
  const artifact = await page.evaluate(
    (scope) => window.electronAPI.inventory.exportSnapshot({ ...scope, format: 'native-v1' }),
    scope
  );
  writeFileSync(
    path.join(evidenceDirectory, 'hierarchy-inventory.dnaforge-inventory.json'),
    artifact.sourceText
  );
  return {
    ...fixture,
    ...afterMove,
    ids: Object.fromEntries(bindings.map((binding) => [binding.sourceId, binding.storageId])),
    well,
    wellStock,
    accepted,
    receiveText,
    artifact,
    nativeDialogQualified: false,
  };
}

export async function runInventoryHierarchyResume(ctx) {
  const checkpoint = ctx.fixture.hierarchyCheckpoint;
  assert.deepEqual(await ctx.inventoryRead(ctx.fixture.scope), checkpoint.received);
  await ctx.capture('04a-resumed-after-verified-hierarchy-and-stock-stages', checkpoint.received);
  return finishInventoryHierarchyJourney(ctx, checkpoint);
}

export async function runInventoryHierarchyReopen(ctx) {
  const { page, expect, fixture, inventoryRead, capture } = ctx;
  const current = await inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  const artifact = await page.evaluate(
    (scope) => window.electronAPI.inventory.exportSnapshot({ ...scope, format: 'native-v1' }),
    fixture.scope
  );
  assert.equal(artifact.sourceText, fixture.artifact.sourceText);
  assert.deepEqual(current.state.stocks[fixture.wellStock.id].quantity, { kind: 'unknown' });
  await capture('08-reopened-hierarchy-stack-wells-stock-and-exact-source-history', current);
  const form = await hierarchyDraft(ctx, fixture, source([...fixture.rows].reverse()));
  await expect(form.getByTestId('inventory-hierarchy-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(fixture.scope), current);
  await capture('09-reopened-hierarchy-source-bindings-still-prevent-duplicates', current);
  await button(form, 'Cancel').click();
  return { ...fixture, ...current, artifact };
}

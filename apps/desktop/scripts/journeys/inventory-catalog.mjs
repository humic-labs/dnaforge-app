import assert from 'node:assert/strict';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const physical = (page, id) =>
  page.locator(`[data-testid="inventory-physical-details"][data-item-id="${id}"]`);
const typeCard = (page, id) => page.locator(`article[data-type-version-id="${id}"]`);
const recipeCard = (page, id) => page.locator(`article[data-recipe-version-id="${id}"]`);
const catalogCard = (page, id) => page.locator(`article[data-catalog-id="${id}"]`);
const availability = (page, scope) =>
  page.evaluate((input) => window.electronAPI.inventory.availability(input), scope);

async function closeDetails(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function setup(ctx, tab = 'Types') {
  await closeDetails(ctx.page);
  const current = dialog(ctx.page, 'Inventory setup');
  if (!(await current.isVisible()))
    await button(
      ctx.page.getByTestId('inventory-panel').locator('header'),
      'Inventory setup'
    ).click();
  await current.getByRole('tab', { name: tab, exact: true }).click();
  await current.getByLabel('Search inventory setup', { exact: true }).fill('');
  return current;
}
async function submit(ctx, form, name) {
  await button(form, name).click();
  await ctx.expect(form).toBeHidden();
  await ctx.expect(ctx.page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
}
async function lifecycle(ctx, target, retire, reason) {
  await setup(ctx, target.kind === 'type-version' ? 'Types' : 'Equipment recipes');
  const card =
    target.kind === 'type-version'
      ? typeCard(ctx.page, target.versionId)
      : recipeCard(ctx.page, target.versionId);
  await button(card, retire ? 'Retire version' : 'Restore version').click();
  const form = dialog(ctx.page, retire ? 'Retire catalog version' : 'Restore catalog version');
  await form.getByLabel('Reason', { exact: true }).fill(reason);
  await submit(ctx, form, retire ? 'Retire catalog version' : 'Restore catalog version');
}
async function closeSetup(page) {
  await button(dialog(page, 'Inventory setup'), 'Close').click();
}
async function selectLocation(page, id) {
  await closeDetails(page);
  await page.locator(`[role="treeitem"][data-location-id="${id}"]`).click();
}

export async function runInventoryCatalogJourney(ctx) {
  const { page, expect, choose, inventoryRead, capture, fixture } = ctx;
  const { project, scope, ids, stockId } = fixture;
  const before = await inventoryRead(scope);
  assert.equal(before.state.schema, 'dnaforge.inventory.v8');
  assert.equal(before.state.revision, fixture.state.revision);
  for (const [id, row] of Object.entries(fixture.state.stocks))
    assert.deepEqual(before.state.stocks[id], row);
  const parentTarget = { kind: 'type-version', versionId: ids.parentV2 };
  await lifecycle(
    ctx,
    parentTarget,
    true,
    'Synthetic acceptance: retire newest version without fallback'
  );
  let observed = await availability(page, scope);
  assert.equal(observed.physical.catalog.typeVersions[ids.parentV2].selection.kind, 'retired');
  assert.equal(observed.physical.catalog.typeVersions[ids.parentV2].relationship, 'current');
  assert.equal(observed.physical.catalog.typeVersions[ids.parentV1].relationship, 'superseded');
  assert.equal(observed.physical.catalog.typeVersions[ids.parentV1].headVersionId, ids.parentV2);
  await expect(typeCard(page, ids.parentV2)).toContainText('Current');
  await expect(typeCard(page, ids.parentV2)).toContainText('Retired');
  await expect(button(typeCard(page, ids.parentV2), 'Use type')).toBeDisabled();
  await capture('01-retired-newest-remains-current-without-fallback', await inventoryRead(scope));

  const childTarget = { kind: 'type-version', versionId: ids.childType };
  await lifecycle(
    ctx,
    childTarget,
    true,
    'Synthetic acceptance: retire a type already installed with stock'
  );
  await expect(button(typeCard(page, ids.childType), 'Use type')).toBeDisabled();
  await closeSetup(page);
  await selectLocation(page, ids.a);
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
  await expect(physical(page, ids.child).getByTestId('inventory-placement-fit')).toHaveAttribute(
    'data-fit',
    'compatible'
  );
  await button(physical(page, ids.child), 'Edit installed arrangement').click();
  const edit = dialog(page, 'Edit installed arrangement');
  await button(edit, 'Edit Asset label').click();
  const metadata = edit.getByTestId('inventory-metadata-assetLabel');
  await metadata.fill('CHILD-03');
  await metadata.press('Enter');
  await edit
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: correct metadata on the existing retired pin');
  await submit(ctx, edit, 'Save this arrangement');
  observed = await availability(page, scope);
  assert.equal(observed.physical.items[ids.child].configuration.revision, fixture.physicalRevision);
  assert.deepEqual(
    observed.physical.items[ids.child].placementCompatibility.evidenceIds,
    fixture.evidenceIds
  );
  assert.equal(observed.physical.items[ids.child].placementCompatibility.fit, 'compatible');
  await capture('02-existing-retired-pin-keeps-stock-and-local-fit', {
    ...(await inventoryRead(scope)),
    availability: observed,
  });
  await lifecycle(
    ctx,
    childTarget,
    false,
    'Synthetic acceptance: restore the exact installed type version'
  );
  await expect(button(typeCard(page, ids.childType), 'Use type')).toBeEnabled();
  const fullId = 'catalog:thermo:tsx60086:920090';
  const catalog = await page.evaluate((input) => window.electronAPI.inventory.catalog(input), {
    project: project.projectId,
  });
  const entry = catalog.find((row) => row.id === fullId);
  const recipe = entry.definitions.find((row) => row.kind === 'define-equipment-recipe');
  const rootComponent = recipe.components.find((row) => row.parentKey === null);
  const firstRack = recipe.components.find((row) => row.parentKey === rootComponent.key);
  const recipeTarget = { kind: 'recipe-version', versionId: recipe.id };
  const rackTarget = { kind: 'type-version', versionId: firstRack.typeVersionId };
  await lifecycle(
    ctx,
    recipeTarget,
    true,
    'Synthetic acceptance: retire the exact offered equipment recipe'
  );
  await expect(button(recipeCard(page, recipe.id), 'Add equipment')).toBeDisabled();
  let after = await inventoryRead(scope);
  assert.deepEqual(
    after.state.storage[fixture.full.rootId],
    before.state.storage[fixture.full.rootId]
  );
  await capture('03-recipe-retirement-preserves-installed-equipment', after);
  await lifecycle(ctx, recipeTarget, false, 'Synthetic acceptance: restore only the exact recipe');
  await lifecycle(ctx, rackTarget, true, 'Synthetic acceptance: retire optional rack version');
  const prefix = `Catalog ${Date.now().toString(36)}`;
  async function installSelected(name, includeRack) {
    await setup(ctx, 'Equipment recipes');
    await button(catalogCard(page, fullId), 'Add equipment').click();
    const form = dialog(page, 'Add equipment');
    await form.getByLabel('Equipment name', { exact: true }).fill(name);
    await choose(form, 'Location', 'Top level');
    await button(form, 'Use empty equipment shell').click();
    const checkbox = form.getByLabel(`Install ${firstRack.name}`, { exact: true });
    if (includeRack) {
      await expect(checkbox).toBeEnabled();
      await checkbox.check();
    } else {
      await expect(checkbox).toBeDisabled();
      await expect(button(form, 'Use full recipe arrangement')).toBeDisabled();
      await capture(
        '04-retired-optional-rack-blocked-while-shell-remains-allowed',
        await inventoryRead(scope)
      );
    }
    await form
      .getByLabel('Reason', { exact: true })
      .fill('Synthetic acceptance: install only explicitly selected available components');
    await submit(ctx, form, 'Add equipment');
    const result = await inventoryRead(scope);
    const root = Object.values(result.state.storage).find((row) => row.name === name);
    assert.ok(root);
    const racks = Object.values(result.state.storage).filter(
      (row) => row.placement.kind === 'located' && row.placement.storageId === root.id
    );
    assert.equal(racks.length, includeRack ? 1 : 0);
    assert.equal(
      racks.reduce((sum, row) => sum + row.layout.slots.length, 0),
      includeRack ? 25 : 0
    );
    return { rootId: root.id, rackIds: racks.map((row) => row.id) };
  }
  const shell = await installSelected(`${prefix} explicit shell`, false);
  await selectLocation(page, shell.rootId);
  await expect(physical(page, shell.rootId)).toContainText('0 occupied');
  await capture('05-empty-shell-omits-the-retired-racks', await inventoryRead(scope));
  await lifecycle(ctx, rackTarget, false, 'Synthetic acceptance: restore the exact rack version');
  const selected = await installSelected(`${prefix} one restored rack`, true);
  await selectLocation(page, selected.rootId);
  await expect(physical(page, selected.rootId)).toContainText('1 occupied');
  await capture(
    '06-restored-component-installed-only-by-explicit-selection',
    await inventoryRead(scope)
  );
  async function previewPack(entryId) {
    await setup(ctx, 'Equipment recipes');
    const unchanged = await inventoryRead(scope);
    const nativePreview = await page.evaluate(
      (input) => window.electronAPI.inventory.catalogUpdatePreview(input),
      { ...scope, catalogEntryId: entryId }
    );
    await button(catalogCard(page, entryId), 'Preview catalog update').click();
    const form = dialog(page, 'Catalog update preview');
    await expect(form.getByTestId('inventory-catalog-preview')).toHaveAttribute(
      'data-preview-revision',
      String(unchanged.state.revision)
    );
    for (const row of nativePreview.definitions)
      await expect(form.locator(`[data-definition-id="${row.definition.id}"]`)).toHaveAttribute(
        'data-definition-status',
        row.status
      );
    assert.deepEqual(await inventoryRead(scope), unchanged);
    return { form, unchanged, nativePreview };
  }
  const identical = await previewPack(fullId);
  assert.ok(identical.nativePreview.definitions.every((row) => row.status === 'identical'));
  assert.ok(
    identical.nativePreview.installedReferences.some((row) => row.item.id === fixture.full.rootId)
  );
  await expect(button(identical.form, 'Apply selected definitions')).toBeDisabled();
  await capture('07-identical-source-pack-preview-and-native-read-make-no-writes', {
    ...identical.unchanged,
    preview: identical.nativePreview,
  });
  await button(identical.form, 'Cancel').click();
  const sourceEntryId = 'catalog:eppendorf:f740h:3c:drawer:53mm';
  const fresh = await previewPack(sourceEntryId);
  assert.ok(fresh.nativePreview.definitions.every((row) => row.status === 'new'));
  const boxesBefore = Object.keys(fresh.unchanged.state.storage).sort();
  const vesselsBefore = Object.keys(fresh.unchanged.state.vessels).sort();
  await capture('08-new-source-pack-preview-with-conflicting-depth-kept-unknown', {
    ...fresh.unchanged,
    preview: fresh.nativePreview,
  });
  for (const checkbox of await fresh.form
    .locator('[data-definition-status="new"] input[type="checkbox"]')
    .all())
    await checkbox.check();
  assert.deepEqual(await inventoryRead(scope), fresh.unchanged);
  await submit(ctx, fresh.form, 'Apply selected definitions');
  after = await inventoryRead(scope);
  assert.deepEqual(Object.keys(after.state.storage).sort(), boxesBefore);
  assert.deepEqual(Object.keys(after.state.vessels).sort(), vesselsBefore);
  for (const [id, row] of Object.entries(before.state.stocks))
    assert.deepEqual(after.state.stocks[id], row);
  assert.deepEqual(after.state.storage[ids.a], before.state.storage[ids.a]);
  assert.deepEqual(after.state.storage[ids.b], before.state.storage[ids.b]);
  assert.deepEqual(
    after.state.storage[fixture.full.rootId],
    before.state.storage[fixture.full.rootId]
  );
  assert.deepEqual(
    after.state.storage[fixture.partial.rootId],
    before.state.storage[fixture.partial.rootId]
  );
  await capture('09-published-definitions-without-invented-equipment-or-stock', after);
  return {
    ...fixture,
    ...after,
    shell,
    selected,
    sourceEntryId,
    parentTarget,
    childTarget,
    recipeTarget,
    rackTarget,
  };
}

export async function runInventoryCatalogReopen(ctx) {
  const { page, expect, inventoryRead, capture, fixture } = ctx;
  const { scope, ids, stockId } = fixture;
  const after = await inventoryRead(scope);
  assert.deepEqual(after.state, fixture.state);
  assert.deepEqual(after.history, fixture.history);
  await setup(ctx);
  await expect(typeCard(page, ids.parentV2)).toContainText('Current');
  await expect(typeCard(page, ids.parentV2)).toContainText('Retired');
  await expect(button(typeCard(page, ids.parentV2), 'Use type')).toBeDisabled();
  await expect(button(typeCard(page, ids.childType), 'Use type')).toBeEnabled();
  await capture('10-reopened-explicit-selection-lifecycle-and-version-order', after);
  await closeSetup(page);
  await selectLocation(page, ids.a);
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
  await expect(physical(page, ids.child)).toContainText('CHILD-03');
  await expect(physical(page, ids.child).getByTestId('inventory-placement-fit')).toHaveAttribute(
    'data-fit',
    'compatible'
  );
  assert.deepEqual(after.state.stocks[stockId].quantity, {
    kind: 'known',
    value: '100',
    unit: 'uL',
  });
  await capture('11-reopened-existing-physical-pin-keeps-quantity-and-fit', after);
  await selectLocation(page, fixture.shell.rootId);
  await expect(physical(page, fixture.shell.rootId)).toContainText('0 occupied');
  await selectLocation(page, fixture.selected.rootId);
  await expect(physical(page, fixture.selected.rootId)).toContainText('1 occupied');
  await capture('12-reopened-selected-components-remain-exact', after);
  return { ...fixture, ...after };
}

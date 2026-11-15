import assert from 'node:assert/strict';

const physical = (page, id) =>
  page.locator(`[data-testid="inventory-physical-details"][data-item-id="${id}"]`);
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const availability = (page, scope) =>
  page.evaluate((input) => window.electronAPI.inventory.availability(input), scope);

async function closeDetails(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function selectLocation(page, id) {
  await closeDetails(page);
  await page.locator(`[role="treeitem"][data-location-id="${id}"]`).click();
}
async function setup(ctx) {
  await closeDetails(ctx.page);
  await button(
    ctx.page.getByTestId('inventory-panel').locator('header'),
    'Inventory setup'
  ).click();
  return dialog(ctx.page, 'Inventory setup');
}
async function submit(ctx, form, name) {
  await button(form, name).click();
  await ctx.expect(form).toBeHidden();
  await ctx.expect(ctx.page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
}
async function textMetadata(ctx, form, label, key, value) {
  await button(form, `Edit ${label}`).click();
  const input = form.getByTestId(`inventory-metadata-${key}`);
  await input.fill(value);
  await input.press('Enter');
  await ctx.expect(button(form, `Edit ${label}`)).toBeVisible();
}
async function configure(ctx, id, reason, edit) {
  await button(physical(ctx.page, id), 'Edit installed arrangement').click();
  const form = dialog(ctx.page, 'Edit installed arrangement');
  await edit(form);
  await form.getByLabel('Reason', { exact: true }).fill(reason);
  await submit(ctx, form, 'Save this arrangement');
}

export async function runInventoryConfigurationJourney(ctx) {
  const { page, expect, choose, inventoryRead, capture, fixture } = ctx;
  const { project, scope } = fixture;
  const before = await inventoryRead(scope);
  const materialId = before.state.stocks[fixture.stockId].materialId;
  const materials = await page.evaluate((input) => window.electronAPI.inventory.materials(input), {
    project: project.projectId,
    query: materialId,
    limit: 100,
  });
  const material = materials.items.find((item) => item.id === materialId);
  assert.ok(material, 'The existing fixture material must still be admitted.');
  const prefix = `Configuration ${Date.now().toString(36)}`;
  const names = {
    childType: `${prefix} container type`,
    parentType: `${prefix} parent type`,
    a: `${prefix} A`,
    b: `${prefix} B`,
    child: `${prefix} container`,
    full: `${prefix} TSX600 full 920090`,
    partial: `${prefix} TSX600 partial 920091`,
  };
  const header = page.getByTestId('inventory-panel').locator('header');
  let after;

  await setup(ctx);
  await button(dialog(page, 'Inventory setup'), 'New type').click();
  let form = dialog(page, 'New type');
  await form.getByLabel('Type name', { exact: true }).fill(names.childType);
  await choose(form, 'Item kind', 'Container');
  await form.getByLabel('Default capacity (µL)', { exact: true }).fill('200');
  await form.getByLabel('Default dead volume (µL)', { exact: true }).fill('0');
  await button(form, 'Add field').click();
  await form.getByLabel('Field 1 label', { exact: true }).fill('Asset label');
  await form.getByLabel('Field 1 key', { exact: true }).fill('assetLabel');
  await form.getByLabel('Field 1 required', { exact: true }).check();
  await button(form, 'Add field').click();
  await form.getByLabel('Field 2 label', { exact: true }).fill('Color');
  await form.getByLabel('Field 2 key', { exact: true }).fill('color');
  await choose(form, 'Field 2 type', 'Choice');
  await form.getByLabel('Choices (one per line)', { exact: true }).fill('Blue\nRed');
  await submit(ctx, form, 'Publish type');
  after = await inventoryRead(scope);
  const childType = Object.values(after.state.typeVersions).find(
    (type) => type.name === names.childType
  );
  assert.ok(childType);
  assert.equal(childType.fields.find((field) => field.key === 'assetLabel').required, true);
  assert.deepEqual(childType.fields.find((field) => field.key === 'color').enumOptions, [
    'Blue',
    'Red',
  ]);

  await button(dialog(page, 'Inventory setup'), 'New type').click();
  form = dialog(page, 'New type');
  await form.getByLabel('Type name', { exact: true }).fill(names.parentType);
  await form.getByLabel('Position names', { exact: true }).fill('A1, A2');
  await choose(form, 'Allowed children', 'Selected types');
  await form.getByLabel(`Allowed children: ${names.childType}`, { exact: true }).check();
  await submit(ctx, form, 'Publish type');
  after = await inventoryRead(scope);
  const parentType = Object.values(after.state.typeVersions).find(
    (type) => type.name === names.parentType
  );
  assert.ok(parentType);
  assert.deepEqual(parentType.definition.childPolicy, {
    kind: 'types',
    typeIds: [childType.typeId],
  });
  await capture('01-custom-types-required-field-choice-and-selected-child', after);

  async function useType(typeId, kind, name, parent, position) {
    if (!(await dialog(page, 'Inventory setup').isVisible())) await setup(ctx);
    await button(page.locator(`article[data-type-version-id="${typeId}"]`), 'Use type').click();
    const create = dialog(page, kind === 'storage' ? 'Add location' : 'Add container');
    await create
      .getByLabel(kind === 'storage' ? 'Location name' : 'Container name', { exact: true })
      .fill(name);
    await choose(create, 'Location', parent ?? (kind === 'storage' ? 'Top level' : 'Unplaced'));
    if (position) await choose(create, 'Position', position);
    if (kind === 'vessel') {
      const unchanged = await inventoryRead(scope);
      await create
        .getByLabel('Reason', { exact: true })
        .fill('Synthetic acceptance: missing required asset label');
      await button(create, 'Add container').click();
      await expect(create).toBeVisible();
      await expect(create).toContainText('Asset label is required');
      assert.deepEqual(await inventoryRead(scope), unchanged);
      await capture('01a-required-label-refuses-without-partial-container', unchanged);
      await textMetadata(ctx, create, 'Asset label', 'assetLabel', 'CHILD-01');
      await button(create, 'Edit Color').click();
      await page.getByRole('option', { name: 'Blue', exact: true }).click();
    }
    await create
      .getByLabel('Reason', { exact: true })
      .fill('Synthetic acceptance: install explicit pinned type');
    await submit(ctx, create, kind === 'storage' ? 'Add location' : 'Add container');
    const result = await inventoryRead(scope);
    const row = Object.values(
      kind === 'storage' ? result.state.storage : result.state.vessels
    ).find((item) => item.name === name);
    assert.ok(row);
    return row;
  }
  const a = await useType(parentType.id, 'storage', names.a);
  const b = await useType(parentType.id, 'storage', names.b);
  const child = await useType(childType.id, 'vessel', names.child, names.a, 'A1');
  await button(header, 'Receive stock').click();
  form = dialog(page, 'Receive stock');
  await form.getByLabel('Find material', { exact: true }).fill(materialId);
  await form.getByRole('combobox', { name: 'Material', exact: true }).click();
  await page.locator(`[role="option"][data-value="${materialId}"]`).click();
  await form.getByRole('combobox', { name: 'Container', exact: true }).click();
  await page.locator(`[role="option"][data-value="${child.id}"]`).click();
  await form.getByLabel('Quantity', { exact: true }).fill('100');
  await submit(ctx, form, 'Receive stock');
  after = await inventoryRead(scope);
  const stock = Object.values(after.state.stocks).find((item) => item.vesselId === child.id);
  assert.ok(stock);
  assert.deepEqual(stock.quantity, { kind: 'known', value: '100', unit: 'uL' });
  assert.deepEqual(after.state.vessels[child.id].configuration.metadata, {
    assetLabel: 'CHILD-01',
    color: 'Blue',
  });
  const unchangedB = structuredClone(after.state.storage[b.id]);
  await selectLocation(page, a.id);
  await expect(
    page
      .getByTestId('inventory-stock-table')
      .locator(`[data-stock-id="${stock.id}"]`)
      .getByTestId('inventory-stock-quantity')
  ).toContainText('100');
  await capture('02-two-pinned-instances-and-received-100-microliters', after);

  await setup(ctx);
  await button(
    page.locator(`article[data-type-version-id="${parentType.id}"]`),
    'Publish new version'
  ).click();
  form = dialog(page, 'Publish type version');
  await form.getByLabel('Position names', { exact: true }).fill('V2-1, V2-2, V2-3');
  await submit(ctx, form, 'Publish type');
  after = await inventoryRead(scope);
  const parentV2 = Object.values(after.state.typeVersions).find(
    (type) => type.typeId === parentType.typeId && type.version === 2
  );
  assert.ok(parentV2);
  assert.equal(after.state.storage[a.id].configuration.typeVersionId, parentType.id);
  assert.deepEqual(after.state.storage[b.id], unchangedB);
  await button(dialog(page, 'Inventory setup'), 'Close').click();
  await selectLocation(page, b.id);
  await expect(
    physical(page, b.id).locator(`[data-type-version-id="${parentType.id}"]`)
  ).toHaveText(`${names.parentType} · v1`);
  await capture('03-publishing-v2-preserves-installed-v1', after);

  await selectLocation(page, a.id);
  await configure(ctx, a.id, 'Synthetic acceptance: customize only A', async (edit) => {
    await edit.getByLabel("Edit this item's layout", { exact: true }).check();
    await edit.getByLabel('Position names', { exact: true }).fill('A1, A2, A3');
    await button(edit, 'Mark a position unavailable').click();
    await choose(edit, 'Unavailable position 1', 'A2');
    await edit
      .getByLabel('Unavailable reason 1', { exact: true })
      .fill('Synthetic damaged support');
  });
  after = await inventoryRead(scope);
  assert.deepEqual(after.state.storage[a.id].layout, { kind: 'named', slots: ['A1', 'A2', 'A3'] });
  assert.deepEqual(after.state.storage[a.id].configuration.unavailablePositions, {
    A2: 'Synthetic damaged support',
  });
  assert.deepEqual(after.state.storage[b.id], unchangedB);
  assert.deepEqual(after.state.typeVersions[parentType.id], parentType);
  await capture('04-only-A-customized-layout-and-unavailable-position', after);

  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stock.id}"]`).click();
  await expect(physical(page, child.id).getByTestId('inventory-placement-fit')).toHaveAttribute(
    'data-fit',
    'unknown'
  );
  await capture('05-allowed-child-with-unknown-fit', {
    ...after,
    availability: await availability(page, scope),
  });
  await configure(ctx, child.id, 'Synthetic acceptance: record upright mounting', (edit) =>
    choose(edit, 'Mounting orientation', '0°')
  );
  await button(physical(page, child.id), 'Record fit evidence').click();
  form = dialog(page, 'Record fit evidence');
  await choose(form, 'Evidence basis', 'Local observation');
  await choose(form, 'Fit result', 'Compatible');
  await form.getByLabel('Evidence orientation 0°', { exact: true }).check();
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance local observation only; no manufacturer qualification');
  await submit(ctx, form, 'Record fit evidence');
  const fitted = await availability(page, scope);
  assert.equal(fitted.physical.items[child.id].placementCompatibility.fit, 'compatible');
  const physicalRevision = fitted.physical.items[child.id].configuration.revision;
  const evidenceIds = fitted.physical.items[child.id].placementCompatibility.evidenceIds;
  await expect(physical(page, child.id).getByTestId('inventory-placement-fit')).toContainText(
    'Locally checked'
  );
  await configure(ctx, child.id, 'Synthetic acceptance: metadata-only label correction', (edit) =>
    textMetadata(ctx, edit, 'Asset label', 'assetLabel', 'CHILD-02')
  );
  const metadataEdited = await availability(page, scope);
  assert.equal(metadataEdited.physical.items[child.id].configuration.revision, physicalRevision);
  assert.deepEqual(
    metadataEdited.physical.items[child.id].placementCompatibility.evidenceIds,
    evidenceIds
  );
  assert.equal(metadataEdited.physical.items[child.id].placementCompatibility.fit, 'compatible');
  await expect(physical(page, child.id).getByTestId('inventory-placement-fit')).toHaveAttribute(
    'data-fit',
    'compatible'
  );
  after = await inventoryRead(scope);
  assert.deepEqual(after.state.vessels[child.id].configuration.metadata, {
    assetLabel: 'CHILD-02',
    color: 'Blue',
  });
  await capture('06-local-fit-survives-metadata-edit', { ...after, availability: metadataEdited });

  const catalog = await page.evaluate((input) => window.electronAPI.inventory.catalog(input), {
    project: project.projectId,
  });
  const stockIdsBeforeCatalog = Object.keys(after.state.stocks).sort();
  const vesselIdsBeforeCatalog = Object.keys(after.state.vessels).sort();
  async function installCatalog(id, name, full) {
    const entry = catalog.find((item) => item.id === id);
    assert.ok(entry);
    const recipe = entry.definitions.find(
      (item) => item.kind === 'define-equipment-recipe' && item.id === entry.recipeVersionId
    );
    assert.ok(recipe);
    const setupDialog = await setup(ctx);
    await setupDialog.getByRole('tab', { name: 'Equipment recipes', exact: true }).click();
    await setupDialog.getByLabel('Search inventory setup', { exact: true }).fill('TSX60086');
    const card = setupDialog.locator(`article[data-catalog-id="${id}"]`);
    await expect(card).toContainText(`Catalog box positions: ${entry.boxPositions}`);
    await capture(
      full ? '07-catalog-920090-source-configuration' : '09-catalog-920091-source-configuration',
      { entry }
    );
    await button(card, 'Add equipment').click();
    const install = dialog(page, 'Add equipment');
    await install.getByLabel('Equipment name', { exact: true }).fill(name);
    await choose(install, 'Location', 'Top level');
    await button(
      install,
      full ? 'Use full recipe arrangement' : 'Use empty equipment shell'
    ).click();
    if (!full)
      for (const component of recipe.components
        .filter((item) => item.parentKey !== null)
        .slice(0, 2))
        await install.getByLabel(`Install ${component.name}`, { exact: true }).check();
    await install
      .getByLabel('Reason', { exact: true })
      .fill('Synthetic acceptance: record selected installed racks only; no boxes or stock');
    await submit(ctx, install, 'Add equipment');
    const result = await inventoryRead(scope);
    const root = Object.values(result.state.storage).find((item) => item.name === name);
    assert.ok(root);
    const racks = Object.values(result.state.storage).filter(
      (item) => item.placement.kind === 'located' && item.placement.storageId === root.id
    );
    assert.equal(racks.length, full ? 24 : 2);
    assert.equal(
      racks.reduce((sum, item) => sum + item.layout.slots.length, 0),
      full ? 600 : 30
    );
    assert.equal(
      Object.values(result.state.storage).filter(
        (item) =>
          item.placement.kind === 'located' &&
          racks.some((rack) => rack.id === item.placement.storageId)
      ).length,
      0
    );
    assert.deepEqual(Object.keys(result.state.stocks).sort(), stockIdsBeforeCatalog);
    assert.deepEqual(Object.keys(result.state.vessels).sort(), vesselIdsBeforeCatalog);
    await selectLocation(page, root.id);
    await expect(physical(page, root.id)).toContainText(`${full ? 24 : 2} occupied`);
    await capture(
      full
        ? '08-full-24-racks-600-empty-box-positions'
        : '10-partial-two-racks-30-empty-box-positions',
      result
    );
    await selectLocation(page, racks[0].id);
    await expect(physical(page, racks[0].id)).toContainText(`${full ? 25 : 15} configured`);
    await expect(physical(page, racks[0].id)).toContainText('0 occupied');
    await capture(
      full ? '08a-full-rack-has-25-empty-positions' : '10a-partial-rack-has-15-empty-positions',
      result
    );
    return {
      rootId: root.id,
      rackIds: racks.map((item) => item.id),
      recipeVersionId: entry.recipeVersionId,
      catalogBoxPositions: entry.boxPositions,
      installedRacks: racks.length,
      installedBoxPositions: racks.reduce((sum, item) => sum + item.layout.slots.length, 0),
    };
  }
  const full = await installCatalog('catalog:thermo:tsx60086:920090', names.full, true);
  const partial = await installCatalog('catalog:thermo:tsx60086:920091', names.partial, false);
  after = await inventoryRead(scope);
  for (const [id, original] of Object.entries(before.state.stocks))
    assert.deepEqual(after.state.stocks[id], original);
  assert.equal(Object.keys(after.state.stocks).length, Object.keys(before.state.stocks).length + 1);
  assert.deepEqual(after.state.storage[b.id], unchangedB);
  return {
    project,
    scope,
    ...after,
    names,
    materialId,
    stockId: stock.id,
    ids: {
      a: a.id,
      b: b.id,
      child: child.id,
      childType: childType.id,
      parentV1: parentType.id,
      parentV2: parentV2.id,
    },
    unchangedB,
    physicalRevision,
    evidenceIds,
    full,
    partial,
  };
}

export async function runInventoryConfigurationReopen(ctx) {
  const { page, expect, inventoryRead, capture, fixture } = ctx;
  const { scope, ids, stockId } = fixture;
  const after = await inventoryRead(scope);
  assert.deepEqual(after.state, fixture.state);
  assert.deepEqual(after.history, fixture.history);
  assert.deepEqual(after.state.storage[ids.b], fixture.unchangedB);
  await selectLocation(page, ids.a);
  await expect(
    physical(page, ids.a).locator(`[data-type-version-id="${ids.parentV1}"]`)
  ).toContainText('v1');
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
  await expect(physical(page, ids.child).getByTestId('inventory-placement-fit')).toHaveAttribute(
    'data-fit',
    'compatible'
  );
  await expect(physical(page, ids.child)).toContainText('CHILD-02');
  const observed = await availability(page, scope);
  assert.equal(observed.physical.items[ids.child].configuration.revision, fixture.physicalRevision);
  assert.deepEqual(
    observed.physical.items[ids.child].placementCompatibility.evidenceIds,
    fixture.evidenceIds
  );
  assert.equal(observed.physical.items[ids.child].placementCompatibility.fit, 'compatible');
  await capture('11-reopened-exact-pins-local-fit-state-and-history', {
    ...after,
    availability: observed,
  });
  await selectLocation(page, fixture.full.rootId);
  await expect(
    physical(page, fixture.full.rootId).locator(
      `[data-recipe-version-id="${fixture.full.recipeVersionId}"]`
    )
  ).toBeVisible();
  await expect(physical(page, fixture.full.rootId)).toContainText('24 occupied');
  await selectLocation(page, fixture.partial.rootId);
  await expect(physical(page, fixture.partial.rootId)).toContainText('2 occupied');
  const width = physical(page, fixture.partial.rootId).getByText(/^width: 1113 mm$/iu);
  await expect(width).toBeVisible();
  assert.equal(await width.evaluate((node) => getComputedStyle(node).textTransform), 'none');
  await width.scrollIntoViewIfNeeded();
  await capture('12-reopened-partial-arrangement-remains-partial', after);
  return { ...fixture, ...after };
}

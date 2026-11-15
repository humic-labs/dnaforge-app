import assert from 'node:assert/strict';

const panel = (page, id) => page.locator(`[data-testid="inventory-custody"][data-item-id="${id}"]`);

async function closeDrawer(page) {
  const close = page.getByRole('button', { name: 'Close stock details', exact: true });
  if (await close.isVisible()) await close.click();
}

async function selectLocation(page, name) {
  await closeDrawer(page);
  await page.getByRole('treeitem').filter({ hasText: name }).click();
}

async function custodyAction({ page, expect, choose }, id, action, destination) {
  await panel(page, id).getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: action, exact: true });
  if (destination) {
    await choose(dialog, 'Location', destination.location);
    if (destination.position) await choose(dialog, 'Position', destination.position);
  }
  await dialog
    .getByLabel('Reason', { exact: true })
    .fill(`Synthetic custody acceptance: ${action}`);
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function availabilityRead(page, scope) {
  return page.evaluate((input) => window.electronAPI.inventory.availability(input), scope);
}

export async function runInventoryCustodyJourney(context) {
  const { page, expect, choose, inventoryRead, capture, fixture } = context;
  const { project, scope } = fixture;
  const prefix = `Custody ${Date.now().toString(36)}`;
  const names = {
    parent: `${prefix} freezer`,
    box: `${prefix} box`,
    empty: `${prefix} empty tube`,
    stock: `${prefix} stock tube`,
    placeholder: `${prefix} old-slot occupant`,
    plate: `${prefix} plate`,
  };
  const initial = await inventoryRead(scope);
  const materialId = initial.state.stocks[fixture.stockId].materialId;
  const materials = await page.evaluate((input) => window.electronAPI.inventory.materials(input), {
    project: project.projectId,
    query: materialId,
    limit: 100,
  });
  const material = materials.items.find((item) => item.id === materialId);
  assert.ok(material);
  const materialName = new RegExp(material.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const header = page.getByTestId('inventory-panel').locator('header');
  async function addLocation(name, positions, parent, position, plate = false) {
    await closeDrawer(page);
    await header.getByRole('button', { name: 'Add location', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add location', exact: true });
    await dialog.getByLabel('Location name', { exact: true }).fill(name);
    if (plate) {
      await choose(dialog, 'Position layout', 'Well plate');
      await dialog.getByLabel('Rows', { exact: true }).fill('2');
      await dialog.getByLabel('Columns', { exact: true }).fill('3');
    } else await dialog.getByLabel('Position names', { exact: true }).fill(positions);
    await choose(dialog, 'Location', parent ?? 'Top level');
    if (position) await choose(dialog, 'Position', position);
    await dialog.getByRole('button', { name: 'Add location', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  async function addContainer(name, location, position) {
    await closeDrawer(page);
    await header.getByRole('button', { name: 'Add container', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add container', exact: true });
    await dialog.getByLabel('Container name', { exact: true }).fill(name);
    await choose(dialog, 'Location', location);
    await choose(dialog, 'Position', position);
    await dialog.getByRole('button', { name: 'Add container', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await addLocation(names.parent, 'A, B');
  await addLocation(names.box, 'T1, T2', names.parent, 'A');
  await addContainer(names.empty, `${names.parent} / A / ${names.box}`, 'T1');
  await header.getByRole('button', { name: 'Receive stock', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
  await dialog.getByLabel('Find material', { exact: true }).fill(materialId);
  await choose(dialog, 'Material', materialName);
  await dialog.getByLabel('Container name', { exact: true }).fill(names.stock);
  await dialog.getByLabel('Quantity', { exact: true }).fill('100');
  await choose(dialog, 'Location', `${names.parent} / A / ${names.box}`);
  await choose(dialog, 'Position', 'T2');
  await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
  await expect(dialog).toBeHidden();
  let after = await inventoryRead(scope);
  const namedStorage = (name) =>
    Object.values(after.state.storage).find((item) => item.name === name);
  const namedVessel = (name) =>
    Object.values(after.state.vessels).find((item) => item.name === name);
  const parent = namedStorage(names.parent),
    box = namedStorage(names.box),
    empty = namedVessel(names.empty);
  const vessel = namedVessel(names.stock);
  const stock = Object.values(after.state.stocks).find((item) => item.vesselId === vessel?.id);
  assert.ok(parent && box && empty && stock);
  assert.equal(
    Object.values(after.state.stocks).some((item) => item.vesselId === empty.id),
    false
  );
  await selectLocation(page, names.box);
  await page.getByTestId('inventory-positions').locator('[data-position-id="T1"]').click();
  await expect(panel(page, empty.id)).toHaveAttribute('data-custody-state', 'available');
  await capture('01-empty-container-without-stock', after);
  await selectLocation(page, names.box);
  await custodyAction(context, box.id, 'Check out');
  after = await inventoryRead(scope);
  let availability = await availabilityRead(page, scope);
  assert.equal(after.state.storage[box.id].custody.kind, 'checked-out');
  assert.deepEqual(after.state.storage[box.id].placement, { kind: 'root' });
  assert.deepEqual(after.state.vessels[empty.id].placement, empty.placement);
  assert.deepEqual(after.state.vessels[vessel.id].placement, vessel.placement);
  assert.equal(after.state.stocks[stock.id].quantity.value, '100');
  assert.equal(availability.items[empty.id].inherited, true);
  assert.equal(availability.items[vessel.id].root.id, box.id);
  assert.equal(availability.items[vessel.id].state.kind, 'checked-out');
  const firstObservation = after.state.storage[box.id].custody.lastKnown;
  assert.ok(firstObservation.path.some((entry) => entry.name === names.parent));
  await capture('02-box-checkout-and-inherited-custody', { ...after, availability });
  await addContainer(names.placeholder, names.parent, 'A');
  await selectLocation(page, names.box);
  await custodyAction(context, box.id, 'Return', { location: names.parent, position: 'B' });
  after = await inventoryRead(scope);
  assert.equal(after.state.storage[box.id].custody.kind, 'available');
  assert.deepEqual(after.state.storage[box.id].placement, {
    kind: 'located',
    storageId: parent.id,
    slotId: 'B',
  });
  assert.equal(namedVessel(names.placeholder).placement.slotId, 'A');
  await capture('03-old-slot-reused-and-explicit-alternate-return', after);
  await custodyAction(context, box.id, 'Report missing');
  after = await inventoryRead(scope);
  availability = await availabilityRead(page, scope);
  assert.equal(after.state.storage[box.id].custody.kind, 'missing');
  assert.equal(after.state.stocks[stock.id].quantity.value, '100');
  assert.equal(availability.items[vessel.id].state.kind, 'missing');
  assert.ok(availability.stocks[stock.id].blockers.some((item) => item.code === 'ITEM_MISSING'));
  await expect(panel(page, box.id).getByTestId('inventory-current-location')).toContainText(
    'unknown'
  );
  await capture('04-missing-is-not-zero-or-disposal', { ...after, availability });
  await custodyAction(context, box.id, 'Record location', {
    location: names.parent,
    position: 'B',
  });
  after = await inventoryRead(scope);
  assert.equal(after.state.storage[box.id].custody.kind, 'available');
  assert.equal(after.state.stocks[stock.id].quantity.value, '100');
  await capture('05-located-with-observation-history', after);
  await addLocation(names.plate, '', undefined, undefined, true);
  after = await inventoryRead(scope);
  const plate = namedStorage(names.plate);
  const wells = Object.values(after.state.vessels).filter(
    (item) => item.kind === 'fixed-well' && item.placement.storageId === plate.id
  );
  assert.equal(wells.length, 6);
  await selectLocation(page, names.plate);
  await page.getByTestId('inventory-positions').locator('[data-position-id="A1"]').click();
  dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
  await dialog.getByLabel('Find material', { exact: true }).fill(materialId);
  await choose(dialog, 'Material', materialName);
  await dialog.getByLabel('Quantity', { exact: true }).fill('25');
  await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
  await expect(dialog).toBeHidden();
  after = await inventoryRead(scope);
  const wellStock = Object.values(after.state.stocks).find(
    (item) => item.vesselId === wells.find((well) => well.name === 'A1').id
  );
  assert.ok(wellStock);
  await closeDrawer(page);
  await custodyAction(context, plate.id, 'Check out');
  after = await inventoryRead(scope);
  availability = await availabilityRead(page, scope);
  for (const well of wells) {
    assert.deepEqual(after.state.vessels[well.id], well);
    assert.equal(availability.items[well.id].root.id, plate.id);
    assert.equal(availability.items[well.id].actions.checkout, false);
  }
  assert.equal(after.state.stocks[wellStock.id].quantity.value, '25');
  await capture('06-permanent-wells-inherit-one-plate-checkout', { ...after, availability });
  await selectLocation(page, names.box);
  await custodyAction(context, box.id, 'Start transfer', { location: names.parent, position: 'B' });
  after = await inventoryRead(scope);
  availability = await availabilityRead(page, scope);
  assert.equal(after.state.storage[box.id].custody.kind, 'in-transit');
  assert.equal(availability.items[vessel.id].state.kind, 'in-transit');
  assert.ok(availability.stocks[stock.id].blockers.some((item) => item.code === 'ITEM_IN_TRANSIT'));
  await capture('07-transfer-is-not-arrival', { ...after, availability });
  return {
    project,
    scope,
    ...after,
    names,
    boxId: box.id,
    parentId: parent.id,
    emptyId: empty.id,
    vesselId: vessel.id,
    stockId: stock.id,
    plateId: plate.id,
    wellIds: wells.map((item) => item.id),
    wellStockId: wellStock.id,
    holder: after.state.storage[box.id].custody.holder,
  };
}

export async function runInventoryCustodyReopen(context) {
  const { page, expect, inventoryRead, capture, fixture } = context;
  const { project, scope, names, boxId, parentId, stockId, plateId, wellIds, holder } = fixture;
  let after = await inventoryRead(scope);
  assert.deepEqual(after.state, fixture.state);
  assert.deepEqual(after.history, fixture.history);
  assert.deepEqual(after.state.storage[boxId].custody.holder, holder);
  await selectLocation(page, names.box);
  await expect(panel(page, boxId)).toHaveAttribute('data-custody-state', 'in-transit');
  await expect(panel(page, boxId).getByTestId('inventory-last-known-location')).toContainText(
    `${names.parent} / B / ${names.box}`
  );
  await capture('08-reopened-exact-custody-and-history', after);
  const table = page.getByTestId('inventory-stock-table');
  const geometry = await table.evaluate((element) => ({
    tableHeight: element.getBoundingClientRect().height,
    wrapperHeight: element.parentElement.getBoundingClientRect().height,
  }));
  assert.ok(
    geometry.wrapperHeight >= geometry.tableHeight,
    'The stock table must retain its full height.'
  );
  await table.locator(`[data-stock-id="${stockId}"]`).click();
  await expect(panel(page, fixture.vesselId)).toHaveAttribute('data-custody-state', 'in-transit');
  await capture('08a-readable-stock-and-inherited-custody', { geometry });
  await selectLocation(page, names.box);
  await custodyAction(context, boxId, 'Record arrival', { location: names.parent, position: 'B' });
  after = await inventoryRead(scope);
  assert.equal(after.state.storage[boxId].custody.kind, 'available');
  assert.deepEqual(after.state.storage[boxId].placement, {
    kind: 'located',
    storageId: parentId,
    slotId: 'B',
  });
  assert.equal(after.state.stocks[stockId].quantity.value, '100');
  await selectLocation(page, names.plate);
  await custodyAction(context, plateId, 'Return', { location: 'Top level' });
  after = await inventoryRead(scope);
  const availability = await availabilityRead(page, scope);
  for (const id of wellIds) assert.equal(availability.items[id].state.kind, 'available');
  assert.equal(after.state.stocks[fixture.wellStockId].quantity.value, '25');
  await capture('09-explicit-arrival-and-plate-return', { ...after, availability });
  return { project, scope, ...after, names, boxId, parentId, stockId, plateId, wellIds, holder };
}

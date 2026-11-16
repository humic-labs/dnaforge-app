import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inventoryFixtureMetadataDefaults } from './inventory-fixture-metadata.mjs';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const modal = (page, name) => page.getByRole('dialog', { name, exact: true });
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function closeDrawer(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}

async function recoverReceipts(page, scope, entries) {
  for (const entry of entries) {
    assert.equal('kind' in entry.request, false);
    const result = await page.evaluate(
      (request) => window.electronAPI.inventory.execute(request),
      entry.request
    );
    assert.deepEqual(result, entry.receipt);
    const lookup = await page.evaluate(
      (request) => window.electronAPI.inventory.operation(request),
      { ...scope, operationId: entry.request.operationId }
    );
    assert.deepEqual(lookup, entry.receipt);
  }
}

export async function runInventoryContentsJourney(ctx) {
  const { page, expect, choose, fixture, inventoryRead, capture, evidenceDirectory } = ctx;
  const { project, scope } = fixture;
  const initial = await inventoryRead(scope);
  assert.deepEqual(initial.state, {
    ...fixture.state,
    ...inventoryFixtureMetadataDefaults(fixture.state),
  });
  assert.deepEqual(initial.history, fixture.history);
  const materialId = Object.values(initial.state.tableBindings).find(
    (binding) => binding.sourceId === 'MP001'
  )?.materialId;
  assert.ok(materialId, 'Use the owned profile with its genuine published primer record.');
  const pageOfMaterials = await page.evaluate(
    (input) => window.electronAPI.inventory.materials(input),
    { project: project.projectId, query: materialId, limit: 100 }
  );
  const material = pageOfMaterials.items.find((item) => item.id === materialId);
  assert.ok(material);
  const prefix = `Contents ${Date.now().toString(36)}`;
  const names = {
    zero: `${prefix} unidentified zero`,
    receive: `${prefix} declaration then receipt`,
    moved: `${prefix} unobserved moved`,
    location: `${prefix} location`,
    plate: `${prefix} plate`,
  };
  const header = page.getByTestId('inventory-panel').locator('header');
  const checkpoint = (phase, data) =>
    writeFileSync(
      path.join(evidenceDirectory, `${phase}-checkpoint.json`),
      JSON.stringify(
        { project, scope, ...data, names, initialRevision: initial.state.revision },
        null,
        2
      )
    );
  async function addContainer(name, initialContents) {
    await closeDrawer(page);
    await button(header, 'Add container').click();
    const form = modal(page, 'Add container');
    await form.getByLabel('Container name', { exact: true }).fill(name);
    await choose(form, 'Initial contents', initialContents);
    await form
      .getByLabel('Reason', { exact: true })
      .fill('Synthetic contents acceptance: source contents were not inventoried');
    await button(form, 'Add container').click();
    await expect(form).toBeHidden();
    const data = await inventoryRead(scope);
    const vessel = Object.values(data.state.vessels).find((item) => item.name === name);
    assert.ok(vessel);
    checkpoint(`created-${vessel.id}`, data);
    const entry = data.history.at(-1);
    assert.equal(entry.request.commands.length, 2);
    assert.deepEqual(entry.request.commands[1], {
      kind: 'record-vessel-contents',
      vesselId: vessel.id,
      knowledge: initialContents.includes('unidentified') ? 'unidentified' : 'unobserved',
      reason: 'Synthetic contents acceptance: source contents were not inventoried',
    });
    return vessel;
  }
  async function openContainer(id) {
    await closeDrawer(page);
    await page
      .getByTestId('inventory-empty-containers')
      .locator(`[data-vessel-id="${id}"]`)
      .click();
    await expect(page.getByTestId('inventory-item-details')).toHaveAttribute('data-item-id', id);
    return page.getByTestId('inventory-detail-drawer');
  }
  async function identify(form, value, quality) {
    await form.getByLabel('Find material', { exact: true }).fill(materialId);
    await choose(form, 'Material', new RegExp(escape(material.name)));
    await form.getByLabel('Quantity', { exact: true }).fill(value);
    await choose(form, 'Stock quality', quality);
    await form
      .getByLabel('Reason', { exact: true })
      .fill('Synthetic explicit identification of material already present');
    await button(form, 'Identify contents').click();
    await expect(form).toBeHidden();
  }

  const zeroVessel = await addContainer(names.zero, 'Contents have not been observed');
  let drawer = await openContainer(zeroVessel.id);
  await expect(drawer.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unobserved'
  );
  await expect(button(drawer, 'Receive stock')).toBeDisabled();
  await capture(
    '01-unobserved-container-created-atomically-and-receiving-disabled',
    await inventoryRead(scope)
  );
  await closeDrawer(page);
  await button(header, 'Receive stock').click();
  let form = modal(page, 'Receive stock');
  await form.getByRole('combobox', { name: 'Container', exact: true }).click();
  await expect(page.getByRole('option', { name: new RegExp(escape(names.zero)) })).toHaveCount(0);
  await page.getByRole('option', { name: 'New container or well', exact: true }).click();
  await capture('02-unobserved-container-excluded-from-ordinary-receiving', {
    vesselId: zeroVessel.id,
  });
  await button(form, 'Cancel').click();
  drawer = await openContainer(zeroVessel.id);
  await button(drawer, 'Record contents status').click();
  form = modal(page, 'Record contents status');
  await choose(form, 'Contents status', 'Material is present but unidentified');
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic observation: material is present but identity is unresolved');
  await button(form, 'Record contents status').click();
  await expect(form).toBeHidden();
  await expect(drawer.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unidentified'
  );
  await capture('03-unidentified-material-remains-separate-from-empty', await inventoryRead(scope));
  await button(drawer, 'Identify contents').click();
  form = modal(page, 'Identify contents');
  await identify(form, '0', 'Usable');
  await expect(page.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'identified'
  );
  await expect(page.getByTestId('inventory-contents').getByRole('button')).toHaveCount(0);
  let after = await inventoryRead(scope);
  const identified = Object.values(after.state.stocks).find(
    (stock) => stock.vesselId === zeroVessel.id
  );
  assert.ok(identified);
  assert.deepEqual(identified.quantity, { kind: 'known', value: '0', unit: 'uL' });
  assert.equal(after.history.at(-1).request.commands[0].kind, 'identify-vessel-stock');
  assert.equal(after.state.vessels[zeroVessel.id].contentsKnowledge.kind, 'recorded');
  await capture('04-identification-is-not-receiving-and-zero-stays-identified', after);

  const receivedVessel = await addContainer(names.receive, 'Material is present but unidentified');
  drawer = await openContainer(receivedVessel.id);
  await button(drawer, 'Declare empty').click();
  form = modal(page, 'Declare empty');
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic explicit declaration that this separate container is empty');
  await button(form, 'Declare empty').click();
  await expect(form).toBeHidden();
  await expect(drawer.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'declared-empty'
  );
  await expect(button(drawer, 'Receive stock')).toBeEnabled();
  await capture('05-empty-is-an-explicit-reason-bearing-declaration', await inventoryRead(scope));
  await button(drawer, 'Receive stock').click();
  form = modal(page, 'Receive stock');
  await form.getByLabel('Find material', { exact: true }).fill(materialId);
  await choose(form, 'Material', new RegExp(escape(material.name)));
  await form.getByLabel('Quantity', { exact: true }).fill('2');
  await button(form, 'Receive stock').click();
  await expect(form).toBeHidden();
  after = await inventoryRead(scope);
  const received = Object.values(after.state.stocks).find(
    (stock) => stock.vesselId === receivedVessel.id
  );
  assert.ok(received);
  assert.deepEqual(received.quantity, { kind: 'known', value: '2', unit: 'uL' });
  assert.equal(after.history.at(-1).request.commands[0].kind, 'receive-stock');
  await capture('06-receiving-is-available-only-after-declaration', after);

  const movedVessel = await addContainer(names.moved, 'Contents have not been observed');
  await closeDrawer(page);
  await button(header, 'Add location').click();
  form = modal(page, 'Add location');
  await form.getByLabel('Location name', { exact: true }).fill(names.location);
  await form.getByLabel('Position names', { exact: true }).fill('U1');
  await button(form, 'Add location').click();
  await expect(form).toBeHidden();
  drawer = await openContainer(movedVessel.id);
  await button(drawer, 'Move').click();
  form = modal(page, 'Move container');
  await choose(form, 'Location', names.location);
  await choose(form, 'Position', 'U1');
  await button(form, 'Move container').click();
  await expect(form).toBeHidden();
  after = await inventoryRead(scope);
  assert.deepEqual(
    after.state.vessels[movedVessel.id].contentsKnowledge,
    movedVessel.contentsKnowledge
  );
  assert.equal(after.state.vessels[movedVessel.id].placement.kind, 'located');
  await closeDrawer(page);
  await page.getByRole('treeitem').filter({ hasText: names.location }).click();
  await expect(
    page.getByTestId('inventory-positions').locator('[data-position-id="U1"]')
  ).toContainText('Contents unobserved');
  await page.getByTestId('inventory-positions').locator('[data-position-id="U1"]').click();
  await capture('07-moving-an-unobserved-container-preserves-its-knowledge', after);
  return finishInventoryContentsJourney(ctx, {
    names,
    initialRevision: initial.state.revision,
    baselineState: initial.state,
  });
}

async function finishInventoryContentsJourney(ctx, { names, initialRevision, baselineState }) {
  const { page, expect, choose, fixture, inventoryRead, capture } = ctx;
  const { project, scope } = fixture;
  const before = await inventoryRead(scope);
  const findVessel = (name) => {
    const matches = Object.values(before.state.vessels).filter((item) => item.name === name);
    assert.equal(matches.length, 1, `Exactly one original container must match ${name}`);
    return matches[0];
  };
  const zeroVessel = findVessel(names.zero);
  const receivedVessel = findVessel(names.receive);
  const movedVessel = findVessel(names.moved);
  const identified = Object.values(before.state.stocks).find(
    (stock) => stock.vesselId === zeroVessel.id
  );
  const received = Object.values(before.state.stocks).find(
    (stock) => stock.vesselId === receivedVessel.id
  );
  assert.ok(identified && received);
  assert.deepEqual(identified.quantity, { kind: 'known', value: '0', unit: 'uL' });
  assert.deepEqual(received.quantity, { kind: 'known', value: '2', unit: 'uL' });
  assert.equal(zeroVessel.contentsKnowledge.kind, 'recorded');
  assert.equal(receivedVessel.contentsKnowledge.kind, 'recorded');
  assert.equal(movedVessel.contentsKnowledge.kind, 'unobserved');
  const locations = Object.values(before.state.storage).filter(
    (item) => item.name === names.location
  );
  assert.equal(locations.length, 1);
  assert.deepEqual(movedVessel.placement, {
    kind: 'located',
    storageId: locations[0].id,
    slotId: 'U1',
  });
  assert.equal(
    Object.values(before.state.storage).some((item) => item.name === names.plate),
    false,
    'The plate must not have been committed before this stage.'
  );
  assert.ok(Number.isSafeInteger(initialRevision) && initialRevision < before.state.revision);
  const header = page.getByTestId('inventory-panel').locator('header');
  let form;
  let drawer;
  let after;
  await closeDrawer(page);
  await button(header, 'Add location').click();
  form = modal(page, 'Add location');
  await form.getByLabel('Location name', { exact: true }).fill(names.plate);
  await choose(form, 'Position layout', 'Well plate');
  await choose(form, 'Location', 'Top level');
  await form.getByLabel('Rows', { exact: true }).fill('1');
  await form.getByLabel('Columns', { exact: true }).fill('1');
  await button(form, 'Add location').click();
  await expect(form).toBeHidden();
  await page.getByRole('treeitem').filter({ hasText: names.plate }).click();
  await page.getByTestId('inventory-positions').locator('[data-position-id="A1"]').click();
  drawer = page.getByTestId('inventory-detail-drawer');
  await expect(drawer.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'declared-empty'
  );
  await expect(button(drawer, 'Receive stock')).toBeEnabled();
  await expect(button(drawer, 'Move')).toHaveCount(0);
  await expect(button(drawer, 'Dispose container')).toHaveCount(0);
  await expect(button(drawer, 'Check out')).toHaveCount(0);
  await capture(
    '08-empty-permanent-well-has-explicit-inspection-and-receiving',
    await inventoryRead(scope)
  );
  await button(drawer, 'Record contents status').click();
  form = modal(page, 'Record contents status');
  await choose(form, 'Contents status', 'Contents have not been observed');
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic source lacks an observation of this permanent well');
  await button(form, 'Record contents status').click();
  await expect(form).toBeHidden();
  await expect(drawer.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unobserved'
  );
  await expect(button(drawer, 'Receive stock')).toBeDisabled();
  await expect(button(drawer, 'Identify contents')).toBeEnabled();
  after = await inventoryRead(scope);
  const plate = Object.values(after.state.storage).find((item) => item.name === names.plate);
  assert.ok(plate);
  const fixedWell = Object.values(after.state.vessels).find(
    (item) => item.kind === 'fixed-well' && item.placement.storageId === plate.id
  );
  assert.ok(fixedWell);
  assert.equal(fixedWell.contentsKnowledge.kind, 'unobserved');
  await capture('09-unobserved-permanent-well-keeps-plate-ownership', after);
  const unknownStock = Object.values(baselineState.stocks).find(
    (stock) =>
      stock.quantity.kind === 'unknown' &&
      baselineState.vessels[stock.vesselId].lifecycle === 'active'
  );
  assert.ok(unknownStock, 'Owned baseline includes a genuinely recorded unknown quantity.');
  await closeDrawer(page);
  await button(page, 'All stock').click();
  await page
    .getByTestId('inventory-stock-table')
    .locator(`[data-stock-id="${unknownStock.id}"]`)
    .click();
  await expect(page.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'identified'
  );
  await capture('10-unknown-quantity-still-has-identified-contents', { stock: unknownStock });
  const accepted = after.history.filter((entry) => entry.receipt.revision > initialRevision);
  await recoverReceipts(page, scope, accepted);
  assert.deepEqual(await inventoryRead(scope), after);
  await capture('11-original-receipts-recover-without-repeating-identification-or-receiving', {
    operations: accepted.map((entry) => entry.request.operationId),
    revision: after.state.revision,
  });
  return {
    project,
    scope,
    ...after,
    contentsJourney: {
      names,
      zeroVesselId: zeroVessel.id,
      zeroStockId: identified.id,
      receivedVesselId: receivedVessel.id,
      receivedStockId: received.id,
      movedVesselId: movedVessel.id,
      fixedWellId: fixedWell.id,
      firstRevision: initialRevision + 1,
      originalReceiptRetries: accepted.length,
      baselineUnknownStockId: unknownStock.id,
    },
  };
}

export async function runInventoryContentsResume(ctx) {
  const { page, expect, fixture, inventoryRead, capture } = ctx;
  assert.equal(fixture.resumePhase, 'after-move');
  assert.ok(Number.isSafeInteger(fixture.initialRevision));
  assert.equal(fixture.state.revision, fixture.initialRevision + 9);
  const current = await inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  await expect(modal(page, 'Add location')).toHaveCount(0);
  await capture('00-resumed-from-verified-original-after-move-state', {
    scope: fixture.scope,
    revision: current.state.revision,
    originalInitialRevision: fixture.initialRevision,
    sourceFailedReceipt: fixture.sourceFailedReceipt,
    preservedOperationIds: current.history
      .filter((entry) => entry.receipt.revision > fixture.initialRevision)
      .map((entry) => entry.request.operationId),
  });
  return finishInventoryContentsJourney(ctx, {
    names: fixture.names,
    initialRevision: fixture.initialRevision,
    baselineState: current.state,
  });
}

export async function runInventoryContentsReopen(ctx) {
  const { page, expect, fixture, inventoryRead, capture } = ctx;
  const actual = await inventoryRead(fixture.scope);
  assert.deepEqual(actual.state, fixture.state);
  assert.deepEqual(actual.history, fixture.history);
  const proof = fixture.contentsJourney;
  assert.deepEqual(actual.state.stocks[proof.zeroStockId].quantity, {
    kind: 'known',
    value: '0',
    unit: 'uL',
  });
  assert.equal(actual.state.vessels[proof.zeroVesselId].contentsKnowledge.kind, 'recorded');
  assert.equal(actual.state.vessels[proof.movedVesselId].contentsKnowledge.kind, 'unobserved');
  await closeDrawer(page);
  await page.getByRole('treeitem').filter({ hasText: proof.names.location }).click();
  await page.getByTestId('inventory-positions').locator('[data-position-id="U1"]').click();
  await expect(page.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unobserved'
  );
  await expect(page.getByTestId('inventory-contents')).toContainText('This desktop profile');
  await capture('01-reopened-unobserved-container-keeps-location-and-reason', actual);
  await closeDrawer(page);
  await page.getByRole('treeitem').filter({ hasText: proof.names.plate }).click();
  await page.getByTestId('inventory-positions').locator('[data-position-id="A1"]').click();
  await expect(page.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unobserved'
  );
  await expect(page.getByTestId('inventory-contents')).toContainText('This desktop profile');
  await expect(button(page.getByTestId('inventory-detail-drawer'), 'Receive stock')).toBeDisabled();
  await expect(button(page.getByTestId('inventory-detail-drawer'), 'Move')).toHaveCount(0);
  await capture('02-reopened-unobserved-permanent-well-keeps-ownership', {
    vessel: actual.state.vessels[proof.fixedWellId],
  });
  await closeDrawer(page);
  await button(page, 'All stock').click();
  await page
    .getByTestId('inventory-stock-table')
    .locator(`[data-stock-id="${proof.zeroStockId}"]`)
    .click();
  await expect(page.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'identified'
  );
  await expect(page.getByTestId('inventory-contents').getByRole('button')).toHaveCount(0);
  await capture('03-reopened-zero-stock-remains-identified', actual);
  await recoverReceipts(
    page,
    fixture.scope,
    actual.history.filter((entry) => entry.receipt.revision >= proof.firstRevision)
  );
  assert.deepEqual(await inventoryRead(fixture.scope), actual);
  await capture('04-reopened-original-receipts-remain-exact', {
    revision: actual.state.revision,
    originalReceiptRetries: proof.originalReceiptRetries,
  });
  return fixture;
}

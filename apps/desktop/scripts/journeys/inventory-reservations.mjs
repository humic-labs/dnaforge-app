import assert from 'node:assert/strict';

async function availabilityRead(page, scope) {
  return page.evaluate((input) => window.electronAPI.inventory.availability(input), scope);
}

async function showStock(page, stockId) {
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
}

async function assertAmounts(page, expect, onHand, held, unreserved) {
  const facts = page.getByTestId('inventory-stock-availability');
  for (const [label, value] of [
    ['On hand', onHand],
    ['Held', held],
    ['Unreserved', unreserved],
  ]) {
    await expect(facts.locator(`[data-availability="${label}"]`)).toHaveText(`${value} µL`);
  }
}

export async function runInventoryReservationJourney({
  page,
  expect,
  choose,
  inventoryRead,
  capture,
  fixture,
}) {
  const { project, scope } = fixture;
  const initial = await inventoryRead(scope);
  const materialId = initial.state.stocks[fixture.stockId].materialId;
  const materials = await page.evaluate((input) => window.electronAPI.inventory.materials(input), {
    project: project.projectId,
    query: materialId,
    limit: 100,
  });
  const material = materials.items.find((item) => item.id === materialId);
  assert.ok(material);
  await page
    .getByTestId('inventory-panel')
    .locator('header')
    .getByRole('button', { name: 'Receive stock', exact: true })
    .click();
  let dialog = page.getByRole('dialog', { name: 'Receive stock', exact: true });
  await dialog.getByLabel('Find material', { exact: true }).fill(materialId);
  await choose(
    dialog,
    'Material',
    new RegExp(material.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  );
  await dialog.getByLabel('Container name', { exact: true }).fill('Reservation tube acceptance');
  await dialog.getByLabel('Quantity', { exact: true }).fill('100');
  await dialog.getByRole('button', { name: 'Receive stock', exact: true }).click();
  await expect(dialog).toBeHidden();
  let after = await inventoryRead(scope);
  const stock = Object.values(after.state.stocks).find(
    (item) => after.state.vessels[item.vesselId].name === 'Reservation tube acceptance'
  );
  assert.ok(stock);
  await showStock(page, stock.id);
  await assertAmounts(page, expect, '100', '0', '100');
  await capture('01-stock-before-reservation', after);
  await page.getByRole('button', { name: 'Reserve quantity', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Reserve quantity', exact: true });
  await dialog.getByLabel('Quantity (µL)', { exact: true }).fill('60');
  await dialog.getByLabel('Purpose', { exact: true }).fill('Reservation acceptance experiment');
  await dialog.getByRole('button', { name: 'Reserve quantity', exact: true }).click();
  await expect(dialog).toBeHidden();
  after = await inventoryRead(scope);
  let availability = await availabilityRead(page, scope);
  const reservation = Object.values(after.state.reservations).find(
    (item) => item.kind === 'quantity' && item.stockId === stock.id
  );
  assert.ok(reservation);
  assert.equal(after.state.stocks[stock.id].quantity.value, '100');
  assert.equal(reservation.remaining.value, '60');
  assert.equal(reservation.deadline, null);
  assert.equal(reservation.holder.kind, 'local-profile');
  assert.deepEqual(reservation.holder, availability.principal);
  await assertAmounts(page, expect, '100', '60', '40');
  await capture('02-reserved-without-consuming', { ...after, availability });
  await page.getByRole('tab', { name: 'reservations', exact: true }).click();
  const booking = page
    .getByTestId('inventory-reservations')
    .locator(`[data-reservation-id="${reservation.id}"]`);
  await expect(booking).toContainText('This desktop profile');
  await booking.getByRole('button', { name: 'Use reserved stock', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Use reserved stock', exact: true });
  await dialog.getByLabel('Quantity (µL)', { exact: true }).fill('20');
  await dialog.getByLabel('Reason', { exact: true }).fill('Use part of the planned allocation');
  await dialog.getByRole('button', { name: 'Use reserved stock', exact: true }).click();
  await expect(dialog).toBeHidden();
  after = await inventoryRead(scope);
  availability = await availabilityRead(page, scope);
  assert.equal(after.state.stocks[stock.id].quantity.value, '80');
  assert.equal(after.state.reservations[reservation.id].remaining.value, '40');
  assert.equal(after.state.reservations[reservation.id].lifecycle.kind, 'active');
  assert.equal(availability.stocks[stock.id].held.value, '40');
  assert.equal(availability.stocks[stock.id].unreserved.value, '40');
  const receipt = after.history.at(-1)?.receipt;
  assert.ok(receipt);
  assert.deepEqual(receipt.context.principal, reservation.holder);
  assert.equal(receipt.recordedAt, after.state.lastRecordedAt);
  await page.getByRole('tab', { name: 'details', exact: true }).click();
  await assertAmounts(page, expect, '80', '40', '40');
  await capture('03-partial-fulfillment', { ...after, availability });
  return {
    project,
    scope,
    ...after,
    stockId: stock.id,
    reservationId: reservation.id,
    holder: reservation.holder,
    priorNativeActor: receipt.actor,
  };
}

export async function runInventoryReservationReopen({
  page,
  expect,
  inventoryRead,
  capture,
  fixture,
}) {
  const { project, scope, stockId, reservationId, holder } = fixture;
  let after = await inventoryRead(scope);
  assert.deepEqual(after.state, fixture.state);
  assert.deepEqual(after.history, fixture.history);
  let availability = await availabilityRead(page, scope);
  assert.deepEqual(availability.principal, holder);
  assert.deepEqual(after.state.reservations[reservationId].holder, holder);
  await showStock(page, stockId);
  await assertAmounts(page, expect, '80', '40', '40');
  await capture('04-reopened-stable-holder-and-exact-history', { ...after, availability });
  await page.getByRole('tab', { name: 'reservations', exact: true }).click();
  const booking = page
    .getByTestId('inventory-reservations')
    .locator(`[data-reservation-id="${reservationId}"]`);
  await expect(booking).toContainText('This desktop profile');
  await booking.getByRole('button', { name: 'Release reservation', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Release reservation', exact: true });
  await dialog
    .getByLabel('Reason', { exact: true })
    .fill('Release the unused allocation after restart');
  await dialog.getByRole('button', { name: 'Release reservation', exact: true }).click();
  await expect(dialog).toBeHidden();
  after = await inventoryRead(scope);
  availability = await availabilityRead(page, scope);
  assert.equal(after.state.reservations[reservationId].lifecycle.kind, 'released');
  assert.equal(after.state.stocks[stockId].quantity.value, '80');
  assert.equal(availability.stocks[stockId].held.value, '0');
  assert.equal(availability.stocks[stockId].unreserved.value, '80');
  await expect(booking.locator('[data-reservation-state="released"]')).toHaveText('Released');
  await page.getByRole('tab', { name: 'details', exact: true }).click();
  await assertAmounts(page, expect, '80', '0', '80');
  await capture('05-release-preserves-stock-and-restores-availability', { ...after, availability });
  return { project, scope, ...after, stockId, reservationId, holder };
}

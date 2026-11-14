import assert from 'node:assert/strict';

export async function runInventoryCompositionJourney({
  page,
  expect,
  choose,
  inventoryRead,
  capture,
  fixture,
}) {
  const { project, scope } = fixture;
  const initial = await inventoryRead(scope);
  const source = initial.state.stocks[fixture.stockId];
  const water = Object.values(initial.state.stocks).find(
    (stock) => stock.materialId === fixture.water.id
  );
  assert.ok(source && water);
  const materialPage = await page.evaluate(
    (input) => window.electronAPI.inventory.materials(input),
    { project: project.projectId, query: source.materialId, limit: 100 }
  );
  const material = materialPage.items.find((item) => item.id === source.materialId);
  assert.ok(material);
  const row = (id) => page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`);
  async function record(id, value, replace = false) {
    await row(id).click();
    await page.getByRole('button', { name: 'Record composition', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Record composition', exact: true });
    await choose(dialog, 'Composition', 'Homogeneous');
    if (replace)
      await dialog.getByRole('button', { name: 'Replace measurement 1', exact: true }).click();
    else {
      await dialog.getByLabel('Find analyte material', { exact: true }).fill(source.materialId);
      await choose(dialog, 'Analyte 1', new RegExp(material.name));
    }
    await choose(dialog, 'Concentration status 1', 'Measured');
    await dialog.getByLabel('Concentration 1', { exact: true }).fill(value);
    await dialog.getByLabel('Reason', { exact: true }).fill('Synthetic concentration measurement');
    await capture(`measurement-${id}-${value}`, await dialog.innerText());
    await dialog.getByRole('button', { name: 'Record composition', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await capture('01-before-concentration-measurements', initial);
  await record(source.id, '1');
  await record(water.id, '0');
  await row(source.id).click();
  await page.getByRole('button', { name: 'Dilute stock', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Dilute stock', exact: true });
  await dialog.getByLabel('Sample amount (µL)', { exact: true }).fill('1');
  await choose(dialog, 'Tracked diluent', /^Water tube acceptance/);
  await dialog.getByLabel('Diluent amount (µL)', { exact: true }).fill('2');
  await dialog.getByLabel('Output batch name', { exact: true }).fill('Exact-third acceptance');
  await dialog.getByLabel('Find output material', { exact: true }).fill(source.materialId);
  await choose(dialog, 'Output material', new RegExp(material.name));
  await dialog
    .getByLabel('Destination container name', { exact: true })
    .fill('Exact-third tube acceptance');
  await choose(dialog, 'Result mixing', 'Homogeneous');
  await dialog
    .getByLabel('Reason', { exact: true })
    .fill('Mix measured source with explicitly analyte-free tracked diluent');
  await dialog.getByRole('button', { name: 'Dilute stock', exact: true }).click();
  await expect(dialog).toBeHidden();
  let after = await inventoryRead(scope);
  const lot = Object.values(after.state.lots).find(
    (item) => item.name === 'Exact-third acceptance'
  );
  const output = Object.values(after.state.stocks).find(
    (item) => item.source.kind === 'lot' && item.source.lotId === lot?.id
  );
  assert.ok(lot && output);
  const exact = { kind: 'known', unit: 'ng/uL', numerator: '1', denominator: '3' };
  assert.equal(output.quantity.value, '3');
  assert.deepEqual(output.composition.analytes[source.materialId], exact);
  assert.equal(lot.origin.sample.composition.analytes[source.materialId].numerator, '1');
  assert.equal(lot.origin.diluent.composition.analytes[source.materialId].numerator, '0');
  await row(output.id).click();
  await expect(page.getByTestId('inventory-stock-composition')).toContainText('1/3 ng/µL');
  await capture('02-exact-one-third-dilution', after);
  await page.getByRole('button', { name: 'Record composition', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Record composition', exact: true });
  await expect(dialog).toContainText('1/3 ng/µL');
  await dialog.getByRole('button', { name: 'Add analyte', exact: true }).click();
  await dialog.getByLabel('Find analyte material', { exact: true }).fill(fixture.water.id);
  await choose(dialog, 'Analyte 2', /^Water acceptance/);
  await choose(dialog, 'Concentration status 2', 'Measured');
  await dialog.getByLabel('Concentration 2', { exact: true }).fill('2');
  await dialog
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic second-analyte edit; preserve original exact fraction');
  await dialog.getByRole('button', { name: 'Record composition', exact: true }).click();
  await expect(dialog).toBeHidden();
  after = await inventoryRead(scope);
  assert.deepEqual(after.state.stocks[output.id].composition.analytes[source.materialId], exact);
  assert.equal(after.state.stocks[output.id].composition.analytes[fixture.water.id].numerator, '2');
  await capture('03-exact-fraction-preserved-while-editing-another-analyte', after);
  await record(source.id, '9', true);
  after = await inventoryRead(scope);
  assert.equal(
    after.state.stocks[source.id].composition.analytes[source.materialId].numerator,
    '9'
  );
  assert.deepEqual(after.state.stocks[output.id].composition.analytes[source.materialId], exact);
  assert.deepEqual(after.state.lots[lot.id].origin, lot.origin);
  await row(output.id).click();
  await expect(page.getByTestId('inventory-stock-composition')).toContainText('1/3 ng/µL');
  await expect(page.getByTestId('inventory-lot-contributions')).toContainText('1 ng/µL');
  await capture('04-immutable-input-facts-after-new-source-measurement', after);
  return {
    project,
    scope,
    state: after.state,
    history: after.history,
    stockId: output.id,
    analyteId: source.materialId,
    lotId: lot.id,
  };
}

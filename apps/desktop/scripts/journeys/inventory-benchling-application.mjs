import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const reference = (item) => JSON.stringify([item.responseId, item.pointer]);
const namespace = 'benchling:synthetic-physical-example';
const sourceBinding = (bindings, id) =>
  Object.values(bindings).find((item) => item.namespace === namespace && item.sourceId === id);
const reason =
  'Explicit synthetic desktop interpretation; selected records do not establish complete inventory';
async function chooseValue(page, scope, label, value) {
  await scope.getByRole('combobox', { name: label, exact: true }).click();
  await page.locator(`[role="option"][data-value=${JSON.stringify(value)}]`).click();
}
async function closeDrawer(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function openCapture(ctx, text) {
  const { page, expect } = ctx;
  await closeDrawer(page);
  await button(
    page.getByTestId('inventory-panel').locator('header'),
    'Inspect Benchling capture'
  ).click();
  const form = page.getByRole('dialog', { name: 'Inspect Benchling capture', exact: true });
  await form.getByLabel('Benchling capture text', { exact: true }).fill(text);
  await button(form, 'Inspect capture').click();
  await expect(form.getByTestId('inventory-benchling-capture')).toHaveAttribute(
    'data-inspection-state',
    'inspected'
  );
  await button(form, 'Interpret physical inventory').click();
  return form;
}
async function decideCapture(ctx, form, inspection, materials) {
  const { page } = ctx;
  const application = form.getByTestId('inventory-benchling-application');
  const choose = (label, value) => chooseValue(page, application, label, value);
  const fill = (label, value = reason) =>
    application.getByLabel(label, { exact: true }).fill(value);
  const selected = (record, field, responseId) =>
    record.fields[field].observations.find(
      (item) => item.kind !== 'omitted' && (!responseId || item.responseId === responseId)
    );
  await fill('Selected-record scope reason');
  for (const issue of inspection.issues)
    await fill(
      `Source issue reason ${JSON.stringify([issue.code, issue.responseId, issue.bodyPointer])}`
    );
  for (const record of inspection.records.filter((item) => !item.kind.endsWith('-schema'))) {
    const id = record.sourceId;
    const group = application.locator(
      `[data-testid="inventory-benchling-record-choice"][data-source-id="${id}"]`
    );
    await group.locator('summary').click();
    await choose(`Disposition for ${id}`, record.kind === 'container' ? 'vessel' : 'storage');
    await button(group, `Copy unique captured facts for ${id}`).click();
    if (record.kind === 'container')
      await choose(
        `Physical target for ${id}`,
        id.startsWith('con_well') ? 'fixed-well' : 'movable'
      );
    if (!id.startsWith('con_well'))
      await choose(`Captured name for ${id}`, reference(selected(record, 'name')));
    if (record.kind === 'location') {
      await fill(
        `Named positions for ${id}`,
        id === 'loc_freezer' ? 'Shelf' : 'Box, Fixed, Matrix'
      );
      await fill(`Layout reason for ${id}`);
    } else if (record.kind !== 'container') {
      if (record.kind === 'plate')
        await choose(`Captured type for ${id}`, reference(selected(record, 'type')));
      await fill(`Layout reason for ${id}`);
    }
    const claim = inspection.placements.find((item) => item.containerId === id);
    if (record.kind === 'container' && claim) {
      await choose(`Placement for ${id}`, 'source');
      await choose(
        `Source parent for ${id}`,
        claim.kind === 'plate-well' ? claim.plateId : claim.boxId
      );
      await choose(`Placement evidence for ${id}`, `membership:${reference(claim)}`);
      await fill(
        `Position for ${id}`,
        claim.kind === 'plate-well' ? claim.position : JSON.parse(claim.gridPosition.jsonText)
      );
      await choose(`Position basis for ${id}`, 'captured-exact');
    } else if (id === 'con_missing') {
      await choose(`Placement for ${id}`, 'unplaced');
      await choose(`Placement evidence for ${id}`, 'declared');
    } else if (id === 'loc_freezer') {
      await choose(`Placement for ${id}`, 'root');
      await choose(
        `Placement evidence for ${id}`,
        `captured:${reference(selected(record, 'parentStorageId'))}`
      );
    } else {
      await choose(`Placement for ${id}`, 'source');
      await choose(`Source parent for ${id}`, id === 'loc_shelf' ? 'loc_freezer' : 'loc_shelf');
      await choose(
        `Placement evidence for ${id}`,
        `captured:${reference(selected(record, 'parentStorageId'))}`
      );
      await fill(
        `Position for ${id}`,
        id === 'loc_shelf'
          ? 'Shelf'
          : id === 'box_1'
            ? 'Box'
            : id === 'plt_fixed'
              ? 'Fixed'
              : 'Matrix'
      );
      await choose(`Position basis for ${id}`, 'declared-mapping');
      await fill(`Position reason for ${id}`);
    }
    await fill(`Placement reason for ${id}`);
    if (record.kind === 'container') {
      const contents =
        id === 'con_missing'
          ? 'unobserved'
          : id === 'con_empty' || id === 'con_well_empty'
            ? 'empty'
            : id === 'con_multiple' || id === 'con_count'
              ? 'unidentified'
              : 'identify';
      await choose(`Contents for ${id}`, contents);
      if (contents !== 'unobserved')
        await choose(`Captured contents for ${id}`, reference(selected(record, 'contents')));
      await fill(`Contents reason for ${id}`);
      if (contents === 'identify') {
        await choose(
          `Scientific record for ${id}`,
          id === 'con_matrix_tube' ? materials.b : materials.a
        );
        await choose(`Quality for ${id}`, 'usable');
        await fill(`Quality reason for ${id}`);
      }
      if (contents === 'identify' || contents === 'empty') {
        await choose(
          `Quantity interpretation for ${id}`,
          id === 'con_matrix_tube' ? 'unknown' : 'source-volume'
        );
        if (id !== 'con_matrix_tube')
          await choose(
            `Captured quantity for ${id}`,
            reference(selected(record, 'quantity', id === 'con_filled' ? 'box-page-1' : undefined))
          );
        await fill(`Quantity reason for ${id}`);
      }
    } else if (id === 'plt_matrix') {
      await fill(`Uncaptured positions for ${id}`, 'A2, B1, B2');
      await fill(`Uncaptured positions reason for ${id}`);
    }
    await group.locator('summary').click();
  }
  await fill('Remaining source evidence reason');
  await button(application, 'Keep undecided records as source evidence').click();
  await button(application, 'Preview physical inventory').click();
  return application;
}
export async function runInventoryBenchlingApplicationJourney(ctx) {
  const { page, expect, fixture, inventoryRead, capture, evidenceDirectory, projectRoot } = ctx;
  const { scope, project } = fixture;
  const initial = await inventoryRead(scope);
  assert.deepEqual(initial.state, fixture.state);
  assert.deepEqual(initial.history, fixture.history);
  assert.equal(
    Object.values(initial.state.vesselBindings).some((item) => item.namespace === namespace),
    false
  );
  const materials = Object.fromEntries(
    ['MP001', 'MP002'].map((id, index) => [
      index === 0 ? 'a' : 'b',
      Object.values(initial.state.tableBindings).find((item) => item.sourceId === id)?.materialId,
    ])
  );
  assert.ok(materials.a && materials.b);
  const sourceText = readFileSync(
    path.join(
      projectRoot,
      'test-fixtures/lims-import/benchling-physical/representative-capture.json'
    ),
    'utf8'
  );
  writeFileSync(path.join(evidenceDirectory, 'original-capture.json'), sourceText);
  const checkpoint = (name, data) =>
    writeFileSync(
      path.join(evidenceDirectory, `${name}-fixture.json`),
      JSON.stringify(
        {
          ...fixture,
          ...data,
          benchling: { initialRevision: initial.state.revision, namespace, sourceText, materials },
        },
        null,
        2
      )
    );
  await capture('01-before-capture-application', initial);
  let form = await openCapture(ctx, sourceText);
  const inspection = await page.evaluate(
    (request) => window.electronAPI.inventory.inspectBenchlingCapture(request),
    { ...scope, sourceText }
  );
  let application = await decideCapture(ctx, form, inspection, materials);
  await expect(application.getByTestId('inventory-benchling-application-preview')).toHaveAttribute(
    'data-preview-kind',
    'ready'
  );
  assert.deepEqual(await inventoryRead(scope), initial);
  await capture('02-explicit-physical-and-contents-preview', { initial, inspection });
  await button(application, 'Import physical inventory').click();
  await expect(form).toBeHidden();
  const imported = await inventoryRead(scope);
  checkpoint('imported', imported);
  assert.equal(imported.state.revision, initial.state.revision + 1);
  assert.equal(imported.history.length, initial.history.length + 1);
  return finishBenchlingApplication(ctx, imported, initial.state.revision, sourceText, materials);
}

async function finishBenchlingApplication(ctx, imported, initialRevision, sourceText, materials) {
  const { page, expect, fixture, inventoryRead, capture, evidenceDirectory } = ctx;
  const { scope } = fixture;
  let form;
  let application;
  const checkpoint = (name, data) =>
    writeFileSync(
      path.join(evidenceDirectory, `${name}-fixture.json`),
      JSON.stringify(
        { ...fixture, ...data, benchling: { initialRevision, namespace, sourceText, materials } },
        null,
        2
      )
    );
  const entry = imported.history.at(-1);
  assert.equal(entry.request.kind, 'import-benchling-capture');
  assert.equal(entry.request.sourceText, sourceText);
  const vessel = (id) => sourceBinding(imported.state.vesselBindings, id).vesselId;
  assert.equal(
    Object.values(imported.state.vesselBindings).filter((item) => item.namespace === namespace)
      .length,
    8
  );
  assert.equal(
    imported.state.vessels[vessel('con_multiple')].contentsKnowledge.kind,
    'unidentified'
  );
  assert.equal(imported.state.vessels[vessel('con_missing')].contentsKnowledge.kind, 'unobserved');
  const filled = Object.values(imported.state.stocks).find(
    (item) => item.vesselId === vessel('con_filled')
  );
  const zero = Object.values(imported.state.stocks).find(
    (item) => item.vesselId === vessel('con_well_zero')
  );
  assert.deepEqual(filled.quantity, { kind: 'known', value: '10.25', unit: 'uL' });
  assert.deepEqual(zero.quantity, { kind: 'known', value: '0', unit: 'uL' });
  const fixedId = sourceBinding(imported.state.hierarchyBindings, 'plt_fixed').storageId;
  await page.locator(`[role="treeitem"][data-location-id="${fixedId}"]`).click();
  await page.getByTestId('inventory-positions').locator('[data-position-id="A1"]').click();
  await expect(page.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'identified'
  );
  await capture('03a-known-zero-remains-identified', imported);
  await closeDrawer(page);
  await page.getByTestId('inventory-positions').locator('[data-position-id="B1"]').click();
  await expect(page.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unobserved'
  );
  await expect(button(page.getByTestId('inventory-detail-drawer'), 'Receive stock')).toBeDisabled();
  await capture('03b-uncaptured-permanent-well-remains-unobserved', imported);
  await closeDrawer(page);
  await page.getByRole('treeitem').filter({ hasText: 'Synthetic tube box' }).click();
  await page
    .getByTestId('inventory-empty-containers')
    .locator(`[data-vessel-id="${vessel('con_multiple')}"]`)
    .click();
  let drawer = page.getByTestId('inventory-detail-drawer');
  await expect(drawer.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unidentified'
  );
  await expect(button(drawer, 'Receive stock')).toBeDisabled();
  await capture('03-imported-unidentified-tube-is-not-an-empty-position', imported);
  await button(drawer, 'Move').click();
  let move = page.getByRole('dialog', { name: 'Move container', exact: true });
  await ctx.choose(move, 'Location', 'Unplaced');
  await button(move, 'Move container').click();
  await expect(move).toBeHidden();
  await closeDrawer(page);
  await button(page, 'All stock').click();
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${filled.id}"]`).click();
  await button(page, 'Use stock').click();
  const use = page.getByRole('dialog', { name: 'Use stock', exact: true });
  await use.getByLabel('Quantity', { exact: true }).fill('2');
  await use
    .getByLabel('Reason', { exact: true })
    .fill('Local use after explicit Benchling source import');
  await button(use, 'Use stock').click();
  await expect(use).toBeHidden();
  await closeDrawer(page);
  const afterUse = await inventoryRead(scope);
  checkpoint('after-local-work', afterUse);
  assert.deepEqual(afterUse.state.stocks[filled.id].quantity, {
    kind: 'known',
    value: '8.25',
    unit: 'uL',
  });
  assert.deepEqual(afterUse.state.vessels[vessel('con_multiple')].placement, { kind: 'unplaced' });
  await capture('04-local-move-and-use-keep-original-source-bindings', afterUse);
  const reordered = JSON.parse(sourceText);
  reordered.responses.reverse();
  form = await openCapture(ctx, JSON.stringify(reordered));
  application = form.getByTestId('inventory-benchling-application');
  await button(application, `Reuse interpretation from revision ${entry.receipt.revision}`).click();
  await button(application, 'Preview physical inventory').click();
  await expect(application.getByTestId('inventory-benchling-application-preview')).toHaveAttribute(
    'data-preview-kind',
    'no-change'
  );
  await expect(button(application, 'Import physical inventory')).toBeDisabled();
  assert.deepEqual(await inventoryRead(scope), afterUse);
  await capture('05-reordered-reimport-keeps-move-and-consumption', afterUse);
  await button(form, 'Close').click();
  const originalReceipt = await page.evaluate(
    (request) => window.electronAPI.inventory.applyBenchlingCapture(request),
    entry.request
  );
  assert.deepEqual(originalReceipt, entry.receipt);
  assert.deepEqual(await inventoryRead(scope), afterUse);
  const changed = JSON.parse(sourceText);
  const firstPage = changed.responses.find((item) => item.id === 'box-page-1');
  const firstBody = JSON.parse(firstPage.bodyText);
  firstBody.containers[1].quantity.value = 12;
  firstPage.bodyText = JSON.stringify(firstBody);
  form = await openCapture(ctx, JSON.stringify(changed));
  application = form.getByTestId('inventory-benchling-application');
  await button(application, `Reuse interpretation from revision ${entry.receipt.revision}`).click();
  await button(application, 'Preview physical inventory').click();
  await expect(application.getByTestId('inventory-benchling-application-preview')).toHaveAttribute(
    'data-preview-kind',
    'blocked'
  );
  await expect(application.getByTestId('inventory-benchling-application-preview')).toContainText(
    'reconciliation'
  );
  await expect(button(application, 'Import physical inventory')).toBeDisabled();
  assert.deepEqual(await inventoryRead(scope), afterUse);
  await capture('05b-changed-source-amount-requires-reconciliation', afterUse);
  await button(form, 'Close').click();
  await button(page.getByTestId('inventory-panel').locator('header'), 'History').click();
  drawer = page.getByTestId('inventory-detail-drawer');
  await expect(drawer).toContainText('Imported Benchling physical inventory');
  const sourceEntry = drawer.locator(`[data-operation-id="${entry.receipt.operationId}"]`);
  await sourceEntry.locator('summary').click();
  await expect(
    sourceEntry.getByLabel('Retained Benchling physical capture', { exact: true })
  ).toHaveValue(sourceText);
  await expect(
    sourceEntry.getByLabel('Retained Benchling physical interpretation', { exact: true })
  ).toHaveValue(JSON.stringify(entry.request.options, null, 2));
  await capture('06-retained-original-capture-and-interpretation-history', afterUse);
  await closeDrawer(page);
  checkpoint('complete', afterUse);
  return {
    ...fixture,
    ...afterUse,
    benchling: {
      initialRevision: initialRevision,
      namespace,
      sourceText,
      materials,
      originalRequest: entry.request,
      originalReceipt: entry.receipt,
      filledStockId: filled.id,
      movedVesselId: vessel('con_multiple'),
      zeroStockId: zero.id,
    },
  };
}
export async function runInventoryBenchlingApplicationResume(ctx) {
  const { fixture, inventoryRead, capture } = ctx;
  const actual = await inventoryRead(fixture.scope);
  assert.deepEqual(actual.state, fixture.state);
  assert.deepEqual(actual.history, fixture.history);
  assert.equal(actual.state.revision, fixture.benchling.initialRevision + 1);
  assert.equal(actual.history.at(-1).request.kind, 'import-benchling-capture');
  await capture('01-resumed-from-verified-single-import', actual);
  return finishBenchlingApplication(
    ctx,
    actual,
    fixture.benchling.initialRevision,
    fixture.benchling.sourceText,
    fixture.benchling.materials
  );
}
export async function runInventoryBenchlingApplicationReopen(ctx) {
  const { page, expect, fixture, inventoryRead, capture } = ctx;
  const actual = await inventoryRead(fixture.scope);
  assert.deepEqual(actual.state, fixture.state);
  assert.deepEqual(actual.history, fixture.history);
  assert.ok(
    Object.values(actual.state.vesselBindings).some((item) => item.namespace === namespace)
  );
  const receipt = await page.evaluate(
    (request) => window.electronAPI.inventory.applyBenchlingCapture(request),
    fixture.benchling.originalRequest
  );
  assert.deepEqual(receipt, fixture.benchling.originalReceipt);
  assert.deepEqual(await inventoryRead(fixture.scope), actual);
  await button(page, 'All stock').click();
  await page
    .getByTestId('inventory-stock-table')
    .locator(`[data-stock-id="${fixture.benchling.filledStockId}"]`)
    .click();
  await expect(page.getByTestId('inventory-detail-drawer')).toContainText('8.25');
  await capture('01-reopened-consumed-quantity-and-original-bindings', actual);
  await closeDrawer(page);
  await page
    .getByTestId('inventory-empty-containers')
    .locator(`[data-vessel-id="${fixture.benchling.movedVesselId}"]`)
    .click();
  await expect(page.getByTestId('inventory-contents')).toHaveAttribute(
    'data-contents-state',
    'unidentified'
  );
  await expect(button(page.getByTestId('inventory-detail-drawer'), 'Receive stock')).toBeDisabled();
  await capture('02-reopened-unidentified-container-preserves-local-move', actual);
  await closeDrawer(page);
  return fixture;
}

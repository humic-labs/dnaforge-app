import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const modal = (page, name) => page.getByRole('dialog', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function closeStock(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function showStock(page, id) {
  await closeStock(page);
  await button(page, 'All stock').click();
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`).click();
}
function arrivalOf(fixture, state) {
  const arrival = Object.values(state.arrivals).find(
    (row) => row.identity.arrivalId === fixture.arrivalJourney.deliveryId
  );
  assert.ok(arrival, 'Recorded actual delivery');
  return arrival;
}
function assertStage(fixture, current, step) {
  const proof = fixture.arrivalJourney;
  assert.equal(current.state.schema, 'dnaforge.inventory.v21');
  assert.equal(current.state.revision, proof.initialRevision + step);
  assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  for (const [id, stock] of Object.entries(proof.baselineStocks))
    assert.deepEqual(current.state.stocks[id], stock);
  if (!step) return;
  const arrival = arrivalOf(fixture, current.state);
  assert.equal(arrival.components.length, 1);
  assert.equal(arrival.supplier, 'Synthetic supplier');
  const component = arrival.components[0];
  assert.equal(component.choice.kind, 'identified');
  assert.deepEqual(component.receivedQuantity, { kind: 'known', value: '1000000', unit: 'ng' });
  const stock = current.state.stocks[component.target.stockId];
  assert.deepEqual(stock.quantity, {
    kind: 'known',
    value: step >= 3 ? '900000' : '1000000',
    unit: 'ng',
  });
  const lot = current.state.lots[component.target.lotId];
  assert.equal(lot.controls.kind, 'managed');
  assert.equal(lot.controls.assessment.value, step >= 2 ? 'released' : 'unassessed');
}
export async function runInventoryArrivalJourney(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(current.state.schema, 'dnaforge.inventory.v21');
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const materialId = Object.values(current.state.tableBindings).find(
    (binding) => binding.sourceId === 'MP001'
  )?.materialId;
  assert.ok(materialId);
  const page = await ctx.page.evaluate((input) => window.electronAPI.inventory.materials(input), {
    project: ctx.fixture.project.projectId,
    query: materialId,
    limit: 100,
  });
  const material = page.items.find((item) => item.id === materialId);
  assert.ok(material);
  const tag = randomUUID().slice(0, 8),
    deliveryId = `desktop-${tag}`;
  return finish({
    ...ctx,
    fixture: {
      ...ctx.fixture,
      arrivalJourney: {
        initialRevision: current.state.revision,
        completedStep: 0,
        baselineStocks: current.state.stocks,
        baselineHistory: current.history,
        deliveryId,
        componentLabel: `Delivery ${tag} reagent`,
        vesselName: `Delivery ${tag} vial`,
        lotName: `Delivery ${tag} supplier lot`,
        batch: `BATCH-${tag}`,
        material,
        documentText: `Synthetic original supplier text\nComponent batch: BATCH-${tag}\nAmount field: 1 mg\nSupplier QC: pass (evidence only)\n`,
      },
    },
  });
}
export async function runInventoryArrivalResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'arrival-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertStage(ctx.fixture, current, ctx.fixture.arrivalJourney.completedStep);
  await ctx.capture('00-resumed-exact-delivery-checkpoint', current);
  return finish(ctx);
}
async function finish(ctx) {
  const { page, expect, choose, fixture, inventoryRead, capture, evidenceDirectory } = ctx;
  const proof = fixture.arrivalJourney;
  let current = await inventoryRead(fixture.scope);
  const checkpoint = (step) => {
    const saved = {
      project: fixture.project,
      scope: fixture.scope,
      ...current,
      arrivalJourney: { ...proof, completedStep: step },
      resumePhase: 'arrival-after-accepted-stage',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${String(step).padStart(2, '0')}-arrival-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint(proof.completedStep);
  const actions = [
    async () => {
      await closeStock(page);
      await button(page, 'Receive delivery').click();
      const form = modal(page, 'Receive delivery');
      await field(form, 'Delivery namespace').fill('desktop-arrival-acceptance');
      await field(form, 'Actual delivery ID').fill(proof.deliveryId);
      await field(form, 'Supplier').fill('Synthetic supplier');
      await field(form, 'Arrival observation reason').fill(
        'Actual synthetic delivery observed in owned acceptance profile'
      );
      await field(form, 'Component scope reason').fill(
        'One explicitly observed loose reagent vial'
      );
      await field(form, 'Original supplier document text').fill(proof.documentText);
      await choose(form, 'Document coverage', 'Explicitly labeled text excerpt');
      await field(form, 'Excerpt scope reason').fill(
        'Exact retained synthetic certificate excerpt, not a whole supplier PDF'
      );
      await field(form, 'Find scientific material').fill(proof.material.id);
      await choose(form, 'Component 1 material', new RegExp(escape(proof.material.name)));
      await field(form, 'Component 1 label').fill(proof.componentLabel);
      await field(form, 'Component 1 batch').fill(proof.batch);
      await field(form, 'Component 1 new lot name').fill(proof.lotName);
      await field(form, 'Component 1 management reason').fill(
        'Start explicit local assessment; supplier QC does not release'
      );
      await field(form, 'Component 1 measured amount').fill('1');
      await choose(form, 'Component 1 unit', 'mg');
      await field(form, 'Component 1 amount reason').fill(
        'Explicit synthetic measured mass, independent from supplier QC'
      );
      await choose(
        form,
        'Component 1 local stock quality',
        'Usable stock; lot assessment remains separate'
      );
      await field(form, 'Component 1 local quality reason').fill(
        'Local stock quality declared independently'
      );
      await field(form, 'Component 1 container name').fill(proof.vesselName);
      await choose(form, 'Component 1 location', 'Unplaced');
      await button(form, 'Preview complete delivery').click();
      await expect(form.getByTestId('inventory-arrival-form')).toHaveAttribute(
        'data-preview-state',
        'ready'
      );
      await capture('01-ready-complete-delivery-preview', { before: current });
      await button(form, 'Receive delivery atomically').click();
      await expect(form).toBeHidden();
    },
    async () => {
      const arrival = arrivalOf(fixture, current.state),
        lotId = arrival.components[0].target.lotId;
      await closeStock(page);
      await button(page, 'Lot quality and recalls').click();
      const form = modal(page, 'Lot quality and recalls');
      await choose(form, 'Lot or preparation', new RegExp(`^${escape(proof.lotName)}`));
      await button(form, 'Record assessment').click();
      await choose(form, 'Lot assessment', 'Released');
      await field(form, 'Reason').fill(
        'Explicit local release after delivery; source QC did not authorize use'
      );
      await button(form, 'Record lot assessment').click();
      await expect(form).toBeHidden();
      assert.ok(lotId);
    },
    async () => {
      const arrival = arrivalOf(fixture, current.state);
      await showStock(page, arrival.components[0].target.stockId);
      await button(page, 'Use stock').click();
      const form = modal(page, 'Use stock');
      await field(form, 'Quantity').fill('100');
      await choose(form, 'Unit', 'µg');
      await field(form, 'Reason').fill('Use after actual local lot release');
      await button(form, 'Use stock').click();
      await expect(form).toBeHidden();
    },
  ];
  for (let index = proof.completedStep; index < actions.length; index++) {
    await actions[index]();
    current = await inventoryRead(fixture.scope);
    const step = index + 1;
    checkpoint(step);
    assertStage(fixture, current, step);
    const arrival = arrivalOf(fixture, current.state);
    await showStock(page, arrival.components[0].target.stockId);
    await capture(
      `${String(step + 1).padStart(2, '0')}-${['recorded-unassessed-delivery', 'explicit-local-release', 'used-mass-keeps-original-arrival'][index]}`,
      current
    );
  }
  await closeStock(page);
  await button(page, 'Receive delivery').click();
  const form = modal(page, 'Receive delivery');
  await expect(field(form, 'Actual delivery ID')).toHaveValue(proof.deliveryId);
  await button(form, 'Preview complete delivery').click();
  await expect(form.getByTestId('inventory-arrival-form')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  await expect(button(form, 'Receive delivery atomically')).toBeDisabled();
  const facts = form.getByTestId('inventory-arrival-facts').first();
  await expect(facts.locator('[data-original-received-quantity]')).toHaveText(
    'Original received amount: 1000000 ng'
  );
  await expect(facts.locator('[data-current-remaining-quantity]')).toHaveText(
    'Current remaining amount: 900000 ng'
  );
  await button(facts, 'Read retained document document-1').click();
  await expect(
    facts.getByRole('textbox', { name: 'Retained original delivery document', exact: true })
  ).toHaveValue(proof.documentText);
  const unchanged = await inventoryRead(fixture.scope);
  assert.deepEqual(unchanged.state, current.state);
  assert.deepEqual(unchanged.history, current.history);
  await capture('05-already-recorded-original-document-and-current-remaining', {
    ...unchanged,
    arrival: arrivalOf(fixture, current.state),
  });
  await button(form, 'Cancel').click();
  return checkpoint(3);
}
export async function runInventoryArrivalReopen(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertStage(ctx.fixture, current, 3);
  await closeStock(ctx.page);
  await button(ctx.page, 'Receive delivery').click();
  const form = modal(ctx.page, 'Receive delivery');
  await ctx
    .expect(field(form, 'Actual delivery ID'))
    .toHaveValue(ctx.fixture.arrivalJourney.deliveryId);
  await button(form, 'Preview complete delivery').click();
  await ctx
    .expect(form.getByTestId('inventory-arrival-form'))
    .toHaveAttribute('data-preview-state', 'no-change');
  const facts = form.getByTestId('inventory-arrival-facts').first();
  await button(facts, 'Read retained document document-1').click();
  await ctx
    .expect(
      facts.getByRole('textbox', { name: 'Retained original delivery document', exact: true })
    )
    .toHaveValue(ctx.fixture.arrivalJourney.documentText);
  await ctx
    .expect(facts.locator('[data-original-received-quantity]'))
    .toHaveText('Original received amount: 1000000 ng');
  await ctx
    .expect(facts.locator('[data-current-remaining-quantity]'))
    .toHaveText('Current remaining amount: 900000 ng');
  await ctx.capture('reopened-exact-original-delivery-and-remaining', current);
  return { ...ctx.fixture, ...current };
}

function assertComponentsStage(fixture, current) {
  const proof = fixture.arrivalComponentsJourney;
  assert.equal(current.state.schema, 'dnaforge.inventory.v21');
  assert.equal(current.state.revision, proof.initialRevision + 1);
  assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  for (const [id, stock] of Object.entries(proof.baselineStocks))
    assert.deepEqual(
      current.state.stocks[id],
      stock,
      'Earlier stock remains unchanged by the second arrival'
    );
  const first = arrivalOf(fixture, current.state),
    firstComponent = first.components[0];
  assert.deepEqual(firstComponent.receivedQuantity, {
    kind: 'known',
    value: '1000000',
    unit: 'ng',
  });
  assert.deepEqual(current.state.stocks[firstComponent.target.stockId].quantity, {
    kind: 'known',
    value: '900000',
    unit: 'ng',
  });
  const arrival = Object.values(current.state.arrivals).find(
    (row) => row.identity.arrivalId === proof.deliveryId
  );
  assert.ok(arrival);
  assert.notEqual(arrival.id, first.id);
  assert.equal(arrival.components.length, 2);
  assert.equal(arrival.packages.length, 1);
  assert.equal(arrival.packages[0].label, proof.packageLabel);
  assert.equal(arrival.packages[0].packagingBatch, proof.packagingBatch);
  const identified = arrival.components.find((component) => component.choice.kind === 'identified'),
    unidentified = arrival.components.find(
      (component) => component.choice.kind === 'unidentified-physical'
    );
  assert.ok(identified);
  assert.ok(unidentified);
  assert.equal(identified.packageKey, arrival.packages[0].key);
  assert.equal(unidentified.packageKey, arrival.packages[0].key);
  assert.equal(identified.componentBatch, proof.componentBatch);
  assert.notEqual(identified.componentBatch, arrival.packages[0].packagingBatch);
  assert.deepEqual(identified.receivedQuantity, { kind: 'known', value: '2000000', unit: 'ng' });
  assert.deepEqual(
    current.state.stocks[identified.target.stockId].quantity,
    identified.receivedQuantity
  );
  assert.equal(current.state.lots[identified.target.lotId].controls.assessment.value, 'unassessed');
  assert.equal(unidentified.target.stockId, null);
  assert.equal(unidentified.target.lotId, null);
  assert.equal(unidentified.receivedQuantity, null);
  assert.equal(
    current.state.vessels[unidentified.target.vesselId].contentsKnowledge.kind,
    'unidentified'
  );
  assert.equal(
    Object.values(current.state.stocks).some(
      (stock) => stock.vesselId === unidentified.target.vesselId
    ),
    false
  );
  return arrival;
}
async function showEarlierArrival(form, page, id) {
  const summary = form
    .locator('summary')
    .filter({ hasText: /^Previously received deliveries/ })
    .first();
  const outer = summary.locator('..');
  if ((await outer.getAttribute('open')) === null) await summary.click();
  const facts = form
    .locator(`[data-testid="inventory-arrival-facts"][data-arrival-id="${id}"]`)
    .last();
  const container = facts.locator('..');
  if ((await container.getAttribute('open')) === null)
    await container.locator(':scope > summary').click();
  await facts.scrollIntoViewIfNeeded();
  return facts;
}
async function verifyComponentsPresentation(ctx, current) {
  const { fixture, page, expect } = ctx,
    proof = fixture.arrivalComponentsJourney;
  const arrival = assertComponentsStage(fixture, current),
    first = arrivalOf(fixture, current.state);
  const form = modal(page, 'Receive delivery');
  await expect(field(form, 'Actual delivery ID')).toHaveValue(proof.deliveryId);
  await button(form, 'Preview complete delivery').click();
  await expect(form.getByTestId('inventory-arrival-form')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  await expect(button(form, 'Receive delivery atomically')).toBeDisabled();
  const facts = form.getByTestId('inventory-arrival-facts').first();
  await expect(facts.locator('[data-original-received-quantity]')).toHaveText(
    'Original received amount: 2000000 ng'
  );
  await expect(facts.locator('[data-current-remaining-quantity]')).toHaveText(
    'Current remaining amount: 2000000 ng'
  );
  await button(facts, 'Read retained document document-1').click();
  await expect(
    facts.getByRole('textbox', { name: 'Retained original delivery document', exact: true })
  ).toHaveValue(proof.documentText);
  await ctx.capture('03-second-delivery-package-and-unidentified-vial', { ...current, arrival });
  const earlier = await showEarlierArrival(form, page, first.id);
  await expect(earlier.locator('[data-original-received-quantity]')).toHaveText(
    'Original received amount: 1000000 ng'
  );
  await expect(earlier.locator('[data-current-remaining-quantity]')).toHaveText(
    'Current remaining amount: 900000 ng'
  );
  await button(earlier, 'Read retained document document-1').click();
  await expect(
    earlier.getByRole('textbox', { name: 'Retained original delivery document', exact: true })
  ).toHaveValue(fixture.arrivalJourney.documentText);
  const unchanged = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(unchanged.state, current.state);
  assert.deepEqual(unchanged.history, current.history);
  await ctx.capture('04-earlier-original-admission-and-current-remaining-still-independent', {
    ...unchanged,
    first,
  });
  return unchanged;
}
export async function runInventoryArrivalComponents(ctx) {
  const initial = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(initial.state, ctx.fixture.state);
  assert.deepEqual(initial.history, ctx.fixture.history);
  assertStage(ctx.fixture, initial, 3);
  const tag = randomUUID().slice(0, 8),
    proof = {
      initialRevision: initial.state.revision,
      completedStep: 0,
      baselineStocks: initial.state.stocks,
      baselineHistory: initial.history,
      deliveryId: `package-${tag}`,
      packageLabel: `Synthetic kit ${tag}`,
      packagingBatch: `PACK-${tag}`,
      componentBatch: `REAGENT-${tag}`,
      componentLabel: `Kit ${tag} identified reagent`,
      lotName: `Kit ${tag} supplier lot`,
      vesselName: `Kit ${tag} reagent tube`,
      unidentifiedLabel: `Kit ${tag} unresolved component`,
      unidentifiedVesselName: `Kit ${tag} unidentified tube`,
      documentText: `Synthetic original kit manifest\nPackaging batch: PACK-${tag}\nReagent component batch: REAGENT-${tag}\nMeasured reagent amount: 2 mg\nOne physical companion vial has unidentified contents\n`,
    };
  return finishComponents({ ...ctx, fixture: { ...ctx.fixture, arrivalComponentsJourney: proof } });
}
export async function runInventoryArrivalComponentsResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'arrival-components-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assert.ok([0, 1].includes(ctx.fixture.arrivalComponentsJourney.completedStep));
  if (ctx.fixture.arrivalComponentsJourney.completedStep)
    assertComponentsStage(ctx.fixture, current);
  await ctx.capture('00-resumed-exact-package-arrival-checkpoint', current);
  return finishComponents(ctx);
}
async function finishComponents(ctx) {
  const { page, expect, choose, fixture, evidenceDirectory } = ctx,
    proof = fixture.arrivalComponentsJourney;
  let current = await ctx.inventoryRead(fixture.scope);
  const checkpoint = (step) => {
    const result = {
      ...fixture,
      ...current,
      arrivalComponentsJourney: { ...proof, completedStep: step },
      resumePhase: 'arrival-components-after-accepted-stage',
    };
    writeFileSync(
      path.join(
        evidenceDirectory,
        `${String(step).padStart(2, '0')}-arrival-components-checkpoint.json`
      ),
      JSON.stringify(result, null, 2)
    );
    return result;
  };
  checkpoint(proof.completedStep);
  if (!proof.completedStep) {
    await closeStock(page);
    await button(page, 'Receive delivery').click();
    const form = modal(page, 'Receive delivery');
    await button(form, 'Start a separate new delivery').click();
    await field(form, 'Delivery namespace').fill('desktop-arrival-acceptance');
    await field(form, 'Actual delivery ID').fill(proof.deliveryId);
    await field(form, 'Supplier').fill('Synthetic supplier');
    await field(form, 'Arrival observation reason').fill(
      'Second actual synthetic delivery physically observed'
    );
    await choose(form, 'Observed component scope', 'Every component in this listed manifest');
    await field(form, 'Component scope reason').fill(
      'Both explicitly listed physical vials were observed; one remains unidentified'
    );
    await field(form, 'Original supplier document text').fill(proof.documentText);
    await choose(form, 'Document coverage', 'Full original text document');
    await form.locator('summary').filter({ hasText: 'Optional package grouping' }).click();
    await field(form, 'Package label').fill(proof.packageLabel);
    await field(form, 'Packaging batch').fill(proof.packagingBatch);
    await field(form, 'Find scientific material').fill(fixture.arrivalJourney.material.id);
    await choose(
      form,
      'Component 1 material',
      new RegExp(escape(fixture.arrivalJourney.material.name))
    );
    await field(form, 'Component 1 label').fill(proof.componentLabel);
    await field(form, 'Component 1 batch').fill(proof.componentBatch);
    await field(form, 'Component 1 new lot name').fill(proof.lotName);
    await field(form, 'Component 1 management reason').fill(
      'Manage the actual reagent component lot independently of packaging batch'
    );
    await field(form, 'Component 1 measured amount').fill('2');
    await choose(form, 'Component 1 unit', 'mg');
    await field(form, 'Component 1 amount reason').fill('Explicit actual synthetic measured mass');
    await choose(
      form,
      'Component 1 local stock quality',
      'Usable stock; lot assessment remains separate'
    );
    await field(form, 'Component 1 local quality reason').fill(
      'Independent local stock declaration; lot remains unassessed'
    );
    await field(form, 'Component 1 container name').fill(proof.vesselName);
    await choose(form, 'Component 1 location', 'Unplaced');
    await button(form, 'Add another listed component').click();
    await field(form, 'Component 2 label').fill(proof.unidentifiedLabel);
    await choose(form, 'Component 2 disposition', 'Physical vial with unidentified contents');
    await field(form, 'Component 2 disposition reason').fill(
      'Physical vial observed; its material identity remains unresolved'
    );
    await field(form, 'Component 2 container name').fill(proof.unidentifiedVesselName);
    await choose(form, 'Component 2 location', 'Unplaced');
    await button(form, 'Preview complete delivery').click();
    await expect(form.getByTestId('inventory-arrival-form')).toHaveAttribute(
      'data-preview-state',
      'ready'
    );
    await ctx.capture('01-ready-entire-package-two-component-preview', { before: current });
    await button(form, 'Receive delivery atomically').click();
    await expect(form).toBeHidden();
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint(1);
    const arrival = assertComponentsStage(fixture, current);
    await ctx.capture('02-entire-package-received-in-one-operation', { ...current, arrival });
  }
  await button(page, 'Receive delivery').click();
  await verifyComponentsPresentation(ctx, current);
  const result = checkpoint(1);
  writeFileSync(
    path.join(evidenceDirectory, 'arrival-components-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}
export async function runInventoryArrivalComponentsReopen(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'arrival-components-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertComponentsStage(ctx.fixture, current);
  await closeStock(ctx.page);
  await button(ctx.page, 'Receive delivery').click();
  await verifyComponentsPresentation(ctx, current);
  await ctx.capture('reopened-both-original-arrivals-package-and-current-stock', current);
  return { ...ctx.fixture, ...current };
}

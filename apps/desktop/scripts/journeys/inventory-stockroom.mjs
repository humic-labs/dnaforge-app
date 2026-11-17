import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const modal = (page, name) => page.getByRole('dialog', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nativeStockroom = (page, scope) =>
  page.evaluate((input) => window.electronAPI.inventory.stockroom(input), scope);
async function closeDialogs(page) {
  const dialog = page.getByTestId('inventory-physical-dialog');
  for (let attempt = 0; attempt < 3 && (await dialog.count()); attempt++)
    await page.keyboard.press('Escape');
  assert.equal(
    await dialog.count(),
    0,
    'An ordinary existing inventory dialog must close before continuing.'
  );
}
async function openStockroom(page) {
  await closeDialogs(page);
  const stock = button(page, 'Close stock details');
  if (await stock.isVisible()) await stock.click();
  await button(page, 'Stockroom').click();
}
function lineOf(fixture, state) {
  const line = Object.values(state.expectedDeliveries).find(
    (line) => line.name === fixture.stockroomJourney.lineName
  );
  assert.ok(line);
  return line;
}
function assertStage(fixture, current, step) {
  const proof = fixture.stockroomJourney;
  assert.equal(current.state.schema, 'dnaforge.inventory.v22');
  assert.equal(current.state.revision, proof.initialRevision + step);
  assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  assert.deepEqual(current.state.arrivals, proof.baselineArrivals);
  for (const [id, stock] of Object.entries(proof.baselineStocks)) {
    if (id === proof.stockId && step >= 3)
      assert.deepEqual(current.state.stocks[id], {
        ...stock,
        quantity: { kind: 'known', value: '850000', unit: 'ng' },
      });
    else
      assert.deepEqual(
        current.state.stocks[id],
        stock,
        'Expectations and matching never change physical stock.'
      );
  }
  if (!step) return;
  const line = lineOf(fixture, current.state);
  assert.deepEqual(line.expectation, {
    materialId: proof.material.id,
    quantity: { value: '1000000', unit: 'ng' },
  });
  assert.equal(line.lifecycle.kind, 'open');
  if (step >= 2) {
    const matches = Object.values(current.state.arrivalAllocations).filter(
      (allocation) => allocation.lineId === line.id && allocation.lifecycle.kind === 'active'
    );
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].quantity, { value: '1000000', unit: 'ng' });
    assert.equal(matches[0].arrivalId, proof.arrivalId);
    assert.equal(matches[0].componentKey, proof.componentKey);
  }
  if (step >= 4) {
    const rule = Object.values(current.state.reorderRules).find(
      (rule) => rule.name === proof.ruleName
    );
    assert.ok(rule);
    assert.deepEqual(rule.threshold, { value: '1', unit: 'ng' });
    assert.equal(rule.actionBasis, 'reserve');
    assert.equal(rule.validityBasis, 'current-recorded-rules');
  }
}
export async function runInventoryStockroomJourney(ctx) {
  const initial = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(initial.state.schema, 'dnaforge.inventory.v22');
  assert.deepEqual(initial.state, ctx.fixture.state);
  assert.deepEqual(initial.history, ctx.fixture.history);
  const arrival = Object.values(initial.state.arrivals).find(
    (arrival) => arrival.identity.arrivalId === ctx.fixture.arrivalJourney?.deliveryId
  );
  assert.ok(arrival, 'Use the first actual received delivery, not a fabricated quantity.');
  const component = arrival.components.find((component) => component.choice.kind === 'identified');
  assert.ok(component);
  assert.deepEqual(component.receivedQuantity, { kind: 'known', value: '1000000', unit: 'ng' });
  const stock = initial.state.stocks[component.target.stockId];
  assert.deepEqual(stock.quantity, { kind: 'known', value: '900000', unit: 'ng' });
  const result = await ctx.page.evaluate((input) => window.electronAPI.inventory.materials(input), {
    project: ctx.fixture.project.projectId,
    query: stock.materialId,
    limit: 100,
  });
  const material = result.items.find((item) => item.id === stock.materialId);
  assert.ok(material);
  const tag = randomUUID().slice(0, 8);
  return finish({
    ...ctx,
    fixture: {
      ...ctx.fixture,
      stockroomJourney: {
        initialRevision: initial.state.revision,
        completedStep: 0,
        baselineStocks: initial.state.stocks,
        baselineArrivals: initial.state.arrivals,
        baselineHistory: initial.history,
        lineName: `Expected ${tag} original reagent`,
        ruleName: `Rule ${tag} reservable mass`,
        arrivalId: arrival.id,
        deliveryId: arrival.identity.arrivalId,
        componentKey: component.key,
        stockId: stock.id,
        material,
      },
    },
  });
}
export async function runInventoryStockroomResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'stockroom-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertStage(ctx.fixture, current, ctx.fixture.stockroomJourney.completedStep);
  await ctx.capture('00-resumed-exact-stockroom-checkpoint', current);
  return finish(ctx);
}
async function finish(ctx) {
  const { page, expect, choose, fixture, inventoryRead, capture, evidenceDirectory } = ctx,
    proof = fixture.stockroomJourney;
  let current = await inventoryRead(fixture.scope);
  const checkpoint = (step) => {
    const result = {
      ...fixture,
      ...current,
      stockroomJourney: { ...proof, completedStep: step },
      resumePhase: 'stockroom-after-accepted-stage',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${String(step).padStart(2, '0')}-stockroom-checkpoint.json`),
      JSON.stringify(result, null, 2)
    );
    return result;
  };
  checkpoint(proof.completedStep);
  const actions = [
    async () => {
      await openStockroom(page);
      await button(page, 'Record expected delivery').click();
      const form = modal(page, 'Record expected delivery');
      await field(form, 'Expected delivery name').fill(proof.lineName);
      await field(form, 'Find scientific material').fill(proof.material.id);
      await choose(form, 'Scientific material', new RegExp(`^${escape(proof.material.name)}`));
      await field(form, 'Expected amount').fill('1');
      await choose(form, 'Amount unit', 'mg');
      await field(form, 'Reason').fill(
        'Local expected amount; this creates no physical stock or supplier order'
      );
      await button(form, 'Record expected delivery').click();
      await expect(form).toBeHidden();
    },
    async () => {
      await openStockroom(page);
      const line = lineOf(fixture, current.state),
        card = page.locator(`[data-expected-line="${line.id}"]`);
      await button(card, 'Match received material').click();
      const form = modal(page, 'Match received material');
      await choose(
        form,
        'Original received component',
        new RegExp(`^${escape(proof.deliveryId)} ·`)
      );
      await expect(form.getByTestId('inventory-allocation-original-balance')).toContainText(
        'Original received amount: 1000000 ng'
      );
      await field(form, 'Amount to match').fill('1');
      await choose(form, 'Amount unit', 'mg');
      await field(form, 'Reason').fill(
        'Allocate original1mg receipt despite900000ng current remaining'
      );
      await button(form, 'Match received material').click();
      await expect(form).toBeHidden();
    },
    async () => {
      await closeDialogs(page);
      await button(page, 'All stock').click();
      await page
        .getByTestId('inventory-stock-table')
        .locator(`[data-stock-id="${proof.stockId}"]`)
        .click();
      await button(page, 'Use stock').click();
      const form = modal(page, 'Use stock');
      await field(form, 'Quantity').fill('50');
      await choose(form, 'Unit', 'µg');
      await field(form, 'Reason').fill('Further use must not undo receipt matching');
      await button(form, 'Use stock').click();
      await expect(form).toBeHidden();
    },
    async () => {
      await openStockroom(page);
      await button(page, 'Record reorder rule').click();
      const form = modal(page, 'Record reorder rule');
      await field(form, 'Reorder rule name').fill(proof.ruleName);
      await field(form, 'Find scientific material').fill(proof.material.id);
      await choose(form, 'Scientific material', new RegExp(`^${escape(proof.material.name)}`));
      await field(form, 'Reorder threshold').fill('1');
      await choose(form, 'Amount unit', 'ng');
      await choose(form, 'Reorder action basis', 'Suitable for reservation');
      await choose(
        form,
        'Reorder validity basis',
        'Current recorded rules; untracked validity may be included'
      );
      await field(form, 'Reason').fill(
        'Explicit positive1ng threshold under reservation and recorded-rules policy; expected quantities excluded'
      );
      await button(form, 'Record reorder rule').click();
      await expect(form).toBeHidden();
    },
  ];
  for (let index = proof.completedStep; index < actions.length; index++) {
    await actions[index]();
    current = await inventoryRead(fixture.scope);
    const step = index + 1;
    checkpoint(step);
    assertStage(fixture, current, step);
    const report = await nativeStockroom(page, fixture.scope);
    assert.equal(report.projectId, fixture.project.projectId);
    assert.equal(report.inventoryId, fixture.scope.inventoryId);
    assert.equal(report.revision, current.state.revision);
    const line = lineOf(fixture, current.state),
      progress = report.expectedDeliveries[line.id];
    assert.deepEqual(progress.allocated, { value: step >= 2 ? '1000000' : '0', unit: 'ng' });
    assert.equal(progress.progress, step >= 2 ? 'fully-received' : 'none-received');
    if (step >= 4) {
      const result = Object.values(report.reorderRules).find(
        (result) =>
          (result.kind === 'ready' ? result.assessment.rule : result.rule).name === proof.ruleName
      );
      assert.equal(result.kind, 'ready');
      assert.equal(result.assessment.conclusion, 'adequate');
      assert.ok(
        result.assessment.knownIncludedStockIds.includes(proof.stockId),
        'Actual remaining free stock, not expectation quantity, supports the report.'
      );
    }
    await openStockroom(page);
    const card = page.locator(`[data-expected-line="${line.id}"]`);
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute(
      'data-received-progress',
      step >= 2 ? 'fully-received' : 'none-received'
    );
    if (step >= 4) {
      const rule = Object.values(current.state.reorderRules).find(
        (rule) => rule.name === proof.ruleName
      );
      await page.locator(`[data-reorder-rule="${rule.id}"]`).scrollIntoViewIfNeeded();
    }
    await capture(
      `${String(step).padStart(2, '0')}-${['recorded-expectation-no-stock', 'matched-original-receipt-not-current-balance', 'further-use-keeps-full-received-progress', 'native-explicit-policy-reorder-report'][index]}`,
      { ...current, report }
    );
  }
  await closeDialogs(page);
  const result = checkpoint(4);
  writeFileSync(
    path.join(evidenceDirectory, 'stockroom-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}
export async function runInventoryStockroomReopen(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertStage(ctx.fixture, current, 4);
  await openStockroom(ctx.page);
  const line = lineOf(ctx.fixture, current.state);
  await ctx
    .expect(ctx.page.locator(`[data-expected-line="${line.id}"]`))
    .toHaveAttribute('data-received-progress', 'fully-received');
  const report = await nativeStockroom(ctx.page, ctx.fixture.scope);
  assert.equal(report.revision, current.state.revision);
  assert.deepEqual(report.expectedDeliveries[line.id].allocated, { value: '1000000', unit: 'ng' });
  const rule = Object.values(current.state.reorderRules).find(
    (rule) => rule.name === ctx.fixture.stockroomJourney.ruleName
  );
  await ctx
    .expect(ctx.page.locator(`[data-reorder-rule="${rule.id}"]`))
    .toHaveAttribute('data-reorder-conclusion', 'adequate');
  await ctx.capture('reopened-exact-original-receipt-progress-and-native-reorder-report', {
    ...current,
    report,
  });
  return { ...ctx.fixture, ...current };
}

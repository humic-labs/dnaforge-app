import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const modal = (page, name) => page.getByRole('dialog', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stages = [
  'receive-stock',
  'record-relative-rule',
  'observe-sealed',
  'reserve-sealed',
  'record-first-opening',
  'use-opened-stock',
  'record-past-cutoff',
];
function stockOf(state, name) {
  const stocks = Object.values(state.stocks).filter(
    (stock) => state.vessels[stock.vesselId].name === name
  );
  assert.equal(stocks.length, 1);
  return stocks[0];
}
async function showStock(page, stockId) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
  await button(page, 'All stock').click();
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
}
const nativeAvailability = (page, scope) =>
  page.evaluate((input) => window.electronAPI.inventory.availability(input), scope);
function assertStage(fixture, actual, step) {
  const proof = fixture.openingJourney;
  assert.equal(actual.state.schema, 'dnaforge.inventory.v20');
  assert.equal(actual.state.revision, proof.initialRevision + step);
  assert.deepEqual(actual.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  for (const [id, stock] of Object.entries(proof.baselineStocks))
    assert.deepEqual(actual.state.stocks[id], stock);
  if (!step) return;
  const stock = stockOf(actual.state, proof.name);
  assert.deepEqual(stock.quantity, { kind: 'known', value: step >= 6 ? '95' : '100', unit: 'uL' });
  if (step >= 2) {
    assert.equal(stock.validity.kind, 'managed');
    assert.equal(stock.validity.rootIds.length, step === 7 ? 2 : 1);
  }
  if (step >= 3) {
    assert.equal(stock.opening.kind, step >= 5 ? 'opened-observed' : 'sealed-observed');
    const observation = actual.state.openingObservations[stock.opening.observationId];
    assert.notEqual(observation.observedAt, null);
    if (step >= 5) {
      assert.equal(observation.kind, 'opening');
      assert.ok(observation.supersedesId);
      assert.equal(actual.state.openingObservations[observation.supersedesId].value, 'sealed');
    }
  }
  if (step >= 4) {
    const holds = Object.values(actual.state.reservations).filter(
      (hold) => hold.kind === 'quantity' && hold.stockId === stock.id
    );
    assert.equal(holds.length, 1);
    assert.deepEqual(holds[0].remaining, { value: '10', unit: 'uL' });
    assert.equal(holds[0].lifecycle.kind, 'active');
  }
}
export async function runInventoryOpeningJourney(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(current.state.schema, 'dnaforge.inventory.v20');
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const materialId = Object.values(current.state.tableBindings).find(
    (binding) => binding.sourceId === 'MP001'
  )?.materialId;
  assert.ok(materialId);
  const materials = await ctx.page.evaluate(
    (input) => window.electronAPI.inventory.materials(input),
    { project: ctx.fixture.project.projectId, query: materialId, limit: 100 }
  );
  const material = materials.items.find((item) => item.id === materialId);
  assert.ok(material, 'Use an existing genuine published project record.');
  return finish({
    ...ctx,
    fixture: {
      ...ctx.fixture,
      openingJourney: {
        initialRevision: current.state.revision,
        completedStep: 0,
        baselineStocks: current.state.stocks,
        baselineHistory: current.history,
        name: `Opening ${randomUUID().slice(0, 8)} tube`,
        material,
      },
    },
  });
}
export async function runInventoryOpeningResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'opening-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const step = ctx.fixture.openingJourney.completedStep;
  assert.ok(Number.isSafeInteger(step) && step >= 0 && step <= stages.length);
  assertStage(ctx.fixture, current, step);
  await ctx.capture('00-resumed-exact-opening-checkpoint', current);
  return finish(ctx);
}
async function finish(ctx) {
  const { page, expect, choose, fixture, inventoryRead, capture, evidenceDirectory } = ctx;
  const { project, scope, openingJourney: proof } = fixture;
  let current = await inventoryRead(scope);
  const checkpoint = (step) => {
    const saved = {
      project,
      scope,
      ...current,
      openingJourney: { ...proof, completedStep: step },
      resumePhase: 'opening-after-accepted-stage',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${String(step).padStart(2, '0')}-opening-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint(proof.completedStep);
  async function opening(value) {
    await showStock(page, stockOf(current.state, proof.name).id);
    await button(page, 'Record opening').click();
    const form = modal(page, 'Record opening');
    const native = await nativeAvailability(page, scope);
    await choose(form, 'Opening observation', value);
    await choose(form, 'Observation time', 'Known UTC time');
    await field(form, 'Observed at (UTC)').fill(new Date(native.asOf).toISOString());
    await field(form, 'Reason').fill(
      'Explicit synthetic physical observation at native snapshot time'
    );
    await button(form, 'Record opening').click();
    await expect(form).toBeHidden();
  }
  async function rule(past) {
    await showStock(page, stockOf(current.state, proof.name).id);
    await button(page, 'Add validity rule').click();
    const form = modal(page, 'Record validity decision');
    if (past) {
      const native = await nativeAvailability(page, scope);
      await choose(form, 'Validity decision', 'Explicit cutoff instant');
      await field(form, 'Cutoff at (UTC)').fill(new Date(native.asOf - 1).toISOString());
      await field(form, 'Original source text').fill('Synthetic printed month: 2026-11');
      await choose(form, 'Source precision', 'month');
    } else {
      await choose(form, 'Validity decision', 'Elapsed time after first opening');
      await field(form, 'Elapsed duration').fill('1800');
      await choose(form, 'Elapsed unit', 'Seconds');
      await field(form, 'Original source text').fill(
        'Use within 1800 exact elapsed seconds after first opening'
      );
      await choose(form, 'Source precision', 'elapsed-duration');
    }
    await field(form, 'Interpretation reason').fill(
      past
        ? 'Explicit synthetic past UTC cutoff; no printed-month conversion'
        : 'Explicit stock-owned elapsed duration'
    );
    await button(form, 'Record validity decision').click();
    await expect(form).toBeHidden();
  }
  const actions = [
    async () => {
      const close = button(page, 'Close stock details');
      if (await close.isVisible()) await close.click();
      await button(page.getByTestId('inventory-panel').locator('header'), 'Receive stock').click();
      const form = modal(page, 'Receive stock');
      await field(form, 'Find material').fill(proof.material.id);
      await choose(form, 'Material', new RegExp(escape(proof.material.name)));
      await choose(form, 'Location', 'Unplaced');
      await field(form, 'Container name').fill(proof.name);
      await field(form, 'Quantity').fill('100');
      await button(form, 'Receive stock').click();
      await expect(form).toBeHidden();
    },
    () => rule(false),
    () => opening('Observed sealed'),
    async () => {
      await showStock(page, stockOf(current.state, proof.name).id);
      await button(page, 'Reserve quantity').click();
      const form = modal(page, 'Reserve quantity');
      await field(form, 'Quantity (µL)').fill('10');
      await field(form, 'Purpose').fill('Plan work while material remains sealed');
      await button(form, 'Reserve quantity').click();
      await expect(form).toBeHidden();
    },
    () => opening('Observed opened'),
    async () => {
      await showStock(page, stockOf(current.state, proof.name).id);
      await button(page, 'Use stock').click();
      const form = modal(page, 'Use stock');
      await field(form, 'Quantity').fill('5');
      await field(form, 'Reason').fill('Use after explicit first opening');
      await button(form, 'Use stock').click();
      await expect(form).toBeHidden();
    },
    () => rule(true),
  ];
  for (let index = proof.completedStep; index < stages.length; index++) {
    await actions[index]();
    current = await inventoryRead(scope);
    const step = index + 1;
    try {
      assertStage(fixture, current, step);
    } catch (error) {
      writeFileSync(
        path.join(evidenceDirectory, `${step}-failed-opening-observed.json`),
        JSON.stringify(
          { project, scope, ...current, openingJourney: proof, failedStage: stages[index] },
          null,
          2
        )
      );
      throw error;
    }
    checkpoint(step);
    const availability = await nativeAvailability(page, scope);
    const stock = stockOf(current.state, proof.name);
    const facts = availability.stocks[stock.id];
    assert.deepEqual(facts.onHand, stock.quantity);
    assert.deepEqual(facts.held, { value: step >= 4 ? '10' : '0', unit: 'uL' });
    if (step >= 3 && step < 5) {
      assert.equal(facts.actions.reserve.kind, 'allowed');
      assert.equal(facts.actions.withdraw.kind, 'blocked');
      assert.ok(
        facts.actions.withdraw.blockers.some((blocker) => blocker.code === 'OPENING_REQUIRED')
      );
    }
    if (step >= 5 && step < 7) {
      assert.equal(facts.actions.reserve.kind, 'allowed');
      assert.equal(facts.actions.withdraw.kind, 'allowed');
      assert.ok(facts.validity.effectiveDeadlineAt > availability.asOf);
    }
    if (step === 7) {
      assert.equal(facts.validity.state, 'expired');
      assert.equal(facts.actions.reserve.kind, 'blocked');
      assert.equal(facts.actions.withdraw.kind, 'blocked');
      assert.ok(
        facts.actions.withdraw.blockers.some((blocker) => blocker.code === 'MATERIAL_EXPIRED')
      );
    }
    await showStock(page, stock.id);
    const panel = page.getByTestId('inventory-stock-validity');
    await panel.scrollIntoViewIfNeeded();
    if (step >= 3 && step < 5) {
      await expect(button(page, 'Reserve quantity')).toBeEnabled();
      await expect(button(page, 'Use stock')).toBeDisabled();
    }
    if (step === 7) {
      await expect(button(page, 'Reserve quantity')).toBeDisabled();
      await expect(button(page, 'Use stock')).toBeDisabled();
      await expect(panel).toHaveAttribute('data-validity-state', 'expired');
    }
    await capture(`${String(step).padStart(2, '0')}-${stages[index]}`, {
      ...current,
      availability,
    });
  }
  return checkpoint(stages.length);
}
export async function runInventoryOpeningReopen(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertStage(ctx.fixture, current, stages.length);
  const stock = stockOf(current.state, ctx.fixture.openingJourney.name);
  await showStock(ctx.page, stock.id);
  const panel = ctx.page.getByTestId('inventory-stock-validity');
  await panel.scrollIntoViewIfNeeded();
  await ctx.expect(panel).toHaveAttribute('data-validity-state', 'expired');
  await ctx.expect(button(ctx.page, 'Reserve quantity')).toBeDisabled();
  await ctx.expect(button(ctx.page, 'Use stock')).toBeDisabled();
  await ctx.capture('reopened-exact-opening-expiry-and-reservation', current);
  return { ...ctx.fixture, ...current };
}

export async function runInventoryOpeningTimer(ctx) {
  const { page, expect, choose, fixture, inventoryRead, capture, evidenceDirectory } = ctx;
  const initial = await inventoryRead(fixture.scope);
  assert.deepEqual(initial.state, fixture.state);
  assert.deepEqual(initial.history, fixture.history);
  assertStage(fixture, initial, stages.length);
  const stock = stockOf(initial.state, fixture.openingJourney.name);
  const absoluteRoots = stock.validity.rootIds.filter(
    (rootId) => initial.state.validityFacts[rootId].rule.kind === 'absolute'
  );
  assert.equal(
    absoluteRoots.length,
    1,
    'Correct the single explicitly recorded absolute cutoff family.'
  );
  const rootId = absoluteRoots[0];
  const successors = new Set(
    Object.values(initial.state.validityFacts)
      .map((fact) => fact.supersedesId)
      .filter(Boolean)
  );
  const currentHeads = Object.values(initial.state.validityFacts).filter(
    (fact) => fact.rootId === rootId && !successors.has(fact.id)
  );
  assert.equal(currentHeads.length, 1);
  const previous = currentHeads[0];
  await showStock(page, stock.id);
  await button(page, `Correct validity rule ${rootId}`).click();
  const form = modal(page, 'Correct validity rule');
  const native = await nativeAvailability(page, fixture.scope);
  const cutoffAt = native.asOf + 15000;
  await choose(form, 'Validity decision', 'Explicit cutoff instant');
  await field(form, 'Cutoff at (UTC)').fill(new Date(cutoffAt).toISOString());
  await field(form, 'Original source text').fill(previous.sourceText);
  await choose(form, 'Source precision', previous.sourcePrecision);
  await field(form, 'Interpretation reason').fill(
    'Explicit synthetic future UTC cutoff to observe native deadline refresh without a stock edit'
  );
  await button(form, 'Correct validity rule').click();
  await expect(form).toBeHidden();
  const accepted = await inventoryRead(fixture.scope);
  assert.equal(accepted.state.revision, initial.state.revision + 1);
  assert.deepEqual(accepted.history.slice(0, initial.history.length), initial.history);
  assert.deepEqual(accepted.state.stocks, initial.state.stocks);
  assert.deepEqual(accepted.state.reservations, initial.state.reservations);
  const corrected = Object.values(accepted.state.validityFacts).filter(
    (fact) => fact.rootId === rootId && fact.supersedesId === previous.id
  );
  assert.equal(corrected.length, 1);
  assert.deepEqual(corrected[0].rule, { kind: 'absolute', deadlineAt: cutoffAt });
  assert.equal(corrected[0].sourceText, previous.sourceText);
  assert.equal(corrected[0].sourcePrecision, previous.sourcePrecision);
  const checkpoint = {
    ...fixture,
    ...accepted,
    resumePhase: 'opening-timer-after-accepted-correction',
    openingTimer: {
      rootId,
      headId: corrected[0].id,
      cutoffAt,
      revision: accepted.state.revision,
      observedFromAsOf: native.asOf,
    },
  };
  writeFileSync(
    path.join(evidenceDirectory, 'opening-timer-checkpoint.json'),
    JSON.stringify(checkpoint, null, 2)
  );
  await showStock(page, stock.id);
  const panel = page.getByTestId('inventory-stock-validity');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toHaveAttribute('data-validity-state', 'current');
  await expect(button(page, 'Reserve quantity')).toBeEnabled();
  await expect(button(page, 'Use stock')).toBeEnabled();
  const beforeDeadline = await nativeAvailability(page, fixture.scope);
  assert.ok(beforeDeadline.asOf < cutoffAt, 'The first capture must precede the real deadline.');
  assert.equal(beforeDeadline.stocks[stock.id].validity.nextBoundaryAt, cutoffAt);
  await capture('01-before-real-native-cutoff', {
    ...accepted,
    availability: beforeDeadline,
    cutoffAt,
  });
  await expect(panel).toHaveAttribute('data-validity-state', 'expired', { timeout: 20000 });
  await expect(button(page, 'Reserve quantity')).toBeDisabled();
  await expect(button(page, 'Use stock')).toBeDisabled();
  const displayedAsOf = Number(
    await panel.locator('[data-validity-as-of]').getAttribute('data-validity-as-of')
  );
  assert.ok(
    displayedAsOf >= cutoffAt,
    'The view must refresh to a native observation at or after the cutoff.'
  );
  const afterDeadline = await nativeAvailability(page, fixture.scope);
  assert.equal(afterDeadline.stocks[stock.id].validity.state, 'expired');
  const unchanged = await inventoryRead(fixture.scope);
  assert.deepEqual(
    unchanged.state,
    accepted.state,
    'Passing the deadline must not mutate saved inventory.'
  );
  assert.deepEqual(
    unchanged.history,
    accepted.history,
    'Passing the deadline must not append a receipt.'
  );
  await capture('02-expired-by-native-refresh-without-inventory-edit', {
    ...unchanged,
    availability: afterDeadline,
    displayedAsOf,
    cutoffAt,
  });
  const result = {
    ...checkpoint,
    ...unchanged,
    openingTimer: { ...checkpoint.openingTimer, displayedExpiredAsOf: displayedAsOf },
  };
  writeFileSync(
    path.join(evidenceDirectory, 'opening-timer-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}

export async function runInventoryOpeningTimerReopen(ctx) {
  const { fixture, page, expect } = ctx;
  assert.equal(fixture.resumePhase, 'opening-timer-after-accepted-correction');
  assert.ok(fixture.openingTimer);
  const current = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  assert.equal(current.state.revision, fixture.openingTimer.revision);
  const stock = stockOf(current.state, fixture.openingJourney.name);
  await showStock(page, stock.id);
  const panel = page.getByTestId('inventory-stock-validity');
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toHaveAttribute('data-validity-state', 'expired');
  await expect(button(page, 'Reserve quantity')).toBeDisabled();
  await expect(button(page, 'Use stock')).toBeDisabled();
  const availability = await nativeAvailability(page, fixture.scope);
  assert.ok(availability.asOf >= fixture.openingTimer.cutoffAt);
  assert.equal(availability.stocks[stock.id].validity.state, 'expired');
  await ctx.capture('reopened-real-cutoff-expired-with-exact-state-and-history', {
    ...current,
    availability,
  });
  return { ...fixture, ...current };
}

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const modal = (page, name) => page.getByRole('dialog', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stages = [
  'create-managed-lot',
  'receive-unassessed-stock',
  'release-lot',
  'quarantine-stock',
  'quarantine-lot',
  'release-lot-retains-stock-hold',
  'release-stock',
  'reserve-before-recall',
  'create-aliquot',
  'create-managed-preparation',
  'receive-preparation',
  'release-preparation',
  'first-ancestor-recall',
  'second-independent-recall',
  'withdraw-only-first-recall',
  'quarantine-lot-with-existing-hold',
  'withdraw-second-retains-assessment',
  'release-lot-after-recalls',
];

function unique(items, predicate, message) {
  const matches = Object.values(items).filter(predicate);
  assert.equal(matches.length, 1, message);
  return matches[0];
}
const lotNamed = (state, name) =>
  unique(state.lots, (lot) => lot.name === name, `Exactly one lot named ${name}`);
const stockNamed = (state, name) =>
  unique(
    state.stocks,
    (stock) => state.vessels[stock.vesselId].name === name,
    `Exactly one stock in ${name}`
  );
const recallNamed = (state, reason) =>
  unique(
    state.lotRecalls,
    (recall) => recall.reason === reason,
    `Exactly one recall for ${reason}`
  );
async function closeDrawer(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function showStock(page, stockId) {
  await closeDrawer(page);
  await button(page, 'All stock').click();
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
}

export async function releaseInventoryJourneyLot({ page, expect, choose }, name) {
  await closeDrawer(page);
  await button(
    page.getByTestId('inventory-panel').locator('header'),
    'Lot quality and recalls'
  ).click();
  const form = modal(page, 'Lot quality and recalls');
  await choose(form, 'Lot or preparation', new RegExp(escape(name)));
  await button(form, 'Record assessment').click();
  await choose(form, 'Lot assessment', 'Released');
  await field(form, 'Reason').fill('Explicit acceptance of synthetic journey lot');
  await button(form, 'Record lot assessment').click();
  await expect(form).toBeHidden();
}

function assertStage(fixture, actual, step) {
  const proof = fixture.lotJourney;
  const { names } = proof;
  assert.equal(actual.state.schema, 'dnaforge.inventory.v19');
  assert.equal(actual.state.revision, proof.initialRevision + step);
  assert.deepEqual(actual.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  for (const [id, stock] of Object.entries(proof.baselineStocks))
    assert.deepEqual(actual.state.stocks[id], stock);
  if (step >= 1) {
    const lot = lotNamed(actual.state, names.lot);
    assert.equal(lot.controls.kind, 'managed');
    const value =
      step < 3
        ? 'unassessed'
        : step === 5 || step === 16 || step === 17
          ? 'quarantined'
          : 'released';
    assert.equal(lot.controls.assessment.value, value);
    if (step === 1) {
      const commands = actual.history.at(-1).request.commands;
      assert.deepEqual(
        commands.map((command) => command.kind),
        ['create-lot', 'manage-lot']
      );
      assert.equal(commands[0].id, commands[1].lotId);
    }
  }
  if (step >= 2) {
    const stock = stockNamed(actual.state, names.stock);
    assert.deepEqual(stock.quantity, { kind: 'known', value: step < 9 ? '100' : '80', unit: 'uL' });
    assert.equal(stock.quality, step >= 4 && step < 7 ? 'quarantined' : 'usable');
    assert.ok(stock.lotConstraints.lotIds.includes(lotNamed(actual.state, names.lot).id));
    if (step >= 8) {
      const hold = unique(
        actual.state.reservations,
        (item) => item.kind === 'quantity' && item.stockId === stock.id,
        'One original reservation'
      );
      assert.deepEqual(hold.remaining, { value: '60', unit: 'uL' });
      assert.equal(hold.lifecycle.kind, 'active');
    }
  }
  if (step >= 9) {
    const aliquot = stockNamed(actual.state, names.aliquot);
    assert.deepEqual(aliquot.quantity, { kind: 'known', value: '20', unit: 'uL' });
    assert.ok(aliquot.lotConstraints.lotIds.includes(lotNamed(actual.state, names.lot).id));
  }
  if (step >= 10) {
    const lot = lotNamed(actual.state, names.preparation);
    assert.equal(lot.controls.kind, 'managed');
    assert.equal(lot.controls.assessment.value, step < 12 ? 'unassessed' : 'released');
    assert.ok(lot.lotConstraints.lotIds.includes(lotNamed(actual.state, names.lot).id));
  }
  if (step >= 11) {
    const stock = stockNamed(actual.state, names.preparedStock);
    assert.deepEqual(stock.quantity, { kind: 'known', value: '10', unit: 'uL' });
    assert.ok(stock.lotConstraints.lotIds.includes(lotNamed(actual.state, names.lot).id));
    assert.ok(stock.lotConstraints.lotIds.includes(lotNamed(actual.state, names.preparation).id));
  }
  if (step >= 13)
    assert.equal(
      recallNamed(actual.state, names.firstRecall).lifecycle.kind,
      step < 15 ? 'active' : 'withdrawn'
    );
  if (step >= 14)
    assert.equal(
      recallNamed(actual.state, names.secondRecall).lifecycle.kind,
      step < 17 ? 'active' : 'withdrawn'
    );
}

async function assertEligibility(ctx, actual, step) {
  const { page, fixture, expect } = ctx;
  const { names } = fixture.lotJourney;
  const availability = await page.evaluate(
    (input) => window.electronAPI.inventory.availability(input),
    fixture.scope
  );
  if (step >= 2) {
    const stock = stockNamed(actual.state, names.stock);
    const facts = availability.stocks[stock.id];
    assert.deepEqual(facts.onHand, stock.quantity);
    assert.deepEqual(facts.held, { value: step >= 8 ? '60' : '0', unit: 'uL' });
    const codes = facts.blockers.map((blocker) => blocker.code);
    assert.equal(codes.includes('STOCK_QUARANTINED'), step >= 4 && step < 7);
    assert.equal(
      codes.includes('LOT_NOT_RELEASED'),
      step < 3 || step === 5 || step === 16 || step === 17
    );
    assert.equal(codes.includes('LOT_RECALLED'), step >= 13 && step < 17);
  }
  if (step >= 13) {
    for (const name of [names.stock, names.aliquot, names.preparedStock]) {
      const stock = stockNamed(actual.state, name);
      const blockers = availability.stocks[stock.id].blockers;
      const parent = lotNamed(actual.state, names.lot);
      const recall = blockers.find(
        (blocker) => blocker.code === 'LOT_RECALLED' && blocker.lotId === parent.id
      );
      const ids = [
        ...(step < 15 ? [recallNamed(actual.state, names.firstRecall).id] : []),
        ...(step >= 14 && step < 17 ? [recallNamed(actual.state, names.secondRecall).id] : []),
      ].sort();
      assert.deepEqual(recall?.recallIds.slice().sort() ?? [], ids);
      if (step === 13 || step === 15 || step === 17 || step === 18) {
        await showStock(page, stock.id);
        const details = page.getByTestId('inventory-stock-lot-controls');
        await details.scrollIntoViewIfNeeded();
        await expect(details.locator('[data-lot-blocker="LOT_RECALLED"]')).toHaveCount(
          ids.length ? 1 : 0
        );
        for (const action of [
          'Use stock',
          'Reserve quantity',
          'Use reserved stock',
          'Transfer or aliquot',
        ]) {
          if (step < 18) await expect(button(page, action)).toBeDisabled();
          else await expect(button(page, action)).toBeEnabled();
        }
      }
    }
  }
  return availability;
}

export async function runInventoryLotJourney(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(current.state.schema, 'dnaforge.inventory.v19');
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const materialId = Object.values(current.state.tableBindings).find(
    (binding) => binding.sourceId === 'MP001'
  )?.materialId;
  assert.ok(materialId, 'Use an existing genuine published project record.');
  const materials = await ctx.page.evaluate(
    (input) => window.electronAPI.inventory.materials(input),
    { project: ctx.fixture.project.projectId, query: materialId, limit: 100 }
  );
  const material = materials.items.find((item) => item.id === materialId);
  assert.ok(material);
  const prefix = `Lots ${Date.now().toString(36)}`;
  return finishJourney({
    ...ctx,
    fixture: {
      ...ctx.fixture,
      lotJourney: {
        completedStep: 0,
        initialRevision: current.state.revision,
        baselineStocks: current.state.stocks,
        baselineHistory: current.history,
        material,
        names: {
          lot: `${prefix} supplier batch`,
          stock: `${prefix} original tube`,
          aliquot: `${prefix} aliquot`,
          preparation: `${prefix} preparation`,
          preparedStock: `${prefix} prepared tube`,
          purpose: `${prefix} planned work`,
          firstRecall: `${prefix} first supplier notice`,
          secondRecall: `${prefix} independent second notice`,
        },
      },
    },
  });
}

export async function runInventoryLotResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'lots-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const step = ctx.fixture.lotJourney.completedStep;
  assert.ok(Number.isSafeInteger(step) && step >= 0 && step <= stages.length);
  assertStage(ctx.fixture, current, step);
  await ctx.capture('00-resumed-exact-lot-checkpoint', current);
  return finishJourney(ctx);
}

async function finishJourney(ctx) {
  const { page, expect, choose, fixture, inventoryRead, capture, evidenceDirectory } = ctx;
  const { names, material } = fixture.lotJourney;
  const { project, scope } = fixture;
  let current = await inventoryRead(scope);
  const header = page.getByTestId('inventory-panel').locator('header');
  const checkpoint = (step) => {
    const saved = {
      project,
      scope,
      ...current,
      lotJourney: { ...fixture.lotJourney, completedStep: step },
      resumePhase: 'lots-after-accepted-stage',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${String(step).padStart(2, '0')}-lot-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint(fixture.lotJourney.completedStep);
  async function selectMaterial(form, label) {
    await field(form, label === 'Material' ? 'Find material' : 'Find output material').fill(
      material.id
    );
    await choose(form, label, new RegExp(escape(material.name)));
  }
  async function addLot(name, prepared = false) {
    if (prepared) {
      await showStock(page, stockNamed(current.state, names.aliquot).id);
      await button(page, 'Record preparation').click();
    } else {
      await closeDrawer(page);
      await button(header, 'Add lot').click();
    }
    const form = modal(page, 'Add lot or preparation');
    await field(form, 'Batch name').fill(name);
    await selectMaterial(form, 'Output material');
    if (prepared) {
      await choose(form, 'Batch origin', 'Internal preparation');
      await field(form, 'Preparation method').fill(
        'Synthetic tracked preparation metadata; source amount is not debited'
      );
    } else {
      await field(form, 'Supplier').fill('Synthetic supplier');
      await field(form, 'Supplier lot number').fill('LOT-ACCEPTANCE');
    }
    await field(form, 'Reason').fill('Start explicit local lot assessment');
    await button(form, 'Add lot or preparation').click();
    await expect(form).toBeHidden();
  }
  async function receive(lotName, vesselName, quantity) {
    await closeDrawer(page);
    await button(header, 'Receive stock').click();
    const form = modal(page, 'Receive stock');
    await selectMaterial(form, 'Material');
    await choose(form, 'Lot or preparation', lotName);
    await choose(form, 'Location', 'Unplaced');
    await field(form, 'Container name').fill(vesselName);
    await field(form, 'Quantity').fill(quantity);
    await button(form, 'Receive stock').click();
    await expect(form).toBeHidden();
  }
  async function lotAction(name, kind, value) {
    await closeDrawer(page);
    await button(header, 'Lot quality and recalls').click();
    const form = modal(page, 'Lot quality and recalls');
    await choose(form, 'Lot or preparation', new RegExp(escape(name)));
    let submit;
    if (kind === 'assess') {
      await button(form, 'Record assessment').click();
      await choose(form, 'Lot assessment', value);
      submit = 'Record lot assessment';
    } else if (kind === 'recall') {
      await button(form, 'Record recall').click();
      submit = 'Record lot recall';
    } else {
      const recall = recallNamed(current.state, value);
      await button(form, `Withdraw recall ${recall.id}`).click();
      submit = 'Withdraw lot recall';
    }
    await field(form, 'Reason').fill(
      kind === 'recall' ? value : `Synthetic explicit ${kind}: ${value}`
    );
    await button(form, submit).click();
    await expect(form).toBeHidden();
  }
  async function quality(value) {
    await showStock(page, stockNamed(current.state, names.stock).id);
    const action = value === 'quarantined' ? 'Quarantine stock' : 'Release stock';
    await button(page, action).click();
    const form = modal(page, action);
    await field(form, 'Reason').fill('Independent physical stock quality decision');
    await button(form, action).click();
    await expect(form).toBeHidden();
  }
  const actions = [
    () => addLot(names.lot),
    () => receive(names.lot, names.stock, '100'),
    () => lotAction(names.lot, 'assess', 'Released'),
    () => quality('quarantined'),
    () => lotAction(names.lot, 'assess', 'Quarantined'),
    () => lotAction(names.lot, 'assess', 'Released'),
    () => quality('usable'),
    async () => {
      await showStock(page, stockNamed(current.state, names.stock).id);
      await button(page, 'Reserve quantity').click();
      const form = modal(page, 'Reserve quantity');
      await field(form, 'Quantity (µL)').fill('60');
      await field(form, 'Purpose').fill(names.purpose);
      await button(form, 'Reserve quantity').click();
      await expect(form).toBeHidden();
    },
    async () => {
      await showStock(page, stockNamed(current.state, names.stock).id);
      await button(page, 'Transfer or aliquot').click();
      const form = modal(page, 'Transfer or aliquot');
      await field(form, 'Source amount (µL)').fill('20');
      await field(form, 'Destination container name').fill(names.aliquot);
      await field(form, 'Reason').fill('Create tracked sibling before supplier recall');
      await button(form, 'Transfer or aliquot').click();
      await expect(form).toBeHidden();
    },
    () => addLot(names.preparation, true),
    () => receive(names.preparation, names.preparedStock, '10'),
    () => lotAction(names.preparation, 'assess', 'Released'),
    () => lotAction(names.lot, 'recall', names.firstRecall),
    () => lotAction(names.lot, 'recall', names.secondRecall),
    () => lotAction(names.lot, 'withdraw', names.firstRecall),
    () => lotAction(names.lot, 'assess', 'Quarantined'),
    () => lotAction(names.lot, 'withdraw', names.secondRecall),
    () => lotAction(names.lot, 'assess', 'Released'),
  ];
  for (let step = fixture.lotJourney.completedStep; step < actions.length; step++) {
    await actions[step]();
    current = await inventoryRead(scope);
    try {
      assertStage(fixture, current, step + 1);
    } catch (error) {
      writeFileSync(
        path.join(evidenceDirectory, `${step + 1}-failed-lot-stage-observed.json`),
        JSON.stringify(
          { project, scope, ...current, failedStage: stages[step], lotJourney: fixture.lotJourney },
          null,
          2
        )
      );
      throw error;
    }
    checkpoint(step + 1);
    const availability = await assertEligibility(ctx, current, step + 1);
    if (step + 1 === 2 || step + 1 === 6) {
      await showStock(page, stockNamed(current.state, names.stock).id);
      await page.getByTestId('inventory-stock-lot-controls').scrollIntoViewIfNeeded();
      await expect(button(page, 'Use stock')).toBeDisabled();
    }
    await capture(`${String(step + 1).padStart(2, '0')}-${stages[step]}`, {
      ...current,
      availability,
    });
  }
  return checkpoint(stages.length);
}

export async function runInventoryLotReopen(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertStage(ctx.fixture, current, stages.length);
  const availability = await assertEligibility(ctx, current, stages.length);
  const { names } = ctx.fixture.lotJourney;
  await closeDrawer(ctx.page);
  await button(
    ctx.page.getByTestId('inventory-panel').locator('header'),
    'Lot quality and recalls'
  ).click();
  const form = modal(ctx.page, 'Lot quality and recalls');
  await ctx.choose(form, 'Lot or preparation', new RegExp(escape(names.lot)));
  await ctx.expect(form.locator('[data-recall-state="withdrawn"]')).toHaveCount(2);
  await ctx.expect(form.getByText(/Local assessment/)).toContainText('This desktop profile');
  await ctx.capture('reopened-assessment-two-independent-withdrawn-recalls', {
    ...current,
    availability,
  });
  await button(form, 'Close').click();
  return { ...ctx.fixture, ...current };
}

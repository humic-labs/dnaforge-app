import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const modal = (page, name) => page.getByRole('dialog', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COUNT = '900719925474099312345678901';
const COUNT_HOLD = '9007199254740993';
const stages = [
  'receive-mass',
  'reserve-mass',
  'fulfill-mass',
  'use-mass',
  'transfer-mass',
  'receive-count',
  'reserve-count',
  'fulfill-count',
  'use-count',
  'transfer-count',
  'receive-unknown-mass',
];

function stockNamed(state, name) {
  const matches = Object.values(state.stocks).filter(
    (stock) => state.vessels[stock.vesselId].name === name
  );
  assert.equal(matches.length, 1, `Exactly one stock must belong to ${name}`);
  return matches[0];
}

async function closeDrawer(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}

async function showStock(page, stockId) {
  await closeDrawer(page);
  await button(page, 'All stock').click();
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
}

async function assertAmountLayout(locator) {
  const geometry = await locator.evaluate((element) => {
    const parent = element.parentElement.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      withinParent: box.left >= parent.left - 1 && box.right <= parent.right + 1,
      textWithinBox: [...range.getClientRects()].every(
        (rect) => rect.left >= box.left - 1 && rect.right <= box.right + 1
      ),
      visible: box.top >= 0 && box.bottom <= window.innerHeight,
    };
  });
  assert.ok(
    geometry.width > 0 && geometry.scrollWidth <= geometry.width + 1,
    JSON.stringify(geometry)
  );
  assert.equal(geometry.withinParent, true, JSON.stringify(geometry));
  assert.equal(geometry.textWithinBox, true, JSON.stringify(geometry));
  assert.equal(geometry.visible, true, JSON.stringify(geometry));
}

function assertStage(fixture, actual, completedStep) {
  const proof = fixture.amountsJourney;
  assert.equal(fixture.state.schema, 'dnaforge.inventory.v19');
  assert.equal(actual.state.schema, fixture.state.schema);
  assert.equal(actual.state.revision, proof.initialRevision + completedStep);
  assert.deepEqual(actual.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  for (const [id, stock] of Object.entries(proof.baselineStocks))
    assert.deepEqual(actual.state.stocks[id], stock, `Existing stock ${id} must remain unchanged`);
  const known = (name, value, unit) =>
    assert.deepEqual(stockNamed(actual.state, name).quantity, { kind: 'known', value, unit });
  if (completedStep >= 1) {
    known(
      proof.names.mass,
      completedStep < 3
        ? '1000000'
        : completedStep < 4
          ? '800000'
          : completedStep < 5
            ? '700000'
            : '450000',
      'ng'
    );
    if (completedStep >= 2) {
      const holds = Object.values(actual.state.reservations).filter(
        (hold) =>
          hold.kind === 'quantity' && hold.stockId === stockNamed(actual.state, proof.names.mass).id
      );
      assert.equal(holds.length, 1);
      assert.deepEqual(holds[0].remaining, {
        value: completedStep < 3 ? '600000' : '400000',
        unit: 'ng',
      });
    }
  }
  if (completedStep >= 5) known(proof.names.massAliquot, '250000', 'ng');
  if (completedStep >= 6) {
    const debit =
      (completedStep >= 8 ? 3n : 0n) +
      (completedStep >= 9 ? 10n : 0n) +
      (completedStep >= 10 ? BigInt(COUNT_HOLD) : 0n);
    known(proof.names.count, (BigInt(COUNT) - debit).toString(), 'item');
    if (completedStep >= 7) {
      const holds = Object.values(actual.state.reservations).filter(
        (hold) =>
          hold.kind === 'quantity' &&
          hold.stockId === stockNamed(actual.state, proof.names.count).id
      );
      assert.equal(holds.length, 1);
      assert.deepEqual(holds[0].remaining, {
        value: (BigInt(COUNT_HOLD) - (completedStep >= 8 ? 3n : 0n)).toString(),
        unit: 'item',
      });
    }
  }
  if (completedStep >= 10) known(proof.names.countAliquot, COUNT_HOLD, 'item');
  if (completedStep >= 11)
    assert.deepEqual(stockNamed(actual.state, proof.names.unknown).quantity, {
      kind: 'unknown',
      unit: 'ng',
    });
}

function assertAvailability(fixture, actual, availability, completedStep) {
  const { names } = fixture.amountsJourney;
  for (const name of [
    ...(completedStep >= 1 ? [names.mass] : []),
    ...(completedStep >= 6 ? [names.count] : []),
    ...(completedStep >= 11 ? [names.unknown] : []),
  ]) {
    const stock = stockNamed(actual.state, name);
    const facts = availability.stocks[stock.id];
    assert.deepEqual(facts.onHand, stock.quantity);
    const holds = Object.values(actual.state.reservations).filter(
      (hold) =>
        hold.kind === 'quantity' && hold.stockId === stock.id && hold.lifecycle.kind === 'active'
    );
    const held = holds.reduce((sum, hold) => sum + BigInt(hold.remaining.value), 0n);
    assert.deepEqual(facts.held, { value: held.toString(), unit: stock.quantity.unit });
    assert.deepEqual(
      facts.unreserved,
      stock.quantity.kind === 'known'
        ? {
            kind: 'known',
            value: (BigInt(stock.quantity.value) - held).toString(),
            unit: stock.quantity.unit,
          }
        : { kind: 'unknown', unit: stock.quantity.unit }
    );
  }
}

export async function runInventoryAmountsJourney(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(
    current.state.schema,
    'dnaforge.inventory.v19',
    'Capture an exact current native fixture after migration.'
  );
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
  assert.ok(material, 'The current native scientific picker must admit the record.');
  const prefix = `Amounts ${Date.now().toString(36)}`;
  const fixture = {
    ...ctx.fixture,
    amountsJourney: {
      initialRevision: current.state.revision,
      completedStep: 0,
      material,
      baselineStocks: current.state.stocks,
      baselineHistory: current.history,
      names: {
        mass: `${prefix} mass`,
        massAliquot: `${prefix} mass aliquot`,
        count: `${prefix} count`,
        countAliquot: `${prefix} count aliquot`,
        unknown: `${prefix} unknown mass`,
        massPurpose: `${prefix} mass allocation`,
        countPurpose: `${prefix} count allocation`,
      },
    },
  };
  return finishJourney({ ...ctx, fixture });
}

export async function runInventoryAmountsResume(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(ctx.fixture.resumePhase, 'amounts-after-accepted-stage');
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const step = ctx.fixture.amountsJourney.completedStep;
  assert.ok(Number.isSafeInteger(step) && step >= 0 && step <= stages.length);
  assertStage(ctx.fixture, current, step);
  await ctx.capture('00-resumed-exact-accepted-checkpoint', current);
  return finishJourney(ctx);
}

async function finishJourney(ctx) {
  const { page, expect, choose, fixture, inventoryRead, capture, evidenceDirectory } = ctx;
  const { project, scope } = fixture;
  const proof = fixture.amountsJourney;
  const { names, material } = proof;
  let current = await inventoryRead(scope);
  const header = page.getByTestId('inventory-panel').locator('header');
  const checkpoint = (step) => {
    const saved = {
      project,
      scope,
      ...current,
      amountsJourney: { ...proof, completedStep: step },
      resumePhase: 'amounts-after-accepted-stage',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${String(step).padStart(2, '0')}-amounts-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint(proof.completedStep);
  async function receive(name, unit, amount) {
    await closeDrawer(page);
    await button(header, 'Receive stock').click();
    const form = modal(page, 'Receive stock');
    await field(form, 'Find material').fill(material.id);
    await choose(form, 'Material', new RegExp(escape(material.name)));
    await choose(form, 'Location', 'Unplaced');
    await field(form, 'Container name').fill(name);
    await choose(form, 'Unit', unit);
    if (amount === null) await choose(form, 'Quantity measurement', 'Unknown quantity');
    else {
      if (unit === 'item') {
        await field(form, 'Quantity').fill('1.5');
        const before = await inventoryRead(scope);
        await button(form, 'Receive stock').click();
        await expect(form).toContainText('An item count requires a whole number.');
        assert.deepEqual(await inventoryRead(scope), before);
        await capture('06-fractional-count-refused-without-receipt', before);
      }
      await field(form, 'Quantity').fill(amount);
    }
    await button(form, 'Receive stock').click();
    await expect(form).toBeHidden();
  }
  async function stockAction(name, action) {
    await showStock(page, stockNamed(current.state, name).id);
    await button(page, action).click();
    return modal(page, action);
  }
  async function compatibleUnits(form, unit, incompatible) {
    await form.getByRole('combobox', { name: 'Unit', exact: true }).click();
    for (const name of incompatible)
      await expect(page.getByRole('option', { name, exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: unit, exact: true }).click();
  }
  async function reserve(name, unit, amount, purpose) {
    const form = await stockAction(name, 'Reserve quantity');
    await compatibleUnits(
      form,
      unit,
      unit === 'item' ? ['µL', 'mg', 'nmol'] : ['µL', 'item', 'nmol']
    );
    await field(form, `Quantity (${unit})`).fill(amount);
    await field(form, 'Purpose').fill(purpose);
    await button(form, 'Reserve quantity').click();
    await expect(form).toBeHidden();
  }
  async function use(name, unit, amount, purpose) {
    const reserved = Boolean(purpose);
    const action = reserved ? 'Use reserved stock' : 'Use stock';
    const form = await stockAction(name, action);
    if (reserved) await choose(form, 'Reservation', new RegExp(escape(purpose)));
    await compatibleUnits(
      form,
      unit,
      unit === 'item' ? ['µL', 'mg', 'nmol'] : ['µL', 'item', 'nmol']
    );
    await field(form, reserved ? `Quantity (${unit})` : 'Quantity').fill(amount);
    await field(form, 'Reason').fill('Synthetic exact same-dimension withdrawal');
    await button(form, action).click();
    await expect(form).toBeHidden();
  }
  async function transfer(name, destinationName, unit, amount) {
    const form = await stockAction(name, 'Transfer or aliquot');
    await compatibleUnits(
      form,
      unit,
      unit === 'item' ? ['µL', 'mg', 'nmol'] : ['µL', 'item', 'nmol']
    );
    await field(form, `Source amount (${unit})`).fill(amount);
    await field(form, 'Destination container name').fill(destinationName);
    await expect(form.getByRole('combobox', { name: 'Result mixing', exact: true })).toHaveCount(0);
    await field(form, 'Reason').fill('Synthetic exact same-dimension aliquot');
    await button(form, 'Transfer or aliquot').click();
    await expect(form).toBeHidden();
  }
  const actions = [
    () => receive(names.mass, 'mg', '1'),
    () => reserve(names.mass, 'mg', '0.6', names.massPurpose),
    () => use(names.mass, 'mg', '0.2', names.massPurpose),
    () => use(names.mass, 'µg', '100'),
    () => transfer(names.mass, names.massAliquot, 'mg', '0.25'),
    () => receive(names.count, 'item', COUNT),
    () => reserve(names.count, 'item', COUNT_HOLD, names.countPurpose),
    () => use(names.count, 'item', '3', names.countPurpose),
    () => use(names.count, 'item', '10'),
    () => transfer(names.count, names.countAliquot, 'item', COUNT_HOLD),
    () => receive(names.unknown, 'mg', null),
  ];
  for (let step = proof.completedStep; step < actions.length; step++) {
    await actions[step]();
    current = await inventoryRead(scope);
    try {
      assertStage(fixture, current, step + 1);
    } catch (error) {
      writeFileSync(
        path.join(evidenceDirectory, `${step + 1}-failed-stage-observed.json`),
        JSON.stringify(
          { project, scope, ...current, failedStage: stages[step], amountsJourney: proof },
          null,
          2
        )
      );
      throw error;
    }
    checkpoint(step + 1);
    const availability = await page.evaluate(
      (input) => window.electronAPI.inventory.availability(input),
      scope
    );
    assertAvailability(fixture, current, availability, step + 1);
    await capture(`${String(step + 1).padStart(2, '0')}-${stages[step]}`, {
      ...current,
      availability,
    });
  }
  const unknown = stockNamed(current.state, names.unknown);
  await showStock(page, unknown.id);
  await expect(
    page.getByTestId('inventory-stock-availability').locator('[data-availability="On hand"]')
  ).toHaveText('Unknown ng');
  await expect(
    page.getByTestId('inventory-stock-availability').locator('[data-availability="Held"]')
  ).toHaveText('0 ng');
  for (const action of [
    'Use stock',
    'Transfer or aliquot',
    'Reserve quantity',
    'Use reserved stock',
    'Pool stocks',
    'Dilute stock',
  ])
    await expect(button(page, action)).toBeDisabled();
  await capture('12-unknown-mass-keeps-basis-and-blocks-withdrawals', current);
  return checkpoint(stages.length);
}

export async function runInventoryAmountsReopen(ctx) {
  const { fixture, page, expect, inventoryRead, capture } = ctx;
  const current = await inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  assertStage(fixture, current, stages.length);
  const availability = await page.evaluate(
    (input) => window.electronAPI.inventory.availability(input),
    fixture.scope
  );
  assertAvailability(fixture, current, availability, stages.length);
  const proof = fixture.amountsJourney;
  for (const name of [proof.names.mass, proof.names.count, proof.names.unknown]) {
    const stock = stockNamed(current.state, name);
    if (name === proof.names.count) {
      await closeDrawer(page);
      await button(page, 'All stock').click();
      const cell = page
        .getByTestId('inventory-stock-table')
        .locator(`[data-stock-id="${stock.id}"]`)
        .getByTestId('inventory-stock-quantity');
      await cell.scrollIntoViewIfNeeded();
      await assertAmountLayout(cell);
      await capture('reopened-count-table-without-overflow', current);
    }
    await showStock(page, stock.id);
    const expected =
      stock.quantity.kind === 'unknown'
        ? `Unknown ${stock.quantity.unit}`
        : `${stock.quantity.value} ${stock.quantity.unit}`;
    await expect(
      page.getByTestId('inventory-stock-availability').locator('[data-availability="On hand"]')
    ).toHaveText(expected);
    const facts = page.getByTestId('inventory-stock-availability');
    for (const value of await facts.locator('[data-availability]').all()) {
      await value.scrollIntoViewIfNeeded();
      await assertAmountLayout(value);
    }
    await facts.scrollIntoViewIfNeeded();
    await capture(
      `reopened-${name === proof.names.mass ? 'mass' : name === proof.names.count ? 'count' : 'unknown-mass'}`,
      current
    );
  }
  return { ...fixture, ...current };
}

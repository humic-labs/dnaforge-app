import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const columns = [
  'observation_id',
  'subject_key',
  'observed_at',
  'quantity_kind',
  'quantity',
  'unit',
  'presence',
  'location_key',
  'slot',
  'reason',
];
const csvCell = (value) => (/[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const source = (...rows) =>
  '\uFEFF' +
  columns.join(',') +
  '\n' +
  rows.map((row) => row.map(csvCell).join(',')).join('\n') +
  '\n';
const namespace = 'synthetic:desktop:stocktake:stable';
const firstReason = 'Apply the first measurement while preserving the active hold and custody';
const secondReason = 'Apply the previously recorded second measurement explicitly';
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function closeDrawer(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}

async function draft(ctx, fixture, document) {
  const { page, expect, choose } = ctx;
  await closeDrawer(page);
  await button(page.getByTestId('inventory-panel').locator('header'), 'Stocktake').click();
  const form = dialog(page, 'Import stocktake observations');
  await form.getByLabel('Stocktake source namespace', { exact: true }).fill(namespace);
  await form.locator('summary').filter({ hasText: 'Paste or inspect stocktake text' }).click();
  await form.getByLabel('Stocktake source text', { exact: true }).fill(document.sourceText);
  assert.equal(
    await form.getByLabel('Stocktake source text', { exact: true }).inputValue(),
    document.sourceText
  );
  await button(form, 'Preview stocktake').click();
  await expect(form.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  for (const [key, target] of Object.entries(document.subjects)) {
    await form.getByLabel('Search stocktake subjects', { exact: true }).fill(target.id);
    await choose(
      form,
      `Subject for ${key}`,
      new RegExp(`^${target.prefix}:[\\s\\S]*${escaped(target.id)}`)
    );
  }
  for (const key of document.locations ?? [])
    await choose(form, `Stocktake location for ${key}`, new RegExp(escaped(fixture.box.id)));
  for (const [id, decision] of Object.entries(document.decisions)) {
    await choose(
      form,
      `Decision for ${id}`,
      decision.kind === 'apply' ? 'Apply observed correction' : 'Record only'
    );
    if (decision.kind === 'apply') {
      const reason = form.getByLabel(`Apply reason for observation ${id}`, { exact: true });
      if (document.exerciseMissingReason === id) {
        await button(form, 'Preview stocktake').click();
        await expect(form.getByTestId('inventory-stocktake-import')).toHaveAttribute(
          'data-preview-state',
          /^(?:blocked|failed)$/
        );
        await expect(reason).toBeVisible();
        await expect(button(form, 'Record stocktake observations')).toBeDisabled();
        await ctx.capture('02a-incomplete-decision-retains-controls-for-correction', {
          observationId: id,
        });
      }
      await reason.fill(decision.reason);
    }
  }
  await button(form, 'Preview stocktake').click();
  await expect(form.getByTestId('inventory-stocktake-import')).not.toHaveAttribute(
    'data-preview-state',
    'previewing'
  );
  return form;
}

export async function runInventoryStocktakeJourney(ctx) {
  const { page, expect, inventoryRead, capture, evidenceDirectory, fixture: input } = ctx;
  const fixture = {
    project: input.project,
    scope: input.scope,
    active: input.active,
    box: input.box,
    well: input.well,
  };
  const { scope } = fixture;
  const read = () => inventoryRead(scope);
  await page.getByTestId('inventory-button').click();
  await ctx.choose(page, 'Inventory project', fixture.project.name);
  await expect(page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
  const initial = await read();
  assert.deepEqual(initial.state, {
    ...input.state,
    schema: 'dnaforge.inventory.v14',
    observations: input.state.observations ?? {},
  });
  assert.deepEqual(initial.history, input.history);
  const baseline = input.stocktakePreparation?.baseline ?? initial;
  const stockId = fixture.active.stockId;
  const vesselId = fixture.active.vesselId;
  const observations = (state) =>
    Object.values(state.observations).filter((value) => value.namespace === namespace);
  const observation = (state, id) =>
    observations(state).find((value) => value.observationId === id);
  const checkpoint = async (phase) => {
    const current = await read();
    writeFileSync(
      path.join(evidenceDirectory, 'stocktake-prepared-fixture.json'),
      JSON.stringify({ ...fixture, ...current, stocktakePreparation: { baseline, phase } }, null, 2)
    );
    return current;
  };
  await capture('01-before-stocktake-observations', initial);
  let hold = Object.values(initial.state.reservations).find(
    (value) =>
      value.kind === 'quantity' &&
      value.stockId === stockId &&
      value.purpose === 'Synthetic stocktake hold remains truthful'
  );
  if (!hold) {
    assert.equal(initial.state.stocks[stockId].quantity.value, '70');
    await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
    await button(page, 'Reserve quantity').click();
    const reserve = dialog(page, 'Reserve quantity');
    await reserve.getByLabel('Quantity (µL)', { exact: true }).fill('60');
    await reserve
      .getByLabel('Purpose', { exact: true })
      .fill('Synthetic stocktake hold remains truthful');
    await button(reserve, 'Reserve quantity').click();
    await expect(reserve).toBeHidden();
    const held = await checkpoint('held');
    hold = Object.values(held.state.reservations).find(
      (value) =>
        value.kind === 'quantity' &&
        value.stockId === stockId &&
        value.purpose === 'Synthetic stocktake hold remains truthful'
    );
  }
  assert.ok(hold);
  let current = await read();
  if (
    !observation(current.state, '0001') &&
    current.state.vessels[vesselId].custody.kind === 'available'
  ) {
    await closeDrawer(page);
    await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
    const custody = page.locator(`[data-testid="inventory-custody"][data-item-id="${vesselId}"]`);
    await button(custody, 'Check out').click();
    const checkout = dialog(page, 'Check out');
    await checkout
      .getByLabel('Reason', { exact: true })
      .fill('Synthetic stocktake must preserve checked-out custody');
    await button(checkout, 'Check out').click();
    await expect(checkout).toBeHidden();
    current = await checkpoint('checked-out');
  }
  await closeDrawer(page);
  const rows = [
    [
      '0001',
      'sample',
      'unknown',
      'known',
      '40',
      'uL',
      'not-observed',
      '',
      '',
      'Synthetic measured quantity below the active hold',
    ],
    [
      '0002',
      'sample',
      'unknown',
      'known',
      '65',
      'uL',
      'not-observed',
      '',
      '',
      'Synthetic second observation is initially recorded only',
    ],
  ];
  const sample = { sample: { prefix: 'Stock', id: stockId } };
  const first = {
    sourceText: source(...rows),
    exerciseMissingReason: '0001',
    subjects: sample,
    decisions: { '0001': { kind: 'apply', reason: firstReason }, '0002': { kind: 'record-only' } },
  };
  const second = {
    ...first,
    exerciseMissingReason: null,
    decisions: { ...first.decisions, '0002': { kind: 'apply', reason: secondReason } },
  };
  writeFileSync(path.join(evidenceDirectory, 'measurements.csv'), first.sourceText);
  async function commit(document, name) {
    const before = await read();
    const form = await draft(ctx, fixture, document);
    await expect(form.getByTestId('inventory-stocktake-import')).toHaveAttribute(
      'data-preview-state',
      'ready'
    );
    await form.getByTestId('inventory-stocktake-preview').scrollIntoViewIfNeeded();
    await capture(name, { before, document });
    await button(form, 'Record stocktake observations').click();
    await expect(form).toBeHidden();
    const after = await checkpoint(name);
    assert.equal(after.state.revision, before.state.revision + 1);
    const accepted = after.history.at(-1);
    assert.equal(accepted.request.kind, 'apply-stocktake');
    assert.equal(accepted.request.sourceText, document.sourceText);
    return after;
  }
  if (!observation(current.state, '0001')) {
    const heldState = current.state;
    current = await commit(first, '02-plan-measurement-shortfall-with-independent-record-only-row');
    assert.equal(current.state.stocks[stockId].quantity.value, '40');
    assert.deepEqual(current.state.reservations[hold.id], hold);
    assert.deepEqual(current.state.vessels[vesselId], heldState.vessels[vesselId]);
    assert.equal(observation(current.state, '0002').application.kind, 'unapplied');
    const availability = await page.evaluate(
      (scope) => window.electronAPI.inventory.availability(scope),
      scope
    );
    assert.equal(availability.stocks[stockId].held.value, '60');
    assert.ok(
      availability.stocks[stockId].blockers.some((value) => value.code === 'ALLOCATION_SHORTFALL')
    );
    await capture('03-truthful-shortfall-retains-hold-custody-and-unapplied-observation', {
      ...current,
      availability,
    });
  }
  if (observation(current.state, '0002').application.kind === 'unapplied')
    current = await commit(second, '04-explicit-later-application-of-recorded-observation');
  assert.equal(observation(current.state, '0002').application.kind, 'applied');
  const physical = { tube: { prefix: 'Container', id: vesselId } };
  const missing = {
    sourceText: source([
      'missing-1',
      'tube',
      'unknown',
      'not-observed',
      '',
      '',
      'missing',
      '',
      '',
      'Synthetic explicit physical missing observation',
    ]),
    subjects: physical,
    decisions: {
      'missing-1': {
        kind: 'apply',
        reason: 'Apply missing observation without changing quantity or hold',
      },
    },
  };
  if (!observation(current.state, 'missing-1')) {
    const before = current;
    current = await commit(missing, '05-explicit-item-missing-plan');
    assert.equal(current.state.vessels[vesselId].custody.kind, 'missing');
    assert.deepEqual(current.state.stocks, before.state.stocks);
    assert.deepEqual(current.state.reservations, before.state.reservations);
  }
  const found = {
    sourceText: source([
      'found-1',
      'tube',
      'unknown',
      'not-observed',
      '',
      '',
      'found',
      'found-place',
      'B',
      'Synthetic explicit found destination',
    ]),
    subjects: physical,
    locations: ['found-place'],
    decisions: {
      'found-1': {
        kind: 'apply',
        reason: 'Locate this item only at the explicit found destination',
      },
    },
  };
  if (!observation(current.state, 'found-1')) {
    const before = current;
    current = await commit(found, '06-explicit-found-location-with-preserved-quantity-and-hold');
    assert.deepEqual(current.state.vessels[vesselId].placement, {
      kind: 'located',
      storageId: fixture.box.id,
      slotId: 'B',
    });
    assert.equal(current.state.vessels[vesselId].custody.kind, 'available');
    assert.deepEqual(current.state.stocks, before.state.stocks);
    assert.deepEqual(current.state.reservations, before.state.reservations);
  }
  if (current.state.stocks[stockId].quantity.value === '65') {
    await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${stockId}"]`).click();
    await button(page, 'Use stock').click();
    const use = dialog(page, 'Use stock');
    await use.getByLabel('Quantity', { exact: true }).fill('2');
    await use
      .getByLabel('Reason', { exact: true })
      .fill('Synthetic later use must survive observation reimport');
    await button(use, 'Use stock').click();
    await expect(use).toBeHidden();
    current = await checkpoint('used-after-observations');
    await closeDrawer(page);
  }
  assert.equal(current.state.stocks[stockId].quantity.value, '63');
  assert.deepEqual(current.state.reservations[hold.id], hold);
  const reordered = { ...second, sourceText: source(...[...rows].reverse()) };
  let form = await draft(ctx, fixture, reordered);
  await expect(form.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await read(), current);
  await capture('07-observation-reimport-keeps-later-use-without-repeating-corrections', current);
  await button(form, 'Cancel').click();
  const invalid = {
    sourceText: source(
      [
        'atomic-first',
        'sample',
        'unknown',
        'known',
        '63',
        'uL',
        'not-observed',
        '',
        '',
        'Synthetic first valid record must not partially commit',
      ],
      [
        'well-missing',
        'well',
        'unknown',
        'not-observed',
        '',
        '',
        'missing',
        '',
        '',
        'A permanent well cannot independently depart',
      ]
    ),
    subjects: { ...sample, well: { prefix: 'Permanent well', id: fixture.well.id } },
    decisions: {
      'atomic-first': { kind: 'record-only' },
      'well-missing': {
        kind: 'apply',
        reason: 'Synthetic impossible independent permanent-well custody',
      },
    },
  };
  form = await draft(ctx, fixture, invalid);
  await expect(form.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  await expect(button(form, 'Record stocktake observations')).toBeDisabled();
  assert.deepEqual(await read(), current);
  await capture('08-late-permanent-well-correction-refuses-entire-proposal', current);
  await button(form, 'Cancel').click();
  const artifact = await page.evaluate(
    (scope) => window.electronAPI.inventory.exportSnapshot({ ...scope, format: 'native-v1' }),
    scope
  );
  writeFileSync(
    path.join(evidenceDirectory, 'stocktake-inventory.dnaforge-inventory.json'),
    artifact.sourceText
  );
  return {
    ...fixture,
    ...current,
    hold,
    baseline,
    first,
    second,
    missing,
    found,
    reordered,
    artifact,
    nativeDialogQualified: false,
  };
}

export async function runInventoryStocktakeReopen(ctx) {
  const { page, expect, fixture, inventoryRead, capture } = ctx;
  const current = await inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  assert.equal(current.state.stocks[fixture.active.stockId].quantity.value, '63');
  assert.deepEqual(current.state.reservations[fixture.hold.id], fixture.hold);
  const artifact = await page.evaluate(
    (scope) => window.electronAPI.inventory.exportSnapshot({ ...scope, format: 'native-v1' }),
    fixture.scope
  );
  assert.equal(artifact.sourceText, fixture.artifact.sourceText);
  await capture('09-reopened-observation-lifecycles-quantity-custody-and-holds', current);
  const form = await draft(ctx, fixture, fixture.reordered);
  await expect(form.getByTestId('inventory-stocktake-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(fixture.scope), current);
  await capture('10-reopened-observations-still-do-not-repeat-corrections', current);
  await button(form, 'Cancel').click();
  return { ...fixture, ...current, artifact };
}

import assert from 'node:assert/strict';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const codes = (page, id) =>
  page.locator(`[data-testid="inventory-item-codes"][data-item-id="${id}"]`);
const physical = (page, id) =>
  page.locator(`[data-testid="inventory-physical-details"][data-item-id="${id}"]`);
const custody = (page, id) =>
  page.locator(`[data-testid="inventory-custody"][data-item-id="${id}"]`);

async function closeDetails(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function allItems(page) {
  await closeDetails(page);
  await button(page, 'All stock').click();
}
async function openStock(page, id) {
  await allItems(page);
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`).click();
}
async function openEmpty(page, id) {
  await allItems(page);
  await page.getByTestId('inventory-empty-containers').locator(`[data-vessel-id="${id}"]`).click();
}
async function submit(ctx, form, name) {
  await button(form, name).click();
  await ctx.expect(form).toBeHidden();
  await ctx.expect(ctx.page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
}
async function attach(ctx, id, namespace, value, refuse = false) {
  await button(codes(ctx.page, id), 'Attach existing code').click();
  const form = dialog(ctx.page, 'Attach existing code');
  await form.getByLabel('Namespace', { exact: true }).fill(namespace);
  await form.getByLabel('Code', { exact: true }).fill(value);
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: record the exact existing physical item code');
  const before = await ctx.inventoryRead(ctx.fixture.scope);
  if (refuse) {
    await button(form, 'Attach code').click();
    await ctx.expect(form).toBeVisible();
    await ctx
      .expect(ctx.page.getByTestId('inventory-panel'))
      .toHaveAttribute('data-state', 'refused');
    assert.deepEqual(await ctx.inventoryRead(ctx.fixture.scope), before);
    const old = Object.values(before.state.itemCodes).find(
      (code) => code.namespace === namespace && code.value === value
    );
    await ctx.capture(
      old?.lifecycle.kind === 'retired'
        ? '12a-retired-tuple-reassignment-refused'
        : '03-duplicate-code-refused-without-state-or-history-change',
      before
    );
    await button(form, 'Cancel').click();
    if ((await ctx.page.getByTestId('inventory-panel').getAttribute('data-state')) !== 'ready') {
      await button(ctx.page.getByTestId('inventory-refused'), 'Edit change').click();
      await ctx
        .expect(ctx.page.getByTestId('inventory-panel'))
        .toHaveAttribute('data-state', 'ready');
    }
    return null;
  }
  await submit(ctx, form, 'Attach code');
  const after = await ctx.inventoryRead(ctx.fixture.scope);
  const code = Object.values(after.state.itemCodes).find(
    (row) => row.namespace === namespace && row.value === value && row.item.id === id
  );
  assert.ok(code);
  assert.equal(code.lifecycle.kind, 'active');
  await ctx
    .expect(codes(ctx.page, id).locator(`[data-code-id="${code.id}"]`))
    .toHaveAttribute('data-code-state', 'active');
  return code;
}
async function lookup(ctx, form, namespace, value, expected, enter = false) {
  const all = form.getByRole('checkbox', { name: 'Search all namespaces', exact: true });
  if (namespace === null) await all.check();
  else {
    await all.uncheck();
    await form.getByLabel('Namespace', { exact: true }).fill(namespace);
  }
  await form.getByLabel('Code', { exact: true }).fill(value);
  const before = await ctx.inventoryRead(ctx.fixture.scope);
  if (enter) await form.getByLabel('Code', { exact: true }).press('Enter');
  else {
    const check = button(form, 'Check code');
    await ((await check.isVisible()) ? check : button(form, 'Look up')).click();
  }
  await ctx
    .expect(form.getByTestId('inventory-code-result'))
    .toHaveAttribute('data-resolution', expected);
  await ctx
    .expect(form.getByTestId('inventory-code-result'))
    .toHaveAttribute('data-inventory-revision', String(before.state.revision));
  assert.deepEqual(await ctx.inventoryRead(ctx.fixture.scope), before);
  await form.getByTestId('inventory-code-result').scrollIntoViewIfNeeded();
  return before;
}

export async function runInventoryItemCodeJourney(ctx) {
  const { page, expect, choose, inventoryRead, capture, fixture } = ctx;
  const { scope, ids, stockId } = fixture;
  const before = await inventoryRead(scope);
  assert.equal(before.state.schema, 'dnaforge.inventory.v9');
  assert.equal(before.state.revision, fixture.state.revision);
  const suffix = Date.now().toString(36);
  const names = {
    box: `Codes ${suffix} box`,
    empty: `Codes ${suffix} empty`,
    second: `Codes ${suffix} second`,
  };
  const namespace = `internal-${suffix}`,
    vendorNamespace = `vendor-${suffix}`;
  const value = `00123-${suffix}`,
    upperValue = `ABC-${suffix}`,
    lowerValue = `abc-${suffix}`;
  const header = page.getByTestId('inventory-panel').locator('header');
  await closeDetails(page);
  await button(header, 'Add location').click();
  let form = dialog(page, 'Add location');
  await form.getByLabel('Location name', { exact: true }).fill(names.box);
  await form.getByLabel('Position names', { exact: true }).fill('A1, A2');
  await choose(form, 'Location', 'Top level');
  await submit(ctx, form, 'Add location');
  for (const [name, position] of [
    [names.empty, 'A1'],
    [names.second, 'A2'],
  ]) {
    await button(header, 'Add container').click();
    form = dialog(page, 'Add container');
    await form.getByLabel('Container name', { exact: true }).fill(name);
    await choose(form, 'Location', names.box);
    await choose(form, 'Position', position);
    await submit(ctx, form, 'Add container');
  }
  let after = await inventoryRead(scope);
  const box = Object.values(after.state.storage).find((row) => row.name === names.box);
  const empty = Object.values(after.state.vessels).find((row) => row.name === names.empty);
  const second = Object.values(after.state.vessels).find((row) => row.name === names.second);
  assert.ok(box && empty && second);
  assert.deepEqual(after.state.stocks, before.state.stocks);
  await openStock(page, stockId);
  const mainCode = await attach(ctx, ids.child, namespace, value);
  await capture('01-exact-physical-code-attached-with-stock-unchanged', await inventoryRead(scope));
  await openEmpty(page, empty.id);
  await attach(ctx, empty.id, namespace, value, true);
  const vendorCode = await attach(ctx, empty.id, vendorNamespace, value);
  await capture('04-same-text-under-an-explicit-other-namespace', await inventoryRead(scope));
  await openStock(page, stockId);
  const upperCode = await attach(ctx, ids.child, namespace, upperValue);
  await openEmpty(page, second.id);
  const lowerCode = await attach(ctx, second.id, namespace, lowerValue);
  await closeDetails(page);
  await page.locator(`[role="treeitem"][data-location-id="${box.id}"]`).click();
  const spacedCode = await attach(ctx, box.id, namespace, ` ${value} `);
  await closeDetails(page);
  await button(header, 'Scan or enter code').click();
  form = dialog(page, 'Scan or enter code');
  await lookup(ctx, form, namespace, value, 'resolved', true);
  await expect(form.getByTestId('inventory-code-result')).toContainText('100 µL');
  await capture('05-focused-enter-resolves-without-inventory-writes', await inventoryRead(scope));
  await lookup(ctx, form, null, value, 'ambiguous');
  await expect(
    form.getByTestId('inventory-code-result').locator('article[data-code-id]')
  ).toHaveCount(2);
  await capture('06-namespace-ambiguity-never-picks-a-container', await inventoryRead(scope));
  await lookup(ctx, form, namespace, value.slice(2), 'not-found');
  await lookup(ctx, form, namespace, upperValue, 'resolved');
  await expect(form.getByTestId('inventory-code-result').locator('article')).toHaveAttribute(
    'data-item-id',
    ids.child
  );
  await lookup(ctx, form, namespace, lowerValue, 'resolved');
  await expect(form.getByTestId('inventory-code-result').locator('article')).toHaveAttribute(
    'data-item-id',
    second.id
  );
  await lookup(ctx, form, namespace, `${value} `, 'not-found');
  await lookup(ctx, form, namespace, ` ${value} `, 'resolved');
  await expect(form.getByTestId('inventory-code-value')).toHaveText(JSON.stringify(` ${value} `));
  await capture('07-exact-case-leading-zeros-and-space-boundaries', await inventoryRead(scope));
  await lookup(ctx, form, namespace, `001\n23-${suffix}`, 'invalid');
  await capture('08-interior-control-characters-remain-invalid', await inventoryRead(scope));
  await lookup(ctx, form, namespace, value + '\n', 'resolved', true);
  await expect(form.getByTestId('inventory-code-value')).toHaveText(JSON.stringify(value));
  await expect(form).toContainText('Removed one trailing LF scanner terminator.');
  await capture(
    '09-explicit-trailing-terminator-without-semantic-trimming',
    await inventoryRead(scope)
  );
  await button(form, 'Close').click();
  await openStock(page, stockId);
  await button(codes(page, ids.child), 'Check code').click();
  form = dialog(page, 'Check code');
  await lookup(ctx, form, vendorNamespace, value, 'resolved');
  await expect(form.getByTestId('inventory-code-expected-match')).toHaveAttribute(
    'data-matches',
    'false'
  );
  await capture('10-wrong-physical-item-is-not-a-match', await inventoryRead(scope));
  await lookup(ctx, form, namespace, value, 'resolved');
  await expect(form.getByTestId('inventory-code-expected-match')).toHaveAttribute(
    'data-matches',
    'true'
  );
  await capture(
    '11-full-scoped-target-matches-without-verification-write',
    await inventoryRead(scope)
  );
  await button(form, 'Close').click();
  await button(
    codes(page, ids.child).locator(`[data-code-id="${mainCode.id}"]`),
    'Retire code'
  ).click();
  form = dialog(page, 'Retire code');
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: keep the retired label bound to its original physical item');
  await submit(ctx, form, 'Retire code');
  await expect(codes(page, ids.child).locator(`[data-code-id="${mainCode.id}"]`)).toHaveAttribute(
    'data-code-state',
    'retired'
  );
  await openEmpty(page, second.id);
  await attach(ctx, second.id, namespace, value, true);
  await closeDetails(page);
  await button(header, 'Scan or enter code').click();
  form = dialog(page, 'Scan or enter code');
  await lookup(ctx, form, null, value, 'ambiguous');
  const states = await form
    .getByTestId('inventory-code-result')
    .locator('article[data-code-state]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-code-state')).sort());
  assert.deepEqual(states, ['active', 'retired']);
  await lookup(ctx, form, namespace, value, 'retired');
  await capture(
    '12-retired-code-retains-target-and-cannot-be-reassigned',
    await inventoryRead(scope)
  );
  await button(form, 'Close').click();
  await openEmpty(page, empty.id);
  await button(custody(page, empty.id), 'Report missing').click();
  form = dialog(page, 'Report missing');
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: lookup must never record a physical location');
  await submit(ctx, form, 'Report missing');
  await closeDetails(page);
  await button(header, 'Scan or enter code').click();
  form = dialog(page, 'Scan or enter code');
  await lookup(ctx, form, vendorNamespace, value, 'resolved');
  await expect(form.getByTestId('inventory-code-current-location')).toHaveText('Location unknown');
  await expect(form.getByTestId('inventory-code-last-known-location')).toContainText(names.box);
  await expect(form.getByTestId('inventory-code-last-known-location')).toContainText('A1');
  await capture(
    '13-code-match-keeps-missing-custody-and-last-known-path',
    await inventoryRead(scope)
  );
  await button(form, 'Close').click();
  await openEmpty(page, second.id);
  await button(page, 'Dispose container').click();
  form = dialog(page, 'Dispose');
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: disposed identity remains discoverable');
  await submit(ctx, form, 'Dispose');
  await closeDetails(page);
  await button(header, 'Scan or enter code').click();
  form = dialog(page, 'Scan or enter code');
  await lookup(ctx, form, namespace, lowerValue, 'resolved');
  await expect(form.getByTestId('inventory-code-result')).toContainText('Disposed');
  await expect(form.getByTestId('inventory-code-result').locator('article')).toHaveAttribute(
    'data-code-state',
    'active'
  );
  await capture(
    '14-disposed-item-and-active-code-are-independent-facts',
    await inventoryRead(scope)
  );
  await button(form, 'Close').click();
  after = await inventoryRead(scope);
  assert.deepEqual(after.state.stocks, before.state.stocks);
  assert.deepEqual(after.state.reservations, before.state.reservations);
  assert.deepEqual(after.state.vessels[ids.child], before.state.vessels[ids.child]);
  assert.equal(after.state.vessels[empty.id].custody.kind, 'missing');
  assert.equal(after.state.vessels[second.id].lifecycle, 'disposed');
  assert.equal(after.history.length, after.state.revision);
  return {
    ...fixture,
    ...after,
    itemCodeFixture: {
      names,
      namespace,
      vendorNamespace,
      value,
      upperValue,
      lowerValue,
      boxId: box.id,
      emptyId: empty.id,
      secondId: second.id,
      mainCode,
      vendorCode,
      upperCode,
      lowerCode,
      spacedCode,
    },
  };
}

export async function runInventoryItemCodeReopen(ctx) {
  const { page, expect, inventoryRead, capture, fixture } = ctx;
  const after = await inventoryRead(fixture.scope);
  assert.deepEqual(after.state, fixture.state);
  assert.deepEqual(after.history, fixture.history);
  assert.equal(after.history.length, after.state.revision);
  const saved = fixture.itemCodeFixture;
  const materialId = after.state.stocks[fixture.stockId].materialId;
  const materials = await page.evaluate((input) => window.electronAPI.inventory.materials(input), {
    project: fixture.project.projectId,
    query: materialId,
    limit: 100,
  });
  const material = materials.items.find((item) => item.id === materialId);
  assert.ok(material);
  await openStock(page, fixture.stockId);
  await expect(
    codes(page, fixture.ids.child).locator(`[data-code-id="${saved.mainCode.id}"]`)
  ).toHaveAttribute('data-code-state', 'retired');
  await expect(
    codes(page, fixture.ids.child).locator(`[data-code-id="${saved.upperCode.id}"]`)
  ).toHaveAttribute('data-code-state', 'active');
  await expect(
    physical(page, fixture.ids.child).getByTestId('inventory-placement-fit')
  ).toHaveAttribute('data-fit', 'compatible');
  await capture('15-reopened-exact-code-history-and-stock-physical-pin', after);
  await closeDetails(page);
  await button(page.getByTestId('inventory-panel').locator('header'), 'Scan or enter code').click();
  const form = dialog(page, 'Scan or enter code');
  await lookup(ctx, form, saved.namespace, saved.value, 'retired');
  await expect(form.getByTestId('inventory-code-result')).toContainText(material.name);
  await capture('16-reopened-retired-binding-stays-historical', await inventoryRead(fixture.scope));
  await lookup(ctx, form, saved.vendorNamespace, saved.value, 'resolved');
  await expect(form.getByTestId('inventory-code-current-location')).toHaveText('Location unknown');
  await expect(form.getByTestId('inventory-code-last-known-location')).toContainText(
    saved.names.box
  );
  await capture(
    '17-reopened-code-read-does-not-locate-missing-item',
    await inventoryRead(fixture.scope)
  );
  await lookup(ctx, form, saved.namespace, saved.lowerValue, 'resolved');
  await expect(form.getByTestId('inventory-code-result')).toContainText('Disposed');
  await capture(
    '18-reopened-disposed-identity-and-zero-write-lookup',
    await inventoryRead(fixture.scope)
  );
  await button(form, 'Close').click();
  assert.deepEqual(await inventoryRead(fixture.scope), after);
  return { ...fixture, ...after };
}

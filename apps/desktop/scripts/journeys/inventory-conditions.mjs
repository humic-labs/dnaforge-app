import assert from 'node:assert/strict';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const conditionsPanel = (page, id) =>
  page.locator(`[data-testid="inventory-storage-conditions"][data-item-id="${id}"]`);
const facts = (page, id) =>
  page.locator(`[data-testid="inventory-temperature-equipment"][data-item-id="${id}"]`).first();
const physical = (page, id) =>
  page.locator(`[data-testid="inventory-physical-details"][data-item-id="${id}"]`);

async function closeDetails(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function stock(ctx) {
  await closeDetails(ctx.page);
  await button(ctx.page, 'All stock').click();
  await ctx.page
    .getByTestId('inventory-stock-table')
    .locator(`[data-stock-id="${ctx.fixture.stockId}"]`)
    .click();
  return conditionsPanel(ctx.page, ctx.fixture.ids.child);
}
async function location(ctx, id) {
  await closeDetails(ctx.page);
  await ctx.page.locator(`[role="treeitem"][data-location-id="${id}"]`).click();
  return conditionsPanel(ctx.page, id);
}
async function thermalContext(ctx, id, mode) {
  const panel = id === ctx.fixture.ids.child ? await stock(ctx) : await location(ctx, id);
  await button(
    panel.getByTestId('inventory-temperature-context').first(),
    'Set temperature context'
  ).click();
  const form = dialog(ctx.page, 'Record temperature context');
  await ctx.choose(form, 'Thermal relationship', mode);
  await common(form, `Synthetic acceptance: explicit thermal relationship ${mode}`);
  await submit(ctx, form, 'Record temperature context');
}
async function read(ctx, freshnessMaxAgeMs = null) {
  return ctx.page.evaluate((request) => window.electronAPI.inventory.storageConditions(request), {
    ...ctx.fixture.scope,
    freshnessMaxAgeMs,
  });
}
async function submit(ctx, form, name) {
  await button(form, name).click();
  await ctx.expect(form).toBeHidden();
  await ctx.expect(ctx.page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
}
async function common(form, reason, observedAt) {
  const source = form.getByLabel('Add a source reference', { exact: true });
  if (await source.isChecked()) await source.uncheck();
  if (observedAt) {
    await form.getByTestId('inventory-temperature-observed-at').fill(observedAt);
  }
  await form.getByLabel('Reason', { exact: true }).fill(reason);
}
async function requirement(ctx, mode, minimum, maximum) {
  const panel = await stock(ctx);
  await button(panel, 'Record stock requirement').click();
  const form = dialog(ctx.page, 'Record temperature requirement');
  await ctx.choose(form, 'Requirement setting', mode);
  if (minimum !== undefined) {
    await form.getByTestId('inventory-temperature-minimum').fill(minimum);
    await form.getByTestId('inventory-temperature-maximum').fill(maximum);
  }
  await common(form, `Synthetic acceptance: stock requirement ${mode}`);
  await submit(ctx, form, 'Record temperature requirement');
}
async function target(ctx, id, value, knownTime = false) {
  await location(ctx, id);
  await button(facts(ctx.page, id), 'Report setpoint').click();
  const form = dialog(ctx.page, 'Report equipment setpoint');
  await ctx.choose(form, 'Reported target knowledge', 'Known reported setpoint');
  await form.getByTestId('inventory-temperature-setpoint').fill(value);
  if (knownTime) await ctx.choose(form, 'Observation time knowledge', 'Known UTC timestamp');
  await common(
    form,
    'Synthetic acceptance: manual target report, no chamber measurement',
    knownTime ? '2026-11-16T00:00:00.000Z' : undefined
  );
  await submit(ctx, form, 'Report equipment setpoint');
}
async function claim(ctx, id, minimum, maximum, qualified = false) {
  if (id === ctx.fixture.ids.child) await stock(ctx);
  else await location(ctx, id);
  const beforeIds = new Set(
    Object.keys((await ctx.inventoryRead(ctx.fixture.scope)).state.temperatureClaims)
  );
  await button(
    facts(ctx.page, id),
    qualified ? 'Record qualification' : 'Record operating range'
  ).click();
  const name = qualified ? 'Record installed qualification' : 'Record specified operating range';
  const form = dialog(ctx.page, name);
  await form.getByTestId('inventory-temperature-minimum').fill(minimum);
  await form.getByTestId('inventory-temperature-maximum').fill(maximum);
  if (qualified) {
    await form.getByTestId('inventory-temperature-setpoint').fill('-80.00');
    await form
      .getByTestId('inventory-temperature-assumptions')
      .fill(
        'Synthetic software acceptance only: declared stable closed chamber, current arrangement and contents. No actual physical qualification or measurement.'
      );
  }
  await common(
    form,
    qualified
      ? 'Synthetic scoped envelope fixture, not a real hardware qualification'
      : 'Synthetic source conflict fixture, not manufacturer equipment data'
  );
  await submit(ctx, form, name);
  const state = (await ctx.inventoryRead(ctx.fixture.scope)).state;
  const matches = Object.values(state.temperatureClaims).filter(
    (row) =>
      !beforeIds.has(row.id) &&
      row.subject.kind === 'installed' &&
      row.subject.item.id === id &&
      row.assertion.kind === (qualified ? 'qualified-envelope' : 'specified-setpoint-range') &&
      row.assertion.range.minimum.value === minimum &&
      row.assertion.range.maximum.value === maximum
  );
  assert.equal(matches.length, 1);
  return matches[0];
}
async function expectAssessments(ctx, capability, target, qualification) {
  const panel = await stock(ctx);
  for (const [kind, value] of [
    ['capability', capability],
    ['target', target],
    ['qualification', qualification],
  ])
    await ctx
      .expect(panel.getByTestId(`inventory-temperature-assessment-${kind}`))
      .toHaveAttribute('data-assessment-state', value);
  await panel.getByTestId('inventory-temperature-assessment-capability').scrollIntoViewIfNeeded();
  const conditions = await read(ctx);
  const view = conditions.stocks[ctx.fixture.stockId];
  assert.equal(view.capability.state, capability);
  assert.equal(view.reportedTarget.state, target);
  assert.equal(view.qualifiedSupport.state, qualification);
  return conditions;
}

export async function runInventoryConditionsJourney(ctx) {
  const { page, expect, choose, inventoryRead, capture, fixture } = ctx;
  const initial = await inventoryRead(fixture.scope);
  assert.deepEqual(initial.history, fixture.history);
  assert.deepEqual(initial.state, {
    ...fixture.state,
    schema: 'dnaforge.inventory.v12',
    origin: { kind: 'native' },
    temperatureClaims: {},
    equipmentSetpoints: {},
    storageRequirements: {},
    thermalContexts: {},
  });
  await expectAssessments(ctx, 'unknown', 'unknown', 'unknown');
  await capture('01-unknown-is-explicit-before-temperature-facts', {
    ...initial,
    conditions: await read(ctx),
  });
  await requirement(ctx, 'Specified temperature range', '-82.00', '-78.000');
  await thermalContext(ctx, fixture.ids.a, 'Has its own temperature control');
  const required = await inventoryRead(fixture.scope);
  assert.deepEqual(required.state.storageRequirements[`stock:${fixture.stockId}`].value, {
    kind: 'specified',
    range: { minimum: { value: '-82', unit: 'C' }, maximum: { value: '-78', unit: 'C' } },
  });
  const capability = await claim(ctx, fixture.ids.a, '-86', '-50');
  await target(ctx, fixture.ids.a, '-80.000', true);
  const qualification = await claim(ctx, fixture.ids.a, '-81', '-79', true);
  let conditions = await expectAssessments(ctx, 'supported', 'supported', 'supported');
  assert.deepEqual(conditions.stocks[fixture.stockId].environment, {
    kind: 'known',
    item: { kind: 'storage', id: fixture.ids.a },
  });
  await capture('02-capability-target-and-scoped-qualification-remain-separate', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });

  const agePolicy = (await stock(ctx)).getByTestId('inventory-temperature-freshness-policy');
  await agePolicy.locator('summary').click();
  await agePolicy.getByTestId('inventory-temperature-max-age').fill('1000');
  await button(agePolicy, 'Apply age policy').click();
  await expect(agePolicy.locator('summary')).toContainText('1000 ms');
  await expect(conditionsPanel(page, fixture.ids.child)).toHaveAttribute(
    'data-revision',
    String((await inventoryRead(fixture.scope)).state.revision)
  );
  conditions = await read(ctx, 1000);
  assert.equal(conditions.equipment[`storage:${fixture.ids.a}`].setpointFreshness.state, 'stale');
  assert.equal(
    conditions.equipment[`storage:${fixture.ids.a}`].setpoint.observedAt,
    Date.parse('2026-11-16T00:00:00.000Z')
  );
  await capture('03-explicit-age-policy-labels-a-manual-report', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  const policy = conditionsPanel(page, fixture.ids.child).getByTestId(
    'inventory-temperature-freshness-policy'
  );
  await policy.getByTestId('inventory-temperature-max-age').fill('');
  await button(policy, 'Apply age policy').click();
  await expect(policy.locator('summary')).toContainText('none selected');

  await target(ctx, fixture.ids.a, '-20');
  conditions = await expectAssessments(ctx, 'supported', 'incompatible', 'unknown');
  await capture('04-mismatching-target-preserves-stock-and-history', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  await target(ctx, fixture.ids.a, '-80');
  const conflict = await claim(ctx, fixture.ids.a, '-90', '-85');
  conditions = await expectAssessments(ctx, 'conflicting', 'supported', 'supported');
  await capture('05-competing-equal-scope-evidence-never-latest-wins', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  await location(ctx, fixture.ids.a);
  const conflictingCard = facts(page, fixture.ids.a).locator(`[data-claim-id="${conflict.id}"]`);
  await button(conflictingCard, 'Withdraw evidence').click();
  const withdrawal = dialog(page, 'Withdraw temperature evidence');
  await withdrawal
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: explicit withdrawal preserves prior source history');
  await submit(ctx, withdrawal, 'Withdraw temperature evidence');
  await expect(conflictingCard).toHaveAttribute('data-claim-lifecycle', 'withdrawn');
  await requirement(ctx, 'Explicitly unknown');
  conditions = await expectAssessments(ctx, 'unknown', 'unknown', 'unknown');
  assert.equal(conditions.stocks[fixture.stockId].requirement.reason, 'stock-override');
  await requirement(ctx, 'Inherit lot requirement');
  conditions = await expectAssessments(ctx, 'unknown', 'unknown', 'unknown');
  assert.equal(conditions.stocks[fixture.stockId].requirement.reason, 'unattributed');
  await requirement(ctx, 'Specified temperature range', '-82', '-78');

  await stock(ctx);
  await button(physical(page, fixture.ids.child), 'Edit installed arrangement').click();
  let edit = dialog(page, 'Edit installed arrangement');
  await button(edit, 'Edit Asset label').click();
  const metadata = edit.getByTestId('inventory-metadata-assetLabel');
  await metadata.fill('CHILD-04');
  await metadata.press('Enter');
  await edit
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: metadata-only correction preserves parent qualification');
  await submit(ctx, edit, 'Save this arrangement');
  conditions = await expectAssessments(ctx, 'supported', 'supported', 'supported');
  const afterMetadata = await inventoryRead(fixture.scope);
  assert.equal(
    afterMetadata.state.vessels[fixture.ids.child].configuration.revision,
    initial.state.vessels[fixture.ids.child].configuration.revision
  );
  await capture('06-child-metadata-preserves-saved-parent-qualification', {
    ...afterMetadata,
    conditions,
  });
  await button(physical(page, fixture.ids.child), 'Edit installed arrangement').click();
  edit = dialog(page, 'Edit installed arrangement');
  await choose(edit, 'Mounting orientation', '90°');
  await edit
    .getByLabel('Reason', { exact: true })
    .fill(
      'Synthetic acceptance: physical descendant rearrangement invalidates saved envelope scope'
    );
  await submit(ctx, edit, 'Save this arrangement');
  conditions = await expectAssessments(ctx, 'supported', 'supported', 'unknown');
  assert.equal(
    conditions.equipment[`storage:${fixture.ids.a}`].claims.find(
      (row) => row.claim.id === qualification.id
    ).applicability,
    'configuration-changed'
  );
  await capture('07-physical-child-change-makes-old-qualification-inapplicable', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });

  await location(ctx, fixture.ids.a);
  const custody = page.locator(
    `[data-testid="inventory-custody"][data-item-id="${fixture.ids.a}"]`
  );
  await button(custody, 'Check out').click();
  let custodyForm = dialog(page, 'Check out');
  await custodyForm
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: remove whole holder from current freezer context');
  await submit(ctx, custodyForm, 'Check out');
  conditions = await expectAssessments(ctx, 'unknown', 'unknown', 'unknown');
  assert.deepEqual(conditions.stocks[fixture.stockId].environment, {
    kind: 'unknown',
    reason: 'custody-unavailable',
  });
  await capture('08-custody-departure-clears-current-thermal-context', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  await location(ctx, fixture.ids.a);
  await button(custody, 'Return').click();
  custodyForm = dialog(page, 'Return');
  await choose(custodyForm, 'Location', 'Top level');
  await custodyForm
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: explicitly restore holder location');
  await submit(ctx, custodyForm, 'Return');
  conditions = await expectAssessments(ctx, 'supported', 'supported', 'unknown');

  const state = (await inventoryRead(fixture.scope)).state;
  assert.deepEqual(state.stocks, initial.state.stocks);
  assert.deepEqual(state.lots, initial.state.lots);
  assert.deepEqual(state.reservations, initial.state.reservations);
  assert.deepEqual(state.itemCodes, initial.state.itemCodes);
  assert.deepEqual(state.storage, initial.state.storage);
  assert.equal(state.temperatureClaims[capability.id].lifecycle.kind, 'active');
  assert.equal(state.temperatureClaims[conflict.id].lifecycle.kind, 'withdrawn');
  const final = await inventoryRead(fixture.scope);
  await capture('09-retained-facts-and-conserved-inventory-before-restart', {
    ...final,
    conditions,
  });
  return {
    ...fixture,
    ...final,
    temperatureFixture: { capability, qualification, conflict, conditions },
  };
}

export async function runInventoryThermalContextJourney(ctx) {
  const { page, expect, inventoryRead, capture, fixture } = ctx;
  const initial = await inventoryRead(fixture.scope);
  const expectedClaims = Object.fromEntries(
    Object.entries(fixture.state.temperatureClaims).map(([id, value]) => [
      id,
      {
        ...value,
        installation:
          value.installation?.map((entry) => ({ ...entry, thermalRelationship: null })) ?? null,
      },
    ])
  );
  assert.deepEqual(initial.state, {
    ...fixture.state,
    schema: 'dnaforge.inventory.v12',
    origin: { kind: 'native' },
    thermalContexts: {},
    temperatureClaims: expectedClaims,
  });
  assert.deepEqual(initial.history, fixture.history);
  await expectAssessments(ctx, 'unknown', 'unknown', 'unknown');
  await capture('10-legacy-facts-do-not-invent-a-temperature-control-relationship', {
    ...initial,
    conditions: await read(ctx),
  });
  await thermalContext(ctx, fixture.ids.a, 'Has its own temperature control');
  let conditions = await expectAssessments(ctx, 'supported', 'supported', 'unknown');
  assert.deepEqual(conditions.stocks[fixture.stockId].environment, {
    kind: 'known',
    item: { kind: 'storage', id: fixture.ids.a },
  });
  await capture('11-explicit-parent-control-is-separate-from-temperature-evidence', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  await thermalContext(ctx, fixture.ids.child, 'Has its own temperature control');
  const innerClaim = await claim(ctx, fixture.ids.child, '-86', '-50');
  conditions = await expectAssessments(ctx, 'supported', 'unknown', 'unknown');
  assert.deepEqual(conditions.stocks[fixture.stockId].environment, {
    kind: 'known',
    item: { kind: 'vessel', id: fixture.ids.child },
  });
  await capture('12-controlled-inner-container-does-not-borrow-parent-target', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  await stock(ctx);
  await button(
    facts(page, fixture.ids.child).locator(`[data-claim-id="${innerClaim.id}"]`),
    'Withdraw evidence'
  ).click();
  const form = dialog(page, 'Withdraw temperature evidence');
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: evidence withdrawal must preserve physical control relationship');
  await submit(ctx, form, 'Withdraw temperature evidence');
  conditions = await expectAssessments(ctx, 'unknown', 'unknown', 'unknown');
  assert.deepEqual(conditions.stocks[fixture.stockId].environment, {
    kind: 'known',
    item: { kind: 'vessel', id: fixture.ids.child },
  });
  await expect(
    conditionsPanel(page, fixture.ids.child).getByTestId('inventory-temperature-context').first()
  ).toHaveAttribute('data-context-relationship', 'self');
  await capture('13-withdrawn-evidence-cannot-erase-inner-control', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  await thermalContext(ctx, fixture.ids.child, 'Relationship unknown');
  conditions = await expectAssessments(ctx, 'unknown', 'unknown', 'unknown');
  assert.deepEqual(conditions.stocks[fixture.stockId].environment, {
    kind: 'unknown',
    reason: 'thermal-context-unknown',
  });
  await capture('14-unknown-relationship-blocks-surrounding-freezer-inheritance', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  await thermalContext(ctx, fixture.ids.child, 'Inherit surrounding conditions');
  const qualification = await claim(ctx, fixture.ids.a, '-81', '-79', true);
  assert.equal(qualification.assertion.scope, 'physical-and-thermal-arrangement');
  assert.deepEqual(
    qualification.installation.map((entry) => entry.thermalRelationship),
    ['self', 'inherit']
  );
  conditions = await expectAssessments(ctx, 'supported', 'supported', 'supported');
  await capture('15-new-qualification-explicitly-covers-physical-and-thermal-arrangement', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  await thermalContext(ctx, fixture.ids.child, 'Relationship unknown');
  conditions = await read(ctx);
  assert.equal(
    conditions.equipment[`storage:${fixture.ids.a}`].claims.find(
      (row) => row.claim.id === qualification.id
    ).applicability,
    'configuration-changed'
  );
  await thermalContext(ctx, fixture.ids.child, 'Inherit surrounding conditions');
  conditions = await expectAssessments(ctx, 'supported', 'supported', 'supported');
  await capture('16-explicit-relationship-correction-restores-exact-saved-scope', {
    ...(await inventoryRead(fixture.scope)),
    conditions,
  });
  return finishTemperatureCatalog(ctx, initial, qualification, innerClaim);
}

async function finishTemperatureCatalog(ctx, initial, qualification, innerClaim) {
  const { page, expect, inventoryRead, capture, fixture } = ctx;
  let conditions;

  await closeDetails(page);
  await button(page.getByTestId('inventory-panel').locator('header'), 'Inventory setup').click();
  const setup = dialog(page, 'Inventory setup');
  await setup.getByRole('tab', { name: 'Equipment recipes', exact: true }).click();
  await setup.getByLabel('Search inventory setup', { exact: true }).fill('TSX60086');
  const catalogId = 'catalog:thermo:tsx60086:920090';
  const card = setup.locator(`article[data-catalog-id="${catalogId}"]`);
  const beforePreview = await inventoryRead(fixture.scope);
  await button(card, 'Preview catalog update').click();
  const preview = dialog(page, 'Catalog update preview');
  await expect(preview).toContainText('Specified operating range');
  await expect(preview).toContainText('Advertised possible setpoints only');
  assert.deepEqual(await inventoryRead(fixture.scope), beforePreview);
  const definition = preview.locator(
    '[data-definition-id="catalog:thermo:tsx60086:v1:specified-temperature:v1"]'
  );
  await definition.scrollIntoViewIfNeeded();
  await definition
    .getByRole('checkbox', {
      name: 'Apply catalog:thermo:tsx60086:v1:specified-temperature:v1',
      exact: true,
    })
    .check();
  await capture('17-read-only-preview-of-primary-source-advertised-range', beforePreview);
  await submit(ctx, preview, 'Apply selected definitions');
  const afterCatalog = await inventoryRead(fixture.scope);
  assert.deepEqual(afterCatalog.state.typeVersions, beforePreview.state.typeVersions);
  assert.deepEqual(afterCatalog.state.recipeVersions, beforePreview.state.recipeVersions);
  assert.deepEqual(afterCatalog.state.fitEvidence, beforePreview.state.fitEvidence);
  const sourceClaim =
    afterCatalog.state.temperatureClaims['catalog:thermo:tsx60086:v1:specified-temperature:v1'];
  assert.ok(sourceClaim);
  assert.equal(
    sourceClaim.source.sha256,
    '2b5c042164560c52d01172c2a5ba148d130106e664184501771dadb316496c56'
  );
  await button(setup, 'Close').click();
  await location(ctx, fixture.full.rootId);
  await expect(
    facts(page, fixture.full.rootId).locator(`[data-claim-id="${sourceClaim.id}"]`)
  ).toContainText('-86 to -50 °C');
  await expect(
    conditionsPanel(page, fixture.full.rootId).getByTestId('inventory-temperature-context').first()
  ).toHaveAttribute('data-context-relationship', 'inherit');
  await capture('18-advertised-range-does-not-invent-installed-control-or-target', {
    ...afterCatalog,
    conditions: await read(ctx),
  });
  conditions = await expectAssessments(ctx, 'supported', 'supported', 'supported');
  const final = await inventoryRead(fixture.scope);
  for (const key of [
    'stocks',
    'lots',
    'reservations',
    'storage',
    'vessels',
    'itemCodes',
    'typeVersions',
    'recipeVersions',
    'fitEvidence',
  ])
    assert.deepEqual(final.state[key], initial.state[key]);
  await capture('19-explicit-control-model-and-conserved-inventory-before-restart', {
    ...final,
    conditions,
  });
  return {
    ...fixture,
    ...final,
    temperatureFixture: {
      ...fixture.temperatureFixture,
      qualification,
      innerClaim,
      sourceClaim,
      conditions,
      expectedQualification: 'supported',
      expectedApplicability: 'applicable',
    },
  };
}

export async function runInventoryTemperatureCatalogRecovery(ctx) {
  const initial = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(initial.state, ctx.fixture.state);
  assert.deepEqual(initial.history, ctx.fixture.history);
  const conditions = await expectAssessments(ctx, 'supported', 'supported', 'supported');
  await ctx.capture('00-recovered-explicit-control-state-before-catalog-selection', {
    ...initial,
    conditions,
  });
  return finishTemperatureCatalog(
    ctx,
    initial,
    ctx.fixture.temperatureFixture.qualification,
    ctx.fixture.temperatureFixture.innerClaim
  );
}

export async function runInventoryConditionsReopen(ctx) {
  const observed = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(observed.state, ctx.fixture.state);
  assert.deepEqual(observed.history, ctx.fixture.history);
  const conditions = await expectAssessments(
    ctx,
    'supported',
    'supported',
    ctx.fixture.temperatureFixture.expectedQualification ?? 'unknown'
  );
  const previous = ctx.fixture.temperatureFixture.conditions;
  assert.deepEqual(conditions.stocks, previous.stocks);
  for (const key of Object.keys(previous.equipment)) {
    assert.deepEqual(conditions.equipment[key].setpoint, previous.equipment[key].setpoint);
    assert.deepEqual(
      conditions.equipment[key].claims.map(({ claim, applicability }) => ({
        claim,
        applicability,
      })),
      previous.equipment[key].claims.map(({ claim, applicability }) => ({ claim, applicability }))
    );
  }
  await ctx.capture('01-reopened-temperature-facts-and-independent-assessments', {
    ...observed,
    conditions,
  });
  await location(ctx, ctx.fixture.ids.a);
  const qualification = facts(ctx.page, ctx.fixture.ids.a).locator(
    `[data-claim-id="${ctx.fixture.temperatureFixture.qualification.id}"]`
  );
  await ctx
    .expect(qualification)
    .toHaveAttribute(
      'data-applicability',
      ctx.fixture.temperatureFixture.expectedApplicability ?? 'configuration-changed'
    );
  await qualification.scrollIntoViewIfNeeded();
  await ctx.capture('02-reopened-scoped-qualification-retains-applicability-state', {
    ...observed,
    conditions,
  });
  const pin = qualification.getByTestId('inventory-temperature-installation-pin');
  await pin.locator('summary').click();
  await pin.scrollIntoViewIfNeeded();
  await ctx.capture('03-reopened-inspectable-physical-and-thermal-qualification-pin', {
    ...observed,
    conditions,
  });
  const sourceClaim = ctx.fixture.temperatureFixture.sourceClaim;
  if (sourceClaim) {
    await location(ctx, ctx.fixture.full.rootId);
    const range = facts(ctx.page, ctx.fixture.full.rootId).locator(
      `[data-claim-id="${sourceClaim.id}"]`
    );
    await range.scrollIntoViewIfNeeded();
    await ctx.expect(range).toContainText('-86 to -50 °C');
    await ctx.capture('04-reopened-primary-source-range-without-invented-qualification', {
      ...observed,
      conditions,
    });
    const context = conditionsPanel(ctx.page, ctx.fixture.full.rootId)
      .getByTestId('inventory-temperature-context')
      .first();
    await context.scrollIntoViewIfNeeded();
    await ctx.expect(context).toHaveAttribute('data-context-relationship', 'inherit');
    await ctx.capture('05-reopened-source-range-does-not-declare-temperature-control', {
      ...observed,
      conditions,
    });
  }
  return {
    ...ctx.fixture,
    ...observed,
    temperatureFixture: { ...ctx.fixture.temperatureFixture, conditions },
  };
}

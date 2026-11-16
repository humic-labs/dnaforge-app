import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { inventoryFixtureMetadataDefaults } from './inventory-fixture-metadata.mjs';
import { previewInventoryReceiveTable } from './inventory-tables.mjs';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const physicalFacts = ({
  revision: _revision,
  lastRecordedAt: _clock,
  tableBindings: _bindings,
  ...facts
}) => facts;
const acknowledgementReason =
  'Acknowledge the revised external record while keeping physical stock and its history unchanged';

async function closeDrawer(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}

async function compare(ctx, fixture) {
  const { page, expect, choose } = ctx;
  await closeDrawer(page);
  await button(page.getByTestId('inventory-panel').locator('header'), 'Source revisions').click();
  const form = dialog(page, 'Acknowledge revised source');
  await form.getByLabel('Source revision namespace', { exact: true }).fill(fixture.namespace);
  await form.locator('summary').filter({ hasText: 'Paste or inspect revised source' }).click();
  await form.getByLabel('Revised receive table text', { exact: true }).fill(fixture.revised);
  assert.equal(
    await form.getByLabel('Revised receive table text', { exact: true }).inputValue(),
    fixture.revised
  );
  await button(form, 'Compare revised source').click();
  await expect(form.getByTestId('inventory-source-revision-import')).not.toHaveAttribute(
    'data-preview-state',
    'previewing'
  );
  for (const [key, id] of Object.entries(fixture.materials)) {
    await form.getByLabel('Search source revision scientific records', { exact: true }).fill(id);
    await choose(form, `Scientific record for ${key}`, new RegExp(escaped(id)));
  }
  await choose(form, 'Location for freezer', new RegExp(escaped(fixture.box.id)));
  await choose(form, 'Location for bench', 'Explicitly unplaced');
  await form.getByLabel('Search source revision vessels', { exact: true }).fill(fixture.well.id);
  await choose(form, 'Existing vessel for well', new RegExp(escaped(fixture.well.id)));
  await form.getByLabel('Skip source skipped-1', { exact: true }).check();
  await form
    .getByLabel('Skip reason for source skipped-1', { exact: true })
    .fill('Explicitly excluded source row; no stock exists for this external identity');
  await button(form, 'Compare revised source').click();
  await expect(form.getByTestId('inventory-source-revision-import')).not.toHaveAttribute(
    'data-preview-state',
    'previewing'
  );
  return form;
}

export async function runInventorySourceRevisionJourney(ctx) {
  const { page, expect, inventoryRead, capture, evidenceDirectory, fixture: input } = ctx;
  const { project, scope, active, box, well } = input;
  const initial = await inventoryRead(scope);
  assert.deepEqual(initial.state, {
    ...input.state,
    ...inventoryFixtureMetadataDefaults(input.state),
  });
  assert.deepEqual(initial.history, input.history);
  assert.equal(initial.state.stocks[active.stockId].quantity.value, '63');
  const originalRequest = initial.history.find(
    (entry) =>
      'kind' in entry.request &&
      entry.request.kind === 'receive-table' &&
      entry.request.options.namespace === 'synthetic:desktop:stock-register:stable'
  ).request;
  const original = originalRequest.sourceText;
  assert.ok(original.includes('"Table tube, alpha\nsecond line"'));
  const revised = original
    .replace('"Table tube, alpha\nsecond line"', 'Revised external tube label')
    .replace(',80,uL,usable,new,,freezer,A', ',90,uL,quarantined,new,,freezer,C');
  assert.notEqual(revised, original);
  const fixture = {
    project,
    scope,
    active,
    box,
    well,
    namespace: originalRequest.options.namespace,
    materials: Object.fromEntries(
      originalRequest.options.materials.map((item) => [item.key, item.materialId])
    ),
    original,
    revised,
    initial,
  };
  writeFileSync(path.join(evidenceDirectory, 'original-register.csv'), original);
  writeFileSync(path.join(evidenceDirectory, 'revised-register.csv'), revised);
  await capture(
    '01-before-source-revision-current-stock-63-at-B-with-hold-and-observations',
    initial
  );
  const form = await compare(ctx, fixture);
  await expect(form.getByTestId('inventory-source-revision-import')).toHaveAttribute(
    'data-preview-state',
    'needs-acknowledgement'
  );
  const row = form.getByTestId('inventory-source-revision-rows').locator('[data-source-id="0007"]');
  await expect(row.locator('[data-source-column="previous"]')).toContainText(/80\s*(?:uL|µL)/u);
  await expect(row.locator('[data-source-column="revised"]')).toContainText(/90\s*(?:uL|µL)/u);
  await expect(row.locator('[data-source-column="actual"]')).toContainText(/63\s*(?:uL|µL)/u);
  await expect(row.locator('[data-source-column="previous"]')).toContainText('Table tube, alpha');
  await expect(row.locator('[data-source-column="revised"]')).toContainText(
    'Revised external tube label'
  );
  await expect(row.locator('[data-source-column="actual"]')).toContainText('Table tube, alpha');
  await row.scrollIntoViewIfNeeded();
  assert.deepEqual(await inventoryRead(scope), initial);
  await capture('02-verified-previous-source-80-revised-source-90-actual-stock-63', initial);
  const [bindingKey, beforeBinding] = Object.entries(initial.state.tableBindings).find(
    ([, value]) => value.namespace === fixture.namespace && value.sourceId === '0007'
  );
  await form.getByLabel('Acknowledge source 0007', { exact: true }).check();
  assert.equal(
    await form.getByLabel('Previous source hash for 0007', { exact: true }).inputValue(),
    beforeBinding.rowSha256
  );
  await form
    .getByLabel('Reason for source revision 0007', { exact: true })
    .fill(acknowledgementReason);
  await button(form, 'Compare revised source').click();
  await expect(form.getByTestId('inventory-source-revision-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  await form.getByTestId('inventory-source-revision-preview').scrollIntoViewIfNeeded();
  const digest = await form
    .getByTestId('inventory-source-revision-preview')
    .getAttribute('data-plan-digest');
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await inventoryRead(scope), initial);
  await capture('03-explicit-source-acknowledgement-plan-with-no-physical-changes', {
    digest,
    acknowledgementReason,
  });
  await button(form, 'Acknowledge source revision').click();
  await expect(form).toBeHidden();
  const acknowledged = await inventoryRead(scope);
  assert.equal(acknowledged.state.revision, initial.state.revision + 1);
  assert.deepEqual(physicalFacts(acknowledged.state), physicalFacts(initial.state));
  for (const [key, value] of Object.entries(initial.state.tableBindings))
    if (key !== bindingKey) assert.deepEqual(acknowledged.state.tableBindings[key], value);
  const afterBinding = acknowledged.state.tableBindings[bindingKey];
  assert.equal(afterBinding.rowSha256, beforeBinding.rowSha256);
  assert.deepEqual(afterBinding.destination, beforeBinding.destination);
  assert.equal(afterBinding.sourceRevisions.length, 1);
  assert.equal(afterBinding.sourceRevisions[0].previousRowSha256, beforeBinding.rowSha256);
  assert.equal(afterBinding.sourceRevisions[0].fields.quantity, '90');
  assert.equal(afterBinding.sourceRevisions[0].fields.quality, 'quarantined');
  assert.equal(afterBinding.sourceRevisions[0].fields.slot, 'C');
  const accepted = acknowledged.history.at(-1);
  assert.equal(accepted.request.kind, 'acknowledge-table-source');
  assert.equal(accepted.request.sourceText, revised);
  assert.equal(accepted.request.expectedPlanDigest, digest);
  assert.deepEqual(afterBinding.sourceRevisions[0].by, accepted.receipt.context.principal);
  assert.equal(afterBinding.sourceRevisions[0].at, accepted.receipt.recordedAt);
  await capture(
    '04-source-history-appended-with-physical-facts-hold-and-observations-unchanged',
    acknowledged
  );
  let receive = await previewInventoryReceiveTable(ctx, fixture, revised);
  await expect(receive.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(scope), acknowledged);
  await capture('05-revised-register-reimport-does-not-receive-or-move-stock', acknowledged);
  await button(receive, 'Cancel').click();
  await page
    .getByTestId('inventory-stock-table')
    .locator(`[data-stock-id="${active.stockId}"]`)
    .click();
  await button(page, 'Use stock').click();
  const use = dialog(page, 'Use stock');
  await use.getByLabel('Quantity', { exact: true }).fill('1');
  await use
    .getByLabel('Reason', { exact: true })
    .fill('Later actual use remains independent from acknowledged external quantity');
  await button(use, 'Use stock').click();
  await expect(use).toBeHidden();
  await closeDrawer(page);
  const afterUse = await inventoryRead(scope);
  assert.equal(afterUse.state.stocks[active.stockId].quantity.value, '62');
  assert.deepEqual(afterUse.state.reservations, initial.state.reservations);
  assert.deepEqual(afterUse.state.observations, initial.state.observations);
  assert.deepEqual(afterUse.state.tableBindings, acknowledged.state.tableBindings);
  receive = await previewInventoryReceiveTable(ctx, fixture, revised);
  await expect(receive.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(scope), afterUse);
  await capture('06-accepted-source-90-does-not-restore-stock-after-use-to-62', afterUse);
  await button(receive, 'Cancel').click();
  await button(page.getByTestId('inventory-panel').locator('header'), 'History').click();
  const drawer = page.getByTestId('inventory-detail-drawer');
  const history = drawer
    .getByTestId('inventory-history')
    .locator(`[data-operation-id="${accepted.receipt.operationId}"]`);
  await expect(history).toContainText('Acknowledged source revision');
  await history.locator('summary').click();
  assert.equal(
    await history.getByLabel('Retained revised source', { exact: true }).inputValue(),
    revised
  );
  await capture('07-retained-revised-source-and-native-metadata-receipt', { accepted });
  await closeDrawer(page);
  const artifact = await page.evaluate(
    (scope) => window.electronAPI.inventory.exportSnapshot({ ...scope, format: 'native-v1' }),
    scope
  );
  writeFileSync(
    path.join(evidenceDirectory, 'source-revision-inventory.dnaforge-inventory.json'),
    artifact.sourceText
  );
  return {
    ...fixture,
    ...afterUse,
    bindingKey,
    beforeBinding,
    accepted,
    artifact,
    nativeDialogQualified: false,
  };
}

export async function runInventorySourceRevisionReopen(ctx) {
  const { fixture, inventoryRead, page, expect, capture } = ctx;
  const current = await inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  const artifact = await page.evaluate(
    (scope) => window.electronAPI.inventory.exportSnapshot({ ...scope, format: 'native-v1' }),
    fixture.scope
  );
  assert.equal(artifact.sourceText, fixture.artifact.sourceText);
  await capture('08-reopened-exact-source-chain-stock-hold-observations-and-history', current);
  let form = await compare(ctx, fixture);
  await expect(form.getByTestId('inventory-source-revision-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  const row = form.getByTestId('inventory-source-revision-rows').locator('[data-source-id="0007"]');
  await expect(row.locator('[data-source-column="previous"]')).toContainText(/90\s*(?:uL|µL)/u);
  await expect(row.locator('[data-source-column="revised"]')).toContainText(/90\s*(?:uL|µL)/u);
  await expect(row.locator('[data-source-column="actual"]')).toContainText(/62\s*(?:uL|µL)/u);
  await row.scrollIntoViewIfNeeded();
  await capture('09-reopened-source-baseline-90-stays-separate-from-actual-62', current);
  await button(form, 'Cancel').click();
  form = await previewInventoryReceiveTable(ctx, fixture, fixture.revised);
  await expect(form.getByTestId('inventory-table-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(fixture.scope), current);
  await capture('10-reopened-revised-register-still-does-not-replenish-stock', current);
  await button(form, 'Cancel').click();
  return { ...fixture, ...current, artifact };
}

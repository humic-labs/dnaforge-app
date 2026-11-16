import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const namespace = 'representative:primer-spreadsheet:stable';
const evidenceReason =
  'Keep original columns as source evidence; scientific publication and physical inventory decisions have separate owners';
const quantityReason = 'The original register contains no volume measurements';
const qualityReason = 'Explicit representative quality choice independent from source QC text';

async function closeDrawer(page) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}

async function mappedDraft(ctx, fixture, sourceText) {
  const { page, expect, choose } = ctx;
  await closeDrawer(page);
  await button(page.getByTestId('inventory-panel').locator('header'), 'Map spreadsheet').click();
  const form = dialog(page, 'Map plate spreadsheet');
  await form.getByLabel('Mapped source namespace', { exact: true }).fill(namespace);
  await form
    .locator('summary')
    .filter({ hasText: 'Paste or inspect original spreadsheet' })
    .click();
  await form.getByLabel('Original spreadsheet text', { exact: true }).fill(sourceText);
  assert.equal(
    await form.getByLabel('Original spreadsheet text', { exact: true }).inputValue(),
    sourceText
  );
  await button(form, 'Preview mapped receiving').click();
  await expect(form.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  await choose(form, 'Source ID column', 'Primer ID');
  await choose(form, 'Plate column', 'Plate');
  await choose(form, 'Well column', 'Well');
  await form.getByLabel('Reason for evidence-only columns', { exact: true }).fill(evidenceReason);
  await button(form, 'Retain remaining columns as evidence').click();
  await form.getByLabel('Declare unknown quantity', { exact: true }).check();
  await form.getByLabel('Reason for unknown quantity', { exact: true }).fill(quantityReason);
  await button(form, 'Preview mapped receiving').click();
  await expect(form.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  for (const [sourcePlate, plate] of Object.entries(fixture.plates))
    await choose(form, `Destination plate for ${sourcePlate}`, new RegExp(escaped(plate.id)));
  for (const [plate, sourceWell, position] of [
    ['Plate-7', 'A01', 'A1'],
    ['Plate-7', 'A02', 'A2'],
    ['Plate-8', 'B01', 'B1'],
  ])
    await choose(form, `Position for ${plate} / ${sourceWell}`, position);
  for (const record of fixture.scientific.recorded) {
    const sourceId = record.artifact.name;
    await form
      .getByLabel('Search mapped scientific records', { exact: true })
      .fill(record.limsEntity.id);
    await choose(
      form,
      `Scientific record for source ${sourceId}`,
      new RegExp(escaped(record.limsEntity.id))
    );
    await choose(
      form,
      `Quality for source ${sourceId}`,
      sourceId === 'MP002' ? 'Quarantined' : 'Usable'
    );
    await form
      .getByLabel(`Quality reason for source ${sourceId}`, { exact: true })
      .fill(qualityReason);
  }
  await button(form, 'Preview mapped receiving').click();
  await expect(form.getByTestId('inventory-mapped-import')).not.toHaveAttribute(
    'data-preview-state',
    'previewing'
  );
  return form;
}

export async function runInventoryMappedJourney(ctx) {
  const {
    page,
    expect,
    choose,
    inventoryRead,
    capture,
    evidenceDirectory,
    projectRoot,
    fixture: input,
  } = ctx;
  const { project, scope } = input;
  const sourceText = readFileSync(
    path.join(projectRoot, 'test-fixtures/lims-import/walkthrough/primers-messy.csv'),
    'utf8'
  );
  const initial = await inventoryRead(scope);
  assert.deepEqual(initial.state, input.state);
  assert.deepEqual(initial.history, input.history);
  writeFileSync(path.join(evidenceDirectory, 'original-primer-register.csv'), sourceText);
  const scientific = await page.evaluate(
    async ({ sourceText, workspaceRoot }) => {
      const { parseDelimitedRows } = await import('/src/shared/delimited-rows.ts');
      const parsed = parseDelimitedRows(sourceText, ',');
      if (!parsed.ok) throw new Error(parsed.error);
      const [headers, ...rows] = parsed.rows;
      const sourceRows = rows.map((row) =>
        Object.fromEntries(headers.map((column, index) => [column, row[index]]))
      );
      const { recordPrimers } = await import('/src/features/primers/public/record-primers.ts');
      const result = await recordPrimers({
        workspaceRoot,
        origin: 'import',
        primers: sourceRows.map((row) => ({
          name: row['Primer ID'],
          sequence: row['Oligo Sequence'],
          notes: row.Notes,
        })),
      });
      return { ...result, sourceRows };
    },
    { sourceText, workspaceRoot: project.path }
  );
  writeFileSync(
    path.join(evidenceDirectory, 'scientific-primer-publication.json'),
    JSON.stringify(scientific, null, 2)
  );
  assert.deepEqual(scientific.failed, []);
  assert.deepEqual(scientific.skipped, []);
  assert.equal(scientific.recorded.length, 3);
  const scientificFiles = [];
  for (const recorded of scientific.recorded) {
    const source = scientific.sourceRows.find((row) => row['Primer ID'] === recorded.artifact.name);
    assert.ok(recorded.artifactPath.startsWith(project.path + path.sep));
    const bytes = readFileSync(recorded.artifactPath);
    const actual = JSON.parse(bytes.toString('utf8'));
    assert.equal(actual.registry.entityId, recorded.limsEntity.id);
    assert.equal(actual.sequence.bases, source['Oligo Sequence']);
    const admitted = await page.evaluate((input) => window.electronAPI.inventory.materials(input), {
      project: project.projectId,
      query: recorded.limsEntity.id,
      limit: 100,
    });
    assert.ok(admitted.items.some((item) => item.id === recorded.limsEntity.id));
    scientificFiles.push({
      path: recorded.artifactPath,
      sha256: hash(bytes),
      entityId: recorded.limsEntity.id,
      sourceId: source['Primer ID'],
    });
  }
  writeFileSync(
    path.join(evidenceDirectory, 'scientific-file-readbacks.json'),
    JSON.stringify(scientificFiles, null, 2)
  );
  assert.deepEqual(await inventoryRead(scope), initial);
  await capture('01-genuine-scientific-primer-publication-does-not-imply-physical-stock', {
    scientificFiles,
    initial,
  });
  for (const sourcePlate of ['Plate-7', 'Plate-8']) {
    await button(page.getByTestId('inventory-panel').locator('header'), 'Add location').click();
    const form = dialog(page, 'Add location');
    await form.getByLabel('Location name', { exact: true }).fill(`Mapped source ${sourcePlate}`);
    await choose(form, 'Position layout', 'Well plate');
    await form.getByLabel('Rows', { exact: true }).fill('2');
    await form.getByLabel('Columns', { exact: true }).fill('2');
    await choose(form, 'Location', 'Top level');
    await button(form, 'Add location').click();
    await expect(form).toBeHidden();
  }
  const prepared = await inventoryRead(scope);
  const plates = Object.fromEntries(
    ['Plate-7', 'Plate-8'].map((name) => [
      name,
      Object.values(prepared.state.storage).find((item) => item.name === `Mapped source ${name}`),
    ])
  );
  assert.ok(plates['Plate-7'] && plates['Plate-8']);
  const fixture = {
    project,
    scope,
    sourceText,
    scientific,
    scientificFiles,
    plates,
    initial,
    prepared,
  };
  writeFileSync(
    path.join(evidenceDirectory, 'mapped-prepared-fixture.json'),
    JSON.stringify({ ...fixture, ...prepared, mappedPreparation: { stage: 'prepared' } }, null, 2)
  );
  return finishInventoryMappedJourney(ctx, fixture);
}

async function finishInventoryMappedJourney(ctx, fixture) {
  const { page, expect, choose, inventoryRead, capture, evidenceDirectory } = ctx;
  const { scope, sourceText, prepared } = fixture;
  let form = await mappedDraft(ctx, fixture, sourceText);
  await expect(form.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  await expect(
    form.getByTestId('inventory-mapped-rows').locator('[data-row-kind="create"]')
  ).toHaveCount(3);
  assert.deepEqual(await inventoryRead(scope), prepared);
  await form.getByTestId('inventory-mapped-preview').scrollIntoViewIfNeeded();
  const digest = await form
    .getByTestId('inventory-mapped-preview')
    .getAttribute('data-plan-digest');
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  await capture(
    '02-explicit-original-columns-quality-and-well-translations-before-atomic-receipt',
    { digest, scientificFiles: fixture.scientificFiles }
  );
  await button(form, 'Receive mapped stocks').click();
  await expect(form).toBeHidden();
  const received = await inventoryRead(scope);
  const accepted = received.history.at(-1);
  assert.equal(accepted.request.kind, 'receive-mapped-table');
  assert.equal(accepted.request.sourceText, sourceText);
  assert.equal(accepted.request.expectedPlanDigest, digest);
  assert.equal(accepted.request.options.evidenceOnlyColumns.length, 10);
  assert.equal(received.state.revision, prepared.state.revision + 1);
  const bindings = Object.values(received.state.tableBindings).filter(
    (binding) => binding.namespace === namespace
  );
  assert.equal(bindings.length, 3);
  for (const record of fixture.scientific.recorded) {
    const binding = bindings.find((binding) => binding.sourceId === record.artifact.name);
    assert.equal(binding.materialId, record.limsEntity.id);
    assert.deepEqual(received.state.stocks[binding.stockId].quantity, { kind: 'unknown' });
    assert.equal(
      received.state.stocks[binding.stockId].quality,
      binding.sourceId === 'MP002' ? 'quarantined' : 'usable'
    );
  }
  writeFileSync(
    path.join(evidenceDirectory, 'mapped-received-checkpoint.json'),
    JSON.stringify(
      {
        ...fixture,
        ...received,
        received,
        accepted,
        bindings,
        mappedPreparation: { stage: 'received' },
      },
      null,
      2
    )
  );
  await capture('03-three-genuine-primer-stocks-with-explicit-unknown-quantity', received);
  const active = bindings.find((binding) => binding.sourceId === 'MP001');
  await page
    .getByTestId('inventory-stock-table')
    .locator(`[data-stock-id="${active.stockId}"]`)
    .click();
  await button(page, 'Record quantity').click();
  const measure = dialog(page, 'Record quantity');
  await choose(measure, 'Quantity measurement', 'Measured quantity');
  await measure.getByLabel('Quantity', { exact: true }).fill('10');
  await measure
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic later measurement separate from source unknown quantity');
  await button(measure, 'Record quantity').click();
  await expect(measure).toBeHidden();
  await button(page, 'Use stock').click();
  const use = dialog(page, 'Use stock');
  await use.getByLabel('Quantity', { exact: true }).fill('2');
  await use
    .getByLabel('Reason', { exact: true })
    .fill('Later use must survive mapped spreadsheet reimport');
  await button(use, 'Use stock').click();
  await expect(use).toBeHidden();
  await closeDrawer(page);
  const afterUse = await inventoryRead(scope);
  assert.deepEqual(afterUse.state.stocks[active.stockId].quantity, {
    kind: 'known',
    value: '8',
    unit: 'uL',
  });
  const lines = sourceText.trimEnd().split('\n');
  const reordered = [lines[0], ...lines.slice(1).reverse()].join('\n') + '\n';
  form = await mappedDraft(ctx, fixture, reordered);
  await expect(form.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(scope), afterUse);
  await form.getByTestId('inventory-mapped-preview').scrollIntoViewIfNeeded();
  await capture('04-reordered-mapped-source-keeps-later-measurement-and-use', afterUse);
  await button(form, 'Cancel').click();
  form = await mappedDraft(
    ctx,
    fixture,
    sourceText.replace('M13 forward control', 'Revised source note only')
  );
  await expect(form.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  await expect(form).toContainText('No new source file or receipt is saved');
  assert.deepEqual(await inventoryRead(scope), afterUse);
  await form.getByTestId('inventory-mapped-preview').scrollIntoViewIfNeeded();
  await capture('05-evidence-only-edit-discloses-no-new-source-or-physical-operation', afterUse);
  await button(form, 'Cancel').click();
  await button(page.getByTestId('inventory-panel').locator('header'), 'History').click();
  const drawer = page.getByTestId('inventory-detail-drawer');
  const history = drawer
    .getByTestId('inventory-history')
    .locator(`[data-operation-id="${accepted.receipt.operationId}"]`);
  await expect(history).toContainText('Received mapped spreadsheet');
  await history.locator('summary').click();
  assert.equal(
    await history.getByLabel('Retained original spreadsheet', { exact: true }).inputValue(),
    sourceText
  );
  await capture('06-complete-thirteen-column-source-retained-with-native-receipt', { accepted });
  await closeDrawer(page);
  const artifact = await page.evaluate(
    (scope) => window.electronAPI.inventory.exportSnapshot({ ...scope, format: 'native-v1' }),
    scope
  );
  writeFileSync(
    path.join(evidenceDirectory, 'mapped-inventory.dnaforge-inventory.json'),
    artifact.sourceText
  );
  return {
    ...fixture,
    ...afterUse,
    received,
    accepted,
    bindings,
    active,
    reordered,
    artifact,
    nativeDialogQualified: false,
  };
}

export async function runInventoryMappedResume(ctx) {
  assert.equal(ctx.fixture.mappedPreparation.stage, 'prepared');
  assert.deepEqual(await ctx.inventoryRead(ctx.fixture.scope), ctx.fixture.prepared);
  return finishInventoryMappedJourney(ctx, ctx.fixture);
}

export async function runInventoryMappedReopen(ctx) {
  const { page, expect, fixture, inventoryRead, capture } = ctx;
  const current = await inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  const artifact = await page.evaluate(
    (scope) => window.electronAPI.inventory.exportSnapshot({ ...scope, format: 'native-v1' }),
    fixture.scope
  );
  assert.equal(artifact.sourceText, fixture.artifact.sourceText);
  for (const file of fixture.scientificFiles)
    assert.equal(hash(readFileSync(file.path)), file.sha256);
  await capture('07-reopened-scientific-files-physical-bindings-and-original-source', current);
  const form = await mappedDraft(ctx, fixture, fixture.reordered);
  await expect(form.getByTestId('inventory-mapped-import')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  assert.deepEqual(await inventoryRead(fixture.scope), current);
  await form.getByTestId('inventory-mapped-preview').scrollIntoViewIfNeeded();
  await capture('08-reopened-mapped-source-does-not-reset-physical-quantity', current);
  await button(form, 'Cancel').click();
  return { ...fixture, ...current, artifact };
}

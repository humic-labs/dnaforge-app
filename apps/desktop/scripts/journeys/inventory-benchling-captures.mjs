import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function rawInventories(userDataPath) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
states=db.execute('SELECT inventory_id,project_id,revision,state_json FROM inventory_state ORDER BY inventory_id').fetchall()
journal=db.execute('SELECT inventory_id,operation_id,revision,request_json,receipt_json FROM inventory_journal ORDER BY inventory_id,revision').fetchall()
print(json.dumps({'states':states,'journal':journal}))
db.close()
`,
        path.join(userDataPath, 'dnaforge.db'),
      ],
      { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }
    )
  );
}

export async function runInventoryBenchlingCaptureJourney(ctx) {
  const {
    page,
    expect,
    fixture,
    inventoryRead,
    capture,
    evidenceDirectory,
    projectRoot,
    userDataPath,
  } = ctx;
  const { project, scope } = fixture;
  assert.equal(scope.project, project.projectId);
  assert.equal(scope.inventoryId, project.defaultInventoryId);
  const initial = await inventoryRead(scope);
  assert.deepEqual(initial.state, fixture.state);
  assert.deepEqual(initial.history, fixture.history);
  const rawBefore = rawInventories(userDataPath);
  const sourceText = readFileSync(
    path.join(
      projectRoot,
      'test-fixtures/lims-import/benchling-physical/representative-capture.json'
    ),
    'utf8'
  );
  const wrapper = JSON.parse(sourceText);
  writeFileSync(path.join(evidenceDirectory, 'original-benchling-capture.json'), sourceText);
  writeFileSync(
    path.join(evidenceDirectory, 'inventory-raw-before.json'),
    JSON.stringify(rawBefore)
  );
  const drawerClose = button(page, 'Close stock details');
  if (await drawerClose.isVisible()) await drawerClose.click();
  await capture('01-before-read-only-capture-inspection', {
    scope,
    revision: initial.state.revision,
    allInventoryBytesSha256: hash(JSON.stringify(rawBefore)),
  });
  await button(
    page.getByTestId('inventory-panel').locator('header'),
    'Inspect Benchling capture'
  ).click();
  const form = page.getByRole('dialog', { name: 'Inspect Benchling capture', exact: true });
  await expect(form.getByText(/changes no inventory/)).toBeVisible();
  await expect(form.getByText(/do not change local custody/)).toBeVisible();
  assert.equal(await form.getByRole('button', { name: /apply|receive|import/i }).count(), 0);
  const sourceInput = form.getByLabel('Benchling capture text', { exact: true });
  async function inspect(text, kind) {
    await sourceInput.fill(text);
    await expect(form.getByTestId('inventory-benchling-inspection')).toHaveCount(0);
    await button(form, 'Inspect capture').click();
    await expect(form.getByTestId('inventory-benchling-capture')).toHaveAttribute(
      'data-inspection-state',
      kind
    );
  }
  await inspect('{"format":"one","format":"two"}', 'blocked');
  await expect(form.getByTestId('inventory-benchling-issues')).toContainText(/duplicate/i);
  await form.getByTestId('inventory-benchling-issues').scrollIntoViewIfNeeded();
  await capture('02-duplicate-key-capture-refused-without-import', initial);

  await inspect(sourceText, 'inspected');
  const inspected = await page.evaluate(
    (input) => window.electronAPI.inventory.inspectBenchlingCapture(input),
    { ...scope, sourceText }
  );
  assert.equal(inspected.kind, 'inspected');
  assert.equal(inspected.sourceSha256, hash(sourceText));
  assert.equal(inspected.capture.scope.kind, 'selected-records');
  assert.equal(inspected.target.projectId, project.projectId);
  assert.equal(inspected.target.inventoryId, scope.inventoryId);
  assert.equal(inspected.target.revision, initial.state.revision);
  await expect(form.getByTestId('inventory-benchling-inspection')).toHaveAttribute(
    'data-source-sha256',
    inspected.sourceSha256
  );
  await expect(form.getByTestId('inventory-benchling-source-scope')).toContainText(
    'selected-records'
  );
  await expect(form.getByTestId('inventory-benchling-pagination')).toContainText('linked');
  await form.getByTestId('inventory-benchling-source-scope').scrollIntoViewIfNeeded();
  await capture('03-selected-v2-scope-and-explicit-interpretation-gaps', {
    target: inspected.target,
    scope: inspected.capture.scope,
    sourceSha256: inspected.sourceSha256,
    recordCount: inspected.records.length,
    issues: inspected.issues,
  });

  async function record(sourceId) {
    const target = form
      .getByTestId('inventory-benchling-records')
      .locator(`[data-source-id="${sourceId}"]`);
    await target.locator(':scope > summary').click();
    return target;
  }
  const counted = await record('con_count');
  await expect(counted.locator('[data-source-field="quantity"]')).toContainText('9007199254740993');
  await expect(counted.locator('[data-source-field="quantity"]')).toContainText('cells');
  await expect(counted.locator('[data-source-field="volume"]')).toContainText('mg');
  await counted.locator('[data-source-field="quantity"]').scrollIntoViewIfNeeded();
  await capture('04-exact-unsafe-count-and-deprecated-nonvolume-evidence', {
    record: inspected.records.find((item) => item.sourceId === 'con_count'),
  });
  const conflicted = await record('con_filled');
  await expect(conflicted.locator('[data-source-field="quantity"]')).toContainText(
    'Conflicting observations'
  );
  await expect(conflicted.locator('[data-source-field="quantity"]')).toContainText('10.2500');
  await expect(conflicted.locator('[data-source-field="quantity"]')).toContainText('11.5');
  await conflicted.locator('[data-source-field="quantity"]').scrollIntoViewIfNeeded();
  await capture('05-conflicting-quantity-observations-retained', {
    record: inspected.records.find((item) => item.sourceId === 'con_filled'),
  });
  await expect(conflicted.locator('[data-source-field="checkoutRecord"]')).toContainText(
    'usr_foreign'
  );
  await conflicted.locator('[data-source-field="checkoutRecord"]').scrollIntoViewIfNeeded();
  await capture('06-foreign-custody-and-restrictions-remain-source-evidence', {
    localInventoryUnchanged: await inventoryRead(scope),
  });
  const missing = await record('con_missing');
  await expect(missing.locator('[data-source-field="parentStorageId"]')).toContainText('Omitted');
  await expect(missing.locator('[data-source-field="contents"]')).toContainText('Omitted');
  await missing.locator('[data-source-field="parentStorageId"]').scrollIntoViewIfNeeded();
  await capture('07-missing-parent-and-contents-remain-omitted', {
    record: inspected.records.find((item) => item.sourceId === 'con_missing'),
  });
  for (const [sourceId, field, values] of [
    ['con_empty', 'contents', ['[]']],
    ['con_well_zero', 'quantity', ['"value":0']],
    ['con_matrix_tube', 'quantity', ['"value":null']],
    ['con_multiple', 'contents', ['seq_A', 'seq_B']],
    ['loc_freezer', 'parentStorageId', ['Explicit null']],
  ]) {
    const sourceRecord = await record(sourceId);
    const sourceField = sourceRecord.locator(`[data-source-field="${field}"]`);
    for (const value of values) await expect(sourceField).toContainText(value);
    await sourceField.scrollIntoViewIfNeeded();
    await capture(`08-${sourceId}-explicit-source-${field}`, {
      record: inspected.records.find((item) => item.sourceId === sourceId),
    });
  }
  for (const [sourceId, expectedType] of [
    ['plt_fixed', 'well_plate'],
    ['plt_matrix', 'matrix_plate'],
  ]) {
    const plate = await record(sourceId);
    await expect(plate.locator('[data-source-field="type"]')).toContainText(expectedType);
    await plate.locator('[data-source-field="type"]').scrollIntoViewIfNeeded();
    await capture(`08-${sourceId}-source-plate-type`, {
      record: inspected.records.find((item) => item.sourceId === sourceId),
    });
  }
  const responses = form.getByTestId('inventory-benchling-responses');
  await responses.locator(':scope > summary').click();
  const response = responses.locator('[data-response-id="box-page-2"]');
  await response.locator(':scope > summary').click();
  await expect(response.getByTestId('inventory-benchling-number-tokens')).toContainText(
    '1.2300e+2'
  );
  await expect(response.getByTestId('inventory-benchling-number-tokens')).toContainText(
    '9007199254740993'
  );
  assert.equal(
    await response.getByLabel('Original response box-page-2', { exact: true }).inputValue(),
    wrapper.responses.find((item) => item.id === 'box-page-2').bodyText
  );
  await response.getByTestId('inventory-benchling-number-tokens').scrollIntoViewIfNeeded();
  await capture('09-original-number-lexemes-and-response-body', {
    response: inspected.capture.responses.find((item) => item.id === 'box-page-2'),
  });
  const partialSource = JSON.stringify({
    ...wrapper,
    responses: wrapper.responses.filter((item) => item.id !== 'box-page-2'),
  });
  await inspect(partialSource, 'inspected');
  await expect(form.getByTestId('inventory-benchling-pagination')).toContainText('incomplete');
  await form.getByTestId('inventory-benchling-pagination').scrollIntoViewIfNeeded();
  await capture('10-missing-linked-page-disclosed', { removedResponseId: 'box-page-2' });
  await sourceInput.fill(sourceText);
  await expect(form.getByTestId('inventory-benchling-inspection')).toHaveCount(0);
  await capture('11-source-edit-invalidates-retained-inspection', {
    sourceSha256: hash(sourceText),
  });
  await button(form, 'Inspect capture').click();
  await expect(form.getByTestId('inventory-benchling-capture')).toHaveAttribute(
    'data-inspection-state',
    'inspected'
  );
  const after = await inventoryRead(scope);
  const rawAfter = rawInventories(userDataPath);
  assert.deepEqual(after, initial);
  assert.deepEqual(rawAfter, rawBefore);
  writeFileSync(path.join(evidenceDirectory, 'inventory-raw-after.json'), JSON.stringify(rawAfter));
  writeFileSync(
    path.join(evidenceDirectory, 'native-capture-inspection.json'),
    JSON.stringify(inspected, null, 2)
  );
  await form.getByTestId('inventory-benchling-field-summary').scrollIntoViewIfNeeded();
  await capture('12-read-only-inspection-preserves-all-inventory-bytes', {
    scope,
    revision: after.state.revision,
    historyEntries: after.history.length,
    allInventoryBytesSha256: hash(JSON.stringify(rawAfter)),
    originalStateAndJournalUnchanged: true,
  });
  await button(form, 'Close').click();
  await expect(form).toBeHidden();
  return {
    project,
    scope,
    ...after,
    sourceSha256: inspected.sourceSha256,
    readOnlyInspection: true,
  };
}

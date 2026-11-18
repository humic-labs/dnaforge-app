import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true }),
  field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
async function dismiss(ctx) {
  if (await ctx.page.locator('[role="dialog"]:visible').count()) return;
  const toast = ctx.page.locator('[data-toast-definition="dev-registry-seed"]');
  if (await button(toast, 'Not now').isVisible()) await button(toast, 'Not now').click();
}
async function closeEditors(ctx) {
  const editor = ctx.page.locator(
    '[data-testid="protocol-declarations-editor"], [data-testid="run-recorded-values-editor"]'
  );
  if (await editor.isVisible()) await button(editor, 'Close value editor').click();
  const creation = ctx.page.getByTestId('scientific-creation-form');
  if (await creation.isVisible()) await button(creation, 'Cancel').click();
}
async function openPackage(ctx, saved) {
  await closeEditors(ctx);
  await dismiss(ctx);
  const project = ctx.page.locator(
    `[role="treeitem"][data-entry-path="${ctx.fixture.project.path}"]`
  );
  if (!(await project.isVisible())) await ctx.page.getByTestId('files-button').click();
  await ctx.expect(project).toBeVisible();
  await ctx.page
    .locator(`[data-entry-path="${saved.path.replace(/\/.forge\/protocol(?:-run)?\.json$/u, '')}"]`)
    .dblclick();
  const view = ctx.page.getByTestId('scientific-document-tab');
  await ctx.expect(field(view, 'Document title')).toHaveValue(saved.title);
  return view;
}
async function newProtocol(ctx) {
  await closeEditors(ctx);
  await dismiss(ctx);
  const project = ctx.page.locator(
    `[role="treeitem"][data-entry-path="${ctx.fixture.project.path}"]`
  );
  if (!(await project.isVisible())) await ctx.page.getByTestId('files-button').click();
  await ctx.expect(project).toBeVisible();
  await project.click({ button: 'right' });
  await ctx.page.getByRole('menuitem', { name: 'New…', exact: true }).hover();
  await ctx.page.getByRole('menuitem', { name: 'Protocol', exact: true }).click();
  await ctx.page
    .getByRole('menu', { name: 'Protocol actions', exact: true })
    .getByRole('menuitem', { name: 'Create', exact: true })
    .click();
  return ctx.page.getByTestId('scientific-creation-form');
}
async function run(ctx, reopen) {
  const { page, expect, fixture, evidenceDirectory } = ctx;
  const initial = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(initial.state, fixture.state);
  assert.deepEqual(initial.history, fixture.history);
  assert.equal(initial.state.revision, 99);
  let proof = fixture.runValuesJourney;
  if (!proof) {
    const tag = randomUUID().slice(0, 8);
    proof = {
      completedStep: 0,
      protocolTitle: `Typed declarations ${tag}`,
      runTitle: `Typed values run ${tag}`,
      inputLabel: 'Sample name',
      outputLabel: 'Result count',
      laterOutputLabel: 'Result count after template edit',
      measurementLabel: 'Visual finding',
      dateLabel: 'Reference time',
      dateValue: '2026-01-02T03:04:05.000Z',
      reasonDeclarations: `Declare input and output ${tag}`,
      reasonValues: `Record ordinary synthetic values ${tag}`,
      reasonLater: `Revise template label after run ${tag}`,
    };
  }
  function checkpoint(name) {
    const saved = { ...fixture, ...initial, runValuesJourney: proof, resumePhase: 'run-values' };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-run-values-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  }
  async function unchanged() {
    assert.deepEqual(await ctx.inventoryRead(fixture.scope), initial);
  }
  async function capture(name, target) {
    if (target) {
      await target.scrollIntoViewIfNeeded();
      await target.screenshot({ path: path.join(evidenceDirectory, `${name}-detail.png`) });
    }
    await ctx.capture(name, { ...initial, proof });
  }
  async function accepted(request, key, step) {
    let result;
    await expect
      .poll(async () => {
        result = await page.evaluate(
          (input) => window.electronAPI.protocols.inspectCreation(input),
          { project: request.project, requestId: request.requestId }
        );
        return result.kind;
      })
      .toBe('ready');
    proof = { ...proof, [key]: result.package, completedStep: step };
    checkpoint(`0${step}-accepted-before-assertions`);
    await unchanged();
    return result.package;
  }
  async function checkExisting(request, key, step) {
    if (!request || proof.completedStep >= step) return;
    const result = await page.evaluate(
      (input) => window.electronAPI.protocols.inspectCreation(input),
      { project: request.project, requestId: request.requestId }
    );
    if (result.kind === 'ready') {
      proof = { ...proof, [key]: result.package, completedStep: step };
      checkpoint(`0${step}-original-operation-reconciled-before-assertions`);
    }
  }
  checkpoint('00-current-inventory');
  for (const [request, key, step] of [
    [proof.createRequest, 'protocol', 1],
    [proof.declarationsRequest, 'declaredProtocol', 2],
    [proof.startRequest, 'run', 3],
    [proof.valuesRequest, 'valuedRun', 4],
    [proof.laterRequest, 'editedProtocol', 5],
  ])
    await checkExisting(request, key, step);
  if (reopen) assert.equal(proof.completedStep, 5);
  async function creationRequest(form, key) {
    await form.getByText('Prepared request details', { exact: true }).click();
    const request = JSON.parse(
      await field(form, 'Prepared scientific creation request').inputValue()
    );
    if (proof[key])
      assert.deepEqual(
        request,
        proof[key],
        'An original creation request must be resumed, never replaced.'
      );
    proof = { ...proof, [key]: request };
    checkpoint(`00-${key}-before-submit`);
    return request;
  }
  async function purposeRequest(editor, key) {
    await button(editor, 'Preview value changes').click();
    await expect(editor).toHaveAttribute('data-edit-phase', 'prepared');
    await editor.getByText('Prepared save request', { exact: true }).click();
    const request = JSON.parse(
      await field(editor, 'Prepared scientific value request').inputValue()
    );
    if (proof[key])
      assert.deepEqual(
        request,
        proof[key],
        'An original typed request must be resumed, never replaced.'
      );
    proof = { ...proof, [key]: request };
    checkpoint(`00-${key}-before-submit`);
    return request;
  }
  async function livePrepared(testId, requestKey) {
    if (!proof[requestKey]) return null;
    const editor = page.getByTestId(testId);
    assert.ok(
      await editor.isVisible(),
      'The original prepared editor must remain open; do not replace its request or row keys.'
    );
    await expect(editor).toHaveAttribute('data-edit-phase', 'prepared');
    const request = JSON.parse(
      await field(editor, 'Prepared scientific value request').inputValue()
    );
    assert.deepEqual(
      request,
      proof[requestKey],
      'Resume must use the exact live prepared request.'
    );
    return editor;
  }
  if (proof.completedStep < 1) {
    const form = await newProtocol(ctx);
    if (await button(form, 'Check original operation').isVisible()) {
      await button(form, 'Check original operation').click();
      if (await button(form, 'Retry same operation').isVisible())
        await button(form, 'Retry same operation').click();
    } else {
      await field(form, 'Protocol title').fill(proof.protocolTitle);
      const request = await creationRequest(form, 'createRequest');
      await button(form, 'Create protocol').click();
      await accepted(request, 'protocol', 1);
    }
    if (proof.completedStep < 1) await accepted(proof.createRequest, 'protocol', 1);
  }
  if (proof.completedStep < 2) {
    let editor = await livePrepared('protocol-declarations-editor', 'declarationsRequest');
    let request = proof.declarationsRequest;
    if (!editor) {
      const view = await openPackage(ctx, proof.protocol);
      await button(view, 'Edit input and output declarations').click();
      editor = page.getByTestId('protocol-declarations-editor');
      await button(editor, 'Add input declaration').click();
      let row = editor.locator('[data-slot-collection="inputs"][data-slot-key]');
      await field(row, 'Label').fill(proof.inputLabel);
      await row.getByRole('checkbox', { name: 'Required', exact: true }).check();
      await button(editor, 'Add output declaration').click();
      row = editor.locator('[data-slot-collection="outputs"][data-slot-key]');
      await field(row, 'Label').fill(proof.outputLabel);
      await ctx.choose(row, 'Type', 'Number');
      await field(editor, 'Reason for save').fill(proof.reasonDeclarations);
      await expect(button(view, 'Start run')).toBeDisabled();
      request = await purposeRequest(editor, 'declarationsRequest');
    }
    proof = {
      ...proof,
      inputKey: request.choices.upserts.find((row) => row.direction === 'inputs').key,
      outputKey: request.choices.upserts.find((row) => row.direction === 'outputs').key,
    };
    checkpoint('00-declaration-keys-before-save');
    await capture(
      '01-proposed-explicit-declarations',
      editor.getByTestId('scientific-value-edit-preview')
    );
    await button(editor, 'Save declarations').click();
    await accepted(request, 'declaredProtocol', 2);
    await expect(editor).toBeHidden();
  }
  const protocolBody = JSON.parse(proof.declaredProtocol.originalText);
  assert.deepEqual(
    protocolBody.inputs.map((row) => [row.key, row.label, row.required, row.valueType.kind]),
    [[proof.inputKey, proof.inputLabel, true, 'text']]
  );
  assert.deepEqual(
    protocolBody.outputs.map((row) => [row.key, row.label, row.valueType.kind]),
    [[proof.outputKey, proof.outputLabel, 'number']]
  );
  if (proof.completedStep < 3) {
    const view = await openPackage(ctx, proof.declaredProtocol);
    await expect(button(view, 'Start run')).toBeEnabled();
    await button(view, 'Start run').click();
    const form = page.getByTestId('scientific-creation-form');
    await field(form, 'Run title').fill(proof.runTitle);
    const request = await creationRequest(form, 'startRequest');
    await button(form, 'Start run').click();
    await accepted(request, 'run', 3);
  }
  const originalRun = JSON.parse(proof.run.originalText);
  assert.deepEqual(originalRun.inputs, []);
  assert.deepEqual(originalRun.outputs, []);
  assert.deepEqual(originalRun.measurements, []);
  assert.equal(originalRun.frozenProtocol.source.originalText, proof.declaredProtocol.originalText);
  assert.equal(originalRun.frozenProtocol.source.sourceSha256, proof.declaredProtocol.sourceSha256);
  if (proof.completedStep < 4) {
    let editor = await livePrepared('run-recorded-values-editor', 'valuesRequest');
    let request = proof.valuesRequest;
    if (!editor) {
      const view = await openPackage(ctx, proof.run);
      await button(view, 'Edit recorded values').click();
      editor = page.getByTestId('run-recorded-values-editor');
      await expect(editor.locator(`[data-missing-slot-key="${proof.inputKey}"]`)).toContainText(
        'Not recorded'
      );
      await button(
        editor.locator(`[data-missing-slot-key="${proof.inputKey}"]`),
        'Record value'
      ).click();
      await field(editor.locator(`[data-slot-key="${proof.inputKey}"]`), 'Value').fill(
        'Synthetic sample'
      );
      await button(
        editor.locator(`[data-missing-slot-key="${proof.outputKey}"]`),
        'Record value'
      ).click();
      await field(editor.locator(`[data-slot-key="${proof.outputKey}"]`), 'Value').fill('0');
      await button(editor, 'Add measurement').click();
      let row = editor.locator('[data-slot-collection="measurements"][data-slot-key]').nth(0);
      await field(row, 'Label').fill(proof.measurementLabel);
      await ctx.choose(row, 'Type', 'Yes or no');
      await field(editor, 'Reason for save').fill(proof.reasonValues);
      await button(editor, 'Preview value changes').click();
      await expect(button(editor, 'Save recorded values')).toBeDisabled();
      await expect(editor).toContainText('Choose Yes or No');
      await ctx.choose(row, 'Value', 'No');
      await button(editor, 'Add measurement').click();
      row = editor.locator('[data-slot-collection="measurements"][data-slot-key]').nth(1);
      await field(row, 'Label').fill(proof.dateLabel);
      await ctx.choose(row, 'Type', 'Date and time');
      await field(row, 'Date and time (UTC)').fill('2026-02-30T03:04:05.000Z');
      await button(editor, 'Preview value changes').click();
      await expect(button(editor, 'Save recorded values')).toBeDisabled();
      await expect(editor).toContainText('Enter an exact UTC timestamp');
      await field(row, 'Date and time (UTC)').fill(proof.dateValue);
      request = await purposeRequest(editor, 'valuesRequest');
    }
    assert.equal(request.choices.upserts.length, 4);
    proof = {
      ...proof,
      measurementKey: request.choices.upserts.find((row) => row.value.type === 'boolean').key,
      dateKey: request.choices.upserts.find((row) => row.value.type === 'date').key,
    };
    checkpoint('00-four-typed-values-before-save');
    await capture(
      '02-valid-explicit-text-zero-false-and-date-draft',
      editor.getByTestId('scientific-value-edit-preview')
    );
    await button(editor, 'Save recorded values').click();
    await accepted(request, 'valuedRun', 4);
    await expect(editor).toBeHidden();
  }
  const savedRun = JSON.parse(proof.valuedRun.originalText);
  assert.deepEqual(
    savedRun.inputs.map((row) => [row.key, row.value]),
    [[proof.inputKey, { type: 'text', value: 'Synthetic sample' }]]
  );
  assert.deepEqual(
    savedRun.outputs.map((row) => [row.key, row.value]),
    [[proof.outputKey, { type: 'number', value: 0 }]]
  );
  assert.equal(savedRun.measurements.length, 2);
  assert.deepEqual(savedRun.measurements.find((row) => row.key === proof.measurementKey).value, {
    type: 'boolean',
    value: false,
  });
  assert.deepEqual(savedRun.measurements.find((row) => row.key === proof.dateKey).value, {
    type: 'date',
    value: proof.dateValue,
  });
  for (const row of savedRun.measurements)
    assert.equal(new Date(row.recordedAt).toISOString(), row.recordedAt);
  assert.deepEqual(savedRun.frozenProtocol, originalRun.frozenProtocol);
  assert.equal(savedRun.status, 'in_progress');
  if (proof.completedStep < 5) {
    let editor = await livePrepared('protocol-declarations-editor', 'laterRequest');
    let request = proof.laterRequest;
    if (!editor) {
      const view = await openPackage(ctx, proof.declaredProtocol);
      await button(view, 'Edit input and output declarations').click();
      editor = page.getByTestId('protocol-declarations-editor');
      await button(
        editor.locator(`[data-saved-slot-key="${proof.outputKey}"]`),
        'Edit declaration'
      ).click();
      await field(editor.locator(`[data-slot-key="${proof.outputKey}"]`), 'Label').fill(
        proof.laterOutputLabel
      );
      await field(editor, 'Reason for save').fill(proof.reasonLater);
      request = await purposeRequest(editor, 'laterRequest');
    }
    assert.equal(request.choices.upserts.length, 1);
    assert.equal(request.choices.upserts[0].key, proof.outputKey);
    await button(editor, 'Save declarations').click();
    await accepted(request, 'editedProtocol', 5);
    await expect(editor).toBeHidden();
  }
  const currentRun = await page.evaluate(
      (input) => window.electronAPI.protocols.readPackage(input),
      { project: fixture.scope.project, entityId: proof.run.entityId }
    ),
    currentProtocol = await page.evaluate(
      (input) => window.electronAPI.protocols.readPackage(input),
      { project: fixture.scope.project, entityId: proof.protocol.entityId }
    );
  assert.equal(currentRun.originalText, proof.valuedRun.originalText);
  assert.equal(currentProtocol.originalText, proof.editedProtocol.originalText);
  assert.equal(JSON.parse(currentProtocol.originalText).outputs[0].label, proof.laterOutputLabel);
  assert.equal(
    JSON.parse(currentRun.originalText).frozenProtocol.source.originalText,
    proof.declaredProtocol.originalText
  );
  await unchanged();
  const view = await openPackage(ctx, currentRun);
  await button(view, 'Edit recorded values').click();
  const editor = page.getByTestId('run-recorded-values-editor');
  await expect(editor.locator(`[data-saved-slot-key="${proof.outputKey}"]`)).toContainText('0');
  await expect(editor.locator(`[data-saved-slot-key="${proof.measurementKey}"]`)).toContainText(
    'No'
  );
  await expect(editor.locator(`[data-saved-slot-key="${proof.dateKey}"]`)).toContainText(
    proof.dateValue
  );
  await expect(editor.locator(`[data-saved-slot-key="${proof.inputKey}"]`)).toContainText(
    'Synthetic sample'
  );
  await capture(
    reopen
      ? '04-restarted-explicit-values-and-original-frozen-declarations'
      : '03-saved-values-after-later-template-label-edit',
    editor
  );
  const savedBoolean = editor.locator(`[data-saved-slot-key="${proof.measurementKey}"]`);
  await savedBoolean.scrollIntoViewIfNeeded();
  await expect(savedBoolean.getByText('No', { exact: true })).toBeVisible();
  await capture('04-saved-boolean-no-visible', savedBoolean);
  const savedDate = editor.locator(`[data-saved-slot-key="${proof.dateKey}"]`);
  await savedDate.scrollIntoViewIfNeeded();
  await expect(savedDate.getByText(proof.dateValue, { exact: true })).toBeVisible();
  await capture('05-saved-canonical-date-visible', savedDate);
  await button(editor, 'Close value editor').click();
  await unchanged();
  const final = checkpoint('06-complete');
  writeFileSync(
    path.join(evidenceDirectory, 'run-values-reopen-fixture.json'),
    JSON.stringify(final, null, 2)
  );
  return {
    inventoryRevision: 99,
    inventoryHistoryUnchanged: true,
    protocolId: proof.protocol.entityId,
    runId: proof.run.entityId,
    typedKinds: ['text', 'number', 'boolean', 'date'],
    measurementCount: 2,
    zeroAndFalsePreserved: true,
    frozenDeclarationsPreserved: true,
  };
}
export const runInventoryRunValues = (ctx) => run(ctx, false);
export const runInventoryRunValuesResume = (ctx) => run(ctx, false);
export const runInventoryRunValuesReopen = (ctx) => run(ctx, true);

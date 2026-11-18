import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
async function run(ctx, reopen) {
  const { page, expect, fixture, evidenceDirectory } = ctx;
  let current = await ctx.inventoryRead(fixture.scope),
    proof = fixture.runValueAttributionJourney,
    reconciled = false;
  const values = fixture.runValuesJourney,
    originalRun = values.valuedRun,
    outputKey = values.outputKey;
  assert.equal(values.completedStep, 5);
  if (!proof) {
    const { schema, runValueAttributions, runValueAttributionWithdrawals, ...old } = current.state,
      {
        schema: oldSchema,
        runValueAttributions: oldAssociations,
        runValueAttributionWithdrawals: oldWithdrawals,
        ...prior
      } = fixture.state;
    assert.equal(schema, 'dnaforge.inventory.v28');
    assert.deepEqual(old, prior);
    assert.deepEqual(current.history, fixture.history);
    assert.deepEqual(runValueAttributions, {});
    assert.deepEqual(runValueAttributionWithdrawals, {});
    if (oldAssociations) assert.deepEqual(oldAssociations, {});
    if (oldWithdrawals) assert.deepEqual(oldWithdrawals, {});
    assert.equal(current.state.revision, 99);
    const observation = fixture.platePlanObservationJourney.observation,
      output = observation.effects.destinations.find(
        (row) => row.vessel.placement.kind === 'located' && row.vessel.placement.slotId === 'A3'
      );
    assert.ok(output);
    assert.equal(output.after.quantity.value, '4');
    assert.equal(output.after.quantity.unit, 'uL');
    const tag = randomUUID().slice(0, 8);
    proof = {
      completedStep: 0,
      initialRevision: 99,
      baselineState: current.state,
      baselineHistory: current.history,
      originalRun,
      observationId: observation.id,
      physical: {
        observationId: observation.id,
        observationIntentSha256: observation.intentSha256,
        subject: { kind: 'output-action', actionId: output.actionId, stockId: output.after.id },
      },
      reasonBase: `Saved result describes the earlier recorded A3 aliquot ${tag}`,
      reasonChanged: `Revise saved numeric result ${tag}`,
      reasonWithdraw: `Withdraw the earlier value association ${tag}`,
      reasonRestored: `Restore saved numeric value ${tag}`,
      reasonChild: `Explicitly associate the restored saved value ${tag}`,
    };
  }
  function checkpoint(name) {
    const saved = {
      ...fixture,
      ...current,
      runValueAttributionJourney: proof,
      resumePhase: 'run-value-attributions',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-run-value-attributions-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  }
  async function capture(name, target) {
    if (target) {
      await target.scrollIntoViewIfNeeded();
      await target.screenshot({ path: path.join(evidenceDirectory, `${name}-detail.png`) });
    }
    await ctx.capture(name, { ...current, proof });
  }
  async function dismiss() {
    if (await page.locator('[role="dialog"]:visible').count()) return;
    const toast = page.locator('[data-toast-definition="dev-registry-seed"]');
    if (await button(toast, 'Not now').isVisible()) await button(toast, 'Not now').click();
  }
  async function closeDialogs() {
    if (await page.getByRole('option').count()) await page.keyboard.press('Escape');
    const form = page.getByTestId('run-value-attribution-form');
    if (await form.isVisible()) await button(form, 'Close association editor').click();
    const editor = page.getByTestId('run-recorded-values-editor');
    if (await editor.isVisible()) await button(editor, 'Close value editor').click();
    const history = page.getByTestId('inventory-saved-value-associations');
    if (await history.isVisible()) await button(history, 'Close saved value associations').click();
    await dismiss();
  }
  async function openRun() {
    await closeDialogs();
    const project = page.locator(`[role="treeitem"][data-entry-path="${fixture.project.path}"]`);
    if (!(await project.isVisible())) await page.getByTestId('files-button').click();
    await expect(project).toBeVisible();
    await page
      .locator(
        `[data-entry-path="${originalRun.path.replace(/\/.forge\/protocol-run\.json$/u, '')}"]`
      )
      .dblclick();
    const view = page.getByTestId('scientific-document-tab');
    await expect(field(view, 'Document title')).toHaveValue(originalRun.title);
    return view;
  }
  async function scopeView() {
    const view = await openRun();
    const section = view.getByTestId('run-value-associations');
    await expect(section).toHaveAttribute('data-run-id', originalRun.entityId);
    return section;
  }
  function physicalUnchanged() {
    const {
        schema,
        revision,
        lastRecordedAt,
        runValueAttributions,
        runValueAttributionWithdrawals,
        ...rest
      } = current.state,
      {
        schema: oldSchema,
        revision: oldRevision,
        lastRecordedAt: oldAt,
        runValueAttributions: oldAssociations,
        runValueAttributionWithdrawals: oldWithdrawals,
        ...old
      } = proof.baselineState;
    assert.deepEqual(rest, old);
    assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  }
  async function unchanged() {
    assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
  }
  function savedMeta(key, step) {
    if (key === 'withdrawRequest') {
      const withdrawal = Object.values(current.state.runValueAttributionWithdrawals).find(
        (row) => row.identity.withdrawalId === proof[key].choices.identity.withdrawalId
      );
      assert.ok(withdrawal);
      proof = { ...proof, withdrawal, completedStep: step };
    } else {
      const record = Object.values(current.state.runValueAttributions).find(
        (row) => row.identity.attributionId === proof[key].choices.identity.attributionId
      );
      assert.ok(record);
      proof = { ...proof, [key === 'baseRequest' ? 'base' : 'child']: record, completedStep: step };
    }
  }
  async function acceptedMeta(key, step) {
    const request = proof[key];
    await expect
      .poll(async () => {
        const receipt = await page.evaluate(
          (input) => window.electronAPI.inventory.operation(input),
          { ...fixture.scope, operationId: request.operationId }
        );
        return receipt?.status ?? 'missing';
      })
      .toBe('committed');
    current = await ctx.inventoryRead(fixture.scope);
    proof = { ...proof, acceptedOperationId: request.operationId };
    checkpoint(`0${step}-native-accepted-before-record-lookup`);
    savedMeta(key, step);
    checkpoint(`0${step}-accepted-before-assertions`);
    physicalUnchanged();
    assert.equal(current.state.revision, request.expectedRevision + 1);
  }
  async function acceptedFile(key, snapshotKey, step) {
    let result;
    await expect
      .poll(async () => {
        result = await page.evaluate(
          (input) => window.electronAPI.protocols.inspectCreation(input),
          { project: proof[key].project, requestId: proof[key].requestId }
        );
        return result.kind;
      })
      .toBe('ready');
    proof = { ...proof, [snapshotKey]: result.package, completedStep: step };
    checkpoint(`0${step}-file-accepted-before-assertions`);
    await unchanged();
    return result.package;
  }
  const requests = [
    ['baseRequest', 1],
    ['changedRequest', 2, 'changedRun'],
    ['withdrawRequest', 3],
    ['restoredRequest', 4, 'restoredRun'],
    ['childRequest', 5],
  ];
  for (const [key, step, snapshotKey] of requests) {
    if (!proof[key] || proof.completedStep >= step) continue;
    if (snapshotKey) {
      const result = await page.evaluate(
        (input) => window.electronAPI.protocols.inspectCreation(input),
        { project: proof[key].project, requestId: proof[key].requestId }
      );
      if (result.kind === 'ready') {
        proof = { ...proof, [snapshotKey]: result.package, completedStep: step };
        reconciled = true;
        checkpoint(`0${step}-original-file-operation-reconciled-before-assertions`);
      }
    } else {
      const receipt = await page.evaluate(
        (input) => window.electronAPI.inventory.operation(input),
        { ...fixture.scope, operationId: proof[key].operationId }
      );
      if (receipt) {
        assert.equal(receipt.status, 'committed');
        current = await ctx.inventoryRead(fixture.scope);
        reconciled = true;
        checkpoint(`0${step}-native-reconciled-before-record-lookup`);
        savedMeta(key, step);
        checkpoint(`0${step}-original-metadata-operation-reconciled-before-assertions`);
      }
    }
  }
  checkpoint('00-current-native-state');
  physicalUnchanged();
  if (proof.completedStep === 0) {
    assert.deepEqual(current.state, proof.baselineState);
    assert.deepEqual(current.history, proof.baselineHistory);
  } else if (!reconciled) {
    assert.deepEqual(current.state, fixture.state);
    assert.deepEqual(current.history, fixture.history);
  }
  if (reopen) assert.equal(proof.completedStep, 5);
  async function candidate() {
    const result = await page.evaluate(
      (input) => window.electronAPI.inventory.runValueCandidates(input),
      { ...fixture.scope, runId: originalRun.entityId, limit: 20 }
    );
    assert.equal(result.kind, 'ready');
    assert.equal(result.run.entityId, originalRun.entityId);
    assert.equal(result.run.fileObjectUuid, originalRun.fileObjectUuid);
    const row = result.rows.find((item) => item.collection === 'outputs' && item.key === outputKey);
    assert.ok(row);
    assert.equal(row.eligibility.kind, 'eligible');
    assert.equal(row.row.value.type, 'number');
    return { result, row };
  }
  async function livePrepared(key, file = false) {
    if (!proof[key]) return null;
    const form = page.getByTestId(
      file ? 'run-recorded-values-editor' : 'run-value-attribution-form'
    );
    if (!(await form.isVisible())) {
      if (file)
        assert.fail(
          'The original prepared file editor must remain open; do not replace its request.'
        );
      const section = await scopeView();
      await expect(button(section, 'Resume saved association change')).toBeVisible();
      await button(section, 'Resume saved association change').click();
      await expect(form).toHaveAttribute('data-attribution-phase', 'unknown');
      await button(form, 'Check association status').click();
      await button(form, 'Retry same association change').click();
      await expect(form).toHaveAttribute('data-attribution-phase', 'complete');
      return form;
    }
    await expect(form).toHaveAttribute(
      file ? 'data-edit-phase' : 'data-attribution-phase',
      file ? 'prepared' : 'previewed'
    );
    const request = JSON.parse(
      await field(
        form,
        file ? 'Prepared scientific value request' : 'Prepared value association request'
      ).inputValue()
    );
    assert.deepEqual(request, proof[key], 'Reuse the exact prepared request and stable identity.');
    return form;
  }
  async function prepareMeta(form, key) {
    await button(
      form,
      key === 'withdrawRequest' ? 'Preview withdrawal' : 'Preview association'
    ).click();
    await expect(form).toHaveAttribute('data-preview-kind', 'ready');
    await form.getByText('Prepared association request', { exact: true }).click();
    const request = JSON.parse(
      await field(form, 'Prepared value association request').inputValue()
    );
    if (proof[key]) assert.deepEqual(request, proof[key]);
    proof = { ...proof, [key]: request };
    checkpoint(`00-${key}-prepared-before-submit`);
    await unchanged();
    await capture(
      `00-${key}-preview-without-write`,
      form.getByTestId('run-value-attribution-preview')
    );
    return request;
  }
  async function fillAssociation(form, reason) {
    const actual = await candidate();
    assert.equal(actual.row.row.value.value, 0);
    proof = { ...proof, [proof.completedStep < 1 ? 'baseCandidate' : 'restoredCandidate']: actual };
    checkpoint('00-current-saved-candidate-before-preview');
    const row = form.locator(
      `[data-candidate-collection="outputs"][data-candidate-key="${outputKey}"]`
    );
    await expect(row).toHaveAttribute('data-candidate-row-sha256', actual.row.rowSha256);
    await button(row, 'Use saved value').click();
    await ctx.choose(
      form,
      'Recorded plate-plan use',
      new RegExp(`${escape(proof.observationId)}$`, 'u')
    );
    await ctx.choose(form, 'Physical subject', /Resulting aliquot · A3 · 4/u);
    await field(form, 'Reason for association').fill(reason);
  }
  async function detail(section, record) {
    const row = section.locator(`article[data-attribution-id="${record.id}"]`);
    await expect(row).toBeVisible();
    await button(row, 'View association').click();
    const result = section.getByTestId('run-value-association-detail');
    await expect(result).toHaveAttribute('data-attribution-id', record.id);
    return result;
  }
  if (proof.completedStep < 1) {
    let form = await livePrepared('baseRequest');
    if (!form) {
      const section = await scopeView();
      await expect(section).toContainText('No saved value associations.');
      await button(section, 'Associate saved value').click();
      form = page.getByTestId('run-value-attribution-form');
      await fillAssociation(form, proof.reasonBase);
      await prepareMeta(form, 'baseRequest');
    }
    if (await button(form, 'Add association').isVisible())
      await button(form, 'Add association').click();
    await acceptedMeta('baseRequest', 1);
    await expect(form).toHaveAttribute('data-attribution-phase', 'complete');
    await button(form, 'Close association editor').click();
    assert.deepEqual(proof.base.physical, proof.physical);
    assert.equal(proof.base.valueSnapshot.value.value, 0);
  }
  if (proof.completedStep === 1) {
    const section = await scopeView(),
      original = await detail(section, proof.base);
    await expect(original).toHaveAttribute('data-attribution-status', 'active');
    await expect(original.getByTestId('attribution-current-comparison')).toHaveAttribute(
      'data-current-comparison',
      'same-source'
    );
    await expect(original.getByTestId('attribution-original-value')).toHaveText('0');
    await expect(original.getByTestId('attribution-current-value')).toHaveText('0');
    await expect(original).toContainText(/Recorded subject: A3 · 4/u);
    await capture('01-active-original-zero-current-zero-recorded-four-microlitres', original);
    await unchanged();
  }
  async function editValue(value, key, snapshotKey, step, reason) {
    let editor = await livePrepared(key, true);
    if (!editor) {
      const existingView = page.getByTestId('scientific-document-tab');
      const view =
        step === 2 &&
        (await existingView.isVisible()) &&
        (await field(existingView, 'Document title').inputValue()) === originalRun.title
          ? existingView
          : await openRun();
      if (step === 2)
        await expect(view.getByTestId('run-value-association-detail')).toHaveAttribute(
          'data-attribution-id',
          proof.base.id
        );
      await button(view, 'Edit recorded values').click();
      editor = page.getByTestId('run-recorded-values-editor');
      await button(editor.locator(`[data-saved-slot-key="${outputKey}"]`), 'Edit value').click();
      await field(editor.locator(`[data-slot-key="${outputKey}"]`), 'Value').fill(String(value));
      await field(editor, 'Reason for save').fill(reason);
      await button(editor, 'Preview value changes').click();
      await expect(editor).toHaveAttribute('data-edit-phase', 'prepared');
      await editor.getByText('Prepared save request', { exact: true }).click();
      const request = JSON.parse(
        await field(editor, 'Prepared scientific value request').inputValue()
      );
      assert.equal(request.choices.upserts.length, 1);
      assert.equal(request.choices.upserts[0].key, outputKey);
      assert.equal(request.choices.upserts[0].value.value, value);
      proof = { ...proof, [key]: request };
      checkpoint(`00-${key}-prepared-before-submit`);
    }
    await capture(
      `00-${key}-typed-value-before-file-save`,
      editor.getByTestId('scientific-value-edit-preview')
    );
    await button(editor, 'Save recorded values').click();
    const saved = await acceptedFile(key, snapshotKey, step);
    await expect(editor).toBeHidden();
    const body = JSON.parse(saved.originalText),
      old = JSON.parse(originalRun.originalText);
    assert.equal(body.outputs.find((row) => row.key === outputKey).value.value, value);
    assert.deepEqual(body.measurements, old.measurements);
    assert.deepEqual(body.inputs, old.inputs);
    return saved;
  }
  if (proof.completedStep < 2) {
    await editValue(1, 'changedRequest', 'changedRun', 2, proof.reasonChanged);
    const section = page
      .getByTestId('scientific-document-tab')
      .getByTestId('run-value-associations');
    const original = section.getByTestId('run-value-association-detail');
    await expect(original).toHaveAttribute('data-attribution-id', proof.base.id);
    await expect(original.getByTestId('attribution-current-comparison')).toHaveAttribute(
      'data-current-comparison',
      'changed-row'
    );
    await expect(original.getByTestId('attribution-original-value')).toHaveText('0');
    await expect(original.getByTestId('attribution-current-value')).toHaveText('1');
    await expect(original).toHaveAttribute('data-attribution-status', 'active');
    await capture('01-active-original-zero-current-one-without-inventory-revision', original);
  }
  if (proof.completedStep < 3) {
    let form = await livePrepared('withdrawRequest');
    if (!form) {
      const section = await scopeView(),
        original = await detail(section, proof.base);
      await button(original, 'Withdraw association').click();
      form = page.getByTestId('run-value-attribution-form');
      await field(form, 'Reason for withdrawal').fill(proof.reasonWithdraw);
      await prepareMeta(form, 'withdrawRequest');
    }
    if (await button(form, 'Withdraw association').isVisible())
      await button(form, 'Withdraw association').click();
    await acceptedMeta('withdrawRequest', 3);
    await expect(form).toHaveAttribute('data-attribution-phase', 'complete');
    await button(form, 'Close association editor').click();
  }
  if (proof.completedStep < 4) {
    const restored = await editValue(0, 'restoredRequest', 'restoredRun', 4, proof.reasonRestored);
    proof = {
      ...proof,
      exactSourceBytesRestored: restored.originalText === originalRun.originalText,
    };
    checkpoint('04-original-content-restoration-observed');
    const section = await scopeView(),
      original = await detail(section, proof.base);
    await expect(original).toHaveAttribute('data-attribution-status', 'withdrawn');
    await expect(original.getByTestId('attribution-current-comparison')).toHaveAttribute(
      'data-current-comparison',
      proof.exactSourceBytesRestored ? 'same-source' : 'changed-source-same-row'
    );
    await capture('02-restored-zero-does-not-restore-withdrawn-association', original);
  }
  if (proof.completedStep < 5) {
    assert.ok(
      proof.exactSourceBytesRestored,
      'The restored source differs; preserve this checkpoint and qualify the changed-source comparison separately before a base duplicate claim.'
    );
    let form = await livePrepared('childRequest');
    if (!form) {
      let section = await scopeView();
      await button(section, 'Associate saved value').click();
      form = page.getByTestId('run-value-attribution-form');
      await fillAssociation(form, 'Re-present the original saved value and physical subject');
      await button(form, 'Preview association').click();
      await expect(form).toHaveAttribute('data-preview-kind', 'no-change');
      await expect(form).toContainText('Already recorded · Withdrawn');
      await expect(button(form, 'Add association')).toHaveCount(0);
      await unchanged();
      await capture(
        '03-base-duplicate-cannot-restore-withdrawal',
        form.getByTestId('run-value-attribution-preview')
      );
      await button(form, 'Close association editor').click();
      section = page.getByTestId('scientific-document-tab').getByTestId('run-value-associations');
      const original = await detail(section, proof.base);
      await button(original, 'Associate again or correct').click();
      form = page.getByTestId('run-value-attribution-form');
      await fillAssociation(form, proof.reasonChild);
      const request = await prepareMeta(form, 'childRequest');
      assert.deepEqual(request.choices.predecessor, {
        attributionId: proof.base.id,
        attributionIntentSha256: proof.base.intentSha256,
        withdrawalId: proof.withdrawal.id,
        withdrawalIntentSha256: proof.withdrawal.intentSha256,
      });
    }
    if (await button(form, 'Add association').isVisible())
      await button(form, 'Add association').click();
    await acceptedMeta('childRequest', 5);
    await expect(form).toHaveAttribute('data-attribution-phase', 'complete');
    await button(form, 'Close association editor').click();
  }
  assert.equal(current.state.revision, 102);
  assert.equal(proof.completedStep, 5);
  physicalUnchanged();
  assert.deepEqual(current.state.runValueAttributions[proof.base.id], proof.base);
  assert.deepEqual(current.state.runValueAttributions[proof.child.id], proof.child);
  assert.deepEqual(
    current.state.runValueAttributionWithdrawals[proof.withdrawal.id],
    proof.withdrawal
  );
  assert.deepEqual(proof.child.predecessor, {
    attributionId: proof.base.id,
    attributionIntentSha256: proof.base.intentSha256,
    withdrawalId: proof.withdrawal.id,
    withdrawalIntentSha256: proof.withdrawal.intentSha256,
  });
  assert.deepEqual(proof.child.physical, proof.base.physical);
  assert.equal(proof.child.runValue.key, outputKey);
  assert.equal(proof.child.source.fileObjectUuid, proof.base.source.fileObjectUuid);
  const currentRun = await page.evaluate(
    (input) => window.electronAPI.protocols.readPackage(input),
    { project: fixture.scope.project, entityId: originalRun.entityId }
  );
  assert.deepEqual(
    JSON.parse(currentRun.originalText).measurements,
    JSON.parse(originalRun.originalText).measurements
  );
  assert.equal(currentRun.originalText, proof.restoredRun.originalText);
  let section = await scopeView(),
    original = await detail(section, proof.base);
  await expect(original).toHaveAttribute('data-attribution-status', 'withdrawn');
  await button(original, 'View original saved value').click();
  await expect(field(original, 'Original attributed Run source')).toHaveValue(
    originalRun.originalText
  );
  await capture('04-withdrawn-base-retains-original-source-and-reason', original);
  const child = await detail(section, proof.child);
  await expect(child).toHaveAttribute('data-attribution-status', 'active');
  await expect(child.getByTestId('attribution-original-value')).toHaveText('0');
  await expect(child.getByTestId('attribution-current-value')).toHaveText('0');
  await capture('05-explicit-successor-active-original-stays-withdrawn', child);
  await closeDialogs();
  await page.getByTestId('inventory-button').click();
  await ctx.choose(page, 'Inventory project', fixture.project.name);
  await expect(page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
  await dismiss();
  await button(page, 'Saved value associations').click();
  const history = page.getByTestId('inventory-saved-value-associations');
  const global = history.getByTestId('run-value-associations');
  original = await detail(global, proof.base);
  await expect(original).toHaveAttribute('data-attribution-status', 'withdrawn');
  await button(original, 'View original saved value').click();
  await expect(field(original, 'Original attributed Run source')).toHaveValue(
    originalRun.originalText
  );
  await capture('06-inventory-unfiltered-history-retains-association', original);
  await button(history, 'Close saved value associations').click();
  await unchanged();
  const final = checkpoint('07-complete');
  writeFileSync(
    path.join(evidenceDirectory, 'run-value-attributions-reopen-fixture.json'),
    JSON.stringify(final, null, 2)
  );
  return {
    inventoryRevision: 102,
    metadataChanges: 3,
    physicalStateUnchanged: true,
    originalJournalsUnchanged: true,
    baseWithdrawn: true,
    explicitSuccessorActive: true,
    exactSourceBytesRestored: proof.exactSourceBytesRestored,
  };
}
export const runInventoryRunValueAttributions = (ctx) => run(ctx, false);
export const runInventoryRunValueAttributionsResume = (ctx) => run(ctx, false);
export const runInventoryRunValueAttributionsReopen = (ctx) => run(ctx, true);

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
async function run(ctx, reopen) {
  const { page, expect, fixture, evidenceDirectory } = ctx,
    scope = fixture.scope;
  const native = (method, input) =>
    page.evaluate((input) => window.electronAPI.inventory[input.method](input.value), {
      method,
      value: input,
    });
  const current = await ctx.inventoryRead(scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  assert.equal(current.state.schema, 'dnaforge.inventory.v29');
  let proof = fixture.scientificProductionJourney;
  if (!proof) {
    const pilotRequest = ctx.pilotRequest ?? fixture.scientificProductionPilot?.request ?? null;
    assert.equal(current.state.revision, 102);
    const dnaId = fixture.scientificJourney.sourceStockId;
    if (pilotRequest) assert.equal(pilotRequest.choices.inputs[0].stockId, dnaId);
    const water = Object.values(current.state.stocks).filter(
      (stock) =>
        current.state.vessels[stock.vesselId].name === 'Water tube acceptance' &&
        stock.quantity.kind === 'known' &&
        stock.quantity.unit === 'uL' &&
        stock.quantity.value === '68'
    );
    assert.equal(
      water.length,
      1,
      'Resolve the one original water stock from current native facts.'
    );
    const facts = await native('availability', scope);
    const empty = Object.values(current.state.vessels).find(
      (vessel) =>
        vessel.lifecycle === 'active' &&
        facts.vesselContents[vessel.id]?.kind === 'declared-empty' &&
        vessel.kind === 'tube'
    );
    const outputVesselId = pilotRequest?.choices.output.vesselId ?? empty?.id;
    assert.ok(
      outputVesselId,
      'The fixture needs an existing empty output vessel; no vessel is created by this journey.'
    );
    const run = fixture.runValuesJourney.valuedRun;
    const savedRun = await page.evaluate(
      (input) => window.electronAPI.protocols.readPackage(input),
      { project: scope.project, entityId: run.entityId }
    );
    proof = {
      completedStep: 0,
      before: current,
      pilotRequest,
      dnaId,
      waterId: water[0].id,
      run: savedRun,
      outputVesselId,
    };
  }
  function checkpoint(name, observed = current) {
    const saved = { ...fixture, ...observed, scientificProductionJourney: proof };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-scientific-production-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  }
  async function capture(name, target) {
    if (target) {
      await target.scrollIntoViewIfNeeded();
      await target.screenshot({ path: path.join(evidenceDirectory, `${name}-detail.png`) });
    }
    await ctx.capture(name, { proof });
  }
  async function dismiss() {
    if (await page.locator('[role="dialog"]:visible').count()) return;
    for (const name of [
      'dev-registry-seed',
      'use-file-association-opportunities-make-dnaforge-the-default-app-for-example-files',
    ]) {
      const toast = page.locator(`[data-toast-definition="${name}"]`);
      if (await button(toast, 'Not now').isVisible()) await button(toast, 'Not now').click();
    }
  }
  async function openRun() {
    await dismiss();
    const row = page.locator(
      `[role="treeitem"][data-entry-path="${proof.run.path.replace(/\/.forge\/protocol(?:-run)?\.json$/u, '')}"]`
    );
    if (!(await row.isVisible())) await page.getByTestId('files-button').click();
    await expect(row).toBeVisible();
    await row.dblclick();
    await expect(field(page.getByTestId('scientific-document-tab'), 'Document title')).toHaveValue(
      proof.run.title
    );
    return page.getByTestId('recorded-scientific-productions');
  }
  async function prepared(form) {
    const text = field(form, 'Prepared production request');
    if (!(await text.isVisible()))
      await form.getByText('Prepared production request', { exact: true }).click();
    return JSON.parse(await text.inputValue());
  }
  async function acceptedIfPresent() {
    if (!proof.request) return false;
    const receipt = await native('operation', { ...scope, operationId: proof.request.operationId });
    const observed = await ctx.inventoryRead(scope);
    const production = observed.state.scientificProductions[proof.productionId];
    if (!receipt && !production) return false;
    proof = { ...proof, completedStep: 1, receipt, accepted: observed, production };
    checkpoint('01-native-accepted-before-assertions', observed);
    assert.ok(production);
    assert.equal(production.intentSha256, proof.intentSha256);
    return true;
  }
  checkpoint('00-current-baseline-and-original-pilot');
  if (reopen) assert.ok(proof.completedStep >= 1);
  if (proof.completedStep < 1 && !(await acceptedIfPresent())) {
    let form = page.getByTestId('scientific-production-form');
    if (!(await form.isVisible())) {
      const section = await openRun();
      await button(section, 'Record completed production').click();
    }
    await expect(form).toBeVisible();
    if (!proof.request) {
      if (!proof.pilotRequest) {
        const designs = await native('scientificProductionDesigns', { ...scope, limit: 50 });
        assert.equal(designs.kind, 'ready');
        const selected = designs.designs.find(
          (row) =>
            row.selection.revision.resourceId ===
              fixture.designSetupJourney.design.entry.resourceId &&
            row.selection.revision.resourceRevisionId ===
              fixture.designSetupJourney.design.entry.revisionId &&
            row.materialAdmission.kind === 'admitted'
        );
        assert.ok(selected, 'The qualified accepted DNA design must be available.');
        await form
          .locator(
            `[data-design-resource-id="${selected.selection.revision.resourceId}"][data-design-revision-id="${selected.selection.revision.resourceRevisionId}"]`
          )
          .getByRole('button')
          .click();
        await form.getByLabel('Input 1 stock', { exact: true }).selectOption(proof.dnaId);
        await field(form, 'Input 1 amount (µL)').fill('2');
        await form.getByLabel('Output vessel', { exact: true }).selectOption(proof.outputVesselId);
        await field(form, 'Measured output amount (µL)').fill('1');
        await field(form, 'Batch name').fill('Completed manual demonstration batch');
        await field(form, 'Preparation method').fill('Manual preparation reported by operator');
        await field(form, 'Reason for production report').fill(
          'Record the completed preparation with explicit inputs and measured output.'
        );
      }
      await expect(form.getByLabel('Input 1 stock', { exact: true })).toHaveValue(proof.dnaId);
      await expect(field(form, 'Input 1 amount (µL)')).toHaveValue('2');
      await expect(form.getByLabel('Output vessel', { exact: true })).toHaveValue(
        proof.outputVesselId
      );
      const availability = await native('availability', scope);
      for (const [id, value] of [
        [proof.dnaId, '52'],
        [proof.waterId, '68'],
      ]) {
        assert.deepEqual(current.state.stocks[id].quantity, { kind: 'known', value, unit: 'uL' });
        assert.equal(availability.stocks[id].actions.withdraw.kind, 'allowed');
      }
      assert.equal(availability.vesselContents[proof.outputVesselId].kind, 'declared-empty');
      if (!(await form.getByLabel('Input 2 stock', { exact: true }).isVisible()))
        await button(form, 'Add production input').click();
      await form.getByLabel('Input 2 stock', { exact: true }).selectOption(proof.waterId);
      await field(form, 'Input 2 amount (µL)').fill('3');
      await form.getByLabel('Manual production status', { exact: true }).selectOption('uncertain');
      await expect(button(form, 'Preview completed production')).toBeDisabled();
      await capture(
        '01-uncertain-physical-report-cannot-be-previewed',
        form.getByLabel('Manual production status', { exact: true })
      );
      await form.getByLabel('Manual production status', { exact: true }).selectOption('completed');
      await button(form, 'Preview completed production').click();
      await expect(button(form, 'Record completed production')).toBeVisible();
      await field(form, 'Input 1 amount (µL)').fill('1');
      await expect(page.getByTestId('scientific-production-preview')).toBeHidden();
      await field(form, 'Input 1 amount (µL)').fill('2');
      await button(form, 'Preview completed production').click();
      await expect(button(form, 'Record completed production')).toBeVisible();
      const request = await prepared(form);
      proof = { ...proof, request };
      if (proof.pilotRequest)
        assert.deepEqual(request.choices.identity, proof.pilotRequest.choices.identity);
      assert.deepEqual(request.choices.inputs, [
        { stockId: proof.dnaId, quantity: { value: '2', unit: 'uL' } },
        { stockId: proof.waterId, quantity: { value: '3', unit: 'uL' } },
      ]);
      if (proof.pilotRequest)
        assert.deepEqual(request.choices.output, proof.pilotRequest.choices.output);
      const preview = await native('previewScientificProduction', {
        ...scope,
        expectedRevision: request.expectedRevision,
        choices: request.choices,
      });
      assert.equal(preview.kind, 'ready');
      assert.equal(preview.planDigest, request.expectedPlanDigest);
      proof = {
        ...proof,
        productionId: preview.production.id,
        intentSha256: preview.production.intentSha256,
      };
      checkpoint('00-exact-request-and-original-business-pins-before-record');
      await capture(
        '02-ready-two-inputs-measured-product-and-initial-quality',
        form.getByTestId('scientific-production-facts')
      );
    }
    if (
      proof.submissionStarted &&
      (await button(form, 'Confirm original production report').isVisible())
    ) {
      await button(form, 'Confirm original production report').click();
      if (!(await acceptedIfPresent()))
        await button(form, 'Retry original production request').click();
    } else {
      assert.deepEqual(
        await prepared(form),
        proof.request,
        'Resume only the exact original prepared request.'
      );
      proof = { ...proof, submissionStarted: true };
      checkpoint('00-original-request-armed-before-record');
      await button(form, 'Record completed production').click();
    }
    await expect
      .poll(async () =>
        Boolean(await native('operation', { ...scope, operationId: proof.request.operationId }))
      )
      .toBe(true);
    await acceptedIfPresent();
  }
  const after = await ctx.inventoryRead(scope),
    production = after.state.scientificProductions[proof.productionId];
  assert.equal(after.state.revision, 103);
  assert.equal(after.history.length, proof.before.history.length + 1);
  assert.deepEqual(after.history.slice(0, -1), proof.before.history);
  assert.deepEqual(after.history.at(-1).request, proof.request);
  assert.equal(production.intentSha256, proof.intentSha256);
  assert.equal(after.state.stocks[proof.dnaId].quantity.value, '50');
  assert.equal(after.state.stocks[proof.waterId].quantity.value, '65');
  assert.deepEqual(production.output.quantity, { value: '1', unit: 'uL' });
  assert.equal(production.output.vesselId, proof.outputVesselId);
  assert.equal(production.effects.lot.after.origin.kind, 'prepared');
  assert.equal(production.effects.lot.after.controls.kind, 'managed');
  assert.equal(production.effects.lot.after.controls.assessment.value, 'unassessed');
  assert.equal(production.effects.stock.after.quality, 'quarantined');
  const expected = structuredClone(proof.before.state);
  for (const source of production.effects.sources) {
    assert.deepEqual(source.before, expected.stocks[source.before.id]);
    expected.stocks[source.after.id] = source.after;
  }
  expected.lots[production.output.lotId] = production.effects.lot.after;
  expected.stocks[production.output.stockId] = production.effects.stock.after;
  expected.scientificProductions[production.id] = production;
  expected.revision = after.state.revision;
  expected.lastRecordedAt = after.state.lastRecordedAt;
  assert.deepEqual(after.state, expected);
  const source = await native('scientificProductionSource', {
    ...scope,
    productionId: production.id,
    intentSha256: production.intentSha256,
  });
  assert.equal(source.kind, 'available');
  assert.equal(source.source.originalText, proof.run.originalText);
  assert.deepEqual(source.design.binding.selection, proof.request.choices.design);
  assert.equal(
    source.design.representation.text,
    fixture.designSetupJourney.design.snapshot.representation.text
  );
  assert.equal(
    await page.evaluate((file) => window.electronAPI.fs.readTextFile(file), proof.run.path),
    proof.run.originalText
  );
  if (!reopen) {
    const retry = await native('applyScientificProduction', proof.request);
    proof = { ...proof, exactRetry: retry };
    checkpoint('02-original-operation-retry-returned', after);
    assert.equal(retry.status, 'committed');
    assert.equal(retry.operationId, proof.request.operationId);
    if (!proof.duplicateRequest) {
      proof = { ...proof, duplicateRequest: { ...proof.request, operationId: randomUUID() } };
      checkpoint('02-fresh-duplicate-request-before-send', after);
    }
    const duplicate = await native('applyScientificProduction', proof.duplicateRequest);
    proof = { ...proof, duplicate };
    checkpoint('02-duplicate-response-before-assertions', after);
    assert.equal(duplicate.status, 'rejected');
    assert.equal(duplicate.operationId, proof.duplicateRequest.operationId);
    assert.equal(duplicate.inventoryId, scope.inventoryId);
    assert.equal(duplicate.code, 'INVENTORY_SCIENTIFIC_PRODUCTION_NO_CHANGES');
    assert.equal(
      await native('operation', { ...scope, operationId: proof.duplicateRequest.operationId }),
      null
    );
    assert.deepEqual(await ctx.inventoryRead(scope), after);
  }
  const form = page.getByTestId('scientific-production-form');
  if (await form.isVisible()) await button(form, 'Close production report').click();
  const section = await openRun();
  const row = section.locator(`[data-production-id="${production.id}"]`);
  await button(row, 'View recorded production').click();
  const detail = section.getByTestId('scientific-production-detail');
  await expect(detail).toContainText('unassessed');
  await expect(detail).toContainText('quarantined');
  await capture(
    '03-recorded-production-inputs-product-and-quality',
    detail.getByTestId('scientific-production-facts')
  );
  await button(detail, 'View saved production sources').click();
  await expect(field(detail, 'Original accepted DNA design')).toHaveValue(
    source.design.representation.text
  );
  await capture(
    '04-original-accepted-dna-and-saved-run',
    detail.getByTestId('scientific-production-source')
  );
  await dismiss();
  if (!(await page.getByTestId('inventory-panel').isVisible()))
    await page.getByTestId('inventory-button').click();
  await ctx.choose(page, 'Inventory project', fixture.project.name);
  await button(page.getByTestId('inventory-panel'), 'Saved productions').click();
  const saved = page.getByRole('dialog', { name: 'Saved productions', exact: true });
  await button(
    saved.locator(`[data-production-id="${production.id}"]`),
    'View recorded production'
  ).click();
  await capture(
    '05-inventory-saved-production-history',
    saved.getByTestId('scientific-production-detail')
  );
  await button(saved, 'Close saved productions').click();
  assert.deepEqual(await ctx.inventoryRead(scope), after);
  proof = { ...proof, completedStep: 2, source };
  checkpoint('03-complete-original-production-proof', after);
  writeFileSync(
    path.join(evidenceDirectory, 'scientific-production-reopen-fixture.json'),
    JSON.stringify({ ...fixture, ...after, scientificProductionJourney: proof }, null, 2)
  );
  return {
    productionId: production.id,
    revision: 103,
    completedStep: 2,
    retainedSources: true,
    desktopLostAcknowledgementQualified: false,
  };
}
export const runInventoryScientificProduction = (ctx) => run(ctx, false);
export const runInventoryScientificProductionResume = (ctx) => run(ctx, false);
export const runInventoryScientificProductionReopen = (ctx) => run(ctx, true);

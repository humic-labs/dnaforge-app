import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function decimal(left, right) {
  const [a, b = ''] = left.split('.'),
    [c, d = ''] = right.split('.'),
    width = Math.max(b.length, d.length),
    x = BigInt(a + b.padEnd(width, '0')),
    y = BigInt(c + d.padEnd(width, '0'));
  return x < y ? -1 : x > y ? 1 : 0;
}
async function dismiss(ctx) {
  const toast = ctx.page.locator('[data-toast-definition="dev-registry-seed"]');
  if (await button(toast, 'Not now').isVisible()) await button(toast, 'Not now').click();
}
async function run(ctx, reopen) {
  const { page, expect, fixture, evidenceDirectory } = ctx;
  let current = await ctx.inventoryRead(fixture.scope),
    proof = fixture.platePlanObservationJourney;
  if (reopen || proof?.completedStep === 1) {
    assert.deepEqual(current.state, fixture.state);
    assert.deepEqual(current.history, fixture.history);
  }
  if (!proof) {
    assert.equal(current.state.schema, 'dnaforge.inventory.v27');
    assert.equal(current.state.revision, 98);
    assert.deepEqual(current.history, fixture.history);
    const { schema, platePlanObservations, ...old } = current.state,
      { schema: oldSchema, platePlanObservations: priorObservations, ...prior } = fixture.state;
    assert.deepEqual(old, prior);
    assert.deepEqual(platePlanObservations, {});
    if (priorObservations !== undefined) assert.deepEqual(priorObservations, {});
    const sourceStockId =
      fixture.scientificJourney?.sourceStockId ?? fixture.protocolRunJourney?.sourceStockId;
    assert.ok(sourceStockId, 'The fixture must identify the original scientific source stock.');
    if (fixture.scientificJourney?.sourceStockId && fixture.protocolRunJourney?.sourceStockId)
      assert.equal(
        fixture.scientificJourney.sourceStockId,
        fixture.protocolRunJourney.sourceStockId
      );
    proof = {
      completedStep: 0,
      initialRevision: 98,
      baselineState: current.state,
      baselineHistory: current.history,
      version: fixture.platePlansJourney.versionB,
      sourceStockId,
      plateId: fixture.platePlansJourney.plateId,
      reason: `Operator reports all listed manual transfers were completed ${randomUUID().slice(0, 8)}`,
    };
  }
  const checkpoint = (name) => {
    const saved = {
      ...fixture,
      ...current,
      platePlanObservationJourney: proof,
      resumePhase: 'plate-plan-observation',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-plate-plan-observation-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  const unchanged = async () => assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
  async function capture(name, target, details = {}) {
    await dismiss(ctx);
    if (target) {
      await target.scrollIntoViewIfNeeded();
      await target.screenshot({ path: path.join(evidenceDirectory, `${name}-detail.png`) });
    }
    await ctx.capture(name, { ...current, proof, ...details });
  }
  checkpoint('00-current-native-memory-upcast');
  await button(page, 'Plate plans').click();
  const plans = page.getByTestId('inventory-plate-plans'),
    row = plans
      .getByTestId('plate-plan-versions')
      .locator(`[data-plan-version-id="${proof.version.id}"]`);
  await expect(row).toBeVisible();
  await button(row, 'Open version').click();
  await expect(plans.getByTestId('plate-plan-selected')).toHaveAttribute(
    'data-plan-version-id',
    proof.version.id
  );
  const pending = button(plans, 'Resume saved manual report');
  if (await pending.isVisible()) {
    await pending.click();
    const form = page.getByTestId('plate-plan-observation-form');
    if (await button(form, 'Check report status').isVisible())
      await button(form, 'Check report status').click();
    if (await button(form, 'Reload recorded use').isVisible())
      await button(form, 'Reload recorded use').click();
    if (await button(form, 'Retry same manual report').isVisible())
      await button(form, 'Retry same manual report').click();
    await expect(form).toHaveAttribute('data-report-phase', 'complete');
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint('01-original-operation-recovered-before-assertions');
    await button(form, 'Close manual report').click();
  }
  if (proof.completedStep === 0 && proof.request) {
    const accepted = await page.evaluate((input) => window.electronAPI.inventory.operation(input), {
      ...fixture.scope,
      operationId: proof.request.operationId,
    });
    if (accepted) {
      current = await ctx.inventoryRead(fixture.scope);
      checkpoint('01-accepted-operation-reconciled-before-assertions');
      const recorded = Object.values(current.state.platePlanObservations).find(
        (item) => item.identity.observationId === proof.request.choices.identity.observationId
      );
      assert.ok(recorded);
      proof = { ...proof, observation: recorded, completedStep: 1 };
      checkpoint('01-accepted-operation-reconciled');
    }
  }
  if (reopen) assert.equal(proof.completedStep, 1);
  if (proof.completedStep === 0) {
    await button(plans, 'Report completed manual use').click();
    const form = page.getByTestId('plate-plan-observation-form');
    if (proof.request)
      await expect(form).toHaveAttribute(
        'data-observation-draft-id',
        proof.request.choices.identity.observationId
      );
    proof = { ...proof, draftId: await form.getAttribute('data-observation-draft-id') };
    checkpoint('00-stable-occurrence-before-discovery');
    await form
      .getByRole('textbox', { name: 'Find saved context', exact: true })
      .fill(fixture.protocolRunJourney.run.title);
    await ctx.choose(
      form,
      'Saved context',
      new RegExp(`${escape(fixture.protocolRunJourney.run.entityId)}$`, 'u')
    );
    await form
      .getByRole('textbox', { name: 'Reason for this manual report', exact: true })
      .fill(proof.reason);
    await ctx.choose(
      form,
      'Were all listed transfers completed exactly as shown?',
      'Some transfers or unsure'
    );
    await expect(button(form, 'Preview completed transfers')).toBeDisabled();
    await unchanged();
    await ctx.choose(
      form,
      'Were all listed transfers completed exactly as shown?',
      'Yes, all transfers'
    );
    const facts = await page.evaluate(
      (input) => window.electronAPI.inventory.availability(input),
      fixture.scope
    );
    assert.equal(facts.revision, 98);
    const source = current.state.stocks[proof.sourceStockId],
      sourceFacts = facts.stocks[source.id];
    assert.deepEqual(source.quantity, { kind: 'known', value: '60', unit: 'uL' });
    assert.equal(sourceFacts.actions.withdraw.kind, 'allowed');
    assert.equal(sourceFacts.held.value, '0');
    assert.equal(sourceFacts.unreserved.kind, 'known');
    assert.ok(decimal(sourceFacts.unreserved.value, '8') >= 0);
    const held = Object.values(current.state.stocks).find(
      (stock) =>
        stock.quantity.kind === 'known' &&
        stock.quantity.unit === 'uL' &&
        decimal(stock.quantity.value, '8') >= 0 &&
        facts.stocks[stock.id]?.held.unit === 'uL' &&
        decimal(facts.stocks[stock.id].held.value, '0') > 0 &&
        facts.stocks[stock.id].unreserved.kind === 'known' &&
        decimal(facts.stocks[stock.id].unreserved.value, '8') < 0
    );
    assert.ok(held);
    proof = {
      ...proof,
      heldFacts: { stock: held, availability: facts.stocks[held.id], asOf: facts.asOf },
    };
    checkpoint('00-current-native-source-and-held-facts');
    async function mappings(plateId, stockId) {
      await ctx.choose(form, 'Physical plate', new RegExp(`${escape(plateId)}$`, 'u'));
      for (const [index, slot] of proof.version.definition.sourceSlots.entries())
        await ctx.choose(
          form,
          `Report source ${index + 1}: ${slot.label}`,
          new RegExp(`${escape(stockId)}$`, 'u')
        );
    }
    await mappings(proof.plateId, held.id);
    await button(form, 'Preview completed transfers').click();
    await expect(form).toHaveAttribute('data-report-preview-state', 'blocked');
    await expect(button(form, 'Record completed transfers')).toHaveCount(0);
    await unchanged();
    await capture(
      '01-held-shortfall-blocks-whole-manual-report',
      form.getByTestId('plate-plan-report-result'),
      { held: proof.heldFacts }
    );
    const incompatible = Object.values(current.state.storage).find(
      (storage) =>
        storage.lifecycle === 'active' &&
        storage.layout.kind === 'fixed-well' &&
        (storage.layout.rows !== 2 || storage.layout.columns !== 3)
    );
    assert.ok(incompatible);
    await mappings(incompatible.id, source.id);
    await button(form, 'Preview completed transfers').click();
    await expect(form).toHaveAttribute('data-report-preview-state', 'blocked');
    await expect(button(form, 'Record completed transfers')).toHaveCount(0);
    await unchanged();
    await capture(
      '02-layout-mismatch-blocks-whole-manual-report',
      form.getByTestId('plate-plan-report-result'),
      { incompatiblePlate: incompatible }
    );
    await mappings(proof.plateId, source.id);
    await button(form, 'Preview completed transfers').click();
    await expect(form).toHaveAttribute('data-report-preview-state', 'ready');
    await unchanged();
    await expect(form.getByTestId('plate-plan-report-result')).toContainText('60 µL → 52 µL');
    await expect(
      form.getByTestId('plate-plan-report-result').locator('[data-action-id]')
    ).toHaveCount(2);
    await capture(
      '03-exact-whole-manual-report-preview-with-no-write',
      form.getByTestId('plate-plan-report-result')
    );
    await form.getByText('Prepared manual report details', { exact: true }).click();
    const request = JSON.parse(
      await form
        .getByRole('textbox', { name: 'Prepared manual report request', exact: true })
        .inputValue()
    );
    assert.equal(request.kind, 'record-plate-plan-observation');
    assert.equal(request.expectedRevision, 98);
    assert.equal(request.choices.identity.observationId, proof.draftId);
    assert.equal(request.choices.binding.versionId, proof.version.id);
    assert.equal(request.choices.context.entityId, fixture.protocolRunJourney.run.entityId);
    if (proof.request) assert.deepEqual(request, proof.request);
    proof = { ...proof, request };
    checkpoint('01-prepared-request-before-submit');
    await button(form, 'Record completed transfers').click();
    await expect.poll(async () => (await ctx.inventoryRead(fixture.scope)).state.revision).toBe(99);
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint('01-accepted-whole-batch-before-assertions');
    const observation = Object.values(current.state.platePlanObservations).find(
      (item) => item.identity.observationId === proof.draftId
    );
    assert.ok(observation);
    proof = { ...proof, observation, completedStep: 1 };
    checkpoint('01-recorded-whole-batch');
    await expect(form).toHaveAttribute('data-report-phase', 'complete');
    await button(form, 'Preview same occurrence again').click();
    await expect(form).toHaveAttribute('data-report-preview-state', 'no-change');
    await expect(button(form, 'Record completed transfers')).toHaveCount(0);
    await unchanged();
    await capture(
      '04-same-occurrence-has-no-second-debit',
      form.getByTestId('plate-plan-report-result')
    );
    await button(form, 'Close manual report').click();
  }
  assert.equal(current.state.revision, 99);
  assert.equal(current.history.length, proof.baselineHistory.length + 1);
  assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  const entry = current.history.at(-1);
  assert.deepEqual(entry.request, proof.request);
  assert.equal(entry.receipt.operationId, proof.request.operationId);
  assert.equal(Object.keys(current.state.platePlanObservations).length, 1);
  const observation = proof.observation;
  assert.equal(observation.binding.versionId, proof.version.id);
  assert.equal(observation.actions.length, 2);
  assert.equal(observation.effects.sources.length, 1);
  assert.equal(observation.effects.destinations.length, 2);
  assert.deepEqual(
    observation.effects.sources[0].before,
    proof.baselineState.stocks[proof.sourceStockId]
  );
  assert.deepEqual(observation.effects.sources[0].after.quantity, {
    kind: 'known',
    value: '52',
    unit: 'uL',
  });
  assert.deepEqual(current.state.stocks[proof.sourceStockId], observation.effects.sources[0].after);
  const expectedStocks = {
    ...proof.baselineState.stocks,
    [proof.sourceStockId]: observation.effects.sources[0].after,
  };
  for (const destination of observation.effects.destinations) {
    assert.equal(destination.before, null);
    assert.deepEqual(destination.after.quantity, { kind: 'known', value: '4', unit: 'uL' });
    assert.equal(destination.after.materialId, observation.effects.sources[0].before.materialId);
    assert.deepEqual(destination.after.source, observation.effects.sources[0].before.source);
    assert.deepEqual(
      destination.after.lotConstraints,
      observation.effects.sources[0].before.lotConstraints
    );
    expectedStocks[destination.after.id] = destination.after;
  }
  assert.deepEqual(current.state.stocks, expectedStocks);
  const { schema, revision, lastRecordedAt, stocks, platePlanObservations, ...rest } =
      current.state,
    {
      schema: oldSchema,
      revision: oldRevision,
      lastRecordedAt: oldAt,
      stocks: oldStocks,
      platePlanObservations: oldObservations,
      ...originalRest
    } = proof.baselineState;
  assert.deepEqual(rest, originalRest);
  assert.deepEqual(current.state.scientificWorks, proof.baselineState.scientificWorks);
  for (const position of ['A1', 'A2']) {
    const vesselId = `well:${proof.plateId}#${position}`,
      stock = Object.values(current.state.stocks).find((item) => item.vesselId === vesselId);
    assert.ok(stock);
    assert.deepEqual(stock, proof.baselineState.stocks[stock.id]);
    assert.equal(stock.quantity.value, '10');
  }
  const list = plans.getByTestId('recorded-plate-plan-uses'),
    recordedRow = list.locator(`[data-plate-plan-observation-id="${observation.id}"]`);
  await expect(recordedRow).toBeVisible();
  await button(recordedRow, 'View recorded use').click();
  await expect(list.getByTestId('plate-plan-observation-facts')).toContainText('60 µL → 52 µL');
  await button(list, 'View saved plan-use context').click();
  await expect(list.getByTestId('plate-plan-observation-source')).toBeVisible();
  const packet = JSON.parse(
    await list
      .getByRole('textbox', { name: 'Saved plate-plan use context', exact: true })
      .inputValue()
  );
  assert.equal(packet.schema, 'dnaforge.protocol-run-saved-source.v1');
  assert.equal(packet.originalText, fixture.protocolRunJourney.run.originalText);
  assert.equal(JSON.parse(packet.originalText).status, 'in_progress');
  assert.deepEqual(JSON.parse(packet.originalText).inputs, []);
  assert.deepEqual(JSON.parse(packet.originalText).outputs, []);
  await capture(
    '05-recorded-plan-use-and-original-saved-run',
    list.getByTestId('plate-plan-observation-detail')
  );
  if (reopen) {
    await button(plans, 'Report completed manual use').click();
    const form = page.getByTestId('plate-plan-observation-form');
    await expect(form).toHaveAttribute(
      'data-observation-draft-id',
      proof.request.choices.identity.observationId
    );
    await button(form, 'Preview completed transfers').click();
    await expect(form).toHaveAttribute('data-report-preview-state', 'no-change');
    await expect(button(form, 'Record completed transfers')).toHaveCount(0);
    await unchanged();
    await button(form, 'Close manual report').click();
  }
  await button(plans, 'Close plate plans').click();
  const saved = fixture.protocolRunJourney.run,
    project = page.locator(`[role="treeitem"][data-entry-path="${fixture.project.path}"]`);
  if (!(await project.isVisible())) await page.getByTestId('files-button').click();
  await expect(project).toBeVisible();
  await page
    .locator(`[data-entry-path="${saved.path.replace(/\/.forge\/protocol-run\.json$/u, '')}"]`)
    .dblclick();
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue(
    saved.title
  );
  const runList = page.getByTestId('recorded-plate-plan-uses');
  await expect(
    runList.locator(`[data-plate-plan-observation-id="${observation.id}"]`)
  ).toBeVisible();
  const originalWork = Object.values(current.state.scientificWorks).find(
    (work) => work.identity.workId === fixture.protocolRunJourney.physicalWorkId
  );
  assert.ok(originalWork);
  await expect(page.locator(`[data-scientific-work-id="${originalWork.id}"]`)).toBeVisible();
  await button(
    runList.locator(`[data-plate-plan-observation-id="${observation.id}"]`),
    'View recorded use'
  ).click();
  await button(runList, 'View saved plan-use context').click();
  await expect(runList.getByTestId('plate-plan-observation-source')).toBeVisible();
  await capture('06-run-shows-whole-plan-use-separately-from-original-transfer', runList);
  await unchanged();
  const source = await page.evaluate(
    (input) => window.electronAPI.inventory.platePlanObservationSource(input),
    { ...fixture.scope, observationId: observation.id, intentSha256: observation.intentSha256 }
  );
  assert.equal(source.kind, 'available');
  assert.equal(source.sourceSha256, observation.context.source.sha256);
  assert.deepEqual(source.source, packet);
  proof = { ...proof, retainedSource: source, currentRunSourceEditQualified: false };
  const final = checkpoint('02-complete');
  writeFileSync(
    path.join(evidenceDirectory, 'plate-plan-observation-reopen-fixture.json'),
    JSON.stringify(final, null, 2)
  );
  return {
    revision: 99,
    observationId: observation.id,
    sourceBefore: '60',
    sourceAfter: '52',
    outputs: observation.effects.destinations.map((row) => row.after.id),
    metadataPlanSaves: 0,
    manualBatchRecords: 1,
    originalWorkAndOtherStateUnchanged: true,
    currentRunSourceEditQualified: false,
  };
}
export const runInventoryPlatePlanObservation = (ctx) => run(ctx, false);
export const runInventoryPlatePlanObservationResume = (ctx) => run(ctx, false);
export const runInventoryPlatePlanObservationReopen = (ctx) => run(ctx, true);

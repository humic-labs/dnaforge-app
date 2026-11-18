import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const packages = (page, project, kind, query) =>
  page.evaluate((input) => window.electronAPI.protocols.listPackages(input), {
    project,
    kind,
    query,
    limit: 50,
  });
async function closeDialogs(page) {
  for (let attempt = 0; attempt < 4 && (await page.getByRole('dialog').count()); attempt++) {
    const cancel = button(page.getByRole('dialog').last(), 'Cancel');
    if (await cancel.isVisible()) await cancel.click();
    else await page.keyboard.press('Escape');
  }
  const stock = button(page, 'Close stock details');
  if (await stock.isVisible()) await stock.click();
}
async function openPackage(ctx, saved) {
  await closeDialogs(ctx.page);
  const project = ctx.page.locator(
    `[role="treeitem"][data-entry-path="${ctx.fixture.project.path}"]`
  );
  if (!(await project.isVisible())) await ctx.page.getByTestId('files-button').click();
  await ctx.expect(project).toBeVisible();
  const packageRoot = saved.path.replace(/\/.forge\/protocol(?:-run)?\.json$/u, '');
  await ctx.page.locator(`[data-entry-path="${packageRoot}"]`).dblclick();
  const view = ctx.page.getByTestId('scientific-document-tab');
  await ctx.expect(field(view, 'Document title')).toHaveValue(saved.title);
  return view;
}
async function newProtocolDialog(ctx) {
  await closeDialogs(ctx.page);
  const project = ctx.page.locator(
    `[role="treeitem"][data-entry-path="${ctx.fixture.project.path}"]`
  );
  if (!(await project.isVisible())) await ctx.page.getByTestId('files-button').click();
  await ctx.page
    .locator(`[role="treeitem"][data-entry-path="${ctx.fixture.project.path}"]`)
    .click({ button: 'right' });
  await ctx.page.getByRole('menuitem', { name: 'New…', exact: true }).hover();
  await ctx.page.getByRole('menuitem', { name: 'Protocol', exact: true }).click();
  await ctx.page
    .getByRole('menu', { name: 'Protocol actions', exact: true })
    .getByRole('menuitem', { name: 'Create', exact: true })
    .click();
  return ctx.page.getByRole('dialog', { name: 'Create protocol', exact: true });
}
function runWork(fixture, state) {
  const work = Object.values(state.scientificWorks).find(
    (item) =>
      item.identity.namespace === fixture.protocolRunJourney.namespace &&
      item.identity.workId === fixture.protocolRunJourney.physicalWorkId
  );
  assert.ok(work);
  return work;
}
function assertWork(fixture, current) {
  const proof = fixture.protocolRunJourney,
    work = runWork(fixture, current.state);
  assert.equal(current.state.revision, proof.initialRevision + 1);
  assert.equal(work.context.kind, 'protocol-run');
  assert.equal(work.context.entityId, proof.run.entityId);
  assert.equal(work.context.source.sha256, proof.run.sourceSha256);
  assert.deepEqual(work.transfer.quantity, { value: '10', unit: 'uL' });
  assert.deepEqual(work.effects.source.before.quantity, { kind: 'known', value: '70', unit: 'uL' });
  assert.deepEqual(work.effects.source.after.quantity, { kind: 'known', value: '60', unit: 'uL' });
  assert.deepEqual(work.effects.destination.after.quantity, {
    kind: 'known',
    value: '10',
    unit: 'uL',
  });
  assert.equal(work.transfer.destination.vesselId, proof.destinationVesselId);
  assert.equal(work.effects.destination.after.materialId, work.effects.source.before.materialId);
  assert.deepEqual(
    work.effects.destination.after.lotConstraints,
    work.effects.source.before.lotConstraints
  );
  assert.deepEqual(current.state.stocks[proof.sourceStockId], work.effects.source.after);
  assert.deepEqual(
    current.state.stocks[work.transfer.destination.stockId],
    work.effects.destination.after
  );
  for (const [id, stock] of Object.entries(proof.baselineState.stocks))
    if (id !== proof.sourceStockId) assert.deepEqual(current.state.stocks[id], stock);
  for (const [id, prior] of Object.entries(proof.baselineState.scientificWorks))
    assert.deepEqual(current.state.scientificWorks[id], prior);
  assert.equal(
    Object.keys(current.state.scientificWorks).length,
    Object.keys(proof.baselineState.scientificWorks).length + 1
  );
  assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  const { stocks, scientificWorks, revision, lastRecordedAt, ...rest } = current.state,
    {
      stocks: oldStocks,
      scientificWorks: oldWorks,
      revision: oldRevision,
      lastRecordedAt: oldClock,
      ...before
    } = proof.baselineState;
  assert.deepEqual(rest, before);
}
export async function runInventoryProtocolRunJourney(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(current.state.schema, 'dnaforge.inventory.v24');
  assert.equal(current.state.revision, 92);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const prior = ctx.fixture.scientificJourney,
    sourceStockId = prior.sourceStockId,
    originalWell = current.state.vessels[prior.destinationVesselId],
    destination = Object.values(current.state.vessels).find(
      (v) =>
        v.kind === 'fixed-well' &&
        v.lifecycle === 'active' &&
        v.contentsKnowledge.kind === 'recorded' &&
        v.placement.kind === 'located' &&
        v.placement.storageId === originalWell.placement.storageId &&
        v.placement.slotId === 'A2' &&
        !Object.values(current.state.stocks).some((s) => s.vesselId === v.id)
    );
  assert.ok(destination, 'The earlier preview left a real empty permanent A2.');
  const availability = await ctx.page.evaluate(
    (input) => window.electronAPI.inventory.availability(input),
    ctx.fixture.scope
  );
  assert.equal(availability.stocks[sourceStockId].actions.withdraw.kind, 'allowed');
  assert.deepEqual(current.state.stocks[sourceStockId].quantity, {
    kind: 'known',
    value: '70',
    unit: 'uL',
  });
  const tag = randomUUID().slice(0, 8);
  return finish({
    ...ctx,
    fixture: {
      ...ctx.fixture,
      protocolRunJourney: {
        initialRevision: 92,
        completedStep: 0,
        creationStage: 'none',
        baselineState: current.state,
        baselineHistory: current.history,
        protocolTitle: `Manual transfer protocol ${tag}`,
        runTitle: `Manual transfer run ${tag}`,
        stepTitle: `Transfer into permanent plate ${tag}`,
        stepText: `Observe a completed10microliter manual transfer for${tag}; recording a run alone moves no stock.`,
        laterStepText: `Later template revision ${tag}; the existing run keeps its earlier saved definition.`,
        namespace: 'desktop-run-observations',
        physicalWorkId: randomUUID(),
        sourceStockId,
        destinationVesselId: destination.id,
      },
    },
  });
}
export async function runInventoryProtocolRunResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'protocol-run-after-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  return finish(ctx);
}
async function finish(ctx) {
  const { page, expect, fixture, evidenceDirectory } = ctx;
  let proof = fixture.protocolRunJourney,
    current = await ctx.inventoryRead(fixture.scope);
  const checkpoint = () => {
    const saved = {
      ...fixture,
      ...current,
      protocolRunJourney: proof,
      resumePhase: 'protocol-run-after-stage',
    };
    writeFileSync(
      path.join(
        evidenceDirectory,
        `${String(proof.completedStep).padStart(2, '0')}-protocol-run-checkpoint.json`
      ),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  const unchanged = async () => {
    const observed = await ctx.inventoryRead(fixture.scope);
    assert.deepEqual(observed.state, current.state);
    assert.deepEqual(observed.history, current.history);
  };
  checkpoint();
  if (proof.completedStep < 1) {
    let saved = (await packages(page, fixture.scope.project, 'protocol', proof.protocolTitle)).find(
      (item) => item.title === proof.protocolTitle
    );
    if (!saved) {
      const form = await newProtocolDialog(ctx);
      if (proof.creationStage === 'protocol-started') {
        await button(form, 'Check original operation').click();
        if (await button(form, 'Retry same operation').isVisible())
          await button(form, 'Retry same operation').click();
      } else {
        await field(form, 'Protocol title').fill(proof.protocolTitle);
        proof = { ...proof, creationStage: 'protocol-started' };
        checkpoint();
        await button(form, 'Create protocol').click();
      }
      await expect
        .poll(
          async () =>
            (await packages(page, fixture.scope.project, 'protocol', proof.protocolTitle)).some(
              (item) => item.title === proof.protocolTitle
            ),
          { timeout: 30000 }
        )
        .toBe(true);
      saved = (await packages(page, fixture.scope.project, 'protocol', proof.protocolTitle)).find(
        (item) => item.title === proof.protocolTitle
      );
    }
    proof = { ...proof, protocol: saved, completedStep: 1, creationStage: 'protocol-ready' };
    checkpoint();
    const view = page.getByTestId('scientific-document-tab');
    await expect(field(view, 'Document title')).toHaveValue(proof.protocolTitle);
    await unchanged();
    await ctx.capture('01-real-protocol-created-with-no-inventory-effect', {
      ...current,
      protocol: saved,
    });
  }
  if (proof.completedStep < 2) {
    const view = await openPackage(ctx, proof.protocol);
    await field(view, 'Step 1 title').fill(proof.stepTitle);
    await field(view, 'Step 1 content').fill(proof.stepText);
    await expect(button(view, 'Start run')).toBeDisabled();
    await unchanged();
    await ctx.capture('02-unsaved-definition-blocks-start-run', current);
    await button(view, 'Save').click();
    await expect(button(view, 'Start run')).toBeEnabled();
    const saved = await page.evaluate((input) => window.electronAPI.protocols.readPackage(input), {
      project: fixture.scope.project,
      entityId: proof.protocol.entityId,
    });
    proof = { ...proof, savedProtocol: saved, completedStep: 2 };
    checkpoint();
    assert.notEqual(saved.sourceSha256, proof.protocol.sourceSha256);
    assert.ok(saved.originalText.includes(proof.stepText));
    assert.deepEqual(
      JSON.parse(saved.originalText).version,
      JSON.parse(proof.protocol.originalText).version
    );
    await unchanged();
    await ctx.capture('03-saved-edited-definition-with-original-declaration', {
      ...current,
      protocol: saved,
    });
  }
  if (proof.completedStep < 3) {
    let saved = (await packages(page, fixture.scope.project, 'protocol-run', proof.runTitle)).find(
      (item) => item.title === proof.runTitle
    );
    if (!saved) {
      const view = await openPackage(ctx, proof.savedProtocol);
      await button(view, 'Start run').click();
      const form = page.getByRole('dialog', { name: 'Start run', exact: true });
      if (proof.creationStage === 'run-started') {
        await button(form, 'Check original operation').click();
        if (await button(form, 'Retry same operation').isVisible())
          await button(form, 'Retry same operation').click();
      } else {
        await field(form, 'Run title').fill(proof.runTitle);
        proof = { ...proof, creationStage: 'run-started' };
        checkpoint();
        await button(form, 'Start run').click();
      }
      await expect
        .poll(
          async () =>
            (await packages(page, fixture.scope.project, 'protocol-run', proof.runTitle)).some(
              (item) => item.title === proof.runTitle
            ),
          { timeout: 30000 }
        )
        .toBe(true);
      saved = (await packages(page, fixture.scope.project, 'protocol-run', proof.runTitle)).find(
        (item) => item.title === proof.runTitle
      );
    }
    proof = { ...proof, run: saved, completedStep: 3, creationStage: 'run-ready' };
    checkpoint();
    const run = JSON.parse(saved.originalText);
    assert.equal(run.frozenProtocol.source.sourceSha256, proof.savedProtocol.sourceSha256);
    assert.equal(run.frozenProtocol.source.originalText, proof.savedProtocol.originalText);
    assert.equal(run.frozenProtocol.definitionSha256, proof.savedProtocol.definitionSha256);
    await expect(page.getByTestId('run-frozen-protocol')).toContainText(proof.stepText);
    await unchanged();
    await ctx.capture('04-run-keeps-actual-saved-definition-with-no-stock-movement', {
      ...current,
      run: saved,
    });
  }
  if (proof.completedStep < 4) {
    const oldEntry = current.history.find(
      (entry) => entry.request.kind === 'record-scientific-transfer'
    );
    assert.ok(oldEntry);
    const old = oldEntry.request.choices,
      choices = {
        identity: old.identity,
        context: {
          kind: 'notebook-page',
          entityId: old.pageId,
          sourceSha256: old.expectedSourceSha256,
        },
        sourceStockId: old.sourceStockId,
        destinationVesselId: old.destinationVesselId,
        quantity: old.quantity,
        reason: old.reason,
      };
    const result = await page.evaluate(
      (input) => window.electronAPI.inventory.applyScientificTransferV2(input),
      {
        ...fixture.scope,
        kind: 'record-scientific-transfer-v2',
        operationId: randomUUID(),
        expectedRevision: current.state.revision,
        choices,
        expectedPlanDigest: oldEntry.request.expectedPlanDigest,
      }
    );
    assert.equal(result.status, 'rejected');
    assert.equal(result.code, 'INVENTORY_SCIENTIFIC_NO_CHANGES');
    await unchanged();
    proof = {
      ...proof,
      completedStep: 4,
      notebookCompatibility: {
        originalOperationId: oldEntry.request.operationId,
        originalSourceSha256: old.expectedSourceSha256,
        result,
      },
    };
    checkpoint();
    await ctx.capture('05-original-notebook-observation-through-V2-remains-no-change', {
      ...current,
      compatibility: proof.notebookCompatibility,
    });
  }
  if (proof.completedStep < 5) {
    await closeDialogs(page);
    await page.getByTestId('inventory-button').click();
    await ctx.choose(page, 'Inventory project', fixture.project.name);
    await button(page, 'Record scientific transfer').click();
    const form = page.getByRole('dialog', { name: 'Record scientific transfer', exact: true });
    await button(form, 'Start a separate observation').click();
    await field(form, 'Work namespace').fill(proof.namespace);
    await field(form, 'Physical work ID').fill(proof.physicalWorkId);
    await ctx.choose(form, 'Scientific context kind', 'Protocol run');
    await field(form, 'Find saved protocol run').fill(proof.runTitle);
    await ctx.choose(form, 'Saved protocol run', new RegExp(`^${escape(proof.runTitle)}`));
    await ctx.choose(form, 'Source stock', new RegExp(escape(proof.sourceStockId)));
    await ctx.choose(
      form,
      'Destination permanent well',
      new RegExp(escape(proof.destinationVesselId))
    );
    await field(form, 'Observed transfer amount').fill('10');
    await ctx.choose(form, 'Observed amount unit', 'µL');
    await field(form, 'Completed manual observation reason').fill(
      'Operator reports a separately completed manual transfer linked to the saved run; creating the run did not execute it'
    );
    await button(form, 'Preview observed transfer').click();
    await expect(form.getByTestId('inventory-scientific-transfer')).toHaveAttribute(
      'data-preview-state',
      'ready'
    );
    await unchanged();
    await ctx.capture('06-run-observation-preview-with-no-debit', current);
    await button(form, 'Record completed manual transfer').click();
    try {
      const accepted = await page.waitForFunction(
        async ({ scope, revision }) =>
          (await window.electronAPI.inventory.inspect(scope)).revision > revision,
        { scope: fixture.scope, revision: proof.initialRevision },
        { timeout: 30000, polling: 50 }
      );
      await accepted.dispose();
    } finally {
      current = await ctx.inventoryRead(fixture.scope);
      if (current.state.revision > proof.initialRevision) {
        proof = { ...proof, completedStep: 5 };
        checkpoint();
      }
    }
    await expect(form).toBeHidden();
    assertWork({ ...fixture, protocolRunJourney: proof }, current);
    await ctx.capture('07-one-run-linked-transfer-source60-wellA2ten', current);
  }
  if (proof.completedStep < 6) {
    const view = await openPackage(ctx, proof.savedProtocol);
    await field(view, 'Step 1 content').fill(proof.laterStepText);
    await button(view, 'Save').click();
    await expect(button(view, 'Start run')).toBeEnabled();
    const template = await page.evaluate(
      (input) => window.electronAPI.protocols.readPackage(input),
      { project: fixture.scope.project, entityId: proof.protocol.entityId }
    );
    proof = { ...proof, editedProtocol: template, completedStep: 6 };
    checkpoint();
    assert.notEqual(template.sourceSha256, proof.savedProtocol.sourceSha256);
    await unchanged();
    await ctx.capture('08-later-template-edit-does-not-repeat-physical-work', {
      ...current,
      template,
    });
  }
  if (proof.completedStep < 7) {
    const title = `${proof.runTitle} Files refresh`;
    let saved = (await packages(page, fixture.scope.project, 'protocol-run', title)).find(
      (item) => item.title === title
    );
    if (!saved) {
      const view = await openPackage(ctx, proof.editedProtocol);
      await button(view, 'Start run').click();
      const form = page.getByRole('dialog', { name: 'Start run', exact: true });
      if (proof.creationStage === 'notification-run-started') {
        await button(form, 'Check original operation').click();
        if (await button(form, 'Retry same operation').isVisible())
          await button(form, 'Retry same operation').click();
      } else {
        await field(form, 'Run title').fill(title);
        proof = { ...proof, creationStage: 'notification-run-started' };
        checkpoint();
        await button(form, 'Start run').click();
      }
      await expect(form).toBeHidden();
      saved = (await packages(page, fixture.scope.project, 'protocol-run', title)).find(
        (item) => item.title === title
      );
    }
    assert.ok(saved, 'The separate tracking run must be registered once.');
    proof = {
      ...proof,
      notificationRun: saved,
      completedStep: 7,
      creationStage: 'notification-run-ready',
    };
    checkpoint();
    const packageRoot = saved.path.replace(/\/.forge\/protocol-run\.json$/u, '');
    await expect(page.locator(`[data-entry-path="${packageRoot}"]`)).toBeVisible();
    assert.equal(
      JSON.parse(saved.originalText).frozenProtocol.source.originalText,
      proof.editedProtocol.originalText
    );
    await unchanged();
    await ctx.capture('09-new-tracking-run-appears-in-Files-with-no-inventory-effect', {
      ...current,
      notificationRun: saved,
    });
  }
  const result = checkpoint();
  await finalPresentation(
    { ...ctx, fixture: result },
    current,
    '09-original-frozen-run-and-retained-work-after-template-edit'
  );
  writeFileSync(
    path.join(evidenceDirectory, 'protocol-run-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}
async function finalPresentation(ctx, current, name) {
  const { page, expect, fixture } = ctx,
    proof = fixture.protocolRunJourney;
  assertWork(fixture, current);
  const run = await page.evaluate((input) => window.electronAPI.protocols.readPackage(input), {
    project: fixture.scope.project,
    entityId: proof.run.entityId,
  });
  assert.equal(run.originalText, proof.run.originalText);
  assert.equal(run.sourceSha256, proof.run.sourceSha256);
  await openPackage(ctx, run);
  await expect(page.getByTestId('run-frozen-protocol')).toContainText(proof.stepText);
  await expect(page.getByTestId('run-frozen-protocol')).not.toContainText(proof.laterStepText);
  const work = runWork(fixture, current.state),
    source = await page.evaluate((input) => window.electronAPI.inventory.scientificSource(input), {
      ...fixture.scope,
      workId: work.id,
    });
  assert.equal(source.kind, 'available');
  assert.equal(source.source.originalText, proof.run.originalText);
  assert.equal(source.sourceSha256, proof.run.sourceSha256);
  const creation = await page.evaluate(
    (input) => window.electronAPI.protocols.inspectCreation(input),
    { project: fixture.scope.project, requestId: proof.run.creationRequestId }
  );
  assert.equal(creation.kind, 'ready');
  assert.equal(creation.package.entityId, proof.run.entityId);
  const unchanged = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(unchanged.state, current.state);
  assert.deepEqual(unchanged.history, current.history);
  await ctx.capture(name, { ...current, run, source, creation });
}
export async function runInventoryProtocolRunReopen(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  await finalPresentation(
    ctx,
    current,
    'reopened-exact-native-run-frozen-definition-and-inventory93'
  );
  return { ...ctx.fixture, ...current };
}

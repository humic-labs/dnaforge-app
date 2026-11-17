import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const contexts = (page, scope) =>
  page.evaluate((input) => window.electronAPI.inventory.scientificContexts(input), scope);
async function closeDialogs(page) {
  for (
    let attempt = 0;
    attempt < 3 && (await page.getByTestId('inventory-physical-dialog').count());
    attempt++
  )
    await page.keyboard.press('Escape');
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
}
async function openForm(ctx) {
  await closeDialogs(ctx.page);
  await ctx.page.getByTestId('inventory-button').click();
  await ctx.expect(ctx.page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
  await ctx.choose(ctx.page, 'Inventory project', ctx.fixture.project.name);
  await button(ctx.page, 'Record scientific transfer').click();
  return ctx.page.getByRole('dialog', { name: 'Record scientific transfer', exact: true });
}
function recordOf(fixture, state) {
  const proof = fixture.scientificJourney;
  const work = Object.values(state.scientificWorks).find(
    (work) =>
      work.identity.workId === proof.physicalWorkId && work.identity.namespace === proof.namespace
  );
  assert.ok(work, 'The stable observed work identity is recorded once.');
  return work;
}
function assertObserved(fixture, current) {
  const proof = fixture.scientificJourney,
    work = recordOf(fixture, current.state),
    baseline = proof.baselineState;
  assert.equal(current.state.revision, proof.initialRevision + 1);
  assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  assert.equal(
    Object.keys(current.state.scientificWorks).length,
    Object.keys(baseline.scientificWorks).length + 1
  );
  assert.equal(work.context.pageId, proof.pageId);
  assert.equal(work.context.source.sha256, proof.sourceSha256);
  assert.equal(work.context.source.title, proof.pageTitle);
  assert.equal(work.context.source.kind, 'native-observed-saved-source');
  assert.deepEqual(work.observation, { kind: 'completed-manual-transfer' });
  assert.deepEqual(work.transfer.quantity, { value: '10', unit: 'uL' });
  assert.equal(work.transfer.sourceStockId, proof.sourceStockId);
  assert.equal(work.transfer.destination.vesselId, proof.destinationVesselId);
  assert.deepEqual(work.effects.source.before, baseline.stocks[proof.sourceStockId]);
  assert.deepEqual(work.effects.source.after.quantity, {
    kind: 'known',
    value: String(Number(work.effects.source.before.quantity.value) - 10),
    unit: 'uL',
  });
  assert.deepEqual(work.effects.destination.after.quantity, {
    kind: 'known',
    value: '10',
    unit: 'uL',
  });
  assert.equal(work.effects.destination.after.materialId, work.effects.source.before.materialId);
  assert.deepEqual(
    work.effects.destination.after.lotConstraints,
    work.effects.source.before.lotConstraints
  );
  assert.equal(work.effects.destination.vessel.kind, 'fixed-well');
  assert.equal(work.effects.destination.vessel.placement.slotId, 'A1');
  assert.deepEqual(current.state.stocks[proof.sourceStockId], work.effects.source.after);
  assert.deepEqual(
    current.state.stocks[work.transfer.destination.stockId],
    work.effects.destination.after
  );
  for (const [id, stock] of Object.entries(baseline.stocks))
    if (id !== proof.sourceStockId) assert.deepEqual(current.state.stocks[id], stock);
  const { stocks, scientificWorks, revision, lastRecordedAt, ...other } = current.state;
  const {
    stocks: oldStocks,
    scientificWorks: oldWorks,
    revision: oldRevision,
    lastRecordedAt: oldClock,
    ...oldOther
  } = baseline;
  assert.deepEqual(
    other,
    oldOther,
    'The observation does not modify notebooks, physical locations, lots or unrelated inventory facts.'
  );
}
export async function runInventoryScientificJourney(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.equal(current.state.schema, 'dnaforge.inventory.v23');
  assert.equal(current.state.revision, 91);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  const availability = await ctx.page.evaluate(
    (scope) => window.electronAPI.inventory.availability(scope),
    ctx.fixture.scope
  );
  assert.equal(availability.revision, current.state.revision);
  const source = Object.values(current.state.stocks).find((stock) => {
    const free = availability.stocks[stock.id]?.unreserved;
    return (
      stock.quantity.kind === 'known' &&
      stock.quantity.unit === 'uL' &&
      /^\d+$/u.test(stock.quantity.value) &&
      Number(stock.quantity.value) <= 1000000 &&
      availability.stocks[stock.id]?.actions.withdraw.kind === 'allowed' &&
      free.kind === 'known' &&
      free.unit === 'uL' &&
      Number(free.value) >= 10
    );
  });
  assert.ok(
    source,
    'Choose a real currently admitted source, never infer usability from its label.'
  );
  const destination = Object.values(current.state.vessels).find(
    (vessel) =>
      vessel.kind === 'fixed-well' &&
      vessel.lifecycle === 'active' &&
      vessel.placement.kind === 'located' &&
      vessel.placement.slotId === 'A1' &&
      !Object.values(current.state.stocks).some((stock) => stock.vesselId === vessel.id) &&
      vessel.contentsKnowledge.kind === 'recorded'
  );
  assert.ok(destination, 'Use a real existing empty permanent wellA1.');
  const tag = randomUUID().slice(0, 8);
  return finish({
    ...ctx,
    fixture: {
      ...ctx.fixture,
      scientificJourney: {
        initialRevision: current.state.revision,
        completedStep: 0,
        notebookStage: 'not-started',
        baselineState: current.state,
        baselineHistory: current.history,
        namespace: 'desktop-manual-observations',
        physicalWorkId: randomUUID(),
        pageTitle: `Scientific observation ${tag}`,
        description: `Manual transfer observation ${tag}: transfer10microliters into permanent wellA1. No biological success is inferred.`,
        sourceStockId: source.id,
        destinationVesselId: destination.id,
      },
    },
  });
}
export async function runInventoryScientificResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'scientific-after-accepted-stage');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  if (ctx.fixture.scientificJourney.completedStep) assertObserved(ctx.fixture, current);
  return finish(ctx);
}
async function finish(ctx) {
  const { page, expect, fixture, evidenceDirectory } = ctx;
  let proof = fixture.scientificJourney,
    current = await ctx.inventoryRead(fixture.scope);
  const checkpoint = () => {
    const saved = {
      ...fixture,
      ...current,
      scientificJourney: proof,
      resumePhase: 'scientific-after-accepted-stage',
    };
    writeFileSync(
      path.join(
        evidenceDirectory,
        `${String(proof.completedStep).padStart(2, '0')}-scientific-checkpoint.json`
      ),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint();
  if (!proof.completedStep && proof.notebookStage !== 'saved') {
    const existing = (await contexts(page, fixture.scope)).pages.find(
      (item) => item.title === proof.pageTitle
    );
    if (existing)
      proof = {
        ...proof,
        pageId: existing.pageId,
        sourceSha256: existing.sourceSha256,
        notebookStage: 'saved',
      };
    else {
      assert.equal(
        proof.notebookStage,
        'not-started',
        'Notebook creation was already started. Inspect the existing visible page and complete its save before resuming; never create it again.'
      );
      proof = { ...proof, notebookStage: 'creating' };
      checkpoint();
      await closeDialogs(page);
      await page.getByTestId('files-button').click();
      const root = page.locator('[data-workspace-root-path]').filter({
        has: page.locator(`[role="treeitem"][data-entry-path="${fixture.project.path}"]`),
      });
      await root
        .locator(`[role="treeitem"][data-entry-path="${fixture.project.path}"]`)
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'New…', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'Notebook Entry', exact: true }).click();
      await page
        .getByRole('menu', { name: 'Notebook Entry actions', exact: true })
        .getByRole('menuitem', { name: 'Create', exact: true })
        .click();
      const rename = page.getByTestId('file-tree-rename-input');
      await rename.fill(proof.pageTitle);
      await rename.press('Enter');
      await expect(page.getByTestId('notebook-title')).toHaveText(proof.pageTitle);
      const editor = page
        .getByTestId('notebook-editor-body')
        .locator('[contenteditable="true"]')
        .first();
      await editor.fill(proof.description);
      const save = button(page, 'Save now');
      if (await save.isVisible()) await save.click();
      else await editor.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
      await expect
        .poll(
          async () =>
            (await contexts(page, fixture.scope)).pages.some(
              (item) => item.title === proof.pageTitle
            ),
          { timeout: 30000 }
        )
        .toBe(true);
      const savedPage = (await contexts(page, fixture.scope)).pages.find(
        (item) => item.title === proof.pageTitle
      );
      proof = {
        ...proof,
        pageId: savedPage.pageId,
        sourceSha256: savedPage.sourceSha256,
        notebookStage: 'saved',
      };
    }
    checkpoint();
    const unchanged = await ctx.inventoryRead(fixture.scope);
    assert.deepEqual(unchanged.state, current.state);
    assert.deepEqual(unchanged.history, current.history);
    await ctx.capture('01-real-notebook-created-saved-and-settled', { ...current, page: proof });
  }
  if (!proof.completedStep) {
    const form = await openForm(ctx);
    await field(form, 'Work namespace').fill(proof.namespace);
    await field(form, 'Physical work ID').fill(proof.physicalWorkId);
    await field(form, 'Find saved notebook page').fill(proof.pageTitle);
    await ctx.choose(form, 'Saved notebook page', new RegExp(`^${escape(proof.pageTitle)}`));
    await ctx.choose(form, 'Source stock', new RegExp(escape(proof.sourceStockId)));
    await ctx.choose(
      form,
      'Destination permanent well',
      new RegExp(escape(proof.destinationVesselId))
    );
    await field(form, 'Observed transfer amount').fill('10');
    await ctx.choose(form, 'Observed amount unit', 'µL');
    await field(form, 'Completed manual observation reason').fill(
      `Operator reports completed manual transfer for${proof.pageTitle}; no instrument or biological outcome is asserted`
    );
    await button(form, 'Preview observed transfer').click();
    await expect(form.getByTestId('inventory-scientific-transfer')).toHaveAttribute(
      'data-preview-state',
      'ready'
    );
    const unchanged = await ctx.inventoryRead(fixture.scope);
    assert.deepEqual(unchanged.state, current.state);
    assert.deepEqual(unchanged.history, current.history);
    await ctx.capture('02-preview-with-no-stock-debit', unchanged);
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
        proof = { ...proof, completedStep: 1 };
        checkpoint();
      }
    }
    await expect(form).toBeHidden();
    assertObserved({ ...fixture, scientificJourney: proof }, current);
    await ctx.capture('03-one-observed-transfer-and-pinned-saved-context', current);
  }
  const result = checkpoint();
  await presentation(
    { ...ctx, fixture: result },
    current,
    '04-duplicate-no-debit-and-retained-saved-context'
  );
  writeFileSync(
    path.join(evidenceDirectory, 'scientific-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}
async function presentation(ctx, current, name) {
  const { page, expect, fixture } = ctx,
    proof = fixture.scientificJourney,
    work = recordOf(fixture, current.state),
    form = await openForm(ctx);
  await expect(field(form, 'Physical work ID')).toHaveValue(proof.physicalWorkId);
  await button(form, 'Preview observed transfer').click();
  await expect(form.getByTestId('inventory-scientific-transfer')).toHaveAttribute(
    'data-preview-state',
    'no-change'
  );
  await expect(button(form, 'Record completed manual transfer')).toBeDisabled();
  const facts = form.locator(`[data-scientific-work-id="${work.id}"]`).first();
  await button(facts, 'Read retained saved context').click();
  await expect(field(facts, 'Retained saved notebook context')).toHaveValue(
    new RegExp(escape(proof.description))
  );
  const source = await page.evaluate(
    (input) => window.electronAPI.inventory.scientificSource(input),
    { ...fixture.scope, workId: work.id }
  );
  assert.equal(source.kind, 'available');
  assert.equal(source.sourceSha256, proof.sourceSha256);
  assert.equal(source.source.pageId, proof.pageId);
  assert.ok(JSON.stringify(source.source.content).includes(proof.description));
  const unchanged = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(unchanged.state, current.state);
  assert.deepEqual(unchanged.history, current.history);
  await ctx.capture(name, { ...current, source });
  await button(facts, 'Open current notebook').click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId('notebook-title')).toHaveText(proof.pageTitle);
  await expect(page.getByTestId('notebook-editor-body')).toContainText(proof.description);
  await ctx.capture(`${name}-current-notebook-navigation`, current);
}
export async function runInventoryScientificReopen(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertObserved(ctx.fixture, current);
  if (ctx.fixture.scientificSourceEditJourney) return reopenEditedSource(ctx, current);
  await presentation(
    ctx,
    current,
    'reopened-exact-observed-transfer-and-retained-notebook-context'
  );
  return { ...ctx.fixture, ...current };
}

function scientificWorkCard(form, workId) {
  return form.locator(`[data-scientific-work-id="${workId}"]`).filter({ visible: true });
}
async function historicalContext(ctx, current, captureName) {
  const { fixture, page, expect } = ctx,
    proof = fixture.scientificJourney,
    edit = fixture.scientificSourceEditJourney,
    work = recordOf(fixture, current.state),
    form = await openForm(ctx);
  const history = form
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: /^Recorded scientific work/ }) });
  await history.locator('summary').first().click();
  const facts = scientificWorkCard(history, work.id);
  await button(facts, 'Read retained saved context').click();
  const text = field(facts, 'Retained saved notebook context');
  await expect(text).toHaveValue(new RegExp(escape(proof.description)));
  await expect(text).not.toHaveValue(new RegExp(escape(edit.appendedText)));
  const source = await page.evaluate(
    (input) => window.electronAPI.inventory.scientificSource(input),
    { ...fixture.scope, workId: work.id }
  );
  assert.equal(source.kind, 'available');
  assert.equal(source.sourceSha256, proof.sourceSha256);
  assert.ok(JSON.stringify(source.source.content).includes(proof.description));
  assert.ok(!JSON.stringify(source.source.content).includes(edit.appendedText));
  if (captureName) await ctx.capture(captureName, { ...current, retainedOriginal: source });
  return { form, facts, source };
}
async function previewEditedSource(ctx, current, captureName) {
  const { fixture, page, expect } = ctx,
    edit = fixture.scientificSourceEditJourney,
    proof = fixture.scientificJourney,
    form = await openForm(ctx);
  const work = recordOf(fixture, current.state);
  if ((await field(form, 'Physical work ID').inputValue()) !== edit.candidateWorkId)
    await button(form, 'Start a separate observation').click();
  await field(form, 'Work namespace').fill(proof.namespace);
  await field(form, 'Physical work ID').fill(edit.candidateWorkId);
  await field(form, 'Find saved notebook page').fill(proof.pageTitle);
  await ctx.choose(form, 'Saved notebook page', new RegExp(`^${escape(proof.pageTitle)}`));
  await ctx.choose(form, 'Source stock', new RegExp(escape(proof.sourceStockId)));
  await ctx.choose(
    form,
    'Destination permanent well',
    new RegExp(escape(edit.destinationVesselId))
  );
  await field(form, 'Observed transfer amount').fill('10');
  await ctx.choose(form, 'Observed amount unit', 'µL');
  await field(form, 'Completed manual observation reason').fill(
    'Preview only a separately identified manual observation with the edited saved page; this preview must not debit stock'
  );
  await expect(field(form, 'Physical work ID')).toHaveValue(edit.candidateWorkId);
  assert.notEqual(edit.candidateWorkId, work.identity.workId);
  await expect(form.locator('[data-selected-scientific-source-sha]')).toContainText(
    edit.sourceSha256
  );
  await button(form, 'Preview observed transfer').click();
  await expect(form.getByTestId('inventory-scientific-transfer')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  await expect(button(form, 'Record completed manual transfer')).toBeEnabled();
  const candidate = form.locator('[data-scientific-work-id]').first();
  await expect(candidate).toContainText(edit.sourceSha256);
  assert.notEqual(await candidate.getAttribute('data-scientific-work-id'), work.id);
  await expect(candidate).toContainText('70 µL → 60 µL');
  const unchanged = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(unchanged.state, current.state);
  assert.deepEqual(unchanged.history, current.history);
  await ctx.capture(captureName, {
    ...unchanged,
    currentSavedSourceSha256: edit.sourceSha256,
    candidateWorkId: edit.candidateWorkId,
  });
  await button(form, 'Cancel').click();
  const afterCancel = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(afterCancel.state, current.state);
  assert.deepEqual(afterCancel.history, current.history);
}
export async function runInventoryScientificSourceEdit(ctx) {
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertObserved(ctx.fixture, current);
  assert.equal(current.state.revision, 92);
  const original = ctx.fixture.scientificJourney,
    originalWell = current.state.vessels[original.destinationVesselId],
    empty = Object.values(current.state.vessels).filter(
      (vessel) =>
        vessel.kind === 'fixed-well' &&
        vessel.lifecycle === 'active' &&
        vessel.placement.kind === 'located' &&
        vessel.id !== original.destinationVesselId &&
        vessel.contentsKnowledge.kind === 'recorded' &&
        !Object.values(current.state.stocks).some((stock) => stock.vesselId === vessel.id)
    ),
    destination =
      empty.find(
        (vessel) =>
          vessel.placement.storageId === originalWell.placement.storageId &&
          vessel.placement.slotId === 'A2'
      ) ??
      empty.find((vessel) => vessel.placement.slotId === 'A2') ??
      empty[0];
  assert.ok(
    destination,
    'Preview another actual empty permanent well, never the already populated A1.'
  );
  const availability = await ctx.page.evaluate(
    (scope) => window.electronAPI.inventory.availability(scope),
    ctx.fixture.scope
  );
  assert.equal(availability.revision, current.state.revision);
  assert.equal(availability.stocks[original.sourceStockId].actions.withdraw.kind, 'allowed');
  const tag = randomUUID().slice(0, 8);
  return finishSourceEdit({
    ...ctx,
    fixture: {
      ...ctx.fixture,
      scientificSourceEditJourney: {
        initialRevision: current.state.revision,
        completedStep: 0,
        notebookStage: 'not-started',
        originalWorkId: recordOf(ctx.fixture, current.state).id,
        candidateWorkId: randomUUID(),
        destinationVesselId: destination.id,
        appendedText: `Separate saved follow-up ${tag}: revised experiment context; no additional transfer was recorded.`,
        originalSourceSha256: original.sourceSha256,
      },
    },
  });
}
export async function runInventoryScientificSourceEditResume(ctx) {
  assert.equal(ctx.fixture.resumePhase, 'scientific-source-edit-checkpoint');
  const current = await ctx.inventoryRead(ctx.fixture.scope);
  assert.deepEqual(current.state, ctx.fixture.state);
  assert.deepEqual(current.history, ctx.fixture.history);
  assertObserved(ctx.fixture, current);
  return finishSourceEdit(ctx);
}
async function finishSourceEdit(ctx) {
  const { page, expect, fixture, evidenceDirectory } = ctx,
    original = fixture.scientificJourney;
  let edit = fixture.scientificSourceEditJourney;
  const current = await ctx.inventoryRead(fixture.scope);
  const checkpoint = () => {
    const saved = {
      ...fixture,
      ...current,
      scientificSourceEditJourney: edit,
      resumePhase: 'scientific-source-edit-checkpoint',
    };
    writeFileSync(
      path.join(
        evidenceDirectory,
        `${String(edit.completedStep).padStart(2, '0')}-scientific-source-edit-checkpoint.json`
      ),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint();
  if (edit.notebookStage !== 'saved') {
    const live = (await contexts(page, fixture.scope)).pages.find(
      (item) => item.pageId === original.pageId
    );
    if (live && live.sourceSha256 !== original.sourceSha256 && edit.notebookStage === 'editing')
      edit = { ...edit, sourceSha256: live.sourceSha256, notebookStage: 'saved', completedStep: 1 };
    else {
      assert.equal(
        edit.notebookStage,
        'not-started',
        'The notebook edit was already started. Inspect and save the existing edit before resuming; never append it twice.'
      );
      assert.equal(live?.sourceSha256, original.sourceSha256);
      const view = await historicalContext(
        { ...ctx, fixture: { ...fixture, scientificSourceEditJourney: edit } },
        current
      );
      await button(view.facts, 'Open current notebook').click();
      await expect(view.form).toBeHidden();
      await expect(page.getByTestId('notebook-title')).toHaveText(original.pageTitle);
      edit = { ...edit, notebookStage: 'editing' };
      checkpoint();
      const editor = page
        .getByTestId('notebook-editor-body')
        .locator('[contenteditable="true"]')
        .first();
      await editor.click();
      await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
      await editor.press('End');
      await editor.press('Enter');
      await page.keyboard.insertText(edit.appendedText);
      const save = button(page, 'Save now');
      if (await save.isVisible()) await save.click();
      else await editor.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
      await expect
        .poll(
          async () => {
            const saved = (await contexts(page, fixture.scope)).pages.find(
              (item) => item.pageId === original.pageId
            );
            return saved && saved.sourceSha256 !== original.sourceSha256
              ? saved.sourceSha256
              : null;
          },
          { timeout: 30000 }
        )
        .not.toBeNull();
      const saved = (await contexts(page, fixture.scope)).pages.find(
        (item) => item.pageId === original.pageId
      );
      edit = {
        ...edit,
        sourceSha256: saved.sourceSha256,
        notebookStage: 'saved',
        completedStep: 1,
      };
    }
    checkpoint();
  }
  assert.notEqual(edit.sourceSha256, edit.originalSourceSha256);
  const savedFixture = checkpoint(),
    next = { ...ctx, fixture: savedFixture };
  await expect
    .poll(
      async () =>
        (await contexts(page, fixture.scope)).pages.find((item) => item.pageId === original.pageId)
          ?.sourceSha256
    )
    .toBe(edit.sourceSha256);
  const old = await historicalContext(
    next,
    current,
    '01-original-context-retained-after-separate-notebook-edit'
  );
  await button(old.facts, 'Open current notebook').click();
  await expect(old.form).toBeHidden();
  await expect(page.getByTestId('notebook-editor-body')).toContainText(original.description);
  await expect(page.getByTestId('notebook-editor-body')).toContainText(edit.appendedText);
  await ctx.capture('02-current-notebook-shows-separate-saved-edit', current);
  await previewEditedSource(
    next,
    current,
    '03-new-observation-preview-uses-edited-source-without-debit'
  );
  const after = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(after.state, current.state);
  assert.deepEqual(after.history, current.history);
  edit = { ...edit, completedStep: 2 };
  const result = checkpoint();
  writeFileSync(
    path.join(evidenceDirectory, 'scientific-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}
async function reopenEditedSource(ctx, current) {
  const edit = ctx.fixture.scientificSourceEditJourney;
  assert.equal(edit.completedStep, 2);
  assert.equal(current.state.revision, edit.initialRevision);
  assertObserved(ctx.fixture, current);
  const live = (await contexts(ctx.page, ctx.fixture.scope)).pages.find(
    (item) => item.pageId === ctx.fixture.scientificJourney.pageId
  );
  assert.equal(live.sourceSha256, edit.sourceSha256);
  assert.notEqual(live.sourceSha256, edit.originalSourceSha256);
  const old = await historicalContext(
    ctx,
    current,
    'reopened-original-retained-source-versus-edited-current-page'
  );
  await button(old.facts, 'Open current notebook').click();
  await ctx.expect(old.form).toBeHidden();
  await ctx.expect(ctx.page.getByTestId('notebook-editor-body')).toContainText(edit.appendedText);
  await previewEditedSource(ctx, current, 'reopened-new-observation-preview-with-no-second-debit');
  return { ...ctx.fixture, ...current };
}

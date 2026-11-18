import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function dismissSeedPrompt({ page, expect }) {
  const toast = page.locator('[data-toast-definition="dev-registry-seed"]');
  const dismiss = button(toast, 'Not now');
  if (await dismiss.isVisible()) {
    await dismiss.click();
    await expect(toast).toBeHidden();
  }
}
async function openRun(ctx) {
  const { page, fixture, expect } = ctx,
    saved = fixture.protocolRunJourney.run;
  const existing = page.getByTestId('scientific-citation-dialog');
  if (await existing.count()) {
    if (await page.getByRole('option').count()) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('option')).toHaveCount(0);
    }
    await expect(existing).not.toHaveAttribute('data-citation-phase', 'sending');
    if (await button(existing, 'Close').isVisible()) await button(existing, 'Close').click();
    else await button(existing, 'Cancel').click();
  }
  const project = page.locator(`[role="treeitem"][data-entry-path="${fixture.project.path}"]`);
  if (!(await project.isVisible())) await page.getByTestId('files-button').click();
  await expect(project).toBeVisible();
  await page
    .locator(`[data-entry-path="${saved.path.replace(/\/.forge\/protocol-run\.json$/u, '')}"]`)
    .dblclick();
  await expect(page.getByRole('textbox', { name: 'Document title', exact: true })).toHaveValue(
    saved.title
  );
}
function workOf(fixture, state) {
  const original = fixture.protocolRunJourney;
  const work = Object.values(state.scientificWorks).find(
    (entry) =>
      entry.identity.namespace === original.namespace &&
      entry.identity.workId === original.physicalWorkId
  );
  assert.ok(work);
  return work;
}
function physical(state) {
  const {
    schema,
    scientificCitations,
    scientificCitationWithdrawals,
    revision,
    lastRecordedAt,
    ...rest
  } = state;
  return rest;
}
async function sources(ctx) {
  return ctx.page.evaluate((input) => window.electronAPI.inventory.scientificContextsV2(input), {
    ...ctx.fixture.scope,
    kind: 'notebook-page',
    query: ctx.fixture.scientificJourney.pageTitle,
    limit: 50,
  });
}
async function run(ctx, reopen) {
  const { page, expect, fixture, evidenceDirectory } = ctx;
  let current = await ctx.inventoryRead(fixture.scope),
    proof = fixture.scientificCitationsJourney;
  if (reopen) {
    assert.deepEqual(current.state, fixture.state);
    assert.deepEqual(current.history, fixture.history);
  }
  if (!proof) {
    assert.equal(current.state.schema, 'dnaforge.inventory.v25');
    assert.equal(current.state.revision, 93);
    assert.deepEqual(physical(current.state), physical(fixture.state));
    assert.deepEqual(current.history, fixture.history);
    assert.deepEqual(current.state.scientificCitations, {});
    assert.deepEqual(current.state.scientificCitationWithdrawals, {});
    const list = await sources(ctx),
      selected = list.contexts.find((entry) => entry.entityId === fixture.scientificJourney.pageId);
    assert.ok(selected);
    assert.equal(selected.sourceSha256, fixture.scientificSourceEditJourney.sourceSha256);
    const work = workOf(fixture, current.state),
      tag = randomUUID().slice(0, 8);
    proof = {
      completedStep: 0,
      initialRevision: 93,
      baselineState: current.state,
      baselineHistory: current.history,
      workId: work.id,
      workIntentSha256: work.intentSha256,
      selected,
      citationReason: `Saved edited Notebook documents this recorded transfer ${tag}`,
      withdrawalReason: `Withdraw this supporting citation after review ${tag}`,
    };
  }
  const checkpoint = (name = `${proof.completedStep}`) => {
    const saved = {
      ...fixture,
      ...current,
      scientificCitationsJourney: proof,
      resumePhase: 'scientific-citations',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-scientific-citations-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint('00-current-native-memory-upcast');
  const scope = {
    ...fixture.scope,
    workId: proof.workId,
    workIntentSha256: proof.workIntentSha256,
    limit: 20,
  };
  const citationRead = () =>
    page.evaluate((input) => window.electronAPI.inventory.scientificCitations(input), scope);
  const unchangedPhysical = () => {
    assert.deepEqual(physical(current.state), physical(proof.baselineState));
    assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
    assert.deepEqual(current.state.scientificWorks, proof.baselineState.scientificWorks);
  };
  await openRun(ctx);
  const row = () => page.locator(`[data-scientific-work-id="${proof.workId}"]`),
    citations = () => row().getByTestId('scientific-citations');
  await expect(citations()).toBeVisible();
  const recovery = button(page, 'Resume saved change');
  if (await recovery.isVisible()) {
    await recovery.click();
    const form = page.getByTestId('scientific-citation-dialog');
    if (await button(form, 'Check status').isVisible()) await button(form, 'Check status').click();
    if (await button(form, 'Reload saved citations').isVisible())
      await button(form, 'Reload saved citations').click();
    if (await button(form, 'Retry same change').isVisible())
      await button(form, 'Retry same change').click();
    await expect(form).toHaveAttribute('data-citation-phase', 'complete');
    await button(form, 'Close').click();
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint('01-recovered-exact-saved-operation');
  }
  if (proof.completedStep === 0 && proof.citationDraftId) {
    const found = Object.values(current.state.scientificCitations).find(
      (entry) => entry.identity.citationId === proof.citationDraftId
    );
    if (found) {
      proof = { ...proof, citation: found, completedStep: 1 };
      checkpoint('01-accepted-citation-recovered');
    }
  }
  if (proof.completedStep < 1) {
    await button(citations(), 'Add saved citation').click();
    const form = page.getByRole('dialog', { name: 'Add saved citation', exact: true });
    await ctx.choose(
      form,
      'Saved citation source',
      new RegExp(`${escape(proof.selected.entityId)}$`, 'u')
    );
    await form
      .getByRole('textbox', { name: 'Reason for citation', exact: true })
      .fill(proof.citationReason);
    await button(form, 'Preview citation').click();
    await expect(form).toContainText('Ready to add this saved citation.');
    const before = await ctx.inventoryRead(fixture.scope);
    assert.deepEqual(before, { state: current.state, history: current.history });
    proof = { ...proof, citationDraftId: await form.getAttribute('data-citation-draft-id') };
    checkpoint('01-before-citation-submit');
    await button(form, 'Add citation').click();
    await expect.poll(async () => (await ctx.inventoryRead(fixture.scope)).state.revision).toBe(94);
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint('01-citation-accepted-before-assertions');
    const citation = Object.values(current.state.scientificCitations).find(
      (entry) => entry.identity.citationId === proof.citationDraftId
    );
    assert.ok(citation);
    proof = { ...proof, citation, completedStep: 1 };
    checkpoint('01-citation-accepted');
    unchangedPhysical();
    await expect(form).toHaveAttribute('data-citation-phase', 'complete');
    await button(form, 'Close').click();
  }
  const citationRow = () => citations().locator(`[data-citation-id="${proof.citation.id}"]`);
  await expect(citationRow()).toBeVisible();
  await button(citationRow(), 'View saved citation').click();
  await expect(
    citationRow().getByRole('textbox', { name: 'Saved cited notebook context', exact: true })
  ).toHaveValue(new RegExp(escape(fixture.scientificSourceEditJourney.appendedText), 'u'));
  const retained = await page.evaluate(
    (input) => window.electronAPI.inventory.scientificCitationSource(input),
    { ...fixture.scope, citationId: proof.citation.id }
  );
  assert.equal(retained.kind, 'available');
  assert.equal(retained.sourceSha256, proof.selected.sourceSha256);
  const primary = await page.evaluate(
    (input) => window.electronAPI.inventory.scientificSource(input),
    { ...fixture.scope, workId: proof.workId }
  );
  assert.equal(primary.source.originalText, fixture.protocolRunJourney.run.originalText);
  current = await ctx.inventoryRead(fixture.scope);
  unchangedPhysical();
  await dismissSeedPrompt(ctx);
  await ctx.capture(
    reopen
      ? '01-reopened-citation-history-and-retained-source'
      : '02-separate-retained-notebook-citation',
    { ...current, retained, primary }
  );
  await button(citationRow(), 'Open current source').click();
  await expect(page.getByTestId('notebook-editor-body')).toContainText(
    fixture.scientificSourceEditJourney.appendedText
  );
  await openRun(ctx);
  await expect(citationRow()).toBeVisible();
  if (proof.completedStep === 1 && proof.withdrawalDraftId) {
    const found = Object.values(current.state.scientificCitationWithdrawals).find(
      (entry) => entry.identity.withdrawalId === proof.withdrawalDraftId
    );
    if (found) {
      proof = { ...proof, withdrawal: found, completedStep: 2 };
      checkpoint('02-accepted-withdrawal-recovered');
    }
  }
  if (proof.completedStep < 2) {
    await button(citations(), 'Add saved citation').click();
    let form = page.getByRole('dialog', { name: 'Add saved citation', exact: true });
    await ctx.choose(
      form,
      'Saved citation source',
      new RegExp(`${escape(proof.selected.entityId)}$`, 'u')
    );
    await form
      .getByRole('textbox', { name: 'Reason for citation', exact: true })
      .fill('Duplicate preview does not replace the original reason');
    await button(form, 'Preview citation').click();
    await expect(form).toContainText('This saved source is already cited.');
    await expect(form).toContainText(proof.citationReason);
    await expect(button(form, 'Add citation')).toHaveCount(0);
    await button(form, 'Cancel').click();
    const duplicate = await ctx.inventoryRead(fixture.scope);
    assert.deepEqual(duplicate, current);
    await button(citationRow(), 'Withdraw citation').click();
    form = page.getByRole('dialog', { name: 'Withdraw citation', exact: true });
    await form
      .getByRole('textbox', { name: 'Reason for withdrawal', exact: true })
      .fill(proof.withdrawalReason);
    await button(form, 'Preview withdrawal').click();
    await expect(form).toContainText('Ready to record the withdrawal.');
    assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
    proof = { ...proof, withdrawalDraftId: await form.getAttribute('data-citation-draft-id') };
    checkpoint('02-before-withdrawal-submit');
    await button(form, 'Withdraw citation').click();
    await expect.poll(async () => (await ctx.inventoryRead(fixture.scope)).state.revision).toBe(95);
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint('02-withdrawal-accepted-before-assertions');
    const withdrawal = Object.values(current.state.scientificCitationWithdrawals).find(
      (entry) => entry.identity.withdrawalId === proof.withdrawalDraftId
    );
    assert.ok(withdrawal);
    proof = { ...proof, withdrawal, completedStep: 2 };
    checkpoint('02-withdrawal-accepted');
    unchangedPhysical();
    await expect(form).toHaveAttribute('data-citation-phase', 'complete');
    await button(form, 'Close').click();
  }
  await expect(citationRow()).toHaveAttribute('data-citation-status', 'withdrawn');
  await expect(citationRow()).toContainText(proof.citationReason);
  await expect(citationRow()).toContainText(proof.withdrawalReason);
  await button(citationRow(), 'View saved citation').click();
  await expect(citationRow().getByTestId('retained-citation-source')).toBeVisible();
  const result = await citationRead();
  assert.equal(result.kind, 'ready');
  assert.deepEqual(result.entries, [
    { citation: proof.citation, withdrawal: proof.withdrawal },
    ...(proof.child ? [{ citation: proof.child, withdrawal: null }] : []),
  ]);
  if (proof.child) {
    const childRow = citations().locator(`[data-citation-id="${proof.child.id}"]`);
    await expect(childRow).toHaveAttribute('data-citation-status', 'active');
    await expect(childRow).toContainText(proof.reattachReason);
    assert.deepEqual(proof.child.reinstates, predecessor(proof));
  }
  current = await ctx.inventoryRead(fixture.scope);
  unchangedPhysical();
  assert.equal(current.state.revision, proof.child ? 96 : 95);
  assert.deepEqual(current.state.scientificCitations[proof.citation.id], proof.citation);
  assert.equal(current.history.length, proof.baselineHistory.length + (proof.child ? 3 : 2));
  const accepted = current.history.slice(proof.baselineHistory.length);
  assert.deepEqual(
    accepted.map((entry) => entry.request.kind),
    [
      'record-scientific-citation',
      'withdraw-scientific-citation',
      ...(proof.child ? ['record-scientific-citation'] : []),
    ]
  );
  proof = { ...proof, acceptedRequests: accepted.map((entry) => entry.request), retained, primary };
  await dismissSeedPrompt(ctx);
  await ctx.capture('03-withdrawn-citation-keeps-original-context-and-reasons', current);
  const final = checkpoint('03-final');
  writeFileSync(
    path.join(evidenceDirectory, 'scientific-citations-reopen-fixture.json'),
    JSON.stringify(final, null, 2)
  );
  return final;
}
export async function runInventoryScientificCitations(ctx) {
  return run(ctx, false);
}
export async function runInventoryScientificCitationsResume(ctx) {
  assert.ok(ctx.fixture.scientificCitationsJourney);
  return run(ctx, false);
}
export async function runInventoryScientificCitationsReopen(ctx) {
  assert.equal(ctx.fixture.scientificCitationsJourney.completedStep, 2);
  return run(ctx, true);
}

function predecessor(proof) {
  return {
    citationId: proof.citation.id,
    citationIntentSha256: proof.citation.intentSha256,
    withdrawalId: proof.withdrawal.id,
    withdrawalIntentSha256: proof.withdrawal.intentSha256,
  };
}
async function reattach(ctx) {
  const { fixture, page, expect, evidenceDirectory } = ctx;
  let proof = fixture.scientificCitationsJourney,
    current = await ctx.inventoryRead(fixture.scope);
  assert.equal(proof.completedStep, 2);
  if (current.state.revision === fixture.state.revision) {
    assert.deepEqual(current.state, fixture.state);
    assert.deepEqual(current.history, fixture.history);
  } else {
    assert.ok(
      proof.childDraftId && fixture.state.revision === 95 && current.state.revision === 96,
      'Only the captured child identity may reconcile an interrupted accepted reattachment.'
    );
  }
  if (!proof.reattachBaselineState) {
    assert.equal(current.state.revision, 95);
    proof = {
      ...proof,
      reattachBaselineState: current.state,
      reattachBaselineHistory: current.history,
      reattachReason: `Explicitly cite this saved version again after withdrawal ${randomUUID().slice(0, 8)}`,
      reattachStage: 'editing',
    };
  }
  const checkpoint = (name) => {
    const saved = {
      ...fixture,
      ...current,
      scientificCitationsJourney: proof,
      resumePhase: 'scientific-citations-reattach',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-scientific-citations-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  };
  checkpoint('04-reattach-current-state');
  const reconcile = () => {
    const child = Object.values(current.state.scientificCitations).find(
      (entry) => entry.identity.citationId === proof.childDraftId
    );
    assert.ok(
      child,
      'The observed metadata revision must contain the exact captured child identity.'
    );
    assert.equal(current.state.revision, 96);
    assert.equal(child.workId, proof.workId);
    assert.equal(child.workIntentSha256, proof.workIntentSha256);
    assert.deepEqual(child.reinstates, predecessor(proof));
    assert.deepEqual(child.context, proof.citation.context);
    assert.equal(child.reason, proof.reattachReason);
    assert.deepEqual(physical(current.state), physical(proof.reattachBaselineState));
    assert.deepEqual(
      current.state.scientificCitationWithdrawals,
      proof.reattachBaselineState.scientificCitationWithdrawals
    );
    assert.deepEqual(current.state.scientificCitations, {
      ...proof.reattachBaselineState.scientificCitations,
      [child.id]: child,
    });
    assert.deepEqual(
      current.history.slice(0, proof.reattachBaselineHistory.length),
      proof.reattachBaselineHistory
    );
    assert.equal(current.history.length, proof.reattachBaselineHistory.length + 1);
    const accepted = current.history.at(-1);
    assert.equal(accepted.request.kind, 'record-scientific-citation');
    assert.equal(accepted.request.choices.identity.citationId, proof.childDraftId);
    assert.deepEqual(accepted.request.choices.reinstates, predecessor(proof));
    proof = {
      ...proof,
      child,
      reattachStage: 'committed',
      childAcceptedRequest: accepted.request,
      childReceipt: accepted.receipt,
    };
    checkpoint('04-reattach-accepted');
  };
  if (current.state.revision === 96 && proof.childDraftId) reconcile();
  await openRun(ctx);
  const citations = () =>
    page.locator(`[data-scientific-work-id="${proof.workId}"]`).getByTestId('scientific-citations');
  const baseRow = () => citations().locator(`[data-citation-id="${proof.citation.id}"]`);
  await expect(baseRow()).toHaveAttribute('data-citation-status', 'withdrawn');
  const recovery = button(page, 'Resume saved change');
  if (await recovery.isVisible()) {
    assert.ok(proof.childDraftId, 'A saved reattachment requires its pre-submit child checkpoint.');
    await recovery.click();
    const form = page.getByTestId('scientific-citation-dialog');
    if (await button(form, 'Check status').isVisible()) await button(form, 'Check status').click();
    if (await button(form, 'Reload saved citations').isVisible())
      await button(form, 'Reload saved citations').click();
    if (await button(form, 'Retry same change').isVisible()) {
      checkpoint('04-before-original-reattach-retry');
      await button(form, 'Retry same change').click();
    }
    await expect.poll(async () => (await ctx.inventoryRead(fixture.scope)).state.revision).toBe(96);
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint('04-reattach-accepted-before-assertions');
    reconcile();
    await expect(form).toHaveAttribute('data-citation-phase', 'complete');
    await button(form, 'Close').click();
  }
  if (!proof.child) {
    const selected = (await sources(ctx)).contexts.find(
      (entry) => entry.entityId === proof.selected.entityId
    );
    assert.ok(selected);
    assert.equal(selected.sourceSha256, proof.selected.sourceSha256);
    await button(baseRow(), 'Add citation again').click();
    const form = page.getByRole('dialog', { name: 'Add citation again', exact: true });
    await form
      .getByRole('textbox', { name: 'Reason for citation', exact: true })
      .fill(proof.reattachReason);
    await button(form, 'Preview citation').click();
    await expect(form).toContainText('Ready to add this saved citation.');
    assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
    proof = {
      ...proof,
      childDraftId: await form.getAttribute('data-citation-draft-id'),
      reattachStage: 'prepared',
    };
    checkpoint('04-before-reattach-submit');
    await button(form, 'Add citation again').click();
    await expect.poll(async () => (await ctx.inventoryRead(fixture.scope)).state.revision).toBe(96);
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint('04-reattach-accepted-before-assertions');
    reconcile();
    await expect(form).toHaveAttribute('data-citation-phase', 'complete');
    await button(form, 'Close').click();
  }
  const childRow = () => citations().locator(`[data-citation-id="${proof.child.id}"]`);
  await expect(childRow()).toHaveAttribute('data-citation-status', 'active');
  await expect(childRow()).toContainText(proof.reattachReason);
  await expect(baseRow()).toHaveAttribute('data-citation-status', 'withdrawn');
  await button(citations(), 'Add saved citation').click();
  const duplicate = page.getByRole('dialog', { name: 'Add saved citation', exact: true });
  await ctx.choose(
    duplicate,
    'Saved citation source',
    new RegExp(`${escape(proof.selected.entityId)}$`, 'u')
  );
  await duplicate
    .getByRole('textbox', { name: 'Reason for citation', exact: true })
    .fill('Base duplicate must preserve the original withdrawn generation');
  await button(duplicate, 'Preview citation').click();
  await expect(duplicate).toContainText('This citation was withdrawn.');
  await expect(duplicate).toContainText(proof.citationReason);
  await expect(duplicate).toContainText(proof.withdrawalReason);
  await expect(button(duplicate, 'Add citation')).toHaveCount(0);
  await button(duplicate, 'Cancel').click();
  assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
  await button(childRow(), 'View saved citation').click();
  await expect(childRow().getByTestId('retained-citation-source')).toBeVisible();
  await dismissSeedPrompt(ctx);
  await ctx.capture('04-explicit-reattachment-keeps-withdrawn-base-and-active-child', current);
  const final = checkpoint('04-reattach-final');
  writeFileSync(
    path.join(evidenceDirectory, 'scientific-citations-reopen-fixture.json'),
    JSON.stringify(final, null, 2)
  );
  return final;
}
export async function runInventoryScientificCitationsReattach(ctx) {
  return reattach(ctx);
}
export async function runInventoryScientificCitationsReattachResume(ctx) {
  assert.ok(ctx.fixture.scientificCitationsJourney.reattachBaselineState);
  return reattach(ctx);
}

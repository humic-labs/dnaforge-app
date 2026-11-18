import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function openRun(ctx, saved) {
  const project = ctx.page.locator(
    `[role="treeitem"][data-entry-path="${ctx.fixture.project.path}"]`
  );
  if (!(await project.isVisible())) await ctx.page.getByTestId('files-button').click();
  await ctx.expect(project).toBeVisible();
  const directory = saved.path.replace(/\/.forge\/protocol-run\.json$/u, '');
  await ctx.page.locator(`[data-entry-path="${directory}"]`).dblclick();
  const view = ctx.page.getByTestId('scientific-document-tab');
  await ctx
    .expect(view.getByRole('textbox', { name: 'Document title', exact: true }))
    .toHaveValue(saved.title);
  return view.getByTestId('run-recorded-physical-work');
}
async function savedPackage(page, project, entityId) {
  return page.evaluate((input) => window.electronAPI.protocols.readPackage(input), {
    project,
    entityId,
  });
}
function exactWork(fixture) {
  const proof = fixture.protocolRunJourney;
  const work = Object.values(fixture.state.scientificWorks).find(
    (item) =>
      item.identity.namespace === proof.namespace && item.identity.workId === proof.physicalWorkId
  );
  assert.ok(work);
  assert.equal(work.context.kind, 'protocol-run');
  assert.equal(work.context.entityId, proof.run.entityId);
  return work;
}
async function run(ctx, reopen) {
  const { fixture, page, expect, evidenceDirectory } = ctx,
    proof = fixture.protocolRunJourney;
  assert.equal(fixture.state.schema, 'dnaforge.inventory.v24');
  assert.equal(fixture.state.revision, 93);
  assert.equal(proof.completedStep, 7);
  assert.ok(proof.notificationRun);
  const work = exactWork(fixture),
    baseline = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(baseline.state, fixture.state);
  assert.deepEqual(baseline.history, fixture.history);
  const packages = await Promise.all(
    [proof.run, proof.editedProtocol, proof.notificationRun].map((saved) =>
      savedPackage(page, fixture.scope.project, saved.entityId)
    )
  );
  for (const [index, saved] of [proof.run, proof.editedProtocol, proof.notificationRun].entries())
    assert.deepEqual(packages[index], saved);
  const unchanged = async () => {
    const current = await ctx.inventoryRead(fixture.scope);
    assert.deepEqual(current.state, baseline.state);
    assert.deepEqual(current.history, baseline.history);
    const currentPackages = await Promise.all(
      packages.map((saved) => savedPackage(page, fixture.scope.project, saved.entityId))
    );
    assert.deepEqual(currentPackages, packages);
    return current;
  };
  const query = await page.evaluate(
    (input) => window.electronAPI.inventory.scientificWorksForContext(input),
    { ...fixture.scope, context: { kind: 'protocol-run', entityId: proof.run.entityId }, limit: 20 }
  );
  assert.equal(query.kind, 'ready');
  assert.equal(query.revision, 93);
  assert.deepEqual(query.works, [work]);
  assert.equal(query.nextCursor, null);
  await unchanged();
  let section = await openRun(ctx, proof.run);
  const row = () => section.locator(`[data-scientific-work-id="${work.id}"]`);
  await expect(row()).toBeVisible();
  await expect(row()).toContainText(/Source balance at recording: 70 [µμu]L → 60 [µμu]L/u);
  await expect(row()).toContainText(/Destination aliquot at recording: 10 [µμu]L/u);
  await expect(row()).toContainText(work.reason);
  await expect(row()).toContainText(new Date(work.at).toISOString());
  await row().getByText('Recorded identities and locations', { exact: true }).click();
  await expect(row()).toContainText(work.transfer.destination.stockId);
  await expect(row()).toContainText(work.transfer.destination.vesselId);
  await expect(row()).toContainText(work.effects.destination.vessel.placement.slotId);
  const deferDevelopmentSeed = button(page, 'Not now');
  if (await deferDevelopmentSeed.isVisible()) await deferDevelopmentSeed.click();
  await ctx.capture(
    reopen ? '01-reopened-run-recorded-physical-work' : '01-run-recorded-physical-work',
    await unchanged()
  );
  await button(row(), 'View saved context').click();
  const retained = row().getByTestId('run-retained-scientific-source');
  await expect(retained).toBeVisible();
  await expect(retained).toContainText(proof.stepText);
  assert.ok(!(await retained.textContent()).includes(proof.laterStepText));
  await retained.getByText('Complete saved Run record', { exact: true }).click();
  await expect(
    retained.getByRole('textbox', { name: 'Saved Run source', exact: true })
  ).toHaveValue(proof.run.originalText);
  const original = await page.evaluate(
    (input) => window.electronAPI.inventory.scientificSource(input),
    { ...fixture.scope, workId: work.id }
  );
  assert.equal(original.kind, 'available');
  assert.equal(original.sourceSha256, work.context.source.sha256);
  assert.equal(original.source.originalText, proof.run.originalText);
  await retained.getByText('Complete saved Run record', { exact: true }).click();
  await ctx.capture('02-historical-run-context-and-frozen-protocol', {
    ...(await unchanged()),
    retained: original,
  });
  await button(section, 'Refresh').click();
  await expect(row()).toBeVisible();
  await button(row(), 'Open current Run').click();
  section = page.getByTestId('scientific-document-tab').getByTestId('run-recorded-physical-work');
  await expect(row()).toBeVisible();
  await unchanged();
  section = await openRun(ctx, proof.notificationRun);
  await expect(
    section.getByText('No recorded physical work for this Run.', { exact: true })
  ).toBeVisible();
  await expect(section.locator('[data-scientific-work-id]')).toHaveCount(0);
  await ctx.capture('03-existing-tracking-run-ready-empty', await unchanged());
  section = await openRun(ctx, proof.run);
  await expect(row()).toBeVisible();
  await expect(row()).toContainText(new RegExp(escape(work.effects.source.vessel.name), 'u'));
  const current = await unchanged();
  const result = {
    ...fixture,
    ...current,
    runRecordedWorkJourney: {
      revision: 93,
      workId: work.id,
      runId: proof.run.entityId,
      trackingRunId: proof.notificationRun.entityId,
      query,
      packages,
      completed: true,
    },
  };
  writeFileSync(
    path.join(evidenceDirectory, 'run-recorded-work-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  await ctx.capture('04-work-bearing-run-restored-with-no-inventory-changes', current);
  return result;
}
export async function runInventoryRunRecordedWork(ctx) {
  return run(ctx, false);
}
export async function runInventoryRunRecordedWorkReopen(ctx) {
  assert.equal(ctx.fixture.runRecordedWorkJourney.completed, true);
  return run(ctx, true);
}

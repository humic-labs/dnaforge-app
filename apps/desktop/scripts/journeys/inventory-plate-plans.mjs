import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function compareDecimal(left, right) {
  const [leftWhole, leftFraction = ''] = left.split('.'),
    [rightWhole, rightFraction = ''] = right.split('.'),
    scale = Math.max(leftFraction.length, rightFraction.length),
    a = BigInt(leftWhole + leftFraction.padEnd(scale, '0')),
    b = BigInt(rightWhole + rightFraction.padEnd(scale, '0'));
  return a < b ? -1 : a > b ? 1 : 0;
}
function physical(state) {
  const { schema, revision, lastRecordedAt, platePlanVersions, ...facts } = state;
  return facts;
}
async function dismissSeed(ctx) {
  const toast = ctx.page.locator('[data-toast-definition="dev-registry-seed"]'),
    dismiss = button(toast, 'Not now');
  if (await dismiss.isVisible()) {
    await dismiss.click();
    await ctx.expect(toast).toBeHidden();
  }
}
async function open(ctx) {
  const { page, expect } = ctx,
    existing = page.getByTestId('inventory-plate-plans');
  if (await page.getByRole('option').count()) await page.keyboard.press('Escape');
  if (await existing.isVisible()) await button(existing, 'Close plate plans').click();
  await button(page, 'Plate plans').click();
  await expect(existing).toBeVisible();
  return existing;
}
async function exactVersion(ctx, version) {
  return ctx.page.evaluate((input) => window.electronAPI.inventory.platePlanVersion(input), {
    ...ctx.fixture.scope,
    versionId: version.id,
    definitionSha256: version.definitionSha256,
  });
}
async function selectVersion(ctx, form, version) {
  const row = form
    .getByTestId('plate-plan-versions')
    .locator(`[data-plan-version-id="${version.id}"]`);
  if (!(await row.isVisible())) await button(form, 'Refresh plan versions').click();
  await ctx.expect(row).toBeVisible();
  await button(row, 'Open version').click();
  await ctx
    .expect(form.getByTestId('plate-plan-selected'))
    .toHaveAttribute('data-plan-version-id', version.id);
  await ctx
    .expect(form.getByTestId('plate-plan-selected'))
    .toHaveAttribute('data-definition-sha256', version.definitionSha256);
}
async function fillDefinition(ctx, form, proof) {
  await form.getByRole('textbox', { name: 'Plan title', exact: true }).fill(proof.title);
  await form.getByRole('textbox', { name: 'Grid rows', exact: true }).fill('8');
  await form.getByRole('textbox', { name: 'Grid columns', exact: true }).fill('12');
  await form.getByRole('textbox', { name: 'Source role 1 label', exact: true }).fill('Template');
  if (!(await form.getByRole('textbox', { name: 'Source role 2 label', exact: true }).count()))
    await button(form, 'Add source role').click();
  await form
    .getByRole('textbox', { name: 'Source role 2 label', exact: true })
    .fill('Positive control');
  await form.getByRole('textbox', { name: 'Step 1 destination', exact: true }).fill('A3');
  await form.getByRole('textbox', { name: 'Step 1 volume (µL)', exact: true }).fill('4.00');
  await form.getByRole('textbox', { name: 'Step 1 label', exact: true }).fill('Template transfer');
  if (!(await form.getByRole('textbox', { name: 'Step 2 destination', exact: true }).count()))
    await button(form, 'Add planned transfer').click();
  await ctx.choose(form, 'Step 2 source role', 'Positive control');
  await form.getByRole('textbox', { name: 'Step 2 destination', exact: true }).fill('B1');
  await form.getByRole('textbox', { name: 'Step 2 volume (µL)', exact: true }).fill('4');
  await form.getByRole('textbox', { name: 'Step 2 label', exact: true }).fill('Control transfer');
  await form
    .getByRole('textbox', { name: 'Reason for version save', exact: true })
    .fill(proof.reasonA);
}
async function binding(ctx, form, version, stockId, plateId) {
  await ctx.choose(form, 'Destination physical plate', new RegExp(`${escape(plateId)}$`, 'u'));
  for (const [index, slot] of version.definition.sourceSlots.entries())
    await ctx.choose(
      form,
      `Source ${index + 1}: ${slot.label}`,
      new RegExp(`${escape(stockId)}$`, 'u')
    );
  const recheck = button(form, 'Recheck feasibility');
  if (await recheck.isVisible()) await recheck.click();
  else await button(form, 'Check feasibility').click();
  await ctx
    .expect(form.getByTestId('plate-plan-binding'))
    .toHaveAttribute('data-binding-state', /observed|stale/u);
  return form.getByTestId('plate-plan-feasibility');
}
async function run(ctx, reopen) {
  const { page, expect, fixture, evidenceDirectory } = ctx;
  let current = await ctx.inventoryRead(fixture.scope),
    proof = fixture.platePlansJourney;
  if (reopen || proof?.completedStep === 2) {
    assert.deepEqual(current.state, fixture.state);
    assert.deepEqual(current.history, fixture.history);
  }
  if (!proof) {
    assert.equal(current.state.schema, 'dnaforge.inventory.v26');
    assert.equal(current.state.revision, 96);
    assert.deepEqual(current.history, fixture.history);
    assert.deepEqual(physical(current.state), physical(fixture.state));
    assert.deepEqual(current.state.platePlanVersions, {});
    const tag = randomUUID().slice(0, 8);
    proof = {
      completedStep: 0,
      initialRevision: 96,
      baselineState: current.state,
      baselineHistory: current.history,
      title: `Reusable transfer plan ${tag}`,
      reasonA: `Save reusable 96-position instructions ${tag}`,
      reasonB: `Save compatible six-position instructions ${tag}`,
      plateId: 'd0c8dbd1-f29a-4b3b-b042-e1824417a358',
    };
  }
  function checkpoint(name) {
    const saved = { ...fixture, ...current, platePlansJourney: proof, resumePhase: 'plate-plans' };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-plate-plans-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  }
  function unchanged() {
    assert.deepEqual(physical(current.state), physical(proof.baselineState));
    assert.deepEqual(current.history.slice(0, proof.baselineHistory.length), proof.baselineHistory);
  }
  async function capture(name, detail = {}) {
    await dismissSeed(ctx);
    await ctx.capture(name, { ...current, proof, ...detail });
  }
  checkpoint('00-native-memory-upcast');
  let form = await open(ctx);
  const resume = button(form, 'Resume saved change');
  if (await resume.isVisible()) {
    await resume.click();
    if (await button(form, 'Check status').isVisible()) await button(form, 'Check status').click();
    if (await button(form, 'Reload saved plan').isVisible())
      await button(form, 'Reload saved plan').click();
    if (await button(form, 'Retry same change').isVisible())
      await button(form, 'Retry same change').click();
    await expect(form).toHaveAttribute('data-save-state', 'complete');
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint('00-recovered-original-operation-before-assertions');
  }
  for (const [index, key] of ['A', 'B'].entries()) {
    const prepared = proof[`request${key}`];
    if (proof.completedStep > index || !prepared) continue;
    const receipt = await page.evaluate((input) => window.electronAPI.inventory.operation(input), {
      ...fixture.scope,
      operationId: prepared.operationId,
    });
    if (receipt) {
      current = await ctx.inventoryRead(fixture.scope);
      checkpoint(`0${index + 1}-accepted-operation-reconciled-before-assertions`);
      const version = Object.values(current.state.platePlanVersions).find(
        (entry) =>
          JSON.stringify(entry.identity) === JSON.stringify(prepared.choices.identity) &&
          JSON.stringify(entry.definition) === JSON.stringify(prepared.choices.definition)
      );
      assert.ok(version);
      assert.equal(receipt.operationId, prepared.operationId);
      assert.equal(receipt.revision, 97 + index);
      proof = { ...proof, [`version${key}`]: version, completedStep: index + 1 };
      checkpoint(`0${index + 1}-accepted-operation-reconciled`);
    }
  }
  if (reopen) assert.equal(proof.completedStep, 2);
  async function save(key, step) {
    const editor = form.getByTestId('plate-plan-editor'),
      sourceSlots = [];
    for (const [index, row] of (await editor.locator('[data-source-slot-key]').all()).entries())
      sourceSlots.push({
        key: await row.getAttribute('data-source-slot-key'),
        label: await row
          .getByRole('textbox', { name: `Source role ${index + 1} label`, exact: true })
          .inputValue(),
      });
    const transfers = [];
    for (const [index, row] of (await editor.locator('[data-action-id]').all()).entries()) {
      await expect(
        row.getByRole('combobox', { name: `Step ${index + 1} source role`, exact: true })
      ).toContainText(sourceSlots[index].label);
      transfers.push({
        actionId: await row.getAttribute('data-action-id'),
        sourceSlotKey: sourceSlots[index].key,
        destinationPosition: await row
          .getByRole('textbox', { name: `Step ${index + 1} destination`, exact: true })
          .inputValue(),
        quantity: { value: '4', unit: 'uL' },
        label: await row
          .getByRole('textbox', { name: `Step ${index + 1} label`, exact: true })
          .inputValue(),
      });
    }
    const beforeChoices = {
      identity: {
        namespace: await form.getAttribute('data-plan-namespace'),
        planId: await form.getAttribute('data-plan-id'),
      },
      definition: {
        schema: 'dnaforge.inventory-plate-plan-definition.v1',
        title: await editor.getByRole('textbox', { name: 'Plan title', exact: true }).inputValue(),
        layout: {
          kind: 'fixed-well',
          rows: Number(
            await editor.getByRole('textbox', { name: 'Grid rows', exact: true }).inputValue()
          ),
          columns: Number(
            await editor.getByRole('textbox', { name: 'Grid columns', exact: true }).inputValue()
          ),
        },
        sourceSlots,
        transfers,
      },
      reason: await editor
        .getByRole('textbox', { name: 'Reason for version save', exact: true })
        .inputValue(),
    };
    proof = { ...proof, identity: beforeChoices.identity, [`choices${key}`]: beforeChoices };
    checkpoint(`0${step}-stable-definition-before-preview`);
    await button(form, 'Preview version save').click();
    await expect(form).toContainText('Ready to save this immutable version.');
    await form.getByText('Prepared save details', { exact: true }).click();
    const request = JSON.parse(
      await form
        .getByRole('textbox', { name: 'Prepared plan save request', exact: true })
        .inputValue()
    );
    assert.equal(request.expectedRevision, 96 + step - 1);
    assert.equal(request.kind, 'save-plate-plan-version');
    assert.deepEqual(request.choices, beforeChoices);
    if (proof[`request${key}`])
      assert.deepEqual(
        request,
        proof[`request${key}`],
        'Resume must preserve the original prepared request.'
      );
    assert.equal(request.choices.definition.transfers.length, 2);
    assert.deepEqual(
      request.choices.definition.transfers.map((entry) => entry.quantity),
      [
        { value: '4', unit: 'uL' },
        { value: '4', unit: 'uL' },
      ]
    );
    if (proof.identity) assert.deepEqual(request.choices.identity, proof.identity);
    proof = { ...proof, identity: request.choices.identity, [`request${key}`]: request };
    checkpoint(`0${step}-before-save-${key}`);
    assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
    await button(form, 'Save plan version').click();
    await expect
      .poll(async () => (await ctx.inventoryRead(fixture.scope)).state.revision)
      .toBe(96 + step);
    current = await ctx.inventoryRead(fixture.scope);
    checkpoint(`0${step}-save-${key}-accepted-before-assertions`);
    const entry = current.history.find(
      (entry) => entry.receipt.operationId === request.operationId
    );
    assert.ok(entry);
    assert.deepEqual(entry.request, request);
    const version = Object.values(current.state.platePlanVersions).find(
      (value) =>
        JSON.stringify(value.identity) === JSON.stringify(request.choices.identity) &&
        JSON.stringify(value.definition) === JSON.stringify(request.choices.definition)
    );
    assert.ok(version);
    proof = { ...proof, [`version${key}`]: version, completedStep: step };
    checkpoint(`0${step}-save-${key}-accepted`);
    unchanged();
    await expect(form).toHaveAttribute('data-save-state', 'complete');
    await button(form, 'View saved version').click();
    await expect(form.getByTestId('plate-plan-selected')).toHaveAttribute(
      'data-plan-version-id',
      version.id
    );
    return version;
  }
  if (proof.completedStep < 1) {
    if (proof.requestA) {
      assert.equal(
        await form.getAttribute('data-plan-id'),
        proof.requestA.choices.identity.planId,
        'Resume must retain the original plan family.'
      );
    } else {
      await button(form, 'New plan').click();
    }
    await fillDefinition(ctx, form, proof);
    checkpoint('00-stable-draft-before-first-preview');
    await save('A', 1);
  }
  await selectVersion(ctx, form, proof.versionA);
  let grid = form.getByTestId('inventory-plate-plan-grid');
  await expect(grid.locator('td')).toHaveCount(96);
  await expect(grid.getByText('Unplanned', { exact: true })).toHaveCount(94);
  await expect(grid.locator('[data-position="A3"]')).toContainText('Template');
  await expect(grid.locator('[data-position="B1"]')).toContainText('Positive control');
  const originalA = await exactVersion(ctx, proof.versionA);
  assert.equal(originalA.kind, 'available');
  assert.deepEqual(originalA.version, proof.versionA);
  assert.equal(originalA.diagram.kind, 'rendered');
  const artifact = originalA.diagram.artifact;
  if (!proof.exportPath) {
    const savedPath = path.join(evidenceDirectory, 'saved-96-position-plan.svg');
    if (ctx.nativeDialogs) {
      await button(form, 'Export printable plan SVG').click();
      console.log(JSON.stringify({ nativeDialog: 'save-plate-plan-svg', destination: savedPath }));
      await expect(form.getByTestId('inventory-plate-plan-output')).toHaveAttribute(
        'data-output-state',
        'exported',
        { timeout: 120000 }
      );
      await expect(form.getByTestId('plate-plan-output-path')).toHaveText(savedPath);
    } else {
      const output = await page.evaluate(
        async ({ scope, version, savedPath }) => {
          const { InventoryPlatePlanReadSession } =
            await import('/src/features/inventory/inventory-plate-plan-read-session.ts');
          const session = new InventoryPlatePlanReadSession(scope, window.electronAPI.inventory, {
            chooseDestination: async () => savedPath,
            write: (path, content) => window.electronAPI.fs.writeTextFileAtomic({ path, content }),
            read: (path) => window.electronAPI.fs.readTextFile(path),
          });
          await session.open();
          await session.select(version.id, version.definitionSha256);
          await session.exportDiagram();
          const result = session.getSnapshot().output;
          session.dispose();
          return result;
        },
        { scope: fixture.scope, version: proof.versionA, savedPath }
      );
      assert.equal(output.kind, 'exported');
      assert.equal(output.path, savedPath);
      assert.deepEqual(output.artifact, artifact);
      writeFileSync(
        path.join(evidenceDirectory, 'explicit-destination-output-proof.json'),
        JSON.stringify(
          {
            boundary:
              'Production plan read session with real native atomic write and exact readback; automation-supplied private destination. OS Save panel unqualified.',
            output,
          },
          null,
          2
        )
      );
    }
    const actual = readFileSync(savedPath);
    assert.equal(actual.toString('utf8'), artifact.svg);
    assert.equal(`sha256:${createHash('sha256').update(actual).digest('hex')}`, artifact.sha256);
    proof = {
      ...proof,
      exportPath: savedPath,
      exportArtifact: artifact,
      nativeDialogQualified: Boolean(ctx.nativeDialogs),
    };
    checkpoint('01-definition-svg-readback');
  } else {
    assert.equal(readFileSync(proof.exportPath, 'utf8'), proof.exportArtifact.svg);
    assert.deepEqual(artifact, proof.exportArtifact);
  }
  await dismissSeed(ctx);
  await grid.scrollIntoViewIfNeeded();
  await grid.screenshot({ path: path.join(evidenceDirectory, '01-exact-96-position-grid.png') });
  await capture('01-immutable-96-position-grid-and-definition-svg', {
    exportPath: proof.exportPath,
    nativeDialogQualified: proof.nativeDialogQualified,
  });
  if (proof.completedStep < 2) {
    await button(form, 'Edit as new version').click();
    await form.getByRole('textbox', { name: 'Grid rows', exact: true }).fill('2');
    await form.getByRole('textbox', { name: 'Grid columns', exact: true }).fill('3');
    await form
      .getByRole('textbox', { name: 'Reason for version save', exact: true })
      .fill(proof.reasonB);
    await save('B', 2);
  }
  assert.equal(current.state.revision, 98);
  assert.equal(Object.keys(current.state.platePlanVersions).length, 2);
  unchanged();
  const { layout: layoutA, ...definitionA } = proof.versionA.definition,
    { layout: layoutB, ...definitionB } = proof.versionB.definition;
  assert.deepEqual(definitionB, definitionA);
  assert.deepEqual(layoutA, { kind: 'fixed-well', rows: 8, columns: 12 });
  assert.deepEqual(layoutB, { kind: 'fixed-well', rows: 2, columns: 3 });
  await selectVersion(ctx, form, proof.versionB);
  const plate = current.state.storage[proof.plateId];
  assert.deepEqual(plate.layout, { kind: 'fixed-well', rows: 2, columns: 3 });
  const availability = await page.evaluate(
    (input) => window.electronAPI.inventory.availability(input),
    fixture.scope
  );
  assert.equal(availability.revision, 98);
  const candidates = Object.values(current.state.stocks)
    .filter(
      (stock) =>
        stock.quantity.kind === 'known' &&
        stock.quantity.unit === 'uL' &&
        availability.stocks[stock.id]?.actions.withdraw.kind === 'allowed' &&
        availability.stocks[stock.id].unreserved.kind === 'known' &&
        Number(availability.stocks[stock.id].unreserved.value) >= 8
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(
    candidates.length,
    'Fresh native availability must offer an allowed source with cumulative demand.'
  );
  let feasible = null,
    chosen = null;
  for (const stock of candidates) {
    const preview = await page.evaluate(
      (input) => window.electronAPI.inventory.previewPlatePlanBinding(input),
      {
        ...fixture.scope,
        expectedRevision: 98,
        binding: {
          versionId: proof.versionB.id,
          definitionSha256: proof.versionB.definitionSha256,
          destinationPlateId: proof.plateId,
          sources: proof.versionB.definition.sourceSlots.map((slot) => ({
            sourceSlotKey: slot.key,
            stockId: stock.id,
          })),
        },
      }
    );
    if (preview.kind === 'ready') {
      feasible = preview;
      chosen = stock;
      break;
    }
  }
  assert.ok(feasible);
  proof = { ...proof, sourceStockId: chosen.id };
  checkpoint('02-fresh-native-eligible-source');
  const ready = await binding(ctx, form, proof.versionB, chosen.id, proof.plateId);
  await expect(ready).toContainText('Feasible at');
  await expect(ready.locator('[data-demand-stock-id]')).toHaveCount(1);
  await expect(ready).toContainText('Combined demand: 8 µL');
  assert.equal(feasible.sources.length, 1);
  assert.deepEqual(feasible.sources[0].demand, { value: '8', unit: 'uL' });
  assert.deepEqual(
    feasible.sources[0].sourceSlotKeys,
    proof.versionB.definition.sourceSlots.map((slot) => slot.key)
  );
  assert.equal(feasible.destinations.length, 2);
  assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
  await capture('02-compatible-binding-aggregates-two-roles-with-no-stock-effect', { feasible });
  const heldCandidates = Object.values(current.state.stocks)
    .filter((stock) => {
      const facts = availability.stocks[stock.id];
      return (
        stock.quantity.kind === 'known' &&
        stock.quantity.unit === 'uL' &&
        compareDecimal(stock.quantity.value, '8') >= 0 &&
        facts?.held.unit === 'uL' &&
        compareDecimal(facts.held.value, '0') > 0 &&
        facts.unreserved.kind === 'known' &&
        facts.unreserved.unit === 'uL' &&
        compareDecimal(facts.unreserved.value, '8') < 0
      );
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.ok(
    heldCandidates.length,
    'Fresh native facts must show a held volume source with less than the combined demand unreserved.'
  );
  const held = heldCandidates[0],
    heldFacts = availability.stocks[held.id];
  proof = {
    ...proof,
    heldStockId: held.id,
    heldSourceFacts: {
      asOf: availability.asOf,
      revision: availability.revision,
      stock: held,
      availability: heldFacts,
    },
  };
  checkpoint('02-fresh-native-held-source-before-picker');
  const blocked = await binding(ctx, form, proof.versionB, held.id, proof.plateId);
  await expect(blocked).toContainText('Blocked at');
  await expect(blocked.locator(`[data-demand-stock-id="${held.id}"]`)).toContainText(
    `Held: ${heldFacts.held.value} µL`
  );
  await expect(blocked.locator(`[data-demand-stock-id="${held.id}"]`)).toContainText(
    `Unreserved: ${heldFacts.unreserved.value} µL`
  );
  await expect(blocked).not.toContainText('Projected remaining:');
  assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
  await capture('03-held-stock-remains-blocked');
  await selectVersion(ctx, form, proof.versionA);
  await expect(
    form.getByRole('combobox', { name: 'Destination physical plate', exact: true })
  ).toContainText('Choose an existing plate');
  for (const [index, slot] of proof.versionA.definition.sourceSlots.entries())
    await expect(
      form.getByRole('combobox', { name: `Source ${index + 1}: ${slot.label}`, exact: true })
    ).toContainText('Choose an existing volume stock');
  const mismatch = await binding(ctx, form, proof.versionA, chosen.id, proof.plateId);
  await expect(mismatch).toContainText('Blocked at');
  await capture('04-selected-version-requires-compatible-plate');
  await button(form, 'Edit as new version').click();
  await form
    .getByRole('textbox', { name: 'Reason for version save', exact: true })
    .fill('A new reason does not replace the original saved version');
  await button(form, 'Preview version save').click();
  await expect(form).toContainText('This exact version already exists.');
  await expect(form).toContainText(proof.reasonA);
  await expect(button(form, 'Save plan version')).toHaveCount(0);
  await expect(form).toContainText('The new reason was not recorded.');
  assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
  assert.deepEqual((await exactVersion(ctx, proof.versionA)).version, proof.versionA);
  assert.deepEqual((await exactVersion(ctx, proof.versionB)).version, proof.versionB);
  unchanged();
  await capture('05-return-to-original-definition-keeps-original-version-and-reason');
  if (reopen) {
    await selectVersion(ctx, form, proof.versionB);
    await binding(ctx, form, proof.versionB, chosen.id, proof.plateId);
    await capture('06-restart-exact-versions-file-and-fresh-readonly-binding');
  }
  const saved = checkpoint('03-complete');
  writeFileSync(
    path.join(evidenceDirectory, 'plate-plans-reopen-fixture.json'),
    JSON.stringify(saved, null, 2)
  );
  return {
    revision: 98,
    versionA: proof.versionA.id,
    versionB: proof.versionB.id,
    initialRevision: 96,
    physicalStateUnchanged: true,
    metadataSaves: 2,
    exportPath: proof.exportPath,
    nativeDialogQualified: proof.nativeDialogQualified,
  };
}
export const runInventoryPlatePlans = (ctx) => run(ctx, false);
export const runInventoryPlatePlansResume = (ctx) => run(ctx, false);
export const runInventoryPlatePlansReopen = (ctx) => run(ctx, true);

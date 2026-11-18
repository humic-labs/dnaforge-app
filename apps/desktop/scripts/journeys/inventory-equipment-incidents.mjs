import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const one = (rows, label) => {
  assert.equal(rows.length, 1, label);
  return rows[0];
};
const same = (a, b) => assert.deepEqual(a, b);
const steps = [
  'manual',
  'identify',
  'clearDestination',
  'relocate',
  'keep',
  'remove',
  'transfer',
  'resolve',
  'keepAfterResolution',
  'correctReading',
  'withdrawReading',
];

async function run(ctx, reopen = false) {
  const { page, expect, fixture, evidenceDirectory } = ctx,
    scope = fixture.scope;
  const native = (method, input = scope) =>
    page.evaluate((input) => window.electronAPI.inventory[input.method](input.input), {
      method,
      input,
    });
  let current = await ctx.inventoryRead(scope),
    proof = fixture.equipmentIncidentJourney;
  assert.ok(
    proof?.reportRequest && proof.reportReceipt,
    'Resume the already accepted report checkpoint; this stage does not create another outage.'
  );
  assert.equal(current.state.schema, 'dnaforge.inventory.v30');
  const incident = one(
    Object.values(current.state.equipmentIncidents).filter(
      (x) => JSON.stringify(x.choices) === JSON.stringify(proof.reportRequest.choices)
    ),
    'Resolve the original report from exact choices.'
  );
  const pin = { incidentId: incident.id, intentSha256: incident.intentSha256 };
  proof = { ...proof, incident: pin, steps: proof.steps ?? {} };
  if (!proof.ids) {
    const state = current.state,
      knownRoot = one(
        Object.values(state.equipmentIncidentReviewRoots).filter(
          (x) =>
            x.incident.incidentId === incident.id &&
            x.qualification === 'identified-stock-at-recording' &&
            x.snapshot.vessel.name === 'Occupied tube'
        ),
        'Original known subject'
      );
    const unknownRoot = one(
      Object.values(state.equipmentIncidentReviewRoots).filter(
        (x) =>
          x.incident.incidentId === incident.id &&
          x.qualification === 'confirmed-unidentified-at-open'
      ),
      'Initial confirmed unknown episode'
    );
    const box = one(
      Object.values(state.storage).filter((x) => x.name === 'Synthetic tube box'),
      'Existing whole tube box'
    );
    const receiver = one(
      Object.values(state.storage).filter((x) => /^Custody .+ freezer$/u.test(x.name)),
      'Existing rescue location'
    );
    const receiving = one(
      Object.values(state.storage).filter((x) => /^Table receiving .* box$/u.test(x.name)),
      'Existing ordinary receiving box'
    );
    const occupant = one(
      Object.values(state.vessels).filter(
        (x) =>
          x.placement.kind === 'located' &&
          x.placement.storageId === receiver.id &&
          x.placement.slotId === 'A'
      ),
      'Existing receiver A occupant'
    );
    const empty = one(
      Object.values(state.vessels).filter(
        (x) => x.name === 'Empty movable tube' && x.placement.storageId === box.id
      ),
      'Existing co-moved empty tube'
    );
    proof.ids = {
      equipmentId: incident.binding.storageId,
      knownRoot: knownRoot.id,
      unknownRoot: unknownRoot.id,
      knownStockId: knownRoot.binding.stockId,
      unknownVesselId: unknownRoot.binding.vesselId,
      boxId: box.id,
      receiverId: receiver.id,
      receivingId: receiving.id,
      occupantId: occupant.id,
      emptyId: empty.id,
    };
    proof.actionBaseline = current;
  }
  const ids = proof.ids;
  function checkpoint(name) {
    const value = { ...fixture, ...current, equipmentIncidentJourney: proof };
    const destination = path.join(evidenceDirectory, `${name}-equipment-incidents-checkpoint.json`);
    if (!existsSync(destination)) writeFileSync(destination, JSON.stringify(value, null, 2));
    return value;
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
  async function choose(scope, label, value) {
    const trigger = scope.getByRole('combobox', { name: label, exact: true });
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    const list = page.getByRole('listbox', { name: label, exact: true });
    const option =
      typeof value === 'string'
        ? list.getByRole('option', { name: value, exact: true })
        : list.locator(`[role="option"][data-value=${JSON.stringify(value.id)}]`);
    await option.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
  async function openLocation(id) {
    await dismiss();
    if (!(await page.getByTestId('inventory-panel').isVisible()))
      await page.getByTestId('inventory-button').click();
    const panel = page.getByTestId('inventory-panel');
    if (
      !(
        await panel.getByRole('combobox', { name: 'Inventory project', exact: true }).innerText()
      ).includes(fixture.project.name)
    )
      await choose(panel, 'Inventory project', { id: scope.project });
    await expect(panel).toHaveAttribute('data-state', 'ready');
    if (await button(panel, 'Close stock details').isVisible())
      await button(panel, 'Close stock details').click();
    const tree = page.getByRole('tree', { name: 'Storage locations', exact: true });
    const ancestors = [];
    let location = current.state.storage[id];
    while (location) {
      ancestors.unshift(location);
      location =
        location.placement.kind === 'located'
          ? current.state.storage[location.placement.storageId]
          : null;
    }
    for (const ancestor of ancestors) {
      const row = tree.locator(`[role="treeitem"][data-location-id="${ancestor.id}"]`);
      if ((await row.getAttribute('aria-expanded')) === 'false')
        await button(row, `Expand ${ancestor.name}`).click();
    }
    await tree.locator(`[role="treeitem"][data-location-id="${id}"]`).click();
    return panel;
  }
  async function detail() {
    const panel = await openLocation(ids.equipmentId),
      section = panel.getByTestId('equipment-incidents');
    const exact = section.locator(
      `[data-testid="equipment-incident-detail"][data-incident-id="${pin.incidentId}"]`
    );
    if (!(await exact.isVisible()))
      await button(
        section.locator(`[data-incident-id="${pin.incidentId}"]`).first(),
        'View equipment incident'
      ).click();
    await expect(exact).toBeVisible();
    return exact;
  }
  async function closeAction() {
    const form = page.getByTestId('equipment-incident-follow-up-form');
    if (await form.isVisible()) await button(form, 'Close incident action').click();
  }
  async function accepted(name) {
    const step = proof.steps[name];
    if (!step?.request) return false;
    let receipt = await native('operation', { ...scope, operationId: step.request.operationId });
    if (!receipt) return false;
    if (step.done) {
      same(receipt, step.receipt);
      return true;
    }
    step.receipt = receipt;
    checkpoint(`${name}-ack-before-assertions`);
    current = await ctx.inventoryRead(scope);
    step.acceptedRevision = receipt.revision;
    checkpoint(`${name}-accepted-before-assertions`);
    assert.equal(receipt.operationId, step.request.operationId);
    assert.equal(receipt.inventoryId, scope.inventoryId);
    assert.equal(receipt.revision, step.request.expectedRevision + 1);
    same(current.history[receipt.revision - 1].request, step.request);
    step.done = true;
    checkpoint(`${name}-accepted`);
    return true;
  }
  async function awaitAccepted(name) {
    await expect.poll(() => accepted(name), { timeout: 15000 }).toBe(true);
  }
  async function settleKnown() {
    const confirmation = button(
      page.getByTestId('equipment-incident-follow-up-form'),
      'Confirm original incident action'
    );
    if (await confirmation.isVisible()) {
      await confirmation.click();
      await expect(confirmation).toBeHidden();
    }
    const unknown = page.getByTestId('inventory-outcome-unknown');
    if (await unknown.isVisible()) {
      await button(unknown, 'Check status').click();
      await expect(unknown).toBeHidden();
    }
    const reload = page.getByTestId('inventory-committed-refresh-failed');
    if (await reload.isVisible()) {
      await button(reload, 'Reload saved inventory').click();
      await expect(reload).toBeHidden();
    }
  }
  async function recover(name) {
    if (await accepted(name)) {
      await settleKnown();
      return true;
    }
    if (!proof.steps[name]?.request) return false;
    const form = page.getByTestId('equipment-incident-follow-up-form');
    if (await button(form, 'Confirm original incident action').isVisible()) {
      await button(form, 'Confirm original incident action').click();
      if (
        !(await accepted(name)) &&
        (await button(form, 'Retry original incident action').isVisible())
      )
        await button(form, 'Retry original incident action').click();
      await awaitAccepted(name);
      return true;
    }
    if (await page.getByTestId('inventory-outcome-unknown').isVisible()) {
      await button(page.getByTestId('inventory-outcome-unknown'), 'Check status').click();
      if (
        !(await accepted(name)) &&
        (await button(
          page.getByTestId('inventory-outcome-unknown'),
          'Retry same change'
        ).isVisible())
      )
        await button(page.getByTestId('inventory-outcome-unknown'), 'Retry same change').click();
      await awaitAccepted(name);
      return true;
    }
    return false;
  }
  async function originalPrepared(form) {
    const text = field(form, 'Prepared incident action request');
    if (!(await text.isVisible()))
      await form.getByText('Prepared incident action request', { exact: true }).click();
    return JSON.parse(await text.inputValue());
  }
  async function action(name, title, open, fill) {
    if (await recover(name)) {
      await closeAction();
      return;
    }
    const form = page.getByTestId('equipment-incident-follow-up-form');
    if (proof.steps[name]?.request) {
      assert.ok(
        await form.isVisible(),
        'Keep the original prepared action; do not reconstruct a different request.'
      );
      same(await originalPrepared(form), proof.steps[name].request);
    } else {
      if (!(await form.isVisible())) await open(await detail());
      await expect(form).toBeVisible();
      await fill(form);
      await button(form, 'Preview incident action').click();
      await expect(button(form, title)).toBeVisible();
      const request = await originalPrepared(form);
      const preview = await native('previewEquipmentIncidentAction', {
        ...scope,
        expectedRevision: request.expectedRevision,
        choices: request.choices,
      });
      assert.equal(preview.kind, 'ready');
      assert.equal(preview.planDigest, request.expectedPlanDigest);
      proof.steps[name] = { request, actionProof: preview.record.actionProof };
      checkpoint(`${name}-prepared-before-record`);
      await capture(
        `${name}-ready-before-record`,
        form.getByTestId('equipment-incident-action-preview')
      );
    }
    proof.steps[name].submissionStarted = true;
    checkpoint(`${name}-before-click`);
    await button(form, title).click();
    await awaitAccepted(name);
    await closeAction();
  }
  const observerName = `__incidentPending_${randomUUID().replaceAll('-', '')}`;
  let ordinaryName = null;
  await page.exposeBinding(observerName, (_source, event) => {
    if (!ordinaryName) return;
    assert.equal(event.request.project, scope.project);
    assert.equal(event.request.inventoryId, scope.inventoryId);
    const old = proof.steps[ordinaryName];
    if (old?.request) {
      same(old.request, event.request);
      return;
    }
    assert.equal(
      event.beforeFlight,
      true,
      'Observe the existing durable publication before its flight.'
    );
    proof.steps[ordinaryName] = { request: event.request, observedBeforeFlightAt: event.at };
    checkpoint(`${ordinaryName}-durable-request-observed-before-flight`);
  });
  await page.evaluate(
    async ({ name, scope }) => {
      const { sharedInventoryPendingCoordinator } =
        await import('/src/features/inventory/inventory-pending-coordinator.ts');
      const pending = sharedInventoryPendingCoordinator();
      window.__equipmentIncidentObserver?.unsubscribe();
      const unsubscribe = pending.subscribe(() => {
        const snapshot = pending.getSnapshot();
        for (const attempt of snapshot.attempts)
          if (
            attempt.request.project === scope.project &&
            attempt.request.inventoryId === scope.inventoryId
          )
            void window[name]({
              request: attempt.request,
              at: Date.now(),
              beforeFlight: !snapshot.flights.some(
                (x) => x.token.operationId === attempt.request.operationId
              ),
            });
      });
      window.__equipmentIncidentObserver = { unsubscribe };
    },
    { name: observerName, scope }
  );
  async function ordinary(name, open, submit) {
    if (await recover(name)) {
      const cancel = page
        .locator('[role="dialog"]:visible')
        .getByRole('button', { name: 'Cancel', exact: true });
      if (await cancel.isVisible()) await cancel.click();
      return;
    }
    assert.ok(
      !proof.steps[name]?.request,
      'An original ordinary request is unresolved; keep its existing pending recovery controls.'
    );
    const form = await open();
    ordinaryName = name;
    try {
      await button(form, submit).click();
      await expect.poll(() => Boolean(proof.steps[name]?.request)).toBe(true);
      await awaitAccepted(name);
      await expect(form).toBeHidden();
    } finally {
      ordinaryName = null;
    }
  }
  async function showFact(name, age = '0.1') {
    const exact = await detail();
    await field(exact, 'Freshness limit for selected manual fact (minutes)').fill(age);
    await button(exact, 'Apply selected-fact freshness policy').click();
    const factId = proof.steps[name].actionProof.actionId;
    await button(
      exact.locator(`[data-fact-id="${factId}"]`).first(),
      'View exact incident fact'
    ).click();
    return exact.locator(`[data-testid="equipment-incident-fact"][data-fact-id="${factId}"]`);
  }
  async function review(name, disposition) {
    await action(
      name,
      'Record incident impact review',
      async (exact) => {
        await exact.getByRole('tab', { name: 'Review obligations', exact: true }).click();
        const row = exact.locator(`[data-review-root-id="${ids.knownRoot}"]`);
        const label = (await button(row, 'Supersede this impact review').isVisible())
          ? 'Supersede this impact review'
          : 'Review this incident obligation';
        await button(row, label).click();
      },
      async (form) => {
        await form
          .getByLabel('Incident restriction decision', { exact: true })
          .selectOption(disposition);
        await field(form, 'Basis for impact review').fill(
          disposition === 'keep-incident-restriction'
            ? 'Retain this incident restriction pending separate subject assessment.'
            : 'This demonstration removes only this incident restriction; other independent restrictions remain.'
        );
        await field(form, 'Reason for incident action').fill(
          'Explicit recorded subject assessment; no quality or batch release is asserted.'
        );
      }
    );
  }
  checkpoint('00-original-report-and-current-state');
  try {
    if (reopen) {
      same(current.state, fixture.state);
      same(current.history, fixture.history);
      assert.ok(steps.every((name) => proof.steps[name]?.done));
    } else {
      await action(
        'manual',
        'Record manual temperature',
        (exact) => button(exact, 'Record manual temperature').click(),
        async (form) => {
          const header = await native('equipmentIncident', { ...scope, ...pin });
          proof.observedTime = new Date(header.asOf).toISOString();
          await field(form, 'Measured temperature (°C)').fill('-20');
          await field(form, 'Temperature observed at (UTC)').fill(proof.observedTime);
          await field(form, 'Measurement point').fill(
            'Manual probe at tube-box shelf (synthetic demonstration)'
          );
          await field(form, 'Reason for incident action').fill(
            'Operator-reported manual observation; no sensor monitoring is asserted.'
          );
        }
      );
      if (!proof.freshCapture) {
        const fact = await showFact('manual');
        await expect(fact.locator('[data-freshness-state="fresh"]')).toBeVisible();
        await capture('01-selected-manual-fact-fresh', fact);
        proof.freshCapture = true;
        checkpoint('manual-fresh-visible');
      }
      await ordinary(
        'identify',
        async () => {
          const form = page.getByRole('dialog', { name: 'Identify contents', exact: true });
          if (!(await form.isVisible())) {
            const panel = await openLocation(ids.boxId);
            await panel.locator(`[data-vessel-id="${ids.unknownVesselId}"]`).click();
            await button(panel.getByTestId('inventory-detail-drawer'), 'Identify contents').click();
          }
          const materials = await native('materials', {
            project: scope.project,
            query: '',
            limit: 50,
          });
          const material = one(
            materials.items.filter(
              (x) => x.id === current.state.stocks[ids.knownStockId].materialId
            ),
            'Existing project material'
          );
          await choose(form, 'Material', { id: material.id });
          await choose(form, 'Quantity measurement', 'Unknown quantity');
          await choose(form, 'Unit', 'µL');
          await choose(form, 'Stock quality', 'Quarantined');
          await field(form, 'Reason').fill(
            'Identify the already confirmed existing contents without asserting a receipt or a measured amount.'
          );
          return form;
        },
        'Identify contents'
      );
      await ordinary(
        'clearDestination',
        async () => {
          const availability = await native('availability');
          assert.equal(availability.vesselContents[ids.occupantId].kind, 'declared-empty');
          const panel = await openLocation(ids.receiverId);
          await panel.locator(`[data-vessel-id="${ids.occupantId}"]`).click();
          await button(panel.getByTestId('inventory-detail-drawer'), 'Move').click();
          const form = page.getByRole('dialog', { name: 'Move container', exact: true });
          await choose(form, 'Location', { id: ids.receivingId });
          await choose(form, 'Position', 'A');
          return form;
        },
        'Move container'
      );
      await action(
        'relocate',
        'Report completed whole-holder relocation',
        (exact) => button(exact, 'Report completed whole-holder relocation').click(),
        async (form) => {
          await form
            .getByLabel('Relocation 1 whole holder', { exact: true })
            .selectOption(JSON.stringify({ kind: 'storage', id: ids.boxId }));
          await form
            .getByLabel('Relocation 1 completed destination', { exact: true })
            .selectOption(ids.receiverId);
          await form
            .getByLabel('Relocation 1 completed position', { exact: true })
            .selectOption('A');
          await field(form, 'Reason for incident action').fill(
            'Operator reports the completed relocation of this one whole tube box. Other source holders remain in place; physical fit is not established.'
          );
        }
      );
      await review('keep', 'keep-incident-restriction');
      await review('remove', 'remove-incident-restriction');
      await ordinary(
        'transfer',
        async () => {
          const availability = await native('availability');
          assert.equal(availability.stocks[ids.knownStockId].actions.withdraw.kind, 'allowed');
          assert.equal(availability.vesselContents[ids.emptyId].kind, 'declared-empty');
          const panel = await openLocation(ids.boxId);
          await panel.locator(`[data-stock-id="${ids.knownStockId}"]`).click();
          await button(panel.getByTestId('inventory-detail-drawer'), 'Transfer or aliquot').click();
          const form = page.getByRole('dialog', { name: 'Transfer or aliquot', exact: true });
          await field(form, 'Source amount (µL)').fill('1');
          await choose(form, 'Destination container', { id: ids.emptyId });
          await field(form, 'Reason').fill(
            'Record the completed one microlitre aliquot into the existing co-moved empty tube.'
          );
          return form;
        },
        'Transfer or aliquot'
      );
      await action(
        'resolve',
        'Resolve equipment incident',
        (exact) => button(exact, 'Resolve equipment incident').click(),
        async (form) => {
          await form
            .getByLabel('Equipment resolution', { exact: true })
            .selectOption('reported-resolved');
          await field(form, 'Reason for incident action').fill(
            'Equipment occurrence reported resolved; retained sample reviews and quality remain separate.'
          );
        }
      );
      await review('keepAfterResolution', 'keep-incident-restriction');
      await action(
        'correctReading',
        'Correct manual temperature reading',
        async () => button(await showFact('manual'), 'Correct selected manual reading').click(),
        async (form) => {
          await field(form, 'Measured temperature (°C)').fill('-19');
          await field(form, 'Reason for incident action').fill(
            'Correct the earlier operator-reported reading while retaining its original observed time and record.'
          );
        }
      );
      await action(
        'withdrawReading',
        'Withdraw manual temperature reading',
        async () =>
          button(await showFact('correctReading'), 'Withdraw selected manual reading').click(),
        async (form) => {
          await field(form, 'Reason for incident action').fill(
            'Withdraw the corrected manual reading explicitly; no replacement temperature is asserted.'
          );
        }
      );
    }
    current = await ctx.inventoryRead(scope);
    const final = await native('equipmentIncident', { ...scope, ...pin });
    assert.equal(final.kind, 'available');
    assert.equal(final.current.lifecycle, 'resolved');
    assert.equal(final.current.review.kept, 1);
    assert.equal(final.current.review.pending, 5);
    const source = current.state.stocks[ids.knownStockId],
      child = one(
        Object.values(current.state.stocks).filter((x) => x.vesselId === ids.emptyId),
        'Recorded derived aliquot'
      );
    same(source.quantity, { kind: 'known', value: '7.25', unit: 'uL' });
    same(child.quantity, { kind: 'known', value: '1', unit: 'uL' });
    assert.ok(source.incidentReviewRootIds.includes(ids.knownRoot));
    assert.ok(child.incidentReviewRootIds.includes(ids.knownRoot));
    proof.childStockId = child.id;
    const identified = one(
      Object.values(current.state.stocks).filter((x) => x.vesselId === ids.unknownVesselId),
      'Identified retained episode'
    );
    same(identified.quantity, { kind: 'unknown', unit: 'uL' });
    assert.equal(identified.quality, 'quarantined');
    assert.ok(identified.incidentReviewRootIds.includes(ids.unknownRoot));
    const availability = await native('availability');
    for (const id of [source.id, child.id]) {
      assert.equal(availability.stocks[id].actions.withdraw.kind, 'blocked');
      assert.ok(
        availability.stocks[id].actions.withdraw.blockers.some(
          (x) => x.code === 'INCIDENT_REVIEW_REQUIRED'
        )
      );
    }
    const factPin = (name) => ({
      factId: proof.steps[name].actionProof.actionId,
      intentSha256: proof.steps[name].actionProof.intentSha256,
    });
    same(proof.steps.remove.request.choices.action.subjects[0].supersedes, factPin('keep'));
    same(
      proof.steps.keepAfterResolution.request.choices.action.subjects[0].supersedes,
      factPin('remove')
    );
    same(current.state.storage[ids.boxId].placement, {
      kind: 'located',
      storageId: ids.receiverId,
      slotId: 'A',
    });
    for (const holder of incident.initial.holders)
      if (holder.item.kind === 'storage' && holder.item.id !== ids.boxId)
        same(
          current.state.storage[holder.item.id].placement,
          proof.actionBaseline.state.storage[holder.item.id].placement
        );
    assert.equal(current.state.revision, proof.reportReceipt.revision + steps.length);
    same(current.history.slice(0, proof.reportReceipt.revision), proof.actionBaseline.history);
    same(proof.steps.correctReading.request.choices.action.supersedes, {
      factId: proof.steps.manual.actionProof.actionId,
      intentSha256: proof.steps.manual.actionProof.intentSha256,
    });
    same(proof.steps.withdrawReading.request.choices.action.supersedes, {
      factId: proof.steps.correctReading.actionProof.actionId,
      intentSha256: proof.steps.correctReading.actionProof.intentSha256,
    });
    const stale = await showFact('manual');
    await expect(stale.locator('[data-freshness-state="stale"]')).toBeVisible();
    await capture('02-selected-original-manual-fact-stale', stale);
    const exact = await detail();
    async function settledSubjects(view, label) {
      const observed = await native('equipmentIncidentSubjects', {
        ...scope,
        ...pin,
        view,
        limit: 20,
        freshnessMaxAgeMs: 6000,
      });
      assert.equal(observed.kind, 'ready');
      assert.equal(observed.revision, current.state.revision);
      await exact.getByRole('tab', { name: label, exact: true }).click();
      const subjects = exact.getByTestId('equipment-incident-subjects');
      await expect(subjects).toHaveAttribute('data-subject-view', view);
      await expect
        .poll(() =>
          subjects
            .locator('[data-subject-key]')
            .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-subject-key')))
        )
        .toEqual(observed.subjects.map((row) => row.key));
      await expect(subjects.getByRole('status')).toHaveCount(0);
      return { observed, subjects };
    }
    const initial = await settledSubjects('initial', 'Contents when recorded');
    const initialVessel = one(
      initial.observed.subjects.filter(
        (row) => row.kind === 'vessel' && row.snapshot.item.id === ids.unknownVesselId
      ),
      'Original confirmed unidentified vessel'
    );
    await capture(
      '03-original-recorded-unidentified-vessel',
      initial.subjects.locator(`[data-subject-key=${JSON.stringify(initialVessel.key)}]`)
    );
    const now = await settledSubjects('current', 'Contents now');
    const currentVessel = one(
      now.observed.subjects.filter(
        (row) => row.kind === 'vessel' && row.stock?.quantity.kind === 'unknown'
      ),
      'Remaining source vessel with unknown quantity'
    );
    await capture(
      '04-current-source-vessel-after-one-box-rescue',
      now.subjects.locator(`[data-subject-key=${JSON.stringify(currentVessel.key)}]`)
    );
    const review = await settledSubjects('review', 'Review obligations');
    for (const [name, match] of [
      [
        '05-known-subject-review-restriction-kept',
        (row) => row.kind === 'root' && row.root.id === ids.knownRoot,
      ],
      [
        '06-original-unknown-episode-review-retained',
        (row) => row.kind === 'root' && row.root.id === ids.unknownRoot,
      ],
      [
        '07-source-stock-retained-review-root',
        (row) => row.kind === 'stock' && row.stock.id === source.id,
      ],
      [
        '08-derived-aliquot-retained-review-root',
        (row) => row.kind === 'stock' && row.stock.id === child.id,
      ],
    ]) {
      const row = one(review.observed.subjects.filter(match), name),
        article = review.subjects.locator(`[data-subject-key=${JSON.stringify(row.key)}]`);
      if (row.kind === 'root')
        await expect(article).toContainText(
          row.root.id === ids.knownRoot
            ? 'Reviewed — restriction kept'
            : 'Pending review restriction'
        );
      if (row.kind === 'stock')
        await expect(article).toContainText(
          row.stock.id === child.id ? 'Derived material' : 'Direct subject'
        );
      await capture(name, article);
    }
    for (const [name, stock] of [
      ['09-source-use-blocked', source],
      ['10-derived-aliquot-use-blocked', child],
    ]) {
      const panel = await openLocation(ids.boxId);
      await panel.locator(`[data-stock-id="${stock.id}"]`).click();
      const drawer = panel.getByTestId('inventory-detail-drawer'),
        availability = drawer.getByTestId('inventory-stock-availability');
      await expect(availability).toHaveAttribute(
        'data-inventory-revision',
        String(current.state.revision)
      );
      await expect(
        availability.locator('[data-blocker-code="INCIDENT_REVIEW_REQUIRED"]')
      ).toBeVisible();
      await expect(button(drawer, 'Transfer or aliquot')).toBeDisabled();
      await capture(name, availability);
    }
    const unchanged = await ctx.inventoryRead(scope);
    same(unchanged.state, current.state);
    same(unchanged.history, current.history);
    checkpoint('final');
    writeFileSync(
      path.join(evidenceDirectory, 'equipment-incidents-reopen-fixture.json'),
      JSON.stringify({ ...fixture, ...current, equipmentIncidentJourney: proof }, null, 2)
    );
    return {
      revision: current.state.revision,
      incident: pin,
      sourceStockId: source.id,
      childStockId: child.id,
      steps: steps.length,
    };
  } finally {
    await page.evaluate(() => {
      window.__equipmentIncidentObserver?.unsubscribe();
      delete window.__equipmentIncidentObserver;
    });
  }
}
export const runInventoryEquipmentIncidents = (ctx) => run(ctx);
export const runInventoryEquipmentIncidentsResume = (ctx) => run(ctx);
export const runInventoryEquipmentIncidentsReopen = (ctx) => run(ctx, true);

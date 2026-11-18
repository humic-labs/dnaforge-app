import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
async function run(ctx, reopen) {
  const { page, expect, fixture, evidenceDirectory } = ctx;
  const current = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  assert.equal(current.state.revision, 102);
  let proof = fixture.designSetupJourney ?? {
    completedStep: 0,
    name: `Demonstration DNA ${randomUUID().slice(0, 8)}`,
    bases: 'ACGTACGTTGCAACGTTGCAACGT',
    workspace: fixture.scope.project,
    workspaceRoot: fixture.project.path,
  };
  function checkpoint(name) {
    const saved = {
      ...fixture,
      ...current,
      designSetupJourney: proof,
      resumePhase: 'design-setup',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-design-setup-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  }
  async function unchanged() {
    assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
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
  const native = async (method, request) =>
    page.evaluate(
      async (input) => window.electronAPI.scientificObjects[input.method](input.request),
      { method, request }
    );
  const scopeRequest = {
    workspaceRoot: proof.workspaceRoot,
    request: { workspace: proof.workspace },
  };
  const catalog = () => native('catalog', scopeRequest);
  async function scientificSnapshot() {
    const listing = await catalog(),
      matches = listing.entries.filter(
        (row) => !row.tombstone && row.path?.endsWith(`/${proof.name}.gb`)
      );
    assert.ok(matches.length <= 1, 'Never create another design to resolve an uncertain creation.');
    if (!matches.length) return null;
    const entry = matches[0],
      snapshot = await native('read', {
        workspaceRoot: proof.workspaceRoot,
        request: {
          workspace: proof.workspace,
          resourceId: entry.resourceId,
          revisionId: entry.revisionId,
        },
      });
    return { catalog: listing, entry, snapshot };
  }
  async function projectRow() {
    const row = page.locator(`[role="treeitem"][data-entry-path="${fixture.project.path}"]`);
    if (!(await row.isVisible())) await page.getByTestId('files-button').click();
    await expect(row).toBeVisible();
    return row;
  }
  async function openRun() {
    await dismiss();
    await projectRow();
    const saved = fixture.runValuesJourney.valuedRun;
    await page
      .locator(`[data-entry-path="${saved.path.replace(/\/.forge\/protocol-run\.json$/u, '')}"]`)
      .dblclick();
    await expect(field(page.getByTestId('scientific-document-tab'), 'Document title')).toHaveValue(
      saved.title
    );
    const panel = page.getByTestId('scientific-design-setup');
    await expect(panel).toHaveAttribute('data-project-id', fixture.scope.project);
    return panel;
  }
  async function originalRequest(panel) {
    const details = panel.locator('details');
    if (!(await field(panel, 'Original design setup request').isVisible()))
      await details
        .getByText('Setup request and saved history identities', { exact: true })
        .click();
    const input = JSON.parse(await field(panel, 'Original design setup request').inputValue());
    assert.equal(input.request.workspace, proof.workspace);
    assert.equal(input.request.expectedHead, null);
    assert.deepEqual(input.request.source, { kind: 'initialize-empty-namespace' });
    if (proof.request)
      assert.deepEqual(input, proof.request, 'Reuse the exact retained setup request.');
    proof = { ...proof, request: input };
    checkpoint('00-original-setup-request-before-submit');
    return input;
  }
  async function accepted(panel, key, step) {
    await expect(panel).toHaveAttribute('data-setup-phase', 'ready');
    const parsed = JSON.parse(await panel.locator('details pre').textContent());
    proof = { ...proof, [key]: parsed.result, completedStep: step };
    checkpoint(`0${step}-setup-accepted-before-assertions`);
    assert.equal(parsed.result.operationId, proof.request.request.operationId);
    assert.equal(parsed.result.receipt.outcome, 'changed');
    assert.equal(parsed.result.delivery.kind, 'complete');
    await unchanged();
    return parsed.result;
  }
  checkpoint('00-current-inventory');
  if (reopen) assert.equal(proof.completedStep, 5);
  let panel = await openRun();
  if (proof.completedStep < 1) {
    await expect
      .poll(async () => await panel.getAttribute('data-setup-phase'))
      .toMatch(/needs-setup|unknown|ready|accepted-pending/u);
    await originalRequest(panel);
    if (await button(panel, 'Set up versioned designs').isVisible()) {
      proof = { ...proof, setupStarted: true };
      checkpoint('00-setup-send-prepared');
      await button(panel, 'Set up versioned designs').click();
    } else await button(panel, 'Retry same setup').click();
    await accepted(panel, 'initialResult', 1);
    const empty = await native('list', scopeRequest);
    proof = { ...proof, emptyAccepted: empty };
    checkpoint('01-empty-accepted-catalog-before-assertions');
    assert.deepEqual(empty.entries, []);
    const map = JSON.parse(
      await page.evaluate(
        (input) => window.electronAPI.fs.readTextFile(input),
        `${proof.workspaceRoot}/.dnaforge/scientific-objects.json`
      )
    );
    assert.equal(map.formatVersion, 1);
    assert.deepEqual(map.entries, []);
    proof = { ...proof, initialMap: map };
    checkpoint('01-empty-map-delivered');
    await capture('01-explicit-setup-ready-existing-project-preserved', panel);
  }
  if (proof.completedStep < 2) {
    await originalRequest(panel);
    await button(panel, 'Retry same setup').click();
    const result = await accepted(panel, 'emptyReplay', 2);
    assert.equal(result.replayed, true);
    assert.equal(result.receipt.version, proof.initialResult.receipt.version);
    assert.equal(result.currentHead, proof.initialResult.currentHead);
  }
  if (proof.completedStep < 3) {
    let saved = await scientificSnapshot();
    if (!saved) {
      if (proof.creationStarted) {
        const named = page.getByTestId('file-tree-rename-input');
        await expect(named).toHaveValue(proof.name);
        assert.ok(
          await named.isVisible(),
          'Recover the original live DNA creation; never allocate another pending identity.'
        );
        await named.press('Enter');
      } else {
        await dismiss();
        const project = await projectRow();
        await project.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'New…', exact: true }).hover();
        await page.getByRole('menuitem', { name: 'DNA sequences', exact: true }).click();
        await page
          .getByRole('menu', { name: 'DNA sequences actions', exact: true })
          .getByRole('menuitem', { name: 'Create', exact: true })
          .click();
        const input = page.getByTestId('file-tree-rename-input');
        await expect(input).toHaveValue('Untitled DNA sequence');
        await expect(input).toBeVisible();
        await input.fill(proof.name);
        proof = {
          ...proof,
          creationStarted: true,
          pendingEntryId: await input
            .locator('xpath=ancestor::*[@data-entry-id][1]')
            .getAttribute('data-entry-id'),
        };
        checkpoint('00-ordinary-dna-create-before-enter');
        await input.press('Enter');
      }
      await expect
        .poll(async () => {
          saved = await scientificSnapshot();
          return saved?.snapshot?.document.kind ?? 'missing';
        })
        .toBe('sequence');
    }
    proof = { ...proof, emptyDesign: saved, completedStep: 3 };
    checkpoint('03-empty-design-accepted-before-assertions');
    assert.equal(saved.snapshot.document.bases, '');
    await unchanged();
  }
  if (proof.completedStep < 4) {
    let saved = await scientificSnapshot();
    if (saved.snapshot.document.bases === proof.bases) {
      proof = { ...proof, design: saved, completedStep: 4 };
      checkpoint('04-existing-design-save-reconciled-before-assertions');
    } else {
      assert.equal(saved.snapshot.document.bases, '');
      await projectRow();
      const packagePath = `${proof.workspaceRoot}/${proof.name}`;
      if (!(await page.getByTestId('empty-sequence-entry-cue').isVisible()))
        await page.locator(`[data-entry-path="${packagePath}"]`).dblclick();
      await expect(page.getByTestId('edit-mode-bar')).toBeVisible();
      const inspectDraft = () =>
        page.evaluate((input) => window.electronAPI.fs.sequenceDocument(input), {
          documentId: proof.emptyDesign.entry.resourceId,
          operation: { kind: 'inspect', start: 0, limit: 1000 },
          projection: 'inspection',
        });
      let draft = await inspectDraft();
      proof = {
        ...proof,
        typingPhase:
          draft.bases?.text === ''
            ? 'empty-confirmed'
            : draft.bases?.text === proof.bases
              ? 'exact-draft-confirmed'
              : 'unexpected-draft',
        beforeTypingDraft: draft,
      };
      checkpoint('00-actual-draft-before-typing-or-resume');
      if (draft.bases?.text === '' && !proof.afterTypingDraft) {
        proof = { ...proof, typingStarted: true, typingPhase: 'typing-prepared' };
        checkpoint('00-explicit-bases-before-ordinary-typing');
        const editor = page.getByTestId('sequence-viewer-container');
        await expect(editor).toBeVisible();
        await editor.click({ position: { x: 12, y: 40 } });
        await page.keyboard.type(proof.bases);
        draft = await inspectDraft();
        proof = { ...proof, typingPhase: 'typing-event-returned', afterTypingDraft: draft };
        checkpoint('00-ordinary-typing-event-returned-before-assertions');
      }
      if (proof.afterTypingDraft && draft.bases?.text !== proof.bases) {
        assert.ok(
          typeof draft.bases?.text === 'string' && proof.bases.startsWith(draft.bases.text),
          'Preserve unexpected draft content without appending or replacing it.'
        );
        await expect
          .poll(
            async () => {
              draft = await inspectDraft();
              return draft.bases?.text;
            },
            { timeout: 10000 }
          )
          .toBe(proof.bases);
        proof = { ...proof, typingPhase: 'queued-typing-settled', settledTypingDraft: draft };
        checkpoint('00-ordinary-typing-queue-settled-before-save');
      }
      assert.equal(
        draft.bases?.text,
        proof.bases,
        'The original draft must be empty or exactly the expected design; preserve partial content without appending.'
      );
      proof = { ...proof, typingPhase: 'exact-draft-confirmed' };
      checkpoint('00-exact-nonempty-draft-confirmed');
      proof = { ...proof, saveStarted: true, savedDraftIntent: draft };
      checkpoint('00-ordinary-nonempty-dna-save-before-click');
      await capture(
        '02-real-nonempty-dna-draft-before-save',
        page.getByTestId('sequence-viewer-container')
      );
      await page.getByTestId('edit-mode-save-btn').click();
      await expect
        .poll(async () => {
          saved = await scientificSnapshot();
          return saved?.snapshot?.document.bases ?? null;
        })
        .toBe(proof.bases);
      proof = { ...proof, design: saved, completedStep: 4 };
      checkpoint('04-nonempty-design-accepted-before-assertions');
    }
    assert.equal(proof.design.snapshot.document.kind, 'sequence');
    assert.equal(proof.design.snapshot.document.molecule, 'DNA');
    assert.equal(proof.design.snapshot.representation.format, 'genbank-v1');
    assert.notEqual(proof.design.entry.revisionId, proof.emptyDesign.entry.revisionId);
    await unchanged();
    await capture(
      '03-saved-nonempty-accepted-design',
      page.getByTestId('sequence-viewer-container')
    );
  }
  panel = await openRun();
  await originalRequest(panel);
  if (proof.completedStep < 5) {
    await button(panel, 'Retry same setup').click();
    const result = await accepted(panel, 'laterReplay', 5);
    assert.equal(result.replayed, true);
    assert.equal(result.receipt.version, proof.initialResult.receipt.version);
    assert.equal(result.currentHead, proof.design.catalog.head);
    assert.notEqual(result.currentHead, result.receipt.version);
    await capture('04-original-setup-retry-preserves-later-accepted-design', panel);
  }
  if (reopen) {
    await button(panel, 'Retry same setup').click();
    const result = await accepted(panel, 'restartReplay', 5);
    assert.equal(result.replayed, true);
    assert.equal(result.currentHead, proof.laterReplay.currentHead);
    await capture('05-restarted-original-setup-and-current-design-history', panel);
  }
  const saved = await scientificSnapshot();
  assert.deepEqual(saved, proof.design);
  const map = JSON.parse(
    await page.evaluate(
      (input) => window.electronAPI.fs.readTextFile(input),
      `${proof.workspaceRoot}/.dnaforge/scientific-objects.json`
    )
  );
  assert.equal(map.formatVersion, 2);
  assert.ok(map.entries.some((row) => row.resourceId === saved.entry.resourceId));
  const materials = await page.evaluate((input) => window.electronAPI.inventory.materials(input), {
    project: fixture.scope.project,
    query: proof.name,
    limit: 20,
  });
  proof = { ...proof, finalMap: map, materialRead: materials };
  assert.ok(
    materials.items.some((row) => row.id === saved.entry.resourceId),
    'The accepted design must have its same-project material projection.'
  );
  checkpoint('05-original-setup-and-nonempty-design-final-read');
  await unchanged();
  const final = checkpoint('06-complete');
  writeFileSync(
    path.join(evidenceDirectory, 'design-setup-reopen-fixture.json'),
    JSON.stringify(final, null, 2)
  );
  return {
    inventoryRevision: 102,
    inventoryUnchanged: true,
    setupOperationId: proof.request.request.operationId,
    designId: proof.design.entry.resourceId,
    designRevision: proof.design.entry.revisionId,
    bases: proof.bases.length,
    originalSetupRetryPreservesCurrentHead: true,
  };
}
export const runInventoryDesignSetup = (ctx) => run(ctx, false);
export const runInventoryDesignSetupResume = (ctx) => run(ctx, false);
export const runInventoryDesignSetupReopen = (ctx) => run(ctx, true);

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function rawInventory(userDataPath, inventoryId) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import json,sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
row=db.execute('SELECT revision,state_json FROM inventory_state WHERE inventory_id=?',(sys.argv[2],)).fetchone()
history=db.execute('SELECT operation_id,revision,request_json,receipt_json FROM inventory_journal WHERE inventory_id=? ORDER BY revision',(sys.argv[2],)).fetchall()
print(json.dumps({'state':None if row is None else {'revision':row[0],'json':row[1]},'history':[{'operationId':r[0],'revision':r[1],'requestJson':r[2],'receiptJson':r[3]} for r in history]}))
`,
        path.join(userDataPath, 'dnaforge.db'),
        inventoryId,
      ],
      { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 }
    )
  );
}

async function openInventory(ctx, name) {
  await ctx.page.getByTestId('inventory-button').click();
  await ctx.choose(ctx.page, 'Inventory project', name);
  await ctx.expect(ctx.page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
}

async function captureArchive(ctx, project, scope, name) {
  const { page, expect, evidenceDirectory } = ctx;
  await button(page.getByTestId('inventory-panel').locator('header'), 'Export inventory').click();
  const form = dialog(page, 'Export inventory archive');
  await button(form, 'Capture inventory archive').click();
  const captured = form.getByTestId('inventory-archive-captured');
  await expect(captured).toBeVisible();
  const artifact = await page.evaluate(
    (input) => window.electronAPI.inventory.exportSnapshot(input),
    { ...scope, format: 'native-v1' }
  );
  assert.equal(await captured.getAttribute('data-source-sha256'), artifact.sourceSha256);
  assert.equal(
    await captured.getAttribute('data-source-revision'),
    String(artifact.source.revision)
  );
  assert.equal(
    await form.getByTestId('inventory-archive-source-text').inputValue(),
    artifact.sourceText
  );
  assert.equal(hash(artifact.sourceText), artifact.sourceSha256);
  const savedPath = path.join(evidenceDirectory, `${name}.dnaforge-inventory.json`);
  const proof = await page.evaluate(
    async ({ scope, savedPath }) => {
      const { InventoryArchiveSession } =
        await import('/src/features/inventory/inventory-archive-session.ts');
      const session = new InventoryArchiveSession(scope, window.electronAPI.inventory, {
        chooseDestination: async () => savedPath,
        write: (path, content) => window.electronAPI.fs.writeTextFileAtomic({ path, content }),
        read: async (path) => {
          const { readInventoryArchiveFile } =
            await import('/src/features/inventory/inventory-archive-file.ts');
          return readInventoryArchiveFile(path);
        },
      });
      await session.capture();
      await session.exportArchive();
      return session.getSnapshot();
    },
    { scope, savedPath }
  );
  assert.equal(proof.capture.kind, 'captured');
  assert.equal(proof.output.kind, 'exported');
  assert.equal(proof.capture.artifact.sourceText, artifact.sourceText);
  assert.equal(readFileSync(savedPath, 'utf8'), artifact.sourceText);
  assert.equal(hash(readFileSync(savedPath)), artifact.sourceSha256);
  await expect(form.getByTestId('inventory-archive-export')).toHaveAttribute(
    'data-output-state',
    'not-exported'
  );
  writeFileSync(
    path.join(evidenceDirectory, `${name}-explicit-destination-proof.json`),
    JSON.stringify(
      {
        boundary:
          'Production archive session and real native filesystem ports; automation supplies destination. Native file dialog selection is unqualified.',
        nativeDialogQualified: false,
        project,
        scope,
        savedPath,
        artifact,
        proof,
      },
      null,
      2
    )
  );
  await captured.scrollIntoViewIfNeeded();
  await ctx.capture(`${name}-captured-native-archive-and-exact-file-output`, {
    artifact,
    savedPath,
    nativeDialogQualified: false,
  });
  await button(form, 'Close').click();
  return { artifact, savedPath };
}

async function openStock(ctx, id) {
  const close = button(ctx.page, 'Close stock details');
  if (await close.isVisible()) await close.click();
  await button(ctx.page, 'All stock').click();
  await ctx.page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`).click();
}

export async function runInventoryPortabilityJourney(ctx) {
  const {
    page,
    expect,
    choose,
    inventoryRead,
    capture,
    fixture: inputFixture,
    evidenceDirectory,
    projectRoot,
    userDataPath,
  } = ctx;
  const prepared = inputFixture.portabilityPreparation;
  const fixture = prepared?.sourceFixture ?? inputFixture;
  await openInventory(ctx, fixture.project.name);
  const initial = await inventoryRead(fixture.scope);
  assert.deepEqual(initial.state, {
    ...fixture.state,
    schema: 'dnaforge.inventory.v12',
    origin: { kind: 'native' },
  });
  assert.deepEqual(initial.history, fixture.history);
  const sourceRaw = rawInventory(userDataPath, fixture.scope.inventoryId);
  if (prepared) assert.deepEqual(sourceRaw, prepared.sourceRaw);
  const source =
    prepared?.source ?? (await captureArchive(ctx, fixture.project, fixture.scope, '01-source'));
  assert.equal(hash(readFileSync(source.savedPath)), source.artifact.sourceSha256);
  const document = JSON.parse(source.artifact.sourceText);
  assert.equal(document.content.state.json, sourceRaw.state.json);
  assert.equal(document.content.history.length, initial.state.revision);
  assert.ok(document.content.history.length > 100);
  assert.deepEqual(
    document.content.history.map(({ operationId, revision, requestJson, receiptJson }) => ({
      operationId,
      revision,
      requestJson,
      receiptJson,
    })),
    sourceRaw.history
  );
  assert.deepEqual(await inventoryRead(fixture.scope), initial);
  await capture('02-complete-history-and-original-raw-strings-before-adoption', {
    sourceRaw,
    artifact: source.artifact,
  });

  let destination = prepared?.destination;
  if (!destination) {
    const destinationName = `Archive acceptance ${Date.now().toString(36)}`;
    await page.getByTestId('files-button').click();
    await button(page, 'Manage projects').click();
    await page.getByTestId('project-switcher-new-project').click();
    await page.getByLabel('New project name', { exact: true }).fill(destinationName);
    await page.getByTestId('project-switcher-new-project-create').click();
    await expect(page.getByLabel('New project name', { exact: true })).toBeHidden();
    await expect
      .poll(
        async () => {
          const projects = await page.evaluate(() => window.electronAPI.inventory.projects());
          destination = projects.find((candidate) => candidate.name === destinationName);
          return Boolean(destination);
        },
        { timeout: 30_000 }
      )
      .toBe(true);
  }
  assert.ok(destination.path.startsWith(`${userDataPath}/`));
  const scope = { project: destination.projectId, inventoryId: destination.defaultInventoryId };
  assert.equal((await inventoryRead(scope)).state, null);
  const materialBindings = [...(prepared?.materialBindings ?? [])];
  const savePreparation = () =>
    writeFileSync(
      path.join(evidenceDirectory, 'prepared-destination.json'),
      JSON.stringify(
        {
          project: destination,
          portabilityPreparation: {
            source,
            sourceRaw,
            initial,
            destination,
            scope,
            materialBindings,
            sourceFixture: fixture,
          },
        },
        null,
        2
      )
    );
  savePreparation();
  for (const reference of document.content.scientificReferences) {
    if (materialBindings.some((binding) => binding.sourceMaterialId === reference.materialId))
      continue;
    const sourceMaterial = await page.evaluate(
      async ({ project, id }) => {
        const result = await window.electronAPI.inventory.materials({
          project,
          query: id,
          limit: 100,
        });
        return result.items.find((item) => item.id === id);
      },
      { project: fixture.project.projectId, id: reference.materialId }
    );
    assert.ok(sourceMaterial);
    let destinationMaterialId;
    if (reference.materialId === fixture.materialId) {
      const content = readFileSync(
        path.join(projectRoot, 'test-fixtures/sequences/circular/pUC19.gb'),
        'utf8'
      );
      const imported = await page.evaluate(
        async (input) => {
          const { platform } = await import('/src/platform/index.ts');
          return platform().workspace.registerImportedSequenceFromContent(input);
        },
        {
          content,
          fileName: `archive-counterpart-${destination.projectId}.gb`,
          targetRoot: destination.path,
        }
      );
      assert.equal(imported.registered, true, JSON.stringify(imported));
      destinationMaterialId = imported.entityIds[0];
    } else {
      assert.equal(
        sourceMaterial.name,
        'Water acceptance',
        'Only explicit representative scientific counterparts are created by this journey.'
      );
      destinationMaterialId = await page.evaluate(
        async ({ destinationPath }) => {
          const { platform } = await import('/src/platform/index.ts');
          const { recordEntityArtifact } =
            await import('/src/features/lims/public/record-entity-artifact.ts');
          let schema = (await platform().lims.listSchemas()).find(
            (item) => item.entityKind === 'inventory-buffer-acceptance'
          );
          if (!schema) {
            await platform().lims.defineSchema({
              kind: 'entity',
              name: 'inventory-buffer-acceptance',
              displayName: 'Inventory buffer acceptance',
              fields: [{ key: 'description', label: 'Description', type: 'text' }],
              existingPolicy: 'reuse',
            });
            schema = (await platform().lims.listSchemas()).find(
              (item) => item.entityKind === 'inventory-buffer-acceptance'
            );
          }
          if (!schema) throw new Error('The representative buffer schema is unavailable.');
          const id = crypto.randomUUID();
          await recordEntityArtifact({
            id,
            kind: schema.entityKind,
            schemaId: schema.schemaId,
            expectedSchemaRevisionId: schema.currentRevisionId,
            name: 'Archive water counterpart',
            fields: {
              description: 'Synthetic explicit scientific binding for archive software acceptance',
            },
            workspaceRoot: destinationPath,
            destinationDir: destinationPath,
          });
          return id;
        },
        { destinationPath: destination.path }
      );
    }
    const admitted = await page.evaluate(
      async ({ project, id }) => {
        const result = await window.electronAPI.inventory.materials({
          project,
          query: id,
          limit: 100,
        });
        return result.items.find((item) => item.id === id);
      },
      { project: destination.projectId, id: destinationMaterialId }
    );
    assert.ok(
      admitted,
      'The existing scientific owner must admit the counterpart in the actual destination project.'
    );
    materialBindings.push({ sourceMaterialId: reference.materialId, destinationMaterialId });
    savePreparation();
  }
  await openInventory(ctx, destination.name);
  await capture('03-fresh-destination-with-explicit-scientific-counterparts', {
    destination,
    scope,
    materialBindings,
    state: await inventoryRead(scope),
  });
  await button(page.getByTestId('inventory-panel').locator('header'), 'Import archive').click();
  const form = dialog(page, 'Import inventory archive');
  await form.getByTestId('inventory-import-source-details').locator('summary').click();
  await form.getByTestId('inventory-import-source').fill(readFileSync(source.savedPath, 'utf8'));
  const targetRaw = rawInventory(userDataPath, scope.inventoryId);
  await button(form, 'Preview archive import').click();
  await expect(form.getByTestId('inventory-archive-import')).toHaveAttribute(
    'data-preview-state',
    'blocked'
  );
  assert.deepEqual(rawInventory(userDataPath, scope.inventoryId), targetRaw);
  await capture('04-missing-scientific-bindings-block-with-zero-inventory-effects', {
    destination,
    state: await inventoryRead(scope),
    previewText: await form.getByTestId('inventory-import-preview').innerText(),
  });
  for (const binding of materialBindings) {
    await form
      .getByLabel('Search destination scientific records', { exact: true })
      .fill(binding.destinationMaterialId);
    await expect
      .poll(async () => {
        const sourceRow = form.locator(`[data-source-material-id="${binding.sourceMaterialId}"]`);
        await sourceRow.getByRole('combobox').click();
        const options = page.getByRole('option').filter({ hasText: binding.destinationMaterialId });
        const count = await options.count();
        if (count === 1) {
          await options.click();
          return true;
        }
        await page.keyboard.press('Escape');
        return false;
      })
      .toBe(true);
  }
  await button(form, 'Preview archive import').click();
  await expect(form.getByTestId('inventory-archive-import')).toHaveAttribute(
    'data-preview-state',
    'ready'
  );
  const preview = await page.evaluate(
    (input) => window.electronAPI.inventory.previewImport(input),
    { ...scope, sourceText: source.artifact.sourceText, options: { bindings: materialBindings } }
  );
  assert.equal(preview.kind, 'ready');
  assert.deepEqual(rawInventory(userDataPath, scope.inventoryId), targetRaw);
  await capture('05-explicit-native-plan-before-first-destination-operation', {
    destination,
    preview,
    raw: targetRaw,
  });
  await button(form, 'Adopt archived inventory').click();
  await expect(form).toBeHidden();
  await expect(page.getByTestId('inventory-panel')).toHaveAttribute('data-state', 'ready');
  const adopted = await inventoryRead(scope);
  assert.equal(adopted.state.revision, 1);
  assert.equal(adopted.history.length, 1);
  assert.equal(adopted.history[0].request.kind, 'adopt-archive');
  assert.equal(adopted.history[0].request.sourceText, source.artifact.sourceText);
  const expected = await page.evaluate(
    async ({ root, initial, materialBindings, receipt, source }) => {
      const { adoptInventoryState } = await import(
        `/@fs${root}/packages/core/domain-services/src/inventory-adoption.ts`
      );
      return adoptInventoryState(
        null,
        initial,
        {
          source: {
            archiveSha256: source.sourceSha256,
            projectId: source.source.projectId,
            inventoryId: source.source.inventoryId,
            revision: source.source.revision,
          },
          materialBindings: Object.fromEntries(
            materialBindings.map((binding) => [
              binding.sourceMaterialId,
              binding.destinationMaterialId,
            ])
          ),
        },
        {
          at: receipt.recordedAt,
          principal: receipt.context.principal,
          authority: receipt.context.authority,
        }
      );
    },
    {
      root: projectRoot,
      initial: initial.state,
      materialBindings,
      receipt: adopted.history[0].receipt,
      source: source.artifact,
    }
  );
  assert.equal(expected.ok, true);
  assert.deepEqual(adopted.state, expected.state);
  for (const key of [
    'storage',
    'vessels',
    'stocks',
    'lots',
    'reservations',
    'typeVersions',
    'recipeVersions',
    'fitEvidence',
    'itemCodes',
    'temperatureClaims',
    'equipmentSetpoints',
    'storageRequirements',
    'thermalContexts',
  ])
    assert.deepEqual(
      Object.keys(adopted.state[key]).sort(),
      Object.keys(initial.state[key]).sort()
    );
  assert.deepEqual(
    Object.fromEntries(
      Object.values(adopted.state.stocks).map((stock) => [stock.id, stock.quantity])
    ),
    Object.fromEntries(
      Object.values(initial.state.stocks).map((stock) => [stock.id, stock.quantity])
    )
  );
  assert.deepEqual(rawInventory(userDataPath, fixture.scope.inventoryId), sourceRaw);
  await expect(page.getByTestId('inventory-archive-origin')).toBeVisible();
  await capture('06-adopted-facts-and-explicit-origin-with-one-native-operation', adopted);
  await openStock(ctx, fixture.stockId);
  await expect(page.getByTestId('inventory-detail-drawer')).toBeVisible();
  await capture('07-imported-stock-keeps-quantity-location-and-source-evidence', adopted);
  await button(page, 'Close stock details').click();
  await button(page.getByTestId('inventory-panel').locator('header'), 'History').click();
  const history = page.getByTestId('inventory-detail-drawer');
  await expect(history.getByTestId('inventory-history').locator('article')).toHaveCount(1);
  await expect(history).toContainText('Adopted inventory archive');
  await history.getByTestId('inventory-imported-source-evidence').locator('summary').click();
  assert.equal(
    await history.getByLabel('Retained imported archive', { exact: true }).inputValue(),
    source.artifact.sourceText
  );
  await capture(
    '08-original-source-history-retained-without-fabricated-destination-actions',
    adopted
  );
  await button(history, 'Close stock details').click();
  const reexport = await captureArchive(ctx, destination, scope, '09-destination');
  const reexportDocument = JSON.parse(reexport.artifact.sourceText);
  assert.equal(
    JSON.parse(reexportDocument.content.history[0].requestJson).sourceText,
    source.artifact.sourceText
  );
  const current = await inventoryRead(scope);
  assert.deepEqual(current, adopted);
  const result = {
    project: destination,
    scope,
    ...adopted,
    sourceFixture: fixture,
    initialSource: initial,
    sourceRaw,
    source,
    materialBindings,
    reexport,
    stockId: fixture.stockId,
    ids: fixture.ids,
    nativeDialogQualified: false,
  };
  writeFileSync(
    path.join(evidenceDirectory, 'archive-reopen-fixture.json'),
    JSON.stringify(result, null, 2)
  );
  return result;
}

export async function runInventoryPortabilityReopen(ctx) {
  const { fixture, page, expect, inventoryRead, capture, userDataPath } = ctx;
  const observed = await inventoryRead(fixture.scope);
  assert.deepEqual(observed.state, fixture.state);
  assert.deepEqual(observed.history, fixture.history);
  assert.deepEqual(await inventoryRead(fixture.sourceFixture.scope), fixture.initialSource);
  assert.deepEqual(
    rawInventory(userDataPath, fixture.sourceFixture.scope.inventoryId),
    fixture.sourceRaw
  );
  const artifact = await page.evaluate(
    (input) => window.electronAPI.inventory.exportSnapshot(input),
    { ...fixture.scope, format: 'native-v1' }
  );
  assert.equal(artifact.sourceText, fixture.reexport.artifact.sourceText);
  assert.equal(hash(readFileSync(fixture.reexport.savedPath)), artifact.sourceSha256);
  await expect(page.getByTestId('inventory-archive-origin')).toBeVisible();
  await capture('10-reopened-exact-adopted-state-history-source-and-exported-bytes', {
    ...observed,
    artifact,
  });
  await openStock(ctx, fixture.stockId);
  await expect(page.getByTestId('inventory-detail-drawer')).toBeVisible();
  await capture('11-reopened-stock-quantity-and-inherited-source-facts', observed);
  return { ...fixture, ...observed };
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const dialog = (page, name) => page.getByRole('dialog', { name, exact: true });
const codes = (page, id) =>
  page.locator(`[data-testid="inventory-item-codes"][data-item-id="${id}"]`);
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function openStock(page, id) {
  const close = button(page, 'Close stock details');
  if (await close.isVisible()) await close.click();
  await button(page, 'All stock').click();
  await page.getByTestId('inventory-stock-table').locator(`[data-stock-id="${id}"]`).click();
}
async function inspectRendered(ctx, form, code, before) {
  const image = form.getByTestId('inventory-label-preview');
  await ctx
    .expect(form.getByTestId('inventory-label-form'))
    .toHaveAttribute('data-label-state', 'rendered');
  const source = await image.getAttribute('src');
  assert.ok(source.startsWith('data:image/svg+xml;charset=utf-8,'));
  const svg = decodeURIComponent(source.slice(source.indexOf(',') + 1));
  const sha256 = await image.getAttribute('data-artifact-sha256');
  assert.equal(sha256, `sha256:${hash(svg)}`);
  const artifact = await ctx.page.evaluate(
    (input) => window.electronAPI.inventory.prepareLabel(input),
    { ...ctx.fixture.scope, codeId: code.id, mediaProfileId: 'qr-80x50-300dpi' }
  );
  assert.equal(artifact.rendered.svg, svg);
  assert.equal(artifact.svgSha256, sha256);
  assert.equal(artifact.binding.value, code.value);
  assert.equal(artifact.binding.namespace, code.namespace);
  assert.deepEqual(artifact.binding.item, code.item);
  assert.equal(artifact.sourceRevision, before.state.revision);
  assert.deepEqual(await ctx.inventoryRead(ctx.fixture.scope), before);
  return artifact;
}

export async function runInventoryLabelJourney(ctx) {
  const { page, expect, choose, inventoryRead, capture, fixture, evidenceDirectory } = ctx;
  const { scope, ids, stockId } = fixture;
  const initial = await inventoryRead(scope);
  assert.deepEqual(initial.state, fixture.state);
  assert.deepEqual(initial.history, fixture.history);
  await openStock(page, stockId);
  await button(codes(page, ids.child), 'Attach existing code').click();
  let form = dialog(page, 'Attach existing code');
  const value = ' 00123^FNC1^029ABCabc ';
  await form.getByLabel('Namespace', { exact: true }).fill('labels');
  await form.getByLabel('Code', { exact: true }).fill(value);
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic label export acceptance; no physical scanner claim');
  await button(form, 'Attach code').click();
  await expect(form).toBeHidden();
  const before = await inventoryRead(scope);
  const code = Object.values(before.state.itemCodes).find(
    (row) => row.namespace === 'labels' && row.value === value && row.item.id === ids.child
  );
  assert.ok(code);
  assert.deepEqual(before.state.stocks, initial.state.stocks);
  const card = codes(page, ids.child).locator(`[data-code-id="${code.id}"]`);
  await card.scrollIntoViewIfNeeded();
  await capture('01-active-alias-before-label-preparation', before);
  await button(card, 'Create label').click();
  form = dialog(page, 'Create label');
  await choose(form, 'Label size', '80 × 50 mm · 300 dpi');
  await button(form, 'Render label').click();
  const artifact = await inspectRendered(ctx, form, code, before);
  await form.getByTestId('inventory-label-preview').scrollIntoViewIfNeeded();
  await capture('02-rendered-exact-alias-with-namespace-and-complete-target', {
    ...before,
    artifact,
  });
  writeFileSync(
    path.join(evidenceDirectory, 'rendered-artifact.json'),
    JSON.stringify(artifact, null, 2)
  );
  const expectedPath = path.join(evidenceDirectory, 'expected-label.json');
  writeFileSync(
    expectedPath,
    JSON.stringify(
      {
        value,
        sha256: artifact.svgSha256.replace(/^sha256:/u, ''),
        symbol: artifact.rendered.symbol,
        media: artifact.rendered.media,
      },
      null,
      2
    )
  );
  const savedPath = path.join(evidenceDirectory, 'label-export.svg');
  const nativeDialogQualified = ctx.nativeDialogs !== false;
  if (!nativeDialogQualified) {
    const outputProof = await page.evaluate(
      async ({ scope, codeId, savedPath }) => {
        const { InventoryLabelSession } =
          await import('/src/features/inventory/inventory-label-session.ts');
        const session = new InventoryLabelSession(
          { ...scope, codeId },
          window.electronAPI.inventory,
          {
            chooseDestination: async () => savedPath,
            write: (path, content) => window.electronAPI.fs.writeTextFileAtomic({ path, content }),
            read: (path) => window.electronAPI.fs.readTextFile(path),
          }
        );
        session.selectMedia('qr-80x50-300dpi');
        await session.prepare();
        await session.exportLabel();
        return session.getSnapshot();
      },
      { scope, codeId: code.id, savedPath }
    );
    assert.equal(outputProof.preparation.kind, 'rendered');
    assert.equal(outputProof.output.kind, 'exported');
    assert.equal(outputProof.output.path, savedPath);
    assert.equal(outputProof.output.artifact.rendered.svg, artifact.rendered.svg);
    writeFileSync(
      path.join(evidenceDirectory, 'explicit-destination-output-proof.json'),
      JSON.stringify(
        {
          boundary:
            'Production label session with real native filesystem ports and an automation-supplied destination; OS Save panel unqualified.',
          snapshot: outputProof,
        },
        null,
        2
      )
    );
  } else {
    await button(form, 'Export label SVG').click();
    console.log(JSON.stringify({ nativeDialog: 'cancel-label-export', codeId: code.id }));
    await expect(form.getByTestId('inventory-label-export')).toHaveAttribute(
      'data-export-state',
      'not-exported',
      { timeout: 120_000 }
    );
    assert.deepEqual(await inventoryRead(scope), before);
    await capture('03-canceled-save-does-not-report-export', before);
    await button(form, 'Export label SVG').click();
    console.log(
      JSON.stringify({ nativeDialog: 'save-label-export', destination: savedPath, codeId: code.id })
    );
    await expect(form.getByTestId('inventory-label-export')).toHaveAttribute(
      'data-export-state',
      'exported',
      { timeout: 120_000 }
    );
    await expect(form.getByTestId('inventory-label-destination')).toHaveText(savedPath);
  }
  const saved = readFileSync(savedPath);
  assert.equal(saved.toString('utf8'), artifact.rendered.svg);
  assert.equal(`sha256:${hash(saved)}`, artifact.svgSha256);
  assert.deepEqual(await inventoryRead(scope), before);
  await capture(
    nativeDialogQualified
      ? '04-native-atomic-export-confirmed-by-exact-file-readback'
      : '04-native-file-output-with-explicit-destination-save-panel-unqualified',
    {
      ...before,
      artifact,
      savedPath,
      nativeDialogQualified,
    }
  );
  execFileSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '../verify-inventory-label.mjs'),
      '--svg',
      savedPath,
      '--expected',
      expectedPath,
      '--out',
      path.join(evidenceDirectory, 'pixel-proof'),
    ],
    { stdio: 'pipe' }
  );
  await button(form, 'Close').click();
  await button(card, 'Retire code').click();
  form = dialog(page, 'Retire code');
  await form
    .getByLabel('Reason', { exact: true })
    .fill('Synthetic acceptance: retained rendered bytes remain a historical label snapshot');
  await button(form, 'Retire code').click();
  await expect(form).toBeHidden();
  await button(card, 'View retained label').click();
  form = dialog(page, 'Create label');
  await expect(button(form, 'Render label')).toBeDisabled();
  await expect(form.getByTestId('inventory-label-preview')).toHaveAttribute(
    'data-artifact-sha256',
    artifact.svgSha256
  );
  await expect(form.getByTestId('inventory-label-export')).toHaveAttribute(
    'data-export-state',
    nativeDialogQualified ? 'exported' : 'not-exported'
  );
  await expect(form).toContainText('its bytes have not changed');
  const after = await inventoryRead(scope);
  assert.deepEqual(after.state.stocks, initial.state.stocks);
  assert.deepEqual(after.state.reservations, initial.state.reservations);
  assert.deepEqual(after.state.vessels, initial.state.vessels);
  assert.equal(after.state.itemCodes[code.id].lifecycle.kind, 'retired');
  assert.equal(readFileSync(savedPath, 'utf8'), artifact.rendered.svg);
  await capture('05-retired-binding-retains-the-exact-exported-snapshot', {
    ...after,
    artifact,
    savedPath,
  });
  await button(form, 'Close').click();
  return {
    ...fixture,
    ...after,
    labelFixture: { code, artifact, savedPath, expectedPath, nativeDialogQualified },
  };
}

export async function runInventoryLabelReopen(ctx) {
  const { page, expect, inventoryRead, capture, fixture, evidenceDirectory } = ctx;
  const after = await inventoryRead(fixture.scope);
  assert.deepEqual(after.state, fixture.state);
  assert.deepEqual(after.history, fixture.history);
  const { code, artifact, savedPath, expectedPath } = fixture.labelFixture;
  assert.equal(readFileSync(savedPath, 'utf8'), artifact.rendered.svg);
  execFileSync(
    process.execPath,
    [
      path.resolve(import.meta.dirname, '../verify-inventory-label.mjs'),
      '--svg',
      savedPath,
      '--expected',
      expectedPath,
      '--out',
      path.join(evidenceDirectory, 'pixel-proof'),
    ],
    { stdio: 'pipe' }
  );
  await openStock(page, fixture.stockId);
  const card = codes(page, fixture.ids.child).locator(`[data-code-id="${code.id}"]`);
  await expect(card).toHaveAttribute('data-code-state', 'retired');
  await expect(button(card, 'Create label')).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();
  await capture('06-reopened-retired-binding-and-unchanged-complete-history', after);
  const close = button(page, 'Close stock details');
  await close.click();
  await button(page.getByTestId('inventory-panel').locator('header'), 'Scan or enter code').click();
  const form = dialog(page, 'Scan or enter code');
  await form.getByRole('checkbox', { name: 'Search all namespaces', exact: true }).uncheck();
  await form.getByLabel('Namespace', { exact: true }).fill(code.namespace);
  await form.getByLabel('Code', { exact: true }).fill(code.value);
  await button(form, 'Look up').click();
  await expect(form.getByTestId('inventory-code-result')).toHaveAttribute(
    'data-resolution',
    'retired'
  );
  await expect(form.getByTestId('inventory-code-result').locator('article')).toHaveAttribute(
    'data-item-id',
    fixture.ids.child
  );
  assert.deepEqual(await inventoryRead(fixture.scope), after);
  await capture('07-reopened-saved-symbol-remains-decodable-and-historically-resolvable', after);
  await button(form, 'Close').click();
  return { ...fixture, ...after };
}

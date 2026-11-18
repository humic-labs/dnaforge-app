import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const field = (scope, name) => scope.getByRole('textbox', { name, exact: true });
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
async function run(ctx, reopen) {
  const { page, expect, fixture, evidenceDirectory } = ctx,
    current = await ctx.inventoryRead(fixture.scope);
  assert.deepEqual(current.state, fixture.state);
  assert.deepEqual(current.history, fixture.history);
  assert.equal(current.state.revision, 102);
  let proof = fixture.newArtifactContinuityJourney;
  const native = (method, input) =>
    page.evaluate((input) => window.electronAPI.lims[input.method](input.value), {
      method,
      value: input,
    });
  const scientific = () =>
    page.evaluate(
      async (input) => ({
        catalog: await window.electronAPI.scientificObjects.catalog({
          workspaceRoot: input.project.path,
          request: { workspace: input.scope.project },
        }),
        design: await window.electronAPI.scientificObjects.read({
          workspaceRoot: input.project.path,
          request: {
            workspace: input.scope.project,
            resourceId: input.designSetupJourney.design.entry.resourceId,
            revisionId: input.designSetupJourney.design.entry.revisionId,
          },
        }),
      }),
      fixture
    );
  const readText = (file) =>
    page.evaluate((file) => window.electronAPI.fs.readTextFile(file), file);
  if (!proof) {
    const accepted = await scientific(),
      materials = [
        ...new Set(
          [...Object.values(current.state.stocks), ...Object.values(current.state.lots)].map(
            (row) => row.materialId
          )
        ),
      ],
      candidates = [];
    for (const id of materials) {
      const rows = await native('queryEntities', { id });
      for (const row of rows) {
        const document = row.fields?._managedSequenceDocument;
        if (
          !row.tombstone &&
          !row.archivedAt &&
          document?.packageRoot?.startsWith(`${fixture.project.path}/`) &&
          !accepted.catalog.entries.some((slot) => slot.resourceId === row.id)
        )
          candidates.push({ entity: row, packageRoot: document.packageRoot });
      }
    }
    assert.equal(
      candidates.length,
      1,
      'Choose one exact current unaccepted local DNA target from the project facts.'
    );
    const target = candidates[0],
      tag = randomUUID().slice(0, 8),
      schema = (await native('listSchemas')).find((row) => row.entityKind === 'strain');
    assert.ok(schema);
    const link = schema.fields.find(
      (row) => row.key === 'relatedRecord' && row.type === 'record_relationship'
    );
    assert.ok(
      link,
      'The already acknowledged optional link schema must exist; do not repeat schema Save.'
    );
    proof = {
      completedStep: 0,
      target,
      schema,
      link,
      baselineScientific: accepted,
      primerName: `Legacy DNA primer ${tag}`,
      strainName: `Linked legacy strain ${tag}`,
      genotype: 'Explicit demonstration genotype',
      initialInventoryRevision: 102,
    };
  }
  function checkpoint(name) {
    const saved = {
      ...fixture,
      ...current,
      newArtifactContinuityJourney: proof,
      resumePhase: 'new-artifact-continuity',
    };
    writeFileSync(
      path.join(evidenceDirectory, `${name}-new-artifact-continuity-checkpoint.json`),
      JSON.stringify(saved, null, 2)
    );
    return saved;
  }
  async function unchanged() {
    assert.deepEqual(await ctx.inventoryRead(fixture.scope), current);
    assert.deepEqual(await scientific(), proof.baselineScientific);
    if (proof.targetText) assert.equal(await readText(proof.targetPath), proof.targetText);
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
    for (const definition of [
      'dev-registry-seed',
      'use-file-association-opportunities-make-dnaforge-the-default-app-for-example-files',
    ]) {
      const toast = page.locator(`[data-toast-definition="${definition}"]`);
      if (await button(toast, 'Not now').isVisible()) await button(toast, 'Not now').click();
    }
  }
  async function projectRow() {
    const row = page.locator(`[role="treeitem"][data-entry-path="${fixture.project.path}"]`);
    if (!(await row.isVisible())) await page.getByTestId('files-button').click();
    await expect(row).toBeVisible();
    return row;
  }
  async function openTarget() {
    await dismiss();
    await projectRow();
    await page.locator(`[data-entry-path="${proof.target.packageRoot}"]`).dblclick();
    const viewer = page.getByTestId('sequence-viewer-container');
    await expect(viewer).toBeVisible();
    const inspect = await page.evaluate((input) => window.electronAPI.fs.sequenceDocument(input), {
      documentId: proof.target.entity.id,
      operation: { kind: 'inspect', start: 0, limit: 1000 },
      projection: 'inspection',
    });
    assert.equal(inspect.documentId, proof.target.entity.id);
    assert.equal(inspect.dirty, false);
    assert.equal(inspect.readOnly, false);
    if (proof.targetText) assert.equal(inspect.path, proof.targetPath);
    else {
      const targetText = await readText(inspect.path);
      proof = {
        ...proof,
        targetPath: inspect.path,
        targetText,
        targetSha256: createHash('sha256').update(targetText).digest('hex'),
        bases: inspect.bases.text.slice(0, 20),
      };
      checkpoint('00-original-local-dna-before-selection');
    }
    return viewer;
  }
  async function savedArtifact(name, suffix) {
    return page.evaluate(
      async (input) => {
        const pending = [input.root],
          found = [];
        let count = 0;
        while (pending.length) {
          const dir = pending.pop();
          for (const entry of await window.electronAPI.fs.readDir(dir)) {
            if (++count > 2000) throw Error('Artifact read exceeded its bounded project scan.');
            const childPath = `${dir.replace(/[\\/]$/u, '')}/${entry.name}`;
            if (entry.isDirectory) {
              if (entry.name !== '.git') pending.push(childPath);
            } else if (entry.isFile && childPath.endsWith(input.suffix)) {
              const text = await window.electronAPI.fs.readTextFile(childPath);
              let artifact;
              try {
                artifact = JSON.parse(text);
              } catch {
                continue;
              }
              if (artifact.name === input.name) found.push({ path: childPath, text, artifact });
            }
          }
        }
        if (found.length > 1)
          throw Error('More than one original artifact matches; do not create another identity.');
        return found[0] ?? null;
      },
      { root: fixture.project.path, name, suffix }
    );
  }
  async function accepted(kind) {
    let saved;
    await expect
      .poll(async () => {
        saved = await savedArtifact(
          proof[`${kind}Name`],
          kind === 'primer' ? '.primer.json' : '.entity.json'
        );
        return saved?.artifact?.id ?? null;
      })
      .toBeTruthy();
    proof = { ...proof, [`${kind}Source`]: saved };
    checkpoint(`0${kind === 'primer' ? 1 : 2}-${kind}-source-saved-before-projection-assertions`);
    let entity;
    await expect
      .poll(async () => {
        entity = (await native('queryEntities', { id: saved.artifact.id }))[0];
        return entity?.id ?? null;
      })
      .toBe(saved.artifact.id);
    proof = { ...proof, [`${kind}Entity`]: entity, completedStep: kind === 'primer' ? 1 : 2 };
    checkpoint(`0${proof.completedStep}-${kind}-accepted-before-assertions`);
    await unchanged();
    return saved;
  }
  checkpoint('00-current-project-and-accepted-design');
  if (reopen) assert.equal(proof.completedStep, 2);
  if (proof.completedStep < 1) {
    const existing = await savedArtifact(proof.primerName, '.primer.json');
    if (existing) {
      proof = { ...proof, primerSource: existing };
      checkpoint('00-original-primer-source-reconciled');
      await accepted('primer');
    } else {
      let form = page.getByTestId('primer-creation-form');
      if (proof.primerPrepared) {
        assert.ok(
          await form.isVisible(),
          'Retain the original live bound-primer form after uncertainty.'
        );
        await expect(form.getByTestId('primer-name-input')).toHaveValue(proof.primerName);
        await expect(field(form, 'Primer sequence')).toHaveValue(proof.bases);
      } else {
        await page.keyboard.press('Escape');
        const viewer = await openTarget();
        if (await page.getByTestId('sequence-view-mode-2d').isVisible())
          await page.getByTestId('sequence-view-mode-2d').click();
        const original = await page.evaluate(
          (input) => window.electronAPI.fs.sequenceDocument(input),
          {
            documentId: proof.target.entity.id,
            operation: { kind: 'inspect', start: 0, limit: 10000 },
            projection: 'inspection',
          }
        );
        assert.equal(original.documentId, proof.target.entity.id);
        assert.equal(original.dirty, false);
        assert.equal(original.bases.text.length, original.length);
        const dna = original.bases.text.toUpperCase();
        const circularDna = dna + dna.slice(0, 19);
        let found;
        for (let start = 96; start + 20 <= dna.length; start++) {
          const query = dna.slice(start, start + 20);
          if (!/^[ACGT]{20}$/u.test(query)) continue;
          const complement = { A: 'T', C: 'G', G: 'C', T: 'A' };
          const reverse = [...query]
            .reverse()
            .map((base) => complement[base])
            .join('');
          if (
            circularDna.indexOf(query) === start &&
            circularDna.lastIndexOf(query) === start &&
            !circularDna.includes(reverse)
          ) {
            found = { start, end: start + 19, query };
            break;
          }
        }
        assert.ok(found, 'The exact Native DNA needs one unique twenty-base Find match.');
        const closeFind = page.getByRole('button', { name: 'Close find bar', exact: true });
        if (await closeFind.isVisible()) await closeFind.click();
        await viewer.click();
        await page.keyboard.press('Meta+f');
        const find = page.getByRole('search', { name: 'Find in sequence', exact: true });
        await expect(find).toBeVisible();
        await expect(button(find, 'Search mode: DNA bases')).toBeVisible();
        await find.getByRole('textbox', { name: 'Search pattern', exact: true }).fill(found.query);
        await expect(find.getByText('1 of 1', { exact: true })).toBeVisible();
        await button(find, 'Next match').click();
        let mapped;
        await expect
          .poll(async () => {
            mapped = await viewer.evaluate((root, selected) => {
              const canvas = root.querySelector('[data-testid="sequence-canvas-interactive"]');
              const scroll = root.querySelector('[data-testid="sequence-scroll-container"]');
              const geometry = window.__sequenceViewerDiagnostics?.layoutGeometry();
              if (!canvas || !scroll || !geometry || !window.__harnessAnchor) return null;
              const rect = canvas.getBoundingClientRect();
              const container = scroll.getBoundingClientRect();
              const { config } = geometry;
              for (const row of geometry.rows) {
                if (selected.start < row.startPos || selected.start >= row.endPos) continue;
                const y =
                  container.top +
                  row.paintedTracks.sequenceY -
                  scroll.scrollTop +
                  row.paintedSequenceHeight / 2;
                const x =
                  container.left +
                  config.marginLeft +
                  (row.xOffset ?? 0) -
                  scroll.scrollLeft +
                  (selected.start - row.startPos + 0.25) * config.charWidth;
                if (
                  x < Math.max(0, rect.left, container.left) ||
                  x >= Math.min(innerWidth, rect.right, container.right) ||
                  y < Math.max(0, rect.top, container.top) ||
                  y >= Math.min(innerHeight, rect.bottom, container.bottom) ||
                  document.elementFromPoint(x, y) !== canvas
                )
                  continue;
                if (window.__harnessAnchor.bpAt(x, y) !== selected.start) continue;
                return { x, y, start: selected.start, end: selected.end };
              }
              return null;
            }, found);
            return Boolean(mapped);
          })
          .toBe(true);
        proof = { ...proof, findSelection: found, selectionMapping: mapped };
        checkpoint('00-unique-native-find-match-before-context-selection');
        await page.mouse.click(mapped.x, mapped.y, { button: 'right' });
        let selection;
        await expect
          .poll(async () => {
            selection = await page.evaluate(
              (id) => window.__test?.sequenceSelection?.[id]?.getSelection(),
              proof.target.entity.id
            );
            return selection?.kind === 'range'
              ? { start: selection.start, end: selection.end }
              : null;
          })
          .toEqual({ start: found.start, end: found.end });
        const selected = await page.evaluate(
          (input) => window.electronAPI.fs.sequenceDocument(input),
          {
            documentId: proof.target.entity.id,
            operation: {
              kind: 'inspect',
              start: selection.start,
              limit: selection.end - selection.start + 1,
            },
            projection: 'inspection',
          }
        );
        assert.equal(selected.documentId, proof.target.entity.id);
        assert.equal(selected.dirty, false);
        assert.equal(selected.bases.start, selection.start);
        assert.equal(selected.bases.text.length, 20);
        proof = {
          ...proof,
          bases: selected.bases.text,
          selectedRange: selection,
          selectionMapping: mapped,
        };
        checkpoint('00-verified-native-bases-and-visible-selection-before-menu');
        await page
          .getByTestId('sequence-context-menu')
          .getByText('Create Forward Primer →', { exact: true })
          .click();
        await expect(form).toBeVisible();
        await form.getByTestId('primer-name-input').fill(proof.primerName);
        await expect(field(form, 'Primer sequence')).toHaveValue(proof.bases);
        proof = {
          ...proof,
          primerPrepared: {
            name: proof.primerName,
            sequence: proof.bases,
            targetDocumentId: proof.target.entity.id,
            targetPath: proof.targetPath,
            targetSha256: proof.targetSha256,
            start: selection.start,
            end: selection.end + 1,
            strand: 1,
            schema: (await native('listSchemas')).find((row) => row.entityKind === 'oligo'),
          },
        };
        checkpoint('00-bound-primer-original-intent-before-save');
      }
      const positionInput = form.getByTestId('primer-position-input');
      if (await positionInput.isVisible())
        await expect(positionInput).toHaveValue(String(proof.primerPrepared.end));
      else
        await expect(form.getByTestId('primer-3prime-position')).toHaveText(
          String(proof.primerPrepared.end)
        );
      await expect(field(form, 'Primer sequence')).toHaveValue(proof.bases);
      await dismiss();
      await capture('01-real-primer-bound-to-old-local-dna-before-save', form);
      await button(form, 'Save Primer').click();
      await accepted('primer');
    }
  }
  const primer = proof.primerSource.artifact;
  assert.equal(primer.name, proof.primerName);
  assert.equal(primer.sequence.bases, proof.bases);
  assert.equal(primer.bindings.length, 1);
  assert.equal(primer.bindings[0].target.documentId, proof.target.entity.id);
  assert.deepEqual(primer.bindings[0].coordinates, {
    system: 'zero_based_half_open',
    start: proof.primerPrepared.start,
    end: proof.primerPrepared.end,
    strand: 1,
  });
  assert.equal(primer.bindings[0].target.fileContentHash, `sha256:${proof.targetSha256}`);
  if (proof.completedStep < 2) {
    const existing = await savedArtifact(proof.strainName, '.entity.json');
    if (existing) {
      proof = { ...proof, strainSource: existing };
      checkpoint('00-original-strain-source-reconciled');
      await accepted('strain');
    } else {
      let form = page.getByTestId('strain-creation-form');
      if (proof.strainPrepared) {
        assert.ok(
          await form.isVisible(),
          'Keep the original live strain creation/recovery identity.'
        );
        assert.equal(await form.getAttribute('data-creation-id'), proof.strainPrepared.id);
        await expect(form.getByTestId('strain-name-input')).toHaveValue(proof.strainName);
      } else {
        await dismiss();
        const project = await projectRow();
        await project.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'New…', exact: true }).hover();
        await page.getByRole('menuitem', { name: 'Strains', exact: true }).click();
        await page
          .getByRole('menu', { name: 'Strains actions', exact: true })
          .getByRole('menuitem', { name: 'Create', exact: true })
          .click();
        await expect(form).toBeVisible();
        await form.getByTestId('strain-name-input').fill(proof.strainName);
        await form.getByTestId('strain-field-genotypeCanonical').fill(proof.genotype);
        const link = form.getByTestId(`strain-field-${proof.link.key}`);
        if (!(await link.isVisible()))
          await form.getByText('More details', { exact: true }).click();
        await button(link, `Choose ${proof.link.label}`).click();
        const picker = page.getByRole('dialog', {
          name: `Choose ${proof.link.label}`,
          exact: true,
        });
        await picker
          .getByRole('searchbox', { name: `Search entities for ${proof.link.label}`, exact: true })
          .fill(proof.target.entity.name);
        await picker
          .getByRole('button', { name: new RegExp(`^${escape(proof.target.entity.name)}`, 'u') })
          .click();
        const selected = {
          origin: 'native',
          resolution: 'exact',
          relationType: 'references',
          label: proof.target.entity.name,
          destinationEntityId: proof.target.entity.id,
        };
        proof = {
          ...proof,
          strainPrepared: {
            id: await form.getAttribute('data-creation-id'),
            kind: 'strain',
            schemaId: await form.getAttribute('data-schema-id'),
            expectedSchemaRevisionId: await form.getAttribute('data-schema-revision-id'),
            name: proof.strainName,
            workspaceRoot: fixture.project.path,
            destinationDir: fixture.project.path,
            fields: { genotypeCanonical: proof.genotype, [proof.link.key]: selected },
            schema: proof.schema,
          },
        };
        checkpoint('00-new-strain-structured-original-intent-before-create');
        assert.equal(proof.strainPrepared.schemaId, proof.schema.schemaId);
        assert.equal(proof.strainPrepared.expectedSchemaRevisionId, proof.schema.currentRevisionId);
        await capture('02-new-strain-exact-selected-record-before-create', link);
      }
      const retry = button(page.getByTestId('entity-projection-recovery'), 'Retry Registry');
      if (await retry.isVisible()) await retry.click();
      else await button(form, 'Create strain').click();
      await accepted('strain');
      await expect(form).toBeHidden();
    }
  }
  const strain = proof.strainSource.artifact;
  assert.equal(strain.id, proof.strainPrepared.id);
  assert.deepEqual(strain.fields[proof.link.key], proof.strainPrepared.fields[proof.link.key]);
  assert.equal(strain.fields.genotypeCanonical, proof.genotype);
  assert.equal(strain.schemaSnapshot.schemaRevisionId, proof.schema.currentRevisionId);
  const link = strain.relationships.find(
    (row) => row.type === 'references' && row.toEntityId === proof.target.entity.id
  );
  assert.ok(link);
  assert.equal(link.fromEntityId, strain.id);
  assert.deepEqual(link.payload, {
    schema: 'dnaforge.schema-field-link.v1',
    sourceEntityId: strain.id,
    fieldKeys: [proof.link.key],
  });
  assert.equal(await readText(proof.primerSource.path), proof.primerSource.text);
  assert.equal(await readText(proof.strainSource.path), proof.strainSource.text);
  await unchanged();
  const acceptedNow = await scientific();
  for (const id of [primer.id, strain.id, proof.target.entity.id])
    assert.ok(
      !acceptedNow.catalog.entries.some((row) => row.resourceId === id),
      'Legacy artifacts and their target must not be implicitly enrolled.'
    );
  await dismiss();
  const fullSearch = page.getByTestId('lims-registry-search'),
    compactSearch = page.getByTestId('lims-registry-compact-search');
  if (!(await fullSearch.isVisible()) && !(await compactSearch.isVisible()))
    await page.getByTestId('lims-button').click();
  if (await fullSearch.isVisible()) await fullSearch.fill(proof.strainName);
  else await compactSearch.fill(proof.strainName);
  const fullRow = page.getByTestId(`lims-registry-row-${strain.id}`),
    compactRow = page.getByTestId(`lims-registry-compact-row-${strain.id}`);
  if (await fullRow.isVisible()) await fullRow.click();
  else await compactRow.click();
  const metadata = page.getByTestId('lims-registry-record-fields').first();
  await expect(metadata).toContainText(proof.link.label);
  await expect(metadata).toContainText(proof.target.entity.name);
  await capture('03-saved-strain-record-retains-exact-schema-link', metadata);
  await openTarget();
  if (!(await page.getByTestId('primers-list').isVisible()))
    await page.getByTestId('toolbar-primers').click();
  await page.getByTestId('primers-tab-attached').click();
  await expect(page.getByTestId('primers-list')).toContainText(proof.primerName);
  await capture('04-new-primer-attached-to-unchanged-local-dna', page.getByTestId('primers-list'));
  await unchanged();
  const final = checkpoint('05-complete');
  writeFileSync(
    path.join(evidenceDirectory, 'new-artifact-continuity-reopen-fixture.json'),
    JSON.stringify(final, null, 2)
  );
  return {
    inventoryRevision: 102,
    inventoryUnchanged: true,
    acceptedDesignUnchanged: true,
    oldTargetUnchanged: true,
    newPrimerId: primer.id,
    newStrainId: strain.id,
    structuredSchemaLinkPreserved: true,
    lostAcknowledgementQualified: false,
  };
}
export const runInventoryNewArtifactContinuity = (ctx) => run(ctx, false);
export const runInventoryNewArtifactContinuityResume = (ctx) => run(ctx, false);
export const runInventoryNewArtifactContinuityReopen = (ctx) => run(ctx, true);

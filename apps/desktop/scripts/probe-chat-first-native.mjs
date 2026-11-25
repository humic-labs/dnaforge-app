import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';

const endpoint = process.argv[2];
if (!endpoint)
  throw new Error('Pass the development desktop CDP URL. This probe creates synthetic projects.');
const output = resolve(process.argv[3] ?? '/tmp/dnaforge-chat-first-native');
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(endpoint);
const page = browser
  .contexts()[0]
  .pages()
  .find((page) => /^http:\/\/(localhost|127\.0\.0\.1):/.test(page.url()));
if (!page) throw new Error('The local development renderer is unavailable.');
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
async function waitForAcknowledgement(check, message) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.fail(message);
}

async function addProject(name) {
  await page.getByTestId('chat-first-project-picker').click();
  await page.getByTestId('project-switcher-new-project').click();
  await page.getByTestId('project-switcher-new-project-name').fill(name);
  await page.getByTestId('project-switcher-new-project-create').click();
  let mounted = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    mounted = await page.evaluate(async (name) => {
      const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
      return useWorkspaceStore.getState().folders.some((folder) => folder.name === name);
    }, name);
    if (mounted) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(mounted, 'The new project must finish mounting.');
  await page.getByTestId('chat-first-project-picker').getByText(name, { exact: true }).waitFor();
  await page.getByTestId('project-switcher-popover').waitFor({ state: 'hidden' });
}
try {
  await page.getByTestId('chat-first-workbench').waitFor({ timeout: 90000 });
  const identity = await page.evaluate(() => {
    if (!window.electronAPI || window.__WAYPOINT_RENDERER_BUILD__?.mode !== 'development')
      throw new Error('This probe requires a native development desktop.');
    return window.__WAYPOINT_RENDERER_BUILD__;
  });
  const name = `Synthetic workflow ${Date.now()}`;
  await addProject(name);
  await page.getByTestId('ai-new-conversation-button').click();
  const chatProject = page.getByTestId('chat-first-conversation-project');
  await chatProject.getByText(name, { exact: true }).waitFor();
  const composer = page.getByTestId('ai-input');
  await composer.fill('Check the notebook and the exact sequence in this project.');
  await page.screenshot({ path: join(output, 'native-start.png') });
  const result = await page.evaluate(async (name) => {
    const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
    const folders = useWorkspaceStore.getState().folders;
    const root = folders.find((folder) => folder.name === name).path;
    const { createAuthoredNotebook, readAuthoredNotebook, updateAuthoredNotebook } =
      await import('/src/features/page/notebook-authoring.ts');
    const input = {
      workspaceRoot: root,
      mountedRoots: [root],
      title: 'Native agent notebook',
      intentId: 'native-workflow',
      operationId: 'native-workflow',
      blocks: [
        { type: 'heading', level: 1, content: [{ text: 'Chat-first native workflow' }] },
        { type: 'paragraph', content: [{ text: 'Saved through the native notebook owner.' }] },
        {
          type: 'table',
          header: true,
          rows: [
            [[{ text: 'Sample' }], [{ text: 'Status' }]],
            [[{ text: 'Synthetic' }], [{ text: 'Verified', bold: true }]],
          ],
        },
      ],
    };
    const first = await createAuthoredNotebook(input);
    const replay = await createAuthoredNotebook(input);
    let changedRetry;
    try {
      await createAuthoredNotebook({ ...input, title: 'Different request' });
    } catch (error) {
      changedRetry = error.message;
    }
    const update = {
      workspaceRoot: root,
      mountedRoots: [root],
      notebookId: first.notebookId,
      expectedRevision: first.revision,
      mode: 'append',
      operationId: 'append',
      blocks: [{ type: 'paragraph', content: [{ text: 'Agent append saved.' }] }],
    };
    const updated = await updateAuthoredNotebook(update);
    const { platform } = await import('/src/platform/index.ts');
    const draft = await platform().notebook.execute({
      documentId: first.notebookId,
      expectedRevision: updated.revision,
      operation: {
        kind: 'splice-blocks',
        index: 3,
        deleteCount: 0,
        blocks: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Independent draft preserved.' }] },
        ],
      },
    });
    let dirtyRefusal;
    try {
      await updateAuthoredNotebook({ ...update, expectedRevision: draft.revision });
    } catch (error) {
      dirtyRefusal = error.message;
    }
    await platform().notebook.execute({
      documentId: first.notebookId,
      expectedRevision: draft.revision,
      operation: { kind: 'save' },
    });
    let stale;
    try {
      await updateAuthoredNotebook(update);
    } catch (error) {
      stale = error.message;
    }
    const { createCreateSequenceProductTool } =
      await import('/src/features/ai/tools/create-sequence-product.ts');
    const { createSequenceProductSchema } = await import('/src/shared/sequence-product.ts');
    const tool = createCreateSequenceProductTool(folders);
    const options = { toolCallId: 'native-workflow', messages: [] };
    const sequenceInput = createSequenceProductSchema.parse({
      workspace: root,
      name: 'Synthetic 60bp',
      parts: [{ kind: 'literal', sequence: 'ATGC'.repeat(15), label: 'Explicit synthetic DNA' }],
    });
    const sequence = await tool.execute(sequenceInput, options);
    const duplicate = await tool.execute(sequenceInput, options);
    const fragment = sequence.ok
      ? await tool.execute(
          createSequenceProductSchema.parse({
            workspace: root,
            name: 'Synthetic fragment',
            parts: [
              { kind: 'source', documentId: sequence.documentId, start: 1, end: 12, strand: 1 },
              { kind: 'literal', sequence: 'GGCC', label: 'Explicit synthetic tail' },
            ],
          }),
          options
        )
      : null;
    const missing = await tool.execute(
      createSequenceProductSchema.parse({
        workspace: root,
        name: 'Missing source must fail',
        parts: [
          { kind: 'source', documentId: 'missing-synthetic-source', start: 1, end: 4, strand: 1 },
        ],
      }),
      options
    );
    const { openEntityNavigationTarget } = await import('/src/services/entity-navigation.ts');
    await openEntityNavigationTarget({ entityId: first.notebookId });
    const read = await readAuthoredNotebook(root, first.notebookId);
    return {
      root,
      first,
      replay,
      updated,
      dirtyRefusal,
      changedRetry,
      stale,
      sequence,
      duplicate,
      fragment,
      missing,
      read,
    };
  }, name);
  await writeFile(
    join(output, 'native-results.json'),
    JSON.stringify({ identity, ...result }, null, 2)
  );
  assert.equal(result.replay.notebookId, result.first.notebookId);
  assert.match(result.changedRetry, /REQUEST_ID_REUSED/);
  assert.match(result.stale, /revision changed/);
  assert.match(result.dirtyRefusal, /unsaved editor changes/);
  assert.equal(result.sequence.ok, true, JSON.stringify(result.sequence));
  assert.equal(result.duplicate.ok, false);
  assert.equal(result.fragment.ok, true, JSON.stringify(result.fragment));
  assert.equal(result.missing.ok, false);
  assert.equal(result.missing.stateChanged, false);
  const notebook = page.locator(`[data-page-id="${result.first.notebookId}"] .tiptap`);
  await notebook.waitFor();
  await composer.waitFor();
  await notebook.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Manual correction persisted.');
  const second = `Synthetic switch ${Date.now()}`;
  await addProject(second);
  assert.equal(await chatProject.textContent(), name);
  assert.equal(
    await composer.inputValue(),
    'Check the notebook and the exact sequence in this project.'
  );
  const queued = await page.evaluate(
    async ({ id, root }) => {
      const { readAuthoredNotebook } = await import('/src/features/page/notebook-authoring.ts');
      let refusal;
      try {
        await readAuthoredNotebook(root, id);
      } catch (error) {
        refusal = error.message;
      }
      const { platform } = await import('/src/platform/index.ts');
      return {
        refusal,
        snapshot: await platform().notebook.execute({
          documentId: id,
          operation: { kind: 'inspect-copy' },
        }),
      };
    },
    { id: result.first.notebookId, root: result.root }
  );
  assert.match(queued.refusal, /unsaved editor changes/);
  assert.equal(queued.snapshot.dirty, true);
  assert.ok(JSON.stringify(queued.snapshot.copy.content).includes('Manual correction persisted.'));
  assert.ok((await notebook.innerText()).includes('Manual correction persisted.'));
  await notebook.locator('p').last().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s');
  await waitForAcknowledgement(
    () =>
      page.evaluate(async (id) => {
        const { platform } = await import('/src/platform/index.ts');
        const snapshot = await platform().notebook.execute({
          documentId: id,
          operation: { kind: 'inspect-copy' },
        });
        return (
          !snapshot.dirty && !snapshot.saving && snapshot.revision === snapshot.persistedRevision
        );
      }, result.first.notebookId),
    'The native owner must acknowledge the saved correction.'
  );
  await page.getByTestId('chat-first-project-picker').click();
  const projectPopover = page.getByTestId('project-switcher-popover');
  await projectPopover.getByTestId('project-switcher-search').fill(name);
  await projectPopover.getByText(name, { exact: true }).click();
  await page.getByTestId('chat-first-project-picker').getByText(name, { exact: true }).waitFor();
  assert.equal(
    await composer.inputValue(),
    'Check the notebook and the exact sequence in this project.'
  );
  let markdown;
  for (let attempt = 0; attempt < 200; attempt++) {
    markdown = await readFile(join(result.first.packagePath, 'Native agent notebook.md'), 'utf8');
    if (markdown.includes('Manual correction persisted.')) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(markdown.includes('Manual correction persisted.'));
  // Use the same serialized read and update as chat. A project switch can leave
  // editor work queued briefly after the first disk save.
  await waitForAcknowledgement(
    () =>
      page.evaluate(
        async ({ id, root }) => {
          const { readAuthoredNotebook, updateAuthoredNotebook } =
            await import('/src/features/page/notebook-authoring.ts');
          try {
            const correction = 'Manual correction persisted.';
            const followUp = 'Agent follow-up retained the correction.';
            const saved = await readAuthoredNotebook(root, id);
            const savedContent = JSON.stringify(saved.content);
            if (!savedContent.includes(correction)) return false;
            if (savedContent.includes(followUp)) return true;
            const updated = await updateAuthoredNotebook({
              workspaceRoot: root,
              mountedRoots: [root],
              notebookId: id,
              expectedRevision: saved.revision,
              mode: 'append',
              operationId: 'follow-up-after-manual-save',
              blocks: [{ type: 'paragraph', content: [{ text: followUp }] }],
            });
            const updatedContent = JSON.stringify(updated.content);
            return updatedContent.includes(correction) && updatedContent.includes(followUp);
          } catch (error) {
            if (error instanceof Error && error.message.includes('unsaved editor changes'))
              return false;
            throw error;
          }
        },
        { id: result.first.notebookId, root: result.root }
      ),
    'The authored follow-up must preserve the saved human correction.'
  );
  markdown = await readFile(join(result.first.packagePath, 'Native agent notebook.md'), 'utf8');
  assert.ok(markdown.includes('Manual correction persisted.'));
  assert.ok(markdown.includes('Agent follow-up retained the correction.'));
  await writeFile(join(output, 'saved-notebook.md'), markdown);
  const sequencePath = join(result.root, 'sequences/Synthetic 60bp/Synthetic 60bp.gb');
  const sequenceText = await readFile(sequencePath, 'utf8');
  assert.equal(
    sequenceText
      .split(/ORIGIN\s*/)[1]
      .split('//')[0]
      .replace(/[^a-z]/gi, '')
      .toUpperCase(),
    'ATGC'.repeat(15)
  );
  await writeFile(join(output, 'saved-sequence.gb'), sequenceText);
  const fragmentText = await readFile(
    join(result.root, 'sequences/Synthetic fragment/Synthetic fragment.gb'),
    'utf8'
  );
  assert.equal(
    fragmentText
      .split(/ORIGIN\s*/)[1]
      .split('//')[0]
      .replace(/[^a-z]/gi, '')
      .toUpperCase(),
    'ATGC'.repeat(3) + 'GGCC'
  );
  const sourcePin = result.fragment.creationDerivation.parts.find(
    (part) => part.kind === 'source'
  ).revision;
  assert.equal(sourcePin.resourceRevisionId, result.sequence.acceptedRevision.resourceRevisionId);
  const openedSequence = await page.evaluate(async (id) => {
    const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
    const { createOpenTabTool } = await import('/src/features/ai/tools/open-tab.ts');
    return createOpenTabTool(useWorkspaceStore.getState().folders).execute(
      { type: 'sequence', entityId: id },
      { toolCallId: 'native-viewer-check', messages: [] }
    );
  }, result.sequence.documentId);
  assert.equal(openedSequence.ok, true);
  await page.getByTestId('sequence-canvas-main').waitFor();
  assert.equal(await page.getByTestId('sequence-error').count(), 0);
  await page.screenshot({ path: join(output, 'native-sequence.png') });
  const sequenceTab = page.getByRole('tab', { name: /Synthetic 60bp/, selected: true });
  const closeSequence = sequenceTab.getByRole('button', { name: /close/i });
  await sequenceTab.hover();
  await closeSequence.click();
  await page.evaluate(
    async ({ sequenceId, notebookId }) => {
      const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
      const { createOpenTabTool } = await import('/src/features/ai/tools/open-tab.ts');
      const tool = createOpenTabTool(useWorkspaceStore.getState().folders);
      const sequence = await tool.execute(
        { type: 'sequence', entityId: sequenceId },
        { toolCallId: 'native-reopen', messages: [] }
      );
      if (!sequence.ok) throw new Error(sequence.error);
      const notebook = await tool.execute(
        { type: 'page', entityId: notebookId },
        { toolCallId: 'native-reopen', messages: [] }
      );
      if (!notebook.ok) throw new Error(notebook.error);
    },
    { sequenceId: result.sequence.documentId, notebookId: result.first.notebookId }
  );
  await page.screenshot({ path: join(output, 'native-workflow.png') });
  await page.reload();
  await page.getByTestId('chat-first-workbench').waitFor({ timeout: 90000 });
  await page.locator('.tiptap').filter({ hasText: 'Manual correction persisted.' }).waitFor();
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        identity,
        project: result.root,
        checks: [
          'native notebook publication',
          'creation retry identity',
          'changed retry refusal',
          'stale revision refusal',
          'unsaved draft protection',
          'pending human edits across project creation',
          'first literal DNA acceptance',
          'duplicate name refusal',
          'exact pinned source product',
          'missing source refusal',
          'reference opening',
          'rich notebook publication',
          'native sequence viewer',
          'sequence close and reopen',
          'chat and draft retained across a project switch',
          'direct edit with native save acknowledgement',
          'authored follow-up preserves human correction',
          'independent disk bytes',
          'renderer reload',
        ],
      },
      null,
      2
    )
  );
  console.log(`Native workflow passed. Evidence: ${output}`);
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}

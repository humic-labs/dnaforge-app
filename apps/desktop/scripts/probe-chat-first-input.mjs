import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:14636';
const output = resolve(process.argv[3] ?? '/tmp/dnaforge-ai-input-probe');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${baseUrl}/?e2e=true`);
  await page.getByTestId('chat-first-workbench').waitFor();
  const composer = page.getByTestId('ai-input');
  await page.getByRole('button', { name: 'Draft a notebook' }).click();
  assert.match(await composer.inputValue(), /Create a notebook/);
  assert.equal(await composer.evaluate((input) => input === document.activeElement), true);
  await composer.clear();
  await page.screenshot({ path: resolve(output, 'start.png') });
  await page.getByTestId('chat-first-project-picker').click();
  await page.getByTestId('project-switcher-new-project').click();
  await page.getByTestId('project-switcher-new-project-name').fill('Synthetic notebook project');
  await page.getByTestId('project-switcher-new-project-create').click();
  await page
    .getByTestId('chat-first-project-picker')
    .getByText('Synthetic notebook project', { exact: true })
    .waitFor();
  await page.getByTestId('ai-new-conversation-button').click();
  await page
    .getByTestId('chat-first-conversation-project')
    .getByText('Synthetic notebook project', { exact: true })
    .waitFor();
  const created = await page.evaluate(async () => {
    if (window.electronAPI || window.__WAYPOINT_RENDERER_BUILD__?.mode !== 'test') {
      throw new Error(
        'This probe requires the test-mode browser renderer and its in-memory platform.'
      );
    }
    const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
    const { createNotebookDocumentTool } =
      await import('/src/features/ai/tools/notebook-document.ts');
    const { folders, workspaceSelection } = useWorkspaceStore.getState();
    const root = workspaceSelection.path;
    if (!root) throw new Error('No selected project.');
    const tool = createNotebookDocumentTool(folders);
    const result = await tool.execute(
      { operation: { kind: 'create', title: 'Agent tool notebook', destinationProject: root } },
      { toolCallId: 'ai-input-probe-create', messages: [] }
    );
    window.__aiInputProbe = { tool, pageId: result.pageId };
    return result;
  });
  assert.equal(created.ok, true);
  assert.equal(created.saved, true);
  const editor = page.locator('.tiptap').first();
  await editor.waitFor();
  const edited = await page.evaluate(async () => {
    const { tool, pageId } = window.__aiInputProbe;
    const options = { toolCallId: 'ai-input-probe-edit', messages: [] };
    const inspected = await tool.execute(
      { pageId, operation: { kind: 'inspect', offset: 0, limit: 20 } },
      options
    );
    const changed = await tool.execute(
      {
        pageId,
        expectedRevision: inspected.revision,
        operation: {
          kind: 'splice-blocks',
          index: 0,
          deleteCount: 1,
          blocks: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Synthetic experiment summary created through the notebook agent tool.',
                },
              ],
            },
          ],
        },
      },
      options
    );
    const current = await tool.execute(
      { pageId, operation: { kind: 'inspect', offset: 0, limit: 20 } },
      options
    );
    const saved = await tool.execute(
      { pageId, expectedRevision: current.revision, operation: { kind: 'save' } },
      options
    );
    return { inspected, changed, saved };
  });
  assert.equal(edited.inspected.editable, true);
  assert.equal(edited.changed.changed, true);
  assert.equal(edited.saved.saved, true);
  assert.equal(
    await editor.innerText(),
    'Synthetic experiment summary created through the notebook agent tool.'
  );
  assert.equal(
    await editor.evaluate((el) =>
      el.closest('[data-ai-input-region]').getAttribute('data-ai-input-region')
    ),
    'manual'
  );
  const box = await editor
    .locator('p')
    .first()
    .evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rect = range.getClientRects()[0];
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  await page.mouse.move(box.x + 5, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 5, 230), box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.ok((await page.evaluate(() => window.getSelection()?.toString() ?? '')).length > 0);
  await editor.locator('p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Manual correction.');
  assert.ok((await editor.innerText()).includes('Manual correction.'));
  await composer.fill('Continue this analysis through AI');
  assert.equal(await composer.inputValue(), 'Continue this analysis through AI');

  await page.getByRole('button', { name: 'Browse project files' }).click();
  await page.getByRole('dialog', { name: 'Go to file' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await page.getByRole('menuitem', { name: 'New DNA sequence…' }).waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: resolve(output, 'workbench.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = {
    scope:
      'Browser renderer with in-memory platform. Existing notebook tool plus explicit manual correction tested; no live model, native IPC or disk persistence claim.',
    created,
    edited,
    errors,
  };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`Chat-first probe passed. Evidence: ${output}`);
} catch (error) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser.close();
}

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
  await page.getByTestId('ai-only-workbench').waitFor();
  const created = await page.evaluate(async () => {
    if (window.electronAPI || window.__WAYPOINT_RENDERER_BUILD__?.mode !== 'test') {
      throw new Error(
        'This probe requires the test-mode browser renderer and its in-memory platform.'
      );
    }
    const { platform } = await import('/src/platform/index.ts');
    const { useWorkspaceStore } = await import('/src/stores/workspaceStore.ts');
    const { createNotebookDocumentTool } =
      await import('/src/features/ai/tools/notebook-document.ts');
    const root = '/synthetic-ai-input-project';
    await platform().fs.mkdir(root, { recursive: true });
    useWorkspaceStore.getState().addFolder(root, 'AI input experiment');
    const tool = createNotebookDocumentTool(useWorkspaceStore.getState().folders);
    const result = await tool.execute(
      { operation: { kind: 'create', title: 'Agent tool notebook', destinationProject: root } },
      { toolCallId: 'ai-input-probe-create', messages: [] }
    );
    window.__aiInputProbe = { tool, pageId: result.pageId };
    return result;
  });
  assert.equal(created.ok, true);
  assert.equal(created.saved, true);
  const editor = page.locator('[data-ai-input-region="output"] .tiptap');
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
    await editor.evaluate((el) => el.closest('[data-ai-input-region="output"]').inert),
    true
  );
  const before = await editor.innerText();
  await editor.click({ force: true });
  await page.keyboard.type('MANUAL EDIT MUST NOT APPEAR');
  assert.equal(await editor.innerText(), before);
  await page.getByTestId('ai-input').fill('Continue this analysis through AI');
  assert.equal(
    await page.getByTestId('ai-input').inputValue(),
    'Continue this analysis through AI'
  );
  const negativeChecks = await page.evaluate(() => {
    const output = document.querySelector('[data-ai-input-region="output"]');
    return Object.fromEntries(
      ['paste', 'cut', 'drop', 'contextmenu', 'dblclick'].map((type) => [
        type,
        output.dispatchEvent(new Event(type, { bubbles: true, cancelable: true })),
      ])
    );
  });
  assert.deepEqual(Object.values(negativeChecks), [false, false, false, false, false]);
  await page
    .getByRole('navigation', { name: 'Output tabs' })
    .getByRole('button', { name: 'Agent tool notebook' })
    .click();
  await page
    .getByRole('navigation', { name: 'Output tabs' })
    .getByRole('button', { name: 'New Chat' })
    .click();
  await page.getByText('Direct API', { exact: true }).click();
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await page.screenshot({ path: resolve(output, 'workbench.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const result = {
    scope:
      'Browser renderer with in-memory platform. Existing notebook tool called directly; no live model, native IPC or disk persistence claim.',
    created,
    edited,
    negativeChecks,
    errors,
  };
  await writeFile(resolve(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`AI-input probe passed. Evidence: ${output}`);
} finally {
  await browser.close();
}

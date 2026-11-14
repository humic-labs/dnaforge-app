import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

function tablesIn(node) {
  const tables = [];
  if (node.type === 'embed' && node.attrs?.type === 'table') tables.push(node.attrs.data);
  for (const child of node.content ?? []) tables.push(...tablesIn(child));
  return tables;
}

async function inspectNotebook(page, pageId) {
  return page.evaluate(
    (documentId) =>
      window.electronAPI.notebook.execute({
        documentId,
        operation: { kind: 'inspect-copy' },
      }),
    pageId
  );
}

export async function runTableEditorJourney(page, { workspaceRoot, onStep } = {}) {
  const errors = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  const shortcut = await page.evaluate(() =>
    navigator.platform.toLowerCase().includes('mac') ? 'Meta' : 'Control'
  );
  const pages = [];
  const step = async (name, details) => onStep?.(name, details);

  if (!workspaceRoot) {
    workspaceRoot = await page.evaluate(async () => {
      const before = new Set(window.__test.getWorkspaceRootPaths());
      await window.__test.createEmptyWorkspace();
      const created = window.__test.getWorkspaceRootPaths().filter((root) => !before.has(root));
      if (created.length !== 1) throw new Error('The journey did not create exactly one project');
      return created[0];
    });
  }

  async function openNotebook(title) {
    const pageId = await page.evaluate(
      async ({ title, workspaceRoot }) => {
        const before = new Set(Object.keys(window.__test.getPageStore().pages));
        await window.__test.createNotebookArtifact({
          workspaceRoot,
          parentPath: workspaceRoot,
          artifactTitle: title,
          artifactFileName: title,
        });
        const created = Object.values(window.__test.getPageStore().pages).filter(
          (notebook) => !before.has(notebook.id) && notebook.title === title
        );
        if (created.length !== 1)
          throw new Error('The journey did not create exactly one notebook');
        return created[0].id;
      },
      { title, workspaceRoot }
    );
    pages.push(pageId);
    const notebook = page.locator(`[data-page-id="${pageId}"]`);
    const editor = notebook.locator('.tiptap[contenteditable="true"]');
    await expect(editor).toBeVisible();
    await editor.focus();
    await expect(editor).toBeFocused();
    return { pageId, notebook, editor };
  }

  async function insertTable({ notebook, editor }, { rows, columns, value }) {
    await expect(editor).toBeFocused();
    await page.keyboard.press(`${shortcut}+A`);
    await page.keyboard.type('/table');
    await expect(
      page.locator('[data-tippy-root]').getByRole('button', { name: /Table$/ })
    ).toBeVisible();
    await step('table-command', { rows, columns });
    await page.keyboard.press('Enter');

    const rowsInput = notebook.getByLabel('rows', { exact: true });
    const colsInput = notebook.getByLabel('cols', { exact: true });
    await expect(rowsInput).toBeFocused();
    await page.keyboard.type(String(rows));
    await expect(rowsInput).toHaveValue(String(rows));
    await page.keyboard.press('Tab');
    await expect(colsInput).toBeFocused();
    await page.keyboard.type(String(columns));
    await expect(colsInput).toHaveValue(String(columns));
    await page.keyboard.press('Shift+Tab');
    await expect(rowsInput).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(colsInput).toBeFocused();
    await step('table-dimensions', { rows, columns });
    await page.keyboard.press('Enter');

    const grid = notebook.getByTestId('table-grid');
    const sink = grid.getByLabel('Table keyboard navigation', { exact: true });
    await expect(sink).toBeFocused();
    const firstCell = grid.locator('[data-cell-position="0,0"]');
    await expect(firstCell.getByTestId('cell-focus-ring')).toBeVisible();
    await page.keyboard.press(value[0]);
    const input = firstCell.locator('input');
    await expect(input).toBeFocused();
    await page.keyboard.type(value.slice(1));
    await expect(input).toHaveValue(value);
    await page.keyboard.press('Enter');
    await expect(firstCell).toHaveText(value);
    await expect(sink).toBeFocused();
    await step('table-edited', { rows, columns, value });
  }

  try {
    const created = await openNotebook('Table keyboard journey');
    const expected = { rows: 4, columns: 3, value: 'Sample-control-42' };
    await insertTable(created, expected);
    await expect
      .poll(async () => {
        const snapshot = await inspectNotebook(page, created.pageId);
        const [table] = tablesIn(snapshot.copy.content);
        return { rows: table?.rows, columns: table?.cols, value: table?.cells?.[0]?.[0]?.value };
      })
      .toEqual(expected);

    await page.keyboard.press(`${shortcut}+S`);
    await expect
      .poll(async () => {
        const snapshot = await inspectNotebook(page, created.pageId);
        return (
          snapshot.ready &&
          !snapshot.dirty &&
          !snapshot.saving &&
          snapshot.revision === snapshot.persistedRevision
        );
      })
      .toBe(true);
    const saved = await inspectNotebook(page, created.pageId);
    assert.ok(saved.path, 'Saved notebook has no native package path');
    assert.deepEqual(
      tablesIn(saved.copy.content).map((table) => ({
        rows: table.rows,
        columns: table.cols,
        value: table.cells[0][0].value,
      })),
      [expected]
    );
    await step('table-saved', {
      pageId: created.pageId,
      revision: saved.revision,
      path: saved.path,
    });

    const tabId = await page.evaluate((pageId) => {
      const tabs = Object.values(window.__test.getCanvasStore().panels)
        .flatMap((panel) => panel.tabs)
        .filter((tab) => tab.type === 'page' && tab.entityId === pageId);
      if (tabs.length !== 1) throw new Error('The journey notebook does not have exactly one tab');
      return tabs[0].id;
    }, created.pageId);
    await page.getByTestId(`tab-close-${tabId}`).click();
    await expect(created.notebook).toHaveCount(0);
    await page.keyboard.press(`${shortcut}+Shift+e`);
    const project = page.locator(`[data-workspace-root-path=${JSON.stringify(workspaceRoot)}]`);
    const rootEntry = project.locator(`[data-entry-path=${JSON.stringify(workspaceRoot)}]`);
    await expect(rootEntry).toBeVisible();
    if ((await rootEntry.getAttribute('aria-expanded')) === 'false') await rootEntry.click();
    const file = project.locator(`[data-entry-path=${JSON.stringify(saved.path)}]`);
    await expect(file).toBeVisible();
    await file.dblclick();
    await expect(created.notebook.getByTestId('table-grid')).toBeVisible();
    await expect(created.notebook.locator('[data-cell-position="0,0"]')).toHaveText(expected.value);
    const reopened = await inspectNotebook(page, created.pageId);
    assert.equal(reopened.persistedRevision, saved.persistedRevision);
    assert.equal(reopened.dirty, false);
    assert.deepEqual(tablesIn(reopened.copy.content), tablesIn(saved.copy.content));
    await step('table-reopened', { pageId: created.pageId, revision: reopened.revision });

    const canceled = await openNotebook('Table cancel and repeat journey');
    await page.keyboard.press(`${shortcut}+A`);
    await page.keyboard.type('/table');
    await expect(
      page.locator('[data-tippy-root]').getByRole('button', { name: /Table$/ })
    ).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(canceled.notebook.getByLabel('rows', { exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(canceled.editor).toBeFocused();
    await step('table-canceled', { pageId: canceled.pageId });
    await insertTable(canceled, { rows: 2, columns: 5, value: 'Repeated-table' });
    assert.deepEqual(errors, [], 'The table journey raised renderer errors');
    return {
      status: 'passed',
      workspaceRoot,
      pages,
      saved: { pageId: created.pageId, revision: saved.revision, path: saved.path },
      errors,
    };
  } finally {
    page.off('pageerror', onError);
  }
}

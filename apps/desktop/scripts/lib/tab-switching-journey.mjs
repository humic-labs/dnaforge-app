import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function runTabSwitchingJourney(page, { pageId, onStep } = {}) {
  assert.ok(pageId, 'Use a notebook created by the table journey');
  const placement = await page.evaluate((pageId) => {
    const canvas = window.__test.getCanvasStore();
    const matches = Object.values(canvas.panels).flatMap((panel) =>
      panel.tabs
        .filter((tab) => tab.type === 'page' && tab.entityId === pageId)
        .map((tab) => ({ panelId: panel.id, tabId: tab.id, tabs: panel.tabs.map(({ id }) => id) }))
    );
    if (matches.length !== 1) throw new Error('Notebook tab is not uniquely placed');
    return matches[0];
  }, pageId);
  assert.ok(placement.tabs.length > 1, 'Tab switching requires another tab in the same pane');
  const index = placement.tabs.indexOf(placement.tabId);
  const nextTab = placement.tabs[(index + 1) % placement.tabs.length];
  const activeTab = () =>
    page.evaluate(
      (panelId) => window.__test.getCanvasStore().panels[panelId]?.activeTabId,
      placement.panelId
    );
  const notebook = page.locator(`[data-page-id="${pageId}"]`);
  const editor = notebook.locator('.tiptap[contenteditable="true"]');

  for (const focusedControl of ['notebook-text', 'table-cell']) {
    await page.getByTestId(`tab-${placement.tabId}`).click();
    await expect.poll(activeTab).toBe(placement.tabId);
    if (focusedControl === 'notebook-text') {
      await editor.focus();
      await expect(editor).toBeFocused();
    } else {
      const cell = notebook.getByTestId('table-grid').locator('[data-cell-position="0,0"]');
      await cell.dblclick();
      await expect(cell.locator('input')).toBeFocused();
    }
    await page.keyboard.press('Control+Tab');
    await expect.poll(activeTab).toBe(nextTab);
    await onStep?.('tab-next', {
      focusedControl,
      panelId: placement.panelId,
      activeTabId: nextTab,
    });
    await page.keyboard.press('Control+Shift+Tab');
    await expect.poll(activeTab).toBe(placement.tabId);
    await expect(editor).toBeVisible();
    const restoredCell = notebook.getByTestId('table-grid').locator('[data-cell-position="0,0"]');
    if (await restoredCell.locator('input').count()) {
      await expect(restoredCell.locator('input')).toHaveValue('Repeated-table');
    } else {
      await expect(restoredCell).toContainText('Repeated-table');
    }
    await onStep?.('tab-previous', {
      focusedControl,
      panelId: placement.panelId,
      activeTabId: placement.tabId,
    });
  }
  return { status: 'passed', panelId: placement.panelId, tabId: placement.tabId, nextTab };
}

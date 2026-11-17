import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';

export async function runHtmlTabSwitchingJourney(page, { workspaceRoot, onStep } = {}) {
  assert.ok(workspaceRoot, 'Use the disposable project created by the notebook journey');
  const filePath = join(workspaceRoot, `keyboard-frame-${randomUUID()}.html`);
  const html =
    '<!doctype html><html><body><h1>HTML keyboard navigation</h1><label>First frame input <input value="first-value"></label><label>Second frame input <input value="second-value"></label></body></html>';
  await writeFile(filePath, html, { flag: 'wx' });
  const tabId = await page.evaluate((filePath) => window.__test.openFile(filePath), filePath);
  assert.ok(tabId, 'The HTML file did not open through the native file owner');
  const placement = await page.evaluate((tabId) => {
    for (const panel of Object.values(window.__test.getCanvasStore().panels)) {
      const tab = panel.tabs.find((tab) => tab.id === tabId);
      if (tab) {
        return { panelId: panel.id, entityId: tab.entityId, tabs: panel.tabs.map(({ id }) => id) };
      }
    }
    throw new Error('The HTML tab is not placed');
  }, tabId);
  assert.ok(placement.tabs.length > 1, 'HTML navigation needs another tab in the same pane');
  const nextTabId = placement.tabs[(placement.tabs.indexOf(tabId) + 1) % placement.tabs.length];
  const activeTab = () =>
    page.evaluate(
      (panelId) => window.__test.getCanvasStore().panels[panelId]?.activeTabId,
      placement.panelId
    );
  const container = page.getByTestId(`tab-content-container-${placement.entityId}`);
  const iframe = container.getByTestId('html-viewer-iframe');
  const frame = iframe.contentFrame();
  const modes = [];
  const nativeInput = await page.context().newCDPSession(page);
  const switchTabs = async (reverse) => {
    const key = {
      key: 'Tab',
      code: 'Tab',
      windowsVirtualKeyCode: 9,
      nativeVirtualKeyCode: process.platform === 'darwin' ? 48 : 9,
      modifiers: reverse ? 10 : 2,
    };
    await nativeInput.send('Input.dispatchKeyEvent', { ...key, type: 'rawKeyDown' });
    await nativeInput.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
  };

  try {
    for (const scriptsEnabled of [false, true]) {
      await page.getByTestId(`tab-${tabId}`).click();
      if (scriptsEnabled) {
        await container.getByTestId('html-viewer-enable-scripts').check();
      }
      const sandbox = scriptsEnabled ? 'allow-scripts' : '';
      await expect(iframe).toHaveAttribute('sandbox', sandbox);
      if (scriptsEnabled) {
        await frame.locator('body').evaluate(() => {
          window.name = 'changed-by-preview';
          document.addEventListener('keydown', (event) => event.stopPropagation(), true);
        });
        assert.equal(await frame.locator('body').evaluate(() => window.name), 'changed-by-preview');
      }
      const first = frame.getByRole('textbox', { name: 'First frame input', exact: true });
      const second = frame.getByRole('textbox', { name: 'Second frame input', exact: true });
      await first.click();
      await expect(first).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(second).toBeFocused();
      await expect.poll(activeTab).toBe(tabId);
      await onStep?.('html-ordinary-tab', { scriptsEnabled, sandbox });

      await switchTabs(false);
      await expect.poll(activeTab).toBe(nextTabId);
      await onStep?.('html-tab-next', {
        scriptsEnabled,
        panelId: placement.panelId,
        activeTabId: nextTabId,
      });
      await switchTabs(true);
      await expect.poll(activeTab).toBe(tabId);
      await expect(frame.getByRole('heading', { name: 'HTML keyboard navigation' })).toBeVisible();
      await expect(second).toHaveValue('second-value');
      await expect(iframe).toHaveAttribute('sandbox', sandbox);
      assert.equal(await readFile(filePath, 'utf8'), html);
      await onStep?.('html-tab-previous', {
        scriptsEnabled,
        panelId: placement.panelId,
        activeTabId: tabId,
      });
      modes.push({ scriptsEnabled, sandbox, status: 'passed' });
    }
    return { status: 'passed', filePath, tabId, panelId: placement.panelId, modes };
  } finally {
    await nativeInput.detach();
  }
}

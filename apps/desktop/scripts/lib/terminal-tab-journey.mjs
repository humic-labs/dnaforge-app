import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function runTerminalTabJourney(page, { leftFile, rightFile, onStep } = {}) {
  assert.ok(leftFile && rightFile && leftFile !== rightFile, 'Supply two distinct fixture files');
  const strip = page.locator('[data-tab-bar]');
  const workspaceTabs = strip.locator('[data-tab-id]');
  await expect(workspaceTabs, 'Start with a fresh project and no open workspace tabs').toHaveCount(
    0
  );
  const activeTab = strip.locator('[data-tab-id][aria-selected="true"]');
  const sessions = page.getByRole('tablist', { name: 'Terminal sessions' });
  const rows = sessions.locator('[data-terminal-tab-id]');
  const shellTab = (id) => sessions.locator(`[data-terminal-tab-id="${id}"]`).getByRole('tab');
  const input = (id) =>
    page.locator(`[data-terminal-id="${id}"]`).getByRole('textbox', { name: 'Terminal input' });
  const step = async (name, details = {}) => {
    const observed = await page.evaluate(() => ({
      workspace: document.querySelector('[data-tab-bar] [aria-selected="true"]')?.dataset.tabId,
      shell: document
        .querySelector('[data-terminal-tab-id] [aria-selected="true"]')
        ?.closest('[data-terminal-tab-id]')?.dataset.terminalTabId,
      focus: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName,
    }));
    await onStep?.(name, { ...details, ...observed });
  };
  const openFile = async (name) => {
    const prior = (await activeTab.count()) ? await activeTab.getAttribute('data-tab-id') : null;
    await page.locator(`[data-entry-name=${JSON.stringify(name)}]`).dblclick();
    await expect(activeTab).toHaveCount(1);
    if (prior) await expect(activeTab).not.toHaveAttribute('data-tab-id', prior);
    return activeTab.getAttribute('data-tab-id');
  };
  const left = await openFile(leftFile);
  await page.getByTestId('new-terminal-tab').click();
  await expect(strip).toHaveCount(1);
  await expect(activeTab).toHaveAttribute('data-tab-type', 'terminal');
  const terminal = await activeTab.getAttribute('data-tab-id');
  await expect(rows).toHaveCount(1);
  const first = await rows.getAttribute('data-terminal-tab-id');
  await page.getByRole('button', { name: 'New Shell', exact: true }).click();
  await expect(rows).toHaveCount(2);
  const second = await rows.nth(1).getAttribute('data-terminal-tab-id');
  await expect(shellTab(second)).toHaveAttribute('aria-selected', 'true');
  const right = await openFile(rightFile);
  const ordered = await workspaceTabs.evaluateAll((tabs) => tabs.map((tab) => tab.dataset.tabId));
  assert.deepEqual(ordered.slice(ordered.indexOf(left), ordered.indexOf(left) + 3), [
    left,
    terminal,
    right,
  ]);
  const press = async (chord, expectedWorkspace, expectedShell, label) => {
    await page.keyboard.press(chord);
    try {
      await expect(activeTab).toHaveAttribute('data-tab-id', expectedWorkspace);
      if (expectedShell) {
        await expect(shellTab(expectedShell)).toHaveAttribute('aria-selected', 'true');
      }
    } finally {
      await step(label, { chord, expectedWorkspace, expectedShell });
    }
  };

  const mac = await page.evaluate(() => navigator.platform.toLowerCase().includes('mac'));
  const previousShell = mac ? 'Meta+Shift+BracketLeft' : 'Control+PageUp';
  const nextShell = mac ? 'Meta+Shift+BracketRight' : 'Control+PageDown';
  await strip.locator(`[data-tab-id="${left}"]`).click();
  await step('start', { left, terminal, right, first, second });
  await press('Control+Tab', terminal, second, 'forward-into-terminal');
  await input(second).focus();
  await expect(input(second)).toBeFocused();
  await input(second).pressSequentially('echo TAB_JOURNEY_');
  await press('Control+Tab', right, null, 'forward-out-of-shell');
  await press('Control+Shift+Tab', terminal, second, 'reverse-into-terminal');
  await input(second).focus();
  await expect(input(second)).toBeFocused();
  await press('Control+Shift+Tab', left, null, 'reverse-out-of-shell');

  await press('Control+Tab', terminal, second, 'return-to-terminal');
  await input(second).focus();
  await press(previousShell, terminal, first, 'previous-shell-from-input');
  await input(first).focus();
  await press(nextShell, terminal, second, 'next-shell-from-input');
  await shellTab(second).focus();
  await press(previousShell, terminal, first, 'previous-shell-from-button');
  await shellTab(first).focus();
  await press(nextShell, terminal, second, 'next-shell-from-button');
  await shellTab(second).focus();
  await press('Control+Tab', right, null, 'forward-out-of-shell-button');
  await press('Control+Shift+Tab', terminal, second, 'return-from-right');
  await shellTab(second).focus();
  await press('Control+Shift+Tab', left, null, 'reverse-out-of-shell-button');
  await press('Control+Tab', terminal, second, 'return-from-left');

  for (const id of [left, right]) {
    await page.getByTestId(`tab-close-${id}`).click();
  }
  await expect(workspaceTabs).toHaveCount(1);
  await expect(activeTab).toHaveAttribute('data-tab-id', terminal);
  await step('sole-workspace-tab');
  for (const [source, target] of [
    ['input', input(second)],
    ['button', shellTab(second)],
  ]) {
    await target.focus();
    await expect(target).toBeFocused();
    await press('Control+Tab', terminal, second, `sole-tab-forward-from-${source}`);
    await target.focus();
    await expect(target).toBeFocused();
    await press('Control+Shift+Tab', terminal, second, `sole-tab-reverse-from-${source}`);
  }

  await input(second).focus();
  await input(second).pressSequentially('PRESERVED');
  await input(second).press('Enter');
  const output = page.getByRole('textbox', { name: 'Accessible terminal output' });
  await expect(async () => {
    await page.getByRole('button', { name: 'Terminal actions', exact: true }).click();
    await page.getByLabel('View terminal output', { exact: true }).click();
    try {
      await expect(output).toHaveValue(/^TAB_JOURNEY_PRESERVED\s*$/m, { timeout: 500 });
      await step('retained-command-output');
    } finally {
      await page.getByRole('button', { name: 'Close terminal output' }).click();
    }
  }).toPass({ timeout: 8000 });
  return { status: 'passed', left, terminal, right, first, second };
}

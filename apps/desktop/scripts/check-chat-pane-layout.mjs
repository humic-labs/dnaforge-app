import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import {
  resolveDesktopDevPort,
  resolveDevCdpPort,
} from '../../../tools/devops/scripts/lib/dev-cdp-port.mjs';

const desktop = path.resolve(import.meta.dirname, '..');
const root = path.resolve(desktop, '../..');
const options = { cwd: desktop, env: {}, argv: [] };
const port = resolveDesktopDevPort(options);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${resolveDevCdpPort(options)}`);
const args = process.argv.slice(2);
const current = args.includes('--current');
const out = args.find((arg) => arg !== '--current');
if (out) mkdirSync(out, { recursive: true });

function inspectButtons(toolbar) {
  const problems = [];
  const previous = [];
  for (const button of toolbar.querySelectorAll('button')) {
    const box = button.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(button).visibility !== 'visible') continue;
    const name = button.getAttribute('aria-label') || button.title || button.textContent.trim();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    if (!button.disabled && !button.contains(hit))
      problems.push(`${name} cannot receive pointer input at its center`);
    for (const other of previous) {
      if (
        box.left < other.box.right - 1 &&
        box.right > other.box.left + 1 &&
        box.top < other.box.bottom - 1 &&
        box.bottom > other.box.top + 1
      )
        problems.push(`${name} overlaps ${other.name}`);
    }
    previous.push({ name, box });
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim() || node.parentElement.closest('svg, .sr-only')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        let left = rect.left;
        let right = rect.right;
        for (let el = node.parentElement; el && button.contains(el); el = el.parentElement) {
          if (getComputedStyle(el).textOverflow !== 'ellipsis') continue;
          const clip = el.getBoundingClientRect();
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
        if (
          right > left &&
          (left < box.left - 1 ||
            right > box.right + 1 ||
            rect.top < box.top - 1 ||
            rect.bottom > box.bottom + 1)
        ) {
          problems.push(`${name} paints text outside its button`);
        }
      }
    }
  }
  return problems;
}

try {
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => {
      const url = new URL(candidate.url());
      return ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === port;
    });
  assert.ok(page, 'Expected the renderer on the configured development port');
  const runtime = await page.evaluate(async () => ({
    kind: window.electronAPI.runtime.getProfile().kind,
    root: (await window.electronAPI.runtime.getProvenance()).projectRoot,
  }));
  assert.deepEqual(runtime, { kind: 'scenario-e2e', root });
  if (!current)
    await page.evaluate(async () => {
      const { applyDevScenarioPreset } = await import('/src/test/scenarios/apply-dev.ts');
      await applyDevScenarioPreset('inline-entity-chips');
    });
  const pane = page.getByTestId('full-chat-view').filter({ visible: true });
  const toolbar = pane.getByTestId('chat-composer-toolbar');
  await expect(toolbar).toBeVisible();
  const dismissSeedPrompt = page.getByRole('button', { name: 'Not now', exact: true });
  if (!current && (await dismissSeedPrompt.isVisible())) await dismissSeedPrompt.click();
  const divider = page.locator('[role="separator"].cursor-col-resize').filter({ visible: true });
  async function resizeChat(width, expectedWidth) {
    const handle = await divider.boundingBox();
    const box = await pane.boundingBox();
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    const rightPane = x < box.x + box.width / 2;
    await page.mouse.move(x + (rightPane ? box.width - width : width - box.width), y, {
      steps: 10,
    });
    await page.mouse.up();
    await expect
      .poll(async () => Math.abs((await pane.boundingBox()).width - expectedWidth))
      .toBeLessThan(3);
  }

  async function checkControlRows(width) {
    const attach = toolbar.getByTestId('chat-attach-button');
    const route = toolbar.getByTestId('model-selector-button');
    if (!current) await expect(route).toHaveAccessibleName('Run with: Direct API');
    const centerY = (box) => box.y + box.height / 2;
    const anchor = await attach.boundingBox();
    const peers =
      width === 600 && !current
        ? toolbar.locator('button:visible')
        : toolbar.getByTestId(/^(model-selector-button|chat-send-button)$/);
    for (const control of await peers.all()) {
      const offset = centerY(await control.boundingBox()) - centerY(anchor);
      assert.ok(
        Math.abs(offset) <= 1,
        `${await control.getAttribute('data-testid')} left the primary row at ${width}px`
      );
    }
    if (width < 600) {
      const model = await toolbar
        .getByTestId(/^(chat-model-controls|chat-cli-model-controls)$/)
        .locator('button:visible, input:visible')
        .first()
        .boundingBox();
      assert.ok(
        model.y >= anchor.y + anchor.height - 1,
        `Model stayed in the primary row at ${width}px`
      );
      assert.ok(Math.abs(model.x - anchor.x) <= 1, `Model row is indented at ${width}px`);
      if (!current) {
        const configure = await toolbar.getByTestId('chat-direct-api-key-warning').boundingBox();
        assert.ok(
          Math.abs(centerY(configure) - centerY(model)) <= 1,
          `API key control left the model row at ${width}px`
        );
      }
    }
  }

  async function checkControls(label, width) {
    const input = pane.getByTestId('ai-input');
    const draft = await input.inputValue();
    if (!current && !draft) await input.fill('Review this layout');
    try {
      if (out) await page.screenshot({ path: path.join(out, `${label}.png`) });
      assert.deepEqual(await toolbar.evaluate(inspectButtons), [], label);
      if (width) await checkControlRows(width);
      const route = toolbar.getByTestId('model-selector-button');
      if (!current) {
        await route.click();
        await expect(page.getByTestId('chat-assistant-route-menu')).toBeVisible();
        await page.keyboard.press('Escape');
      }
      const send = toolbar.getByTestId('chat-send-button');
      await expect(send).toBeInViewport({ ratio: 1 });
      if (!current && (await send.isEnabled())) await send.click({ trial: true });
      console.log(`${label} passed`);
    } finally {
      if (!current && !draft) await input.fill('');
    }
  }
  if (current) {
    const width = (await pane.boundingBox()).width;
    const focus = await page.evaluateHandle(() => document.activeElement);
    try {
      for (const sample of [260, 320, 600]) {
        await resizeChat(sample, sample);
        await checkControls(`current-${sample}`, sample);
      }
    } finally {
      await resizeChat(width, width);
      await focus.evaluate((el) => {
        if (el instanceof HTMLElement) el.focus({ preventScroll: true });
      });
      await focus.dispose();
    }
  } else {
    await resizeChat(260, 260);
    await checkControls('conversation-260', 260);
    await resizeChat(320, 320);
    await checkControls('conversation-320', 320);
    await resizeChat(72, 256);
    const history = page.getByTestId('ai-history-button');
    await expect
      .poll(async () => (await history.boundingBox()).x - (await pane.boundingBox()).x)
      .toBeGreaterThanOrEqual(0);
    await checkControls('conversation-minimum');
    await history.click();
    await expect(pane).toHaveAttribute('data-history-pinned', 'true');
    const transcript = pane.getByTestId('chat-transcript-rail');
    await expect
      .poll(async () => (await transcript.boundingBox()).width)
      .toBeGreaterThanOrEqual(200);
    await checkControls('pinned-history');
    await history.click();
    await page.mouse.move(0, 0);
    await resizeChat(600, 600);
    await checkControls('conversation-600', 600);
    await page.getByTestId('ai-new-conversation-button').click();
    await expect(pane.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
    await resizeChat(260, 260);
    await checkControls('new-chat-260', 260);
  }
} finally {
  await browser.close();
}

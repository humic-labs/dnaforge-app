import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { runTableEditorJourney } from './lib/table-editor-journey.mjs';
import { runTabSwitchingJourney } from './lib/tab-switching-journey.mjs';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(values.out, 'Use --out with a durable evidence directory');
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(appDir, '../..');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const receipt = {
  sourceCommit,
  startedAt: new Date().toISOString(),
  steps: [],
  pageErrors: [],
  consoleErrors: [],
};
let browser;
try {
  const status = execFileSync(
    process.execPath,
    ['scripts/dev-single-instance-guard.cjs', '--status'],
    {
      cwd: appDir,
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  assert.match(
    status,
    /^ELECTRON_DEV_(?:HEALTHY|ATTACHED)$/mu,
    'Start this checkout with pnpm --dir apps/desktop dev'
  );
  const renderer = status.match(/Desktop renderer:\s*(http:\/\/[^\s]+)/u)?.[1];
  const cdp = status.match(/DevTools\/CDP:\s*(http:\/\/127\.0\.0\.1:\d+)/u)?.[1];
  assert.ok(renderer && cdp, 'The development guard did not identify the owned renderer');
  receipt.renderer = renderer;
  browser = await chromium.connectOverCDP(cdp);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => new URL(page.url()).origin === new URL(renderer).origin);
  assert.ok(page, 'No page belongs to this checkout renderer');
  page.on('pageerror', (error) => receipt.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') receipt.consoleErrors.push(message.text());
  });
  const options = {
    onStep: async (name, details) => {
      const file = `${String(receipt.steps.length + 1).padStart(2, '0')}.png`;
      await page.screenshot({ path: join(out, file) });
      receipt.steps.push({ name, details, file, at: new Date().toISOString() });
    },
  };
  receipt.result = await runTableEditorJourney(page, options);
  receipt.tabSwitching = await runTabSwitchingJourney(page, {
    ...options,
    pageId: receipt.result.pages.at(-1),
  });
  assert.deepEqual(receipt.pageErrors, [], 'The native keyboard journey raised a renderer error');
  assert.deepEqual(receipt.consoleErrors, [], 'The native keyboard journey logged an error');
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'failed';
  receipt.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser?.close();
}
console.log(`TABLE_EDITOR_${receipt.status.toUpperCase()} ${join(out, 'receipt.json')}`);
if (receipt.error) console.error(receipt.error);

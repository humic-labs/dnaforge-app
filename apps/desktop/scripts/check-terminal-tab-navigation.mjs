import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { runTerminalTabJourney } from './lib/terminal-tab-journey.mjs';

const { values } = parseArgs({
  options: {
    cdp: { type: 'string' },
    left: { type: 'string' },
    right: { type: 'string' },
    out: { type: 'string' },
  },
});
assert.ok(
  values.cdp && values.left && values.right && values.out,
  'Pass --cdp <scenario CDP URL> --left <file-tree name> --right <file-tree name> --out <new evidence directory>'
);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const out = resolve(values.out);
await mkdir(out);
const receipt = { status: 'failed', steps: [] };
let browser;
try {
  browser = await chromium.connectOverCDP(values.cdp);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const matches = [];
  for (const page of pages) {
    const runtime = await page.evaluate(async () => {
      const api = window.electronAPI?.runtime;
      if (!api) return null;
      return { profile: api.getProfile(), provenance: await api.getProvenance() };
    });
    if (
      runtime?.profile.kind === 'scenario-e2e' &&
      resolve(runtime.provenance.projectRoot) === resolve(repo)
    ) {
      matches.push({ page, runtime });
    }
  }
  assert.equal(matches.length, 1, 'Use one scenario renderer from this checkout');
  const [{ page, runtime }] = matches;
  receipt.provenance = runtime.provenance;
  receipt.result = await runTerminalTabJourney(page, {
    leftFile: values.left,
    rightFile: values.right,
    onStep: async (name, observed) => {
      const screenshot = `${name}.png`;
      await page.screenshot({ path: join(out, screenshot) });
      receipt.steps.push({ name, observed, screenshot });
    },
  });
  receipt.status = 'passed';
} catch (error) {
  receipt.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  await browser?.close();
}
console.log(`${receipt.status}: ${join(out, 'receipt.json')}`);

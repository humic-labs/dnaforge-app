// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGE_DIR = dirname(fileURLToPath(import.meta.url));

const ALLOWLIST = new Set<string>(['hooks/useSmoothVerticalScroll.ts']);

const NON_PASSIVE_WHEEL = /addEventListener\(\s*['"]wheel['"][\s\S]{0,200}?passive\s*:\s*false/g;

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (
      (entry.endsWith('.ts') || entry.endsWith('.tsx')) &&
      !entry.includes('.test.') &&
      !entry.includes('.spec.')
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe('notebook page feature — wheel passivity invariant', () => {
  it('registers no { passive: false } wheel listener (would kill compositor trackpad momentum)', () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(PAGE_DIR)) {
      const rel = relative(PAGE_DIR, file);
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      NON_PASSIVE_WHEEL.lastIndex = 0;
      if (NON_PASSIVE_WHEEL.test(src)) offenders.push(rel);
    }

    expect(
      offenders,
      `Non-passive wheel listener(s) found in the notebook page feature: ${offenders.join(
        ', '
      )}. A preventDefault-capable wheel listener over the notebook kills trackpad ` +
        `momentum (). Let vertical wheels chain to the notebook pane natively, ` +
        `or allowlist with justification.`
    ).toEqual([]);
  });

  it('the guard itself would catch a re-introduction (meta — proves the pattern)', () => {
    const sample = `el.addEventListener('wheel', onWheel, { passive: false });`;
    NON_PASSIVE_WHEEL.lastIndex = 0;
    expect(NON_PASSIVE_WHEEL.test(sample)).toBe(true);

    const passive = `el.addEventListener('wheel', onWheel, { passive: true });`;
    NON_PASSIVE_WHEEL.lastIndex = 0;
    expect(NON_PASSIVE_WHEEL.test(passive)).toBe(false);
  });
});

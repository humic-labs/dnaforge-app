// @vitest-environment node

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { expect, it } from 'vitest';
import { documentOpeningViolations } from './boundary-analysis.test-harness';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(path)
      : /\.tsx?$/.test(path) && !/\.test[.-]|\.test-harness\./.test(path)
        ? [path]
        : [];
  });
}

const root = resolve(__dirname, '../..');

it('routes production callers through document opening and handlers through the presenter', () => {
  const violations: string[] = [];
  for (const path of sourceFiles(root)) {
    const name = relative(root, path);
    const source = readFileSync(path, 'utf8');
    violations.push(...documentOpeningViolations(path, name, source));
  }
  expect(violations).toEqual([]);
});

it('retains escaped opening imports and presenter checks when filtering source parsing', () => {
  const scan = (name: string, source: string) => documentOpeningViolations(name, name, source);
  expect(
    scan(
      'features/caller.ts',
      String.raw`import { open\u0053equenceFile as open } from './open\u0053equenceFile';`
    )
  ).toEqual(['features/caller.ts: bypasses coordinator']);
  expect(scan('features/caller.ts', String.raw`void import('./open\u0053tructureFile');`)).toEqual([
    'features/caller.ts: lazy bypasses coordinator',
  ]);
  expect(scan('features/sequence/openSequenceFile.ts', 'platform.tabs.openTab({});')).toEqual([
    'features/sequence/openSequenceFile.ts: bypasses presenter',
  ]);
  expect(scan('App.tsx', 'reconcileEntityFile();')).toEqual([
    'App.tsx: document preparation returned to the shell',
  ]);
  expect(
    scan(
      'features/document-opening/open-document.ts',
      String.raw`import { open\u0053equenceFile as open } from './open\u0053equenceFile';`
    )
  ).toEqual([]);
});

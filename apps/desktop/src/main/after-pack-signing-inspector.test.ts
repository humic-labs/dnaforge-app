import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

test('the public packaging hook preserves the explicit signing inspector contract', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const oracle = resolve(root, 'apps/desktop/scripts/lib/after-pack-signing-injection.test.cjs');
  const result = spawnSync(process.execPath, ['--test', oracle], {
    cwd: root,
    env: { ...process.env, DNAFORGE_SIGNING_PUBLIC_ROOT: root },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error?.message ?? null).toBeNull();
  expect(result.status, `${result.stdout ?? ''}\n${result.stderr ?? ''}`).toBe(0);
});

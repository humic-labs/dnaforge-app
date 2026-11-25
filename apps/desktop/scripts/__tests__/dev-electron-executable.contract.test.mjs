import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { devChildEnv } = createRequire(import.meta.url)('../dev-single-instance-guard.cjs');

test('foreground development launches the prepared executable instead of the Electron dependency', () => {
  const env = devChildEnv({
    env: { DESKTOP_DEV_PORT: '14638' },
    platform: 'linux',
    electronBinary: '/prepared/Electron',
  });
  assert.equal(env.ELECTRON_EXEC_PATH, '/prepared/Electron');
});

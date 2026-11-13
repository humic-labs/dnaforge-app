import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const guard = require('../../scripts/dev-single-instance-guard.cjs') as {
  electronViteDevArguments(env: NodeJS.ProcessEnv): string[];
};

describe('guarded development profile arguments', () => {
  it('passes the private profile after the CLI separator so electron-vite preserves it', () => {
    const profile = '--user-data-dir=/Users/test/task profile';
    expect(
      guard.electronViteDevArguments({ ELECTRON_CLI_ARGS: JSON.stringify([profile]) })
    ).toEqual(['exec', 'electron-vite', 'dev', '--', profile]);
  });

  it('keeps ordinary dev launches unchanged', () => {
    expect(guard.electronViteDevArguments({})).toEqual(['exec', 'electron-vite', 'dev']);
  });

  it.each(['{}', '[1]', 'not JSON'])('refuses malformed runtime arguments: %s', (value) => {
    expect(() => guard.electronViteDevArguments({ ELECTRON_CLI_ARGS: value })).toThrow(
      'ELECTRON_CLI_ARGS must be a JSON array of strings.'
    );
  });
});

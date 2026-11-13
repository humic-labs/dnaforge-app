import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeLoginShellPath } from '../resolve-shell-path';

const OPEN = '__WP_PATH_START__';
const CLOSE = '__WP_PATH_END__';

describe(': PATH probe vs a backgrounded daemon holding stdout', () => {
  it('returns the valid PATH promptly even when a daemon keeps the pipe open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'provider-response-order-regression-'));
    const shell = join(dir, 'fakeshell');
    writeFileSync(
      shell,
      `#!/bin/sh\nsleep 30 &\nprintf '%s' "${OPEN}/opt/homebrew/bin:/usr/bin${CLOSE}"\nexit 0\n`
    );
    chmodSync(shell, 0o755);

    const t0 = Date.now();
    const result = await probeLoginShellPath(shell, 5000);
    const elapsed = Date.now() - t0;

    expect(result).toBe('/opt/homebrew/bin:/usr/bin');
    expect(elapsed).toBeLessThan(4000);
  }, 10000);
});

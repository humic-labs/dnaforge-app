import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('genetic-codes.generated.ts', () => {
  it('is current with the vendored NCBI file', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(REPO_ROOT, 'scripts/generate-genetic-codes.mjs'), '--check'],
      { cwd: REPO_ROOT, encoding: 'utf8' }
    );
    expect(output).toContain('is current');
  });
});

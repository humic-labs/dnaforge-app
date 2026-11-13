import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffHostedWorkspace, snapshotHostedWorkspace } from './hosted-native-workspace-diff';

describe('Hosted native managed workspace diff', () => {
  let root = '';
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('retains relative paths and hashes but never content or absolute paths', async () => {
    root = await mkdtemp(join(tmpdir(), 'hosted-workspace-diff-'));
    const before = await snapshotHostedWorkspace(root);
    await mkdir(join(root, 'constructs'));
    await writeFile(join(root, 'constructs', 'named.gb'), 'ATGCGT');
    const diff = diffHostedWorkspace(before, await snapshotHostedWorkspace(root));
    expect(diff).toContainEqual(
      expect.objectContaining({
        path: 'constructs/named.gb',
        operation: 'create',
        after: { byte_count: 6, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      })
    );
    expect(JSON.stringify(diff)).not.toContain(root);
    expect(JSON.stringify(diff)).not.toContain('ATGCGT');
  });
});

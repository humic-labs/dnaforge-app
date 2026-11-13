// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest';

import {
  beginWorkspaceSyncRendererGeneration,
  finishWorkspaceSyncRendererGeneration,
  readStableWorkspaceGeneration,
  resetWorkspaceSyncRendererGenerationsForTest,
} from './workspace-sync-renderer-generation';

afterEach(() => {
  resetWorkspaceSyncRendererGenerationsForTest();
});

describe('workspace sync renderer generations', () => {
  it('discards an old read that crosses a replica replacement and publishes the retry', async () => {
    let releaseOldRead!: (value: string) => void;
    let reads = 0;
    const result = readStableWorkspaceGeneration('/workspace/a', async () => {
      reads += 1;
      if (reads === 1) {
        return new Promise<string>((resolve) => {
          releaseOldRead = resolve;
        });
      }
      return 'remote-generation';
    });

    await Promise.resolve();
    beginWorkspaceSyncRendererGeneration('/workspace/a', 'delivery-1');
    releaseOldRead('stale-local-generation');
    await Promise.resolve();
    expect(reads).toBe(1);

    finishWorkspaceSyncRendererGeneration('/workspace/a', 'delivery-1');
    await expect(result).resolves.toBe('remote-generation');
    expect(reads).toBe(2);
  });

  it('does not block an unrelated workspace while one replica is active', async () => {
    beginWorkspaceSyncRendererGeneration('/workspace/a', 'delivery-1');

    await expect(
      readStableWorkspaceGeneration('/workspace/b', async () => 'workspace-b')
    ).resolves.toBe('workspace-b');

    finishWorkspaceSyncRendererGeneration('/workspace/a', 'delivery-1');
  });

  it('retries an invalidated read error instead of surfacing an apply-time filesystem race', async () => {
    let rejectOldRead!: (error: Error) => void;
    let reads = 0;
    const result = readStableWorkspaceGeneration('C:\\Lab\\A', async () => {
      reads += 1;
      if (reads === 1) {
        return new Promise<string>((_resolve, reject) => {
          rejectOldRead = reject;
        });
      }
      return 'remote-generation';
    });

    await Promise.resolve();
    beginWorkspaceSyncRendererGeneration('c:/lab/a/', 'delivery-1');
    rejectOldRead(new Error('file moved during replica install'));
    await Promise.resolve();
    finishWorkspaceSyncRendererGeneration('C:\\Lab\\A', 'delivery-1');

    await expect(result).resolves.toBe('remote-generation');
    expect(reads).toBe(2);
  });
});

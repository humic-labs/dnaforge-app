// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import { createHostedManagedOperationsRuntimeSource } from './managed-operations-runtime';

const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';

describe('hosted managed operation runtime source', () => {
  it('binds the existing operation client to the active hosted workspace proxy', async () => {
    const source = createHostedManagedOperationsRuntimeSource(
      WORKSPACE_ID,
      'https://staging.dnaforge.test'
    );
    await expect(source.getStatus()).resolves.toBe('ready');
    await expect(source.getBaseUrl()).resolves.toBe(
      `https://staging.dnaforge.test/api/hosted-operations/${WORKSPACE_ID}`
    );
    const listener = vi.fn();
    const unsubscribe = source.subscribeStatus(listener);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('rejects an invalid workspace identity before constructing a transport URL', () => {
    expect(() =>
      createHostedManagedOperationsRuntimeSource('not-a-workspace', 'https://dnaforge.test')
    ).toThrow(/workspace/i);
  });
});

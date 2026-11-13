import { describe, expect, it, vi } from 'vitest';
import { resolveActiveHostedWorkspacePath } from './hosted-workspace-authority';

describe('resolveActiveHostedWorkspacePath', () => {
  it('returns only the canonical path selected from the active workspace catalog', async () => {
    const get = vi.fn(() => ({ path: '/catalog/workspace' }));
    const prepare = vi.fn(() => ({ get }));
    const resolveSafePath = vi.fn(async () => '/real/catalog/workspace');

    await expect(
      resolveActiveHostedWorkspacePath({ prepare } as never, '/catalog/workspace', resolveSafePath)
    ).resolves.toBe('/real/catalog/workspace');
    expect(prepare).toHaveBeenCalledWith(
      expect.stringMatching(/archived_at IS NULL[\s\S]*trashed_at IS NULL/)
    );
    expect(get).toHaveBeenCalledWith('/catalog/workspace');
  });

  it('refuses a renderer path that has no active catalog row', async () => {
    const resolveSafePath = vi.fn();

    await expect(
      resolveActiveHostedWorkspacePath(
        { prepare: () => ({ get: () => undefined }) } as never,
        '/forged/workspace',
        resolveSafePath
      )
    ).rejects.toThrow(/active workspace catalog/i);
    expect(resolveSafePath).not.toHaveBeenCalled();
  });
});

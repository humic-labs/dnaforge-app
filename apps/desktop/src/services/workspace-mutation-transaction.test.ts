import { beforeEach, describe, expect, it, vi } from 'vitest';

const beginWorkspaceMutation = vi.fn();
const endWorkspaceMutation = vi.fn();

vi.mock('../platform', () => ({
  platform: () => ({
    fs: { beginWorkspaceMutation, endWorkspaceMutation },
  }),
}));

import { withRendererWorkspaceMutation } from './workspace-mutation-transaction';

describe('withRendererWorkspaceMutation', () => {
  beforeEach(() => {
    beginWorkspaceMutation.mockReset().mockResolvedValue('token-a');
    endWorkspaceMutation.mockReset().mockResolvedValue(undefined);
  });

  it('holds the main-process capability across every awaited renderer step', async () => {
    const order: string[] = [];
    beginWorkspaceMutation.mockImplementation(async () => {
      order.push('begin');
      return 'token-a';
    });
    endWorkspaceMutation.mockImplementation(async () => {
      order.push('end');
    });

    await withRendererWorkspaceMutation('/workspace/a', async () => {
      order.push('file');
      await Promise.resolve();
      order.push('database');
    });

    expect(order).toEqual(['begin', 'file', 'database', 'end']);
  });

  it('releases the capability when an intermediate step fails', async () => {
    await expect(
      withRendererWorkspaceMutation('/workspace/a', async () => {
        throw new Error('file write failed');
      })
    ).rejects.toThrow('file write failed');

    expect(endWorkspaceMutation).toHaveBeenCalledWith('token-a');
  });

  it('propagates an explicit parent token for logical nesting', async () => {
    await withRendererWorkspaceMutation(
      '/workspace/a',
      async (token) => {
        expect(token).toBe('token-a');
      },
      'parent-token'
    );

    expect(beginWorkspaceMutation).toHaveBeenCalledWith('/workspace/a', 'parent-token');
    expect(endWorkspaceMutation).toHaveBeenCalledWith('token-a');
  });

  it('requests queued admission only for passive background work', async () => {
    await withRendererWorkspaceMutation('/workspace/a', async () => undefined, undefined, {
      waitForAvailability: true,
    });

    expect(beginWorkspaceMutation).toHaveBeenCalledWith('/workspace/a', undefined, true);
    expect(endWorkspaceMutation).toHaveBeenCalledWith('token-a');
  });

  it('serializes same-root passive admissions while the first request is pending', async () => {
    let releaseFirstAdmission: ((token: string) => void) | undefined;
    beginWorkspaceMutation
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseFirstAdmission = resolve;
          })
      )
      .mockResolvedValueOnce('token-b');

    const first = withRendererWorkspaceMutation('/workspace/a', async () => undefined, undefined, {
      waitForAvailability: true,
    });
    const second = withRendererWorkspaceMutation('/workspace/a', async () => undefined, undefined, {
      waitForAvailability: true,
    });

    await vi.waitFor(() => expect(beginWorkspaceMutation).toHaveBeenCalledTimes(1));
    releaseFirstAdmission?.('token-a');
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(beginWorkspaceMutation).toHaveBeenCalledTimes(2);
  });
});

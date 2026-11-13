import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const registered = vi.hoisted(() => ({
  handlers: null as null | Record<string, (...args: unknown[]) => unknown>,
  userData: '',
}));

vi.mock('../../shared/ipc-contract', () => ({
  handleGroup: (_contract: unknown, handlers: Record<string, (...args: unknown[]) => unknown>) => {
    registered.handlers = handlers;
    return () => undefined;
  },
}));

vi.mock('electron', () => ({
  app: { getPath: () => registered.userData },
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.stubGlobal('__DNAFORGE_DISTRIBUTION__', 'community');
registered.userData = mkdtempSync(join(tmpdir(), 'feedback-community-'));

const { registerFeedbackHandlers } = await import('./feedback');

afterAll(() => {
  rmSync(registered.userData, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('feedback in a community build', () => {
  it('refuses to send and never contacts the feedback service', async () => {
    registerFeedbackHandlers();
    const result = await registered.handlers?.send?.(
      {},
      { message: 'Great app!', app_version: '1.0.0', platform_info: 'linux x64' }
    );
    expect(result).toEqual({ success: false, error: 'service_unavailable' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

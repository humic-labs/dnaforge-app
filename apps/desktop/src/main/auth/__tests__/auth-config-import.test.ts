import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../ipc/database', () => ({
  getDb: () => {
    throw new Error('Development auth must not read packaged update preferences.');
  },
}));

describe('auth configuration initialization', () => {
  it('loads development auth without constructing the native updater', async () => {
    const config = await import('../auth-config');
    expect(config.getAuthChannel()).toBe('dev');
  });
});

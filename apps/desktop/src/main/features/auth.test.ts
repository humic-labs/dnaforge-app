// @vitest-environment node
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const registered = vi.hoisted(() => [] as Array<() => BrowserWindow | null>);

vi.mock('../ipc/auth', () => ({
  registerAuthHandlers: (getWindow: () => BrowserWindow | null) => registered.push(getWindow),
}));

import { authFeature } from './auth';

describe('auth feature', () => {
  it('registers sign-in on the main window with an accessor that reads the live window', () => {
    const first = { id: 1 } as BrowserWindow;
    const recreated = { id: 2 } as BrowserWindow;
    let current: BrowserWindow | null = first;
    authFeature.onMainWindow?.(first, { getMainWindow: () => current });
    expect(registered).toHaveLength(1);
    expect(registered[0]()).toBe(first);
    current = recreated;
    expect(registered[0]()).toBe(recreated);
    current = null;
    expect(registered[0]()).toBeNull();
  });

  it('has no work before the window, at IPC registration, or at quit', () => {
    expect(authFeature.prepare).toBeUndefined();
    expect(authFeature.registerIpc).toBeUndefined();
    expect(authFeature.willQuit).toBeUndefined();
    expect(authFeature.shutdown).toBeUndefined();
  });
});

// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => `/paths/${name}`,
    getAppPath: () => '/app',
    isPackaged: false,
  },
}));
vi.mock('../track-store', () => ({
  resolveDnaforgeDataRoot: vi.fn((input: { home: string }) => {
    calls.push('resolve-data-root');
    return `${input.home}/.dnaforge`;
  }),
  resolveTrackResourceRoot: vi.fn((input: { appPath: string }) => {
    calls.push('resolve-resource-root');
    return `${input.appPath}/resources`;
  }),
  initializeTrackStore: vi.fn((roots: { dataRoot: string; resourceRoot: string }) => {
    calls.push(`initialize:${roots.dataRoot}|${roots.resourceRoot}`);
  }),
}));
vi.mock('../ipc/track-store', () => ({
  seedTrackStoreAtStartup: vi.fn(() => calls.push('seed')),
  registerTrackStoreIpcHandlers: vi.fn(() => calls.push('register-ipc')),
}));

import { trackStoreFeature } from './track-store';

describe('track store feature', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('prepares the store from the resolved roots, then seeds it, without registering IPC', async () => {
    await trackStoreFeature.prepare?.({ getMainWindow: () => null });
    expect(calls).toEqual([
      'resolve-data-root',
      'resolve-resource-root',
      'initialize:/paths/home/.dnaforge|/app/resources',
      'seed',
    ]);
  });

  it('registers its IPC handlers only when the root registers feature IPC', () => {
    const dispose = trackStoreFeature.registerIpc?.();
    expect(calls).toEqual(['register-ipc']);
    expect(dispose).toBeTypeOf('function');
  });

  it('has no window, quit or shutdown work', () => {
    expect(trackStoreFeature.onMainWindow).toBeUndefined();
    expect(trackStoreFeature.willQuit).toBeUndefined();
    expect(trackStoreFeature.shutdown).toBeUndefined();
  });
});

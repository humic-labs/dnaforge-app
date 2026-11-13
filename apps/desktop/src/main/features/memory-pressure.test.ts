// @vitest-environment node
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';

const registered = vi.hoisted(() => [] as Array<() => BrowserWindow | null>);

vi.mock('../ipc/memory-pressure', () => ({
  registerMemoryPressureHandlers: (getWindow: () => BrowserWindow | null) =>
    registered.push(getWindow),
}));

import { memoryPressureFeature } from './memory-pressure';

describe('memory pressure feature', () => {
  it('starts sampling on the main window with an accessor that reads the live window', () => {
    const first = { id: 1 } as BrowserWindow;
    const recreated = { id: 2 } as BrowserWindow;
    let current: BrowserWindow | null = first;
    memoryPressureFeature.onMainWindow?.(first, { getMainWindow: () => current });
    expect(registered).toHaveLength(1);
    expect(registered[0]()).toBe(first);
    current = recreated;
    expect(registered[0]()).toBe(recreated);
    current = null;
    expect(registered[0]()).toBeNull();
  });

  it('has no work before the window, at IPC registration, or at quit', () => {
    expect(memoryPressureFeature.prepare).toBeUndefined();
    expect(memoryPressureFeature.registerIpc).toBeUndefined();
    expect(memoryPressureFeature.willQuit).toBeUndefined();
    expect(memoryPressureFeature.shutdown).toBeUndefined();
  });
});

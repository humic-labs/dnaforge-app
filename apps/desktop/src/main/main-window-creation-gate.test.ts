import { describe, expect, it, vi } from 'vitest';
import { MainWindowCreationGate } from './main-window-creation-gate';

interface FakeWindow {
  id: number;
  destroyed: boolean;
}

describe('main-window creation gate', () => {
  it('coalesces the macOS activate race with slow first-start initialization', async () => {
    const gate = new MainWindowCreationGate<FakeWindow>((window) => window.destroyed);
    let resolveCreation!: (window: FakeWindow) => void;
    const pendingWindow = new Promise<FakeWindow>((resolve) => {
      resolveCreation = resolve;
    });
    const create = vi.fn(() => pendingWindow);

    const fromActivate = gate.getOrCreate(null, create);
    const fromInit = gate.getOrCreate(null, create);
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);

    const window = { id: 1, destroyed: false };
    resolveCreation(window);
    await expect(fromActivate).resolves.toBe(window);
    await expect(fromInit).resolves.toBe(window);
  });

  it('reuses a live window and creates a replacement only after destruction', async () => {
    const gate = new MainWindowCreationGate<FakeWindow>((window) => window.destroyed);
    const live = { id: 1, destroyed: false };
    const create = vi.fn(async () => ({ id: 2, destroyed: false }));

    await expect(gate.getOrCreate(live, create)).resolves.toBe(live);
    expect(create).not.toHaveBeenCalled();

    live.destroyed = true;
    await expect(gate.getOrCreate(live, create)).resolves.toEqual({ id: 2, destroyed: false });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('shares a failed creation and permits a later retry', async () => {
    const gate = new MainWindowCreationGate<FakeWindow>((window) => window.destroyed);
    const failure = new Error('window creation failed');
    const create = vi
      .fn<() => Promise<FakeWindow>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ id: 2, destroyed: false });

    const first = gate.getOrCreate(null, create);
    const second = gate.getOrCreate(null, create);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(create).toHaveBeenCalledTimes(1);

    await expect(gate.getOrCreate(null, create)).resolves.toEqual({ id: 2, destroyed: false });
    expect(create).toHaveBeenCalledTimes(2);
  });
});

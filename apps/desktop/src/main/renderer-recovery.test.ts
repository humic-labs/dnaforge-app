import { userMessage } from '@waypoint/user-messages';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { powerMonitor, type BrowserWindow } from 'electron';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: { quit: vi.fn() },
    dialog: { showMessageBox: vi.fn() },
    powerMonitor: new EventEmitter(),
  };
});

import {
  installRendererRecovery,
  isRendererAvailable,
  onRendererHang,
  resetRendererRecoveryForTests,
} from './renderer-recovery';
import type { UserMessageBoxOptions } from './user-dialogs';

const windows: EventEmitter[] = [];

function setup(
  answer: number,
  overrides: { quitting?: boolean; suppressed?: boolean; frozen?: boolean; packaged?: boolean } = {}
) {
  const contents = Object.assign(new EventEmitter(), {
    reload: vi.fn(),
    isLoadingMainFrame: () => false,
    isCrashed: () => false,
    executeJavaScript: vi.fn(() =>
      overrides.frozen ? new Promise<number>(() => undefined) : Promise.resolve(1)
    ),
    loadURL: vi.fn(async () => undefined),
    forcefullyCrashRenderer: vi.fn(),
    getOSProcessId: () => 0,
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    showInactive: vi.fn(),
  });
  windows.push(win);
  const showMessageBox = vi.fn(async (_win: BrowserWindow, _options: UserMessageBoxOptions) => ({
    response: answer,
  }));
  const quit = vi.fn();
  const onHang = vi.fn();
  onRendererHang(onHang);
  installRendererRecovery(win as unknown as BrowserWindow, {
    isQuitting: () => overrides.quitting ?? false,
    suppressDialogs: () => overrides.suppressed ?? false,
    devServerUrl: overrides.packaged ? undefined : 'http://localhost:1665',
    appUrl: 'http://localhost:1665/?app',
    heartbeatMs: 1000,
    hungAfterMs: 3000,
    showMessageBox,
    quit,
  });
  return { contents, win, showMessageBox, quit, onHang };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('renderer recovery ', () => {
  beforeEach(resetRendererRecoveryForTests);
  afterEach(() => {
    for (const win of windows.splice(0)) win.emit('closed');
    powerMonitor.removeAllListeners();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('offers a reload instead of leaving a crashed window blank', async () => {
    const { contents, showMessageBox } = setup(0);
    contents.emit('did-finish-load');
    expect(isRendererAvailable()).toBe(true);
    contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(isRendererAvailable()).toBe(false);
    await settle();
    expect(showMessageBox.mock.calls[0][1]).toMatchObject({
      message: 'The DNAForge window stopped working.',
      buttons: ['Reload Window', 'Quit DNAForge'],
    });
    expect(contents.reload).toHaveBeenCalledOnce();
  });

  it('prompts after a clean renderer exit while the app stays open', async () => {
    const { contents, showMessageBox } = setup(0);
    contents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    await settle();
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(contents.reload).toHaveBeenCalledOnce();
  });

  it('quits when asked after a crash', async () => {
    const { contents, quit } = setup(1);
    contents.emit('render-process-gone', {}, { reason: 'oom', exitCode: 1 });
    await settle();
    expect(quit).toHaveBeenCalledOnce();
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it('names a stopped dev server and retries the load', async () => {
    const { contents, showMessageBox } = setup(0);
    contents.emit(
      'did-fail-load',
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://localhost:1665/',
      true
    );
    await settle();
    expect(showMessageBox.mock.calls[0][1]).toMatchObject({
      message: "DNAForge can't reach its development server.",
      detail: expect.stringContaining(userMessage('startup.reloadWindow')),
    });
    expect(contents.loadURL).toHaveBeenCalledWith('http://localhost:1665/?app');
  });

  it('ignores cancelled navigations, subframes, quitting, and automated tests', async () => {
    const first = setup(0);
    first.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:1665/', true);
    first.contents.emit('did-fail-load', {}, -102, 'refused', 'http://x/', false);
    const quitting = setup(0, { quitting: true });
    quitting.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    const suppressed = setup(0, { suppressed: true });
    suppressed.contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await settle();
    expect(first.showMessageBox).not.toHaveBeenCalled();
    expect(quitting.showMessageBox).not.toHaveBeenCalled();
    expect(suppressed.showMessageBox).not.toHaveBeenCalled();
  });

  it('replaces a hung window on request without reporting its exit as a crash', async () => {
    const { contents, showMessageBox } = setup(1);
    contents.emit('unresponsive');
    await settle();
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledOnce();
    expect(contents.reload).not.toHaveBeenCalled();
    contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
    await settle();
    expect(contents.reload).toHaveBeenCalledOnce();
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it('terminates the frozen renderer once when its process is available', async () => {
    const { contents } = setup(1);
    vi.spyOn(contents, 'getOSProcessId').mockReturnValue(207);
    const terminate = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      contents.emit('unresponsive');
      await settle();
      expect(terminate).toHaveBeenCalledWith(207, 'SIGKILL');
      expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
      contents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 1 });
      expect(contents.reload).toHaveBeenCalledOnce();
    } finally {
      terminate.mockRestore();
    }
  });

  it('prompts when a frozen window stops answering, without any user input', async () => {
    vi.useFakeTimers();
    try {
      const { contents, showMessageBox } = setup(1, { frozen: true });
      contents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(2000);
      expect(showMessageBox).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(showMessageBox.mock.calls[0][1]).toMatchObject({
        message: "DNAForge isn't responding.",
        buttons: ['Wait', 'Reload Window'],
      });
      expect(isRendererAvailable()).toBe(false);
      expect(contents.forcefullyCrashRenderer).toHaveBeenCalledOnce();
      expect(contents.reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(3000);
      expect(contents.reload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a Chromium hang and its reload resolution', async () => {
    const { contents, onHang } = setup(1);
    contents.emit('unresponsive');
    await settle();
    expect(onHang.mock.calls.map(([event]) => event)).toEqual([
      { phase: 'detected', source: 'chromium' },
      expect.objectContaining({ phase: 'resolved', source: 'chromium', resolution: 'reloaded' }),
    ]);
  });

  it('reports a heartbeat hang that recovers on its own with its duration', async () => {
    vi.useFakeTimers();
    try {
      const { contents, onHang } = setup(0);
      let unfreeze: (value: number) => void = () => undefined;
      contents.executeJavaScript.mockImplementationOnce(
        () => new Promise<number>((resolve) => (unfreeze = resolve))
      );
      contents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(5000);
      expect(onHang).toHaveBeenCalledWith({ phase: 'detected', source: 'heartbeat' });
      unfreeze(1);
      await vi.advanceTimersByTimeAsync(1000);
      const resolved = onHang.mock.calls
        .map(([event]) => event)
        .find((e) => e.phase === 'resolved');
      expect(resolved).toMatchObject({ source: 'heartbeat', resolution: 'recovered' });
      expect(resolved.durationMs).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not report system sleep as a hang', async () => {
    vi.useFakeTimers();
    try {
      const { showMessageBox, onHang } = setup(0);
      await vi.advanceTimersByTimeAsync(2000);
      vi.setSystemTime(Date.now() + 60_000);
      await vi.advanceTimersByTimeAsync(5000);
      expect(showMessageBox).not.toHaveBeenCalled();
      expect(onHang).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays quiet while the window keeps answering', async () => {
    vi.useFakeTimers();
    try {
      const { showMessageBox } = setup(1);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(showMessageBox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'ignores elapsed sleep time in a healthy renderer (packaged: %s)',
    async (packaged) => {
      vi.useFakeTimers();
      const { contents, showMessageBox } = setup(0, { packaged });
      contents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(1000);
      vi.setSystemTime(Date.now() + 3_600_000);
      contents.emit('unresponsive');
      await vi.advanceTimersByTimeAsync(1000);
      expect(showMessageBox).not.toHaveBeenCalled();
      expect(contents.reload).not.toHaveBeenCalled();
      expect(isRendererAvailable()).toBe(true);
    }
  );

  it('pauses hang detection during sleep and starts a fresh deadline on wake', async () => {
    vi.useFakeTimers();
    const { contents, showMessageBox } = setup(0, { frozen: true });
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(1000);
    powerMonitor.emit('suspend');
    vi.setSystemTime(Date.now() + 3_600_000);
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(5000);
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(1);
    powerMonitor.emit('resume');
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(2000);
    expect(showMessageBox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(isRendererAvailable()).toBe(false);
  });

  it('reprobes on wake even when a pre-sleep probe never completes', async () => {
    vi.useFakeTimers();
    const overrides = { frozen: true };
    const { contents, showMessageBox } = setup(0, overrides);
    contents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(1000);
    powerMonitor.emit('suspend');
    vi.setSystemTime(Date.now() + 3_600_000);
    overrides.frozen = false;
    powerMonitor.emit('resume');
    contents.emit('unresponsive');
    await vi.advanceTimersByTimeAsync(1000);
    expect(contents.executeJavaScript.mock.calls.length).toBeGreaterThan(1);
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(contents.reload).not.toHaveBeenCalled();
    expect(isRendererAvailable()).toBe(true);
  });

  it('does not let a stale pre-sleep reply clear the current probe', async () => {
    vi.useFakeTimers();
    const { contents, showMessageBox } = setup(0, { frozen: true });
    let answerOld!: (value: number) => void;
    contents.executeJavaScript.mockReturnValueOnce(
      new Promise((resolve) => {
        answerOld = resolve;
      })
    );
    await vi.advanceTimersByTimeAsync(1000);
    powerMonitor.emit('suspend');
    powerMonitor.emit('resume');
    await vi.advanceTimersByTimeAsync(1000);
    const calls = contents.executeJavaScript.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    answerOld(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(contents.executeJavaScript).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(3000);
    expect(showMessageBox).toHaveBeenCalledOnce();
  });

  it('restores availability when a renderer recovers after its warning', async () => {
    vi.useFakeTimers();
    const { contents, showMessageBox } = setup(0);
    contents.emit('did-finish-load');
    contents.emit('unresponsive');
    expect(isRendererAvailable()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(isRendererAvailable()).toBe(true);
  });

  it('removes power listeners and heartbeat work when the window closes', async () => {
    vi.useFakeTimers();
    const { contents, win } = setup(0);
    expect(powerMonitor.listenerCount('suspend')).toBe(1);
    expect(powerMonitor.listenerCount('resume')).toBe(1);
    win.emit('closed');
    powerMonitor.emit('resume');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(powerMonitor.listenerCount('suspend')).toBe(0);
    expect(powerMonitor.listenerCount('resume')).toBe(0);
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('dismisses a stale hang warning when the renderer answers without applying a late reload choice', async () => {
    vi.useFakeTimers();
    const { contents, showMessageBox } = setup(0);
    let answer!: (value: { response: number }) => void;
    showMessageBox.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    contents.emit('unresponsive');
    const signal = showMessageBox.mock.calls[0][1].signal!;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal.aborted).toBe(true);
    answer({ response: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(contents.reload).not.toHaveBeenCalled();
    expect(isRendererAvailable()).toBe(true);
  });
});

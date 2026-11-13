import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserWindow, dialog, powerMonitor } from 'electron';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: { quit: vi.fn() },
    powerMonitor: new EventEmitter(),
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    BrowserWindow: class extends EventEmitter {
      isDestroyed = vi.fn(() => false);
      isFocused = vi.fn(() => false);
      isVisible = vi.fn(() => false);
      showInactive = vi.fn();
      webContents = Object.assign(new EventEmitter(), {
        reload: vi.fn(),
        isLoadingMainFrame: () => false,
        isCrashed: () => false,
        executeJavaScript: vi.fn(async () => 1),
        loadURL: vi.fn(async () => undefined),
        forcefullyCrashRenderer: vi.fn(),
        getOSProcessId: () => 0,
      });
    },
  };
});

import { installRendererRecovery, resetRendererRecoveryForTests } from './renderer-recovery';

let window: BrowserWindow;
beforeEach(() => {
  resetRendererRecoveryForTests();
  vi.mocked(dialog.showMessageBox).mockClear();
  window = new BrowserWindow({ show: false });
  installRendererRecovery(window, {
    isQuitting: () => false,
    suppressDialogs: () => false,
    heartbeatMs: 1000,
    hungAfterMs: 3000,
  });
});
afterEach(() => {
  window.emit('closed');
  powerMonitor.removeAllListeners();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('background renderer recovery', () => {
  it('does not show a native dialog or reveal an unfocused window for a Chromium hang', () => {
    window.webContents.emit('unresponsive');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it('does not show a native dialog when the health timer detects a background hang', async () => {
    window.emit('closed');
    vi.useFakeTimers();
    vi.mocked(window.webContents.executeJavaScript).mockImplementation(() => new Promise(() => {}));
    installRendererRecovery(window, {
      isQuitting: () => false,
      suppressDialogs: () => false,
      heartbeatMs: 1000,
      hungAfterMs: 3000,
    });
    window.webContents.emit('did-finish-load');
    await vi.advanceTimersByTimeAsync(5000);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(window.showInactive).not.toHaveBeenCalled();
  });

  it('drops an obsolete hang prompt when the renderer recovers before the user returns', () => {
    window.webContents.emit('unresponsive');
    window.webContents.emit('responsive');
    vi.mocked(window.isFocused).mockReturnValue(true);
    window.emit('focus');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('presents an unresolved hang once when the user returns to the window', () => {
    window.webContents.emit('unresponsive');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    vi.mocked(window.isFocused).mockReturnValue(true);
    window.emit('focus');
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
    expect(window.showInactive).not.toHaveBeenCalled();
    window.emit('focus');
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });

  it('preserves crash recovery until the user returns instead of opening it in the background', () => {
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    vi.mocked(window.isFocused).mockReturnValue(true);
    window.emit('focus');
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
  });

  it('does not retain a recovery prompt after a successful reload', () => {
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    window.webContents.emit('did-finish-load');
    vi.mocked(window.isFocused).mockReturnValue(true);
    window.emit('focus');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('removes pending presentation when the window closes', () => {
    window.webContents.emit('unresponsive');
    window.emit('closed');
    vi.mocked(window.isFocused).mockReturnValue(true);
    window.emit('focus');
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(window.listenerCount('focus')).toBe(0);
  });
});

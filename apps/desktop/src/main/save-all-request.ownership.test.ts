// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ bus: null as EventEmitter | null, send: vi.fn() }));
vi.mock('../shared/ipc-contract', () => ({
  mainIpc: {
    on: (...args: Parameters<EventEmitter['on']>) => host.bus!.on(...args),
    once: (...args: Parameters<EventEmitter['once']>) => host.bus!.once(...args),
    removeListener: (...args: Parameters<EventEmitter['removeListener']>) =>
      host.bus!.removeListener(...args),
  },
  sendRendererIpc: (...args: unknown[]) => host.send(...args),
  handleGroup: vi.fn(),
}));
vi.mock('electron-updater', () => ({ default: { autoUpdater: {} } }));
vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getName: () => 'DNAForge',
    isPackaged: false,
    getPath: () => '/tmp',
  },
  BrowserWindow: class {},
  net: {},
  autoUpdater: {},
}));
vi.mock('./analytics', () => ({ trackEvent: vi.fn() }));
vi.mock('./ipc/feedback', () => ({ getInstallId: () => 'fixture' }));
vi.mock('./dirty-state-cache', () => ({ readCurrentDirtyState: vi.fn() }));
vi.mock('./quit-consent', () => ({
  setQuitConsentGranted: vi.fn(),
  showUnsavedWorkDialog: vi.fn(),
}));
vi.mock('./boot-log', () => ({ appendBootLog: vi.fn() }));
vi.mock('./update-install-telemetry', () => ({
  UPDATE_BOOT_ID: 'fixture',
  createUpdateInstallMeasurement: vi.fn(),
  parseUpdateInstallMeasurement: vi.fn(),
  isUpdateInstallMeasurementPermitted: vi.fn(),
  isUpdateDownloadMeasurementPermitted: vi.fn(),
  recordUpdateDownloadMeasurement: vi.fn(),
  recordUpdateInstallMeasurement: vi.fn(),
}));

import { requestSaveAll } from './auto-updater';
const renderer = { id: 7 };
const window = { isDestroyed: () => false, webContents: renderer };
beforeEach(() => {
  vi.useFakeTimers();
  host.bus = new EventEmitter();
  host.send.mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it('keeps the save request pending when another renderer acknowledges it', async () => {
  let done = false;
  const pending = requestSaveAll(window as never, 1000).then(() => {
    done = true;
  });
  const requestId = host.send.mock.calls[0][2];
  host.bus!.emit('app:saveAllDone', { sender: { id: 8 } }, requestId);
  await Promise.resolve();
  expect(done).toBe(false);
  host.bus!.emit('app:saveAllDone', { sender: renderer }, requestId);
  await pending;
  expect(done).toBe(true);
  expect(host.bus!.listenerCount('app:saveAllDone')).toBe(0);
});

it('does not let a late timed-out acknowledgement finish a replacement save request', async () => {
  const first = requestSaveAll(window as never, 1000);
  const firstId = host.send.mock.calls[0][2];
  await vi.advanceTimersByTimeAsync(1000);
  await first;
  let done = false;
  const replacement = requestSaveAll(window as never, 1000).then(() => {
    done = true;
  });
  const replacementId = host.send.mock.calls[1][2];
  host.bus!.emit('app:saveAllDone', { sender: renderer }, firstId);
  await Promise.resolve();
  expect(done).toBe(false);
  host.bus!.emit('app:saveAllDone', { sender: renderer }, replacementId);
  await replacement;
  expect(done).toBe(true);
  expect(host.bus!.listenerCount('app:saveAllDone')).toBe(0);
});

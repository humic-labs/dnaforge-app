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
const renderer = Object.assign(new EventEmitter(), { id: 7, isDestroyed: () => false });
const window = { isDestroyed: () => false, webContents: renderer };
beforeEach(() => {
  vi.useFakeTimers();
  host.bus = new EventEmitter();
  host.send.mockClear();
  renderer.removeAllListeners();
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
  const timedOut = expect(first).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(1000);
  await timedOut;
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

it('rejects the matching native save failure and keeps its file and reason', async () => {
  const failures = [
    {
      documentId: 'doc-blocked',
      path: '/workspace/Blocked Save.txt',
      error: 'The text file is read-only.',
    },
  ];
  const pending = requestSaveAll(window as never, 1000);
  const rejected = expect(pending).rejects.toMatchObject({ failures });
  const requestId = host.send.mock.calls[0][2];
  host.bus!.emit('app:saveAllDone', { sender: renderer }, requestId, {
    status: 'failed',
    failures,
  });
  await rejected;
  expect(host.bus!.listenerCount('app:saveAllDone')).toBe(0);
  expect(renderer.eventNames()).toEqual([]);
});

it.each(['destroyed', 'render-process-gone'])(
  'rejects when the saving renderer emits %s and removes its listeners',
  async (event) => {
    const pending = requestSaveAll(window as never, 1000);
    const rejected = expect(pending).rejects.toThrow('stopped before confirming');
    renderer.emit(event);
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(host.bus!.listenerCount('app:saveAllDone')).toBe(0);
    expect(renderer.eventNames()).toEqual([]);
  }
);

it('fails before sending when the window has already gone', async () => {
  await expect(requestSaveAll({ isDestroyed: () => true } as never, 1000)).rejects.toThrow(
    'stopped before confirming'
  );
  expect(host.send).not.toHaveBeenCalled();
  expect(host.bus!.listenerCount('app:saveAllDone')).toBe(0);
});

it('cleans up a request when sending to the renderer throws', async () => {
  host.send.mockImplementationOnce(() => {
    throw new Error('Renderer unavailable');
  });
  await expect(requestSaveAll(window as never, 1000)).rejects.toThrow('Renderer unavailable');
  expect(host.bus!.listenerCount('app:saveAllDone')).toBe(0);
  expect(renderer.eventNames()).toEqual([]);
});

it.each([
  { status: 'failed' },
  { status: 'failed', failures: [null] },
  { status: 'failed', failures: [{ documentId: 'doc', error: 7 }] },
  { status: 'failed', failures: [{ documentId: 'doc', path: {}, error: 'Failed' }] },
  { status: 'unexpected' },
])(
  'rejects an invalid acknowledgement without throwing out of the IPC listener: %j',
  async (result) => {
    const pending = requestSaveAll(window as never, 1000);
    const rejected = expect(pending).rejects.toThrow('did not return a valid save result');
    const requestId = host.send.mock.calls[0][2];
    expect(() =>
      host.bus!.emit('app:saveAllDone', { sender: renderer }, requestId, result)
    ).not.toThrow();
    await rejected;
    expect(host.bus!.listenerCount('app:saveAllDone')).toBe(0);
    expect(renderer.eventNames()).toEqual([]);
  }
);

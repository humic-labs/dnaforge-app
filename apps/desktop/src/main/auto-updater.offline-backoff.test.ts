import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeSdkEvent } from '@waypoint/analytics-policy';
import { sanitizeClosedBetaProperties } from '../shared/analytics-allowlist';
import {
  CLOSED_BETA_EVENT_PROPERTIES,
  CLOSED_BETA_EVENT_VERSIONS,
} from '../shared/analytics-registry.generated';

const mocks = vi.hoisted(() => ({
  userData: '',
  online: vi.fn(() => true),
  trackEvent: vi.fn<(event: string, properties: Record<string, unknown>) => void>(),
  events: new Map<string, (...args: unknown[]) => void>(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  appEvents: new Map<string, () => void>(),
  checkForUpdates: vi.fn<() => Promise<null>>(),
}));

vi.mock('electron-updater', () => {
  const autoUpdater = {
    checkForUpdates: mocks.checkForUpdates,
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn(),
    setFeedURL: vi.fn(),
    isUserWithinRollout: vi.fn().mockResolvedValue(true),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      mocks.events.set(event, listener);
    }),
    removeListener: vi.fn(),
  };
  return { default: { autoUpdater }, autoUpdater };
});

vi.mock('electron', () => ({
  net: { isOnline: mocks.online },
  app: {
    getVersion: () => '1.0.0',
    getName: () => 'DNAForge',
    getPath: () => mocks.userData,
    isPackaged: true,
    on: vi.fn((event: string, listener: () => void) => mocks.appEvents.set(event, listener)),
    quit: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  dialog: { showMessageBox: vi.fn(), showErrorBox: vi.fn() },
}));

vi.mock('./analytics', () => ({
  trackEvent: mocks.trackEvent,
  captureOptionalTelemetryOrigin: () => null,
  enqueueOptionalAnalyticsEvent: () => false,
  enqueueOptionalAnalyticsEventFromReceipt: () => false,
}));

const MINUTE = 60_000;
const INITIAL_DELAY = 30_000;
const TOLERANCE = 1_000;

function backgroundStarts(): number[] {
  return mocks.trackEvent.mock.calls
    .filter(
      ([event, properties]) => event === 'app_update_check_started' && properties.manual === false
    )
    .map(([, properties]) => properties.occurred_at_ms as number);
}

function errors(manual: boolean): Record<string, unknown>[] {
  return mocks.trackEvent.mock.calls
    .filter(([event, properties]) => event === 'app_update_error' && properties.manual === manual)
    .map(([, properties]) => properties);
}

async function start(): Promise<void> {
  const { initAutoUpdater } = await import('./auto-updater');
  initAutoUpdater({ webContents: { send: vi.fn() }, isDestroyed: () => false } as never);
}

describe(' offline updater contract', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T00:00:00Z'));
    mocks.events.clear();
    mocks.handlers.clear();
    mocks.appEvents.clear();
    mocks.userData = mkdtempSync(join(tmpdir(), 'dnaforge-offline-contract-'));
    mocks.online.mockReturnValue(true);
    mocks.checkForUpdates.mockReset().mockImplementation(async () => {
      const error = new Error('net::ERR_INTERNET_DISCONNECTED');
      mocks.events.get('error')?.(error);
      throw error;
    });
  });

  afterEach(() => {
    mocks.appEvents.get('will-quit')?.();
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(mocks.userData, { recursive: true, force: true });
    for (const [event, properties] of mocks.trackEvent.mock.calls) {
      if (event !== 'app_update_error' && event !== 'app_update_origin_failed') continue;
      const sanitized = sanitizeClosedBetaProperties(properties);
      expect(sanitized).toEqual(properties);
      const sent = sanitizeSdkEvent(
        { event, properties: sanitized },
        'desktop',
        'unknown',
        CLOSED_BETA_EVENT_PROPERTIES,
        undefined,
        CLOSED_BETA_EVENT_VERSIONS
      );
      expect(sent?.event).toBe(event);
      expect(sent?.properties).toMatchObject(properties);
    }
  });

  it('makes zero provider checks during 24 hours offline and emits at most one background error', async () => {
    mocks.online.mockReturnValue(false);
    await start();
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect.soft(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect.soft(errors(false).length).toBeLessThanOrEqual(1);
  });

  it('spaces five consecutive network failures by 10, 20, 40, 80, 160 minutes and emits one background error with streak_count', async () => {
    mocks.checkForUpdates.mockImplementation(async () => {
      if (backgroundStarts().length === 6) {
        mocks.events.get('update-not-available')?.({ version: '1.0.0' });
        return null;
      }
      const error = new Error('net::ERR_INTERNET_DISCONNECTED');
      mocks.events.get('error')?.(error);
      throw error;
    });
    await start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY);
    expect(backgroundStarts()).toHaveLength(1);
    for (const minutes of [10, 20, 40, 80, 160]) {
      const last = backgroundStarts().at(-1) ?? Number.NaN;
      await vi.advanceTimersByTimeAsync(last + minutes * MINUTE - Date.now());
    }
    const starts = backgroundStarts();
    expect.soft(starts).toHaveLength(6);
    for (const [index, minutes] of [10, 20, 40, 80, 160].entries()) {
      expect
        .soft(Math.abs(starts[index + 1] - starts[index] - minutes * MINUTE))
        .toBeLessThanOrEqual(TOLERANCE);
    }
    expect.soft(errors(false)).toHaveLength(1);
    expect.soft(errors(false)[0]).toMatchObject({ error_code: 'network', streak_count: 1 });
  });

  it('always emits manual errors during backoff and resets the next background delay to 10 minutes', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY + 10 * MINUTE);
    expect(backgroundStarts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    const manual = mocks.handlers.get('update:check-manual');
    expect(manual).toBeTypeOf('function');
    if (!manual) throw new Error('Manual update command was not registered');
    const callsBeforeManual = mocks.checkForUpdates.mock.calls.length;
    await manual({});
    await manual({});
    expect
      .soft(mocks.checkForUpdates.mock.calls.length)
      .toBeGreaterThanOrEqual(callsBeforeManual + 2);
    expect.soft(errors(true)).toHaveLength(2);
    expect
      .soft(errors(true))
      .toEqual(expect.arrayContaining([expect.objectContaining({ error_code: 'network' })]));
    const manualAt = Date.now();
    await vi.advanceTimersByTimeAsync(10 * MINUTE + TOLERANCE);
    expect.soft(backgroundStarts()).toHaveLength(3);
    expect
      .soft(Math.abs((backgroundStarts().at(-1) ?? Number.NaN) - manualAt - 10 * MINUTE))
      .toBeLessThanOrEqual(TOLERANCE);
    expect.soft(errors(false)).toHaveLength(2);
    expect.soft(errors(false)[1]).toMatchObject({ streak_count: 1 });
  });
});

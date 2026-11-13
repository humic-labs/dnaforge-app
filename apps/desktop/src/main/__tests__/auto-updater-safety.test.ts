import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { AnalyticsOutboxAuthority, OptionalTelemetryOrigin } from '../analytics-outbox';

const ipcHandlers = new Map<string, (...args: unknown[]) => void>();
const ipcInvokers = new Map<string, (...args: unknown[]) => unknown>();
const autoUpdaterEvents = new Map<string, (...args: unknown[]) => void>();
const nativeUpdaterEvents = new Map<string, (...args: unknown[]) => void>();
const mockNativeUpdater = {
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    nativeUpdaterEvents.set(event, cb);
  }),
  removeListener: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    if (nativeUpdaterEvents.get(event) === cb) nativeUpdaterEvents.delete(event);
  }),
  checkForUpdates: vi.fn(() => nativeUpdaterEvents.get('update-downloaded')?.()),
};

const mockAutoUpdater = {
  checkForUpdates: vi.fn().mockResolvedValue(null),
  downloadUpdate: vi.fn().mockResolvedValue([]),
  quitAndInstall: vi.fn(),
  setFeedURL: vi.fn(),
  on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    autoUpdaterEvents.set(event, cb);
  }),
  isUserWithinRollout: vi.fn().mockResolvedValue(true),
  autoDownload: true,
  autoInstallOnAppQuit: true,
  allowPrerelease: false,
  disableWebInstaller: false,
};

const showMessageBox = vi.fn();
const showErrorBox = vi.fn();
const trackEvent = vi.fn();
const quitFn = vi.fn();
const relaunchFn = vi.fn();
const userDataRoot = vi.hoisted(() => ({ value: '' }));

vi.mock('electron-updater', () => ({
  default: { autoUpdater: mockAutoUpdater },
  autoUpdater: mockAutoUpdater,
}));

const mockNet = vi.hoisted(() => ({}) as { isOnline?: () => boolean });
vi.mock('electron', () => ({
  net: mockNet,
  autoUpdater: mockNativeUpdater,
  app: {
    getVersion: () => '2.0.0',
    getName: () => 'DNAForge',
    isPackaged: true,
    on: vi.fn(),
    quit: () => quitFn(),
    relaunch: () => relaunchFn(),
    getPath: vi.fn(() => userDataRoot.value),
  },
  BrowserWindow: vi.fn(),
  ipcMain: {
    on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
      ipcHandlers.set(channel, cb);
    }),
    handle: vi.fn((channel: string, cb: (...args: unknown[]) => unknown) => {
      ipcInvokers.set(channel, cb);
    }),
    once: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
      ipcHandlers.set(channel, cb);
    }),
    removeListener: vi.fn(),
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...args),
    showErrorBox: (...args: unknown[]) => showErrorBox(...args),
  },
}));

let telemetryDb: Database.Database | undefined;
const telemetryAuthority: AnalyticsOutboxAuthority = {
  origin: {
    consentScope: '55700000-0000-4000-8000-000000000001',
    contextId: '55700000-0000-4000-8000-000000000002',
    processId: '55700000-0000-4000-8000-000000000003',
    classification: 'private',
  },
  context: {
    distinctId: '55700000-0000-4000-8000-000000000004',
    sessionId: '55700000-0000-4000-8000-000000000005',
    kind: 'anonymous',
    generation: 1,
  },
  runtimeProperties: { telemetry_actor: 'dev' },
};
vi.mock('../analytics', async () => {
  const { putOriginBoundAnalyticsOutboxEvent } =
    await vi.importActual<typeof import('../analytics-outbox')>('../analytics-outbox');
  const captureOrigin = () => {
    try {
      const db = telemetryDb;
      if (!db) return null;
      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('analytics_consent') as { value: string } | undefined;
      return row?.value === 'true' ? telemetryAuthority.origin : null;
    } catch {
      return null;
    }
  };
  const enqueue = (
    origin: OptionalTelemetryOrigin,
    event: Parameters<typeof putOriginBoundAnalyticsOutboxEvent>[1]
  ) => {
    if (
      !telemetryDb ||
      !captureOrigin() ||
      JSON.stringify(origin) !== JSON.stringify(telemetryAuthority.origin)
    )
      return false;
    return putOriginBoundAnalyticsOutboxEvent(
      telemetryDb,
      event,
      { ...telemetryAuthority, origin },
      () => captureOrigin() !== null
    );
  };
  return {
    trackEvent: (...args: unknown[]) => trackEvent(...args),
    captureOptionalTelemetryOrigin: captureOrigin,
    enqueueOptionalAnalyticsEvent: enqueue,
    enqueueOptionalAnalyticsEventFromReceipt: (
      read: () => {
        origin: OptionalTelemetryOrigin;
        event: Parameters<typeof putOriginBoundAnalyticsOutboxEvent>[1];
      } | null
    ) => {
      const first = read();
      const second = read();
      return (
        first !== null &&
        second !== null &&
        JSON.stringify(first) === JSON.stringify(second) &&
        enqueue(first.origin, first.event)
      );
    },
  };
});

beforeEach(() => {
  telemetryDb = undefined;
  userDataRoot.value = mkdtempSync(join(tmpdir(), 'dnaforge-updater-safety-'));
  vi.clearAllMocks();
  vi.resetModules();
  mockAutoUpdater.checkForUpdates.mockReset().mockResolvedValue(null);
  mockAutoUpdater.downloadUpdate.mockReset().mockResolvedValue([]);
  mockAutoUpdater.isUserWithinRollout = vi.fn().mockResolvedValue(true);
  ipcHandlers.clear();
  ipcInvokers.clear();
  autoUpdaterEvents.clear();
  nativeUpdaterEvents.clear();
  mockNativeUpdater.checkForUpdates.mockReset().mockImplementation(() => {
    nativeUpdaterEvents.get('update-downloaded')?.();
  });
  mockAutoUpdater.autoInstallOnAppQuit = true;
  mockAutoUpdater.allowPrerelease = false;
  mockAutoUpdater.disableWebInstaller = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (userDataRoot.value) rmSync(userDataRoot.value, { recursive: true, force: true });
});

function makeMockWindow() {
  return {
    webContents: { send: vi.fn() },
    isDestroyed: () => false,
  };
}

async function telemetryDatabase() {
  const { createTestDb } = await import('./test-db');
  const { ANALYTICS_CONSENT_VERSION } = await import('@waypoint/analytics-policy');
  const db = createTestDb();
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE analytics_event_outbox (event_id TEXT PRIMARY KEY, event_name TEXT NOT NULL,
      payload_schema_version INTEGER NOT NULL, reference_kind TEXT NOT NULL, reference_id TEXT NOT NULL,
      properties_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL, send_attempts INTEGER NOT NULL,
      last_attempt_at_ms INTEGER, sent_at_ms INTEGER, origin_json TEXT);`);
  const insert = db.prepare('INSERT INTO settings VALUES (?, ?, ?)');
  insert.run('analytics_consent', 'true', Date.now());
  insert.run('analytics_consent_version', String(ANALYTICS_CONSENT_VERSION), Date.now());
  insert.run('_last_app_version', '2.0.0', Date.now());
  telemetryDb = db;
  return db;
}

describe('download episode ownership  / ', () => {
  function candidate(digest = 'controlled-candidate-digest') {
    return {
      version: '2.1.0',
      files: [{ url: 'private-installer.zip', sha512: digest, size: 128 }],
    };
  }

  it('reports how long a downloaded update has waited and whether checks were online', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T08:00:00.000Z'));
    mockNet.isOnline = () => false;
    try {
      const db = await telemetryDatabase();
      let updater = await import('../auto-updater');
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-available')!(candidate());
      autoUpdaterEvents.get('update-downloaded')!(candidate());

      vi.resetModules();
      autoUpdaterEvents.clear();
      vi.setSystemTime(new Date('2026-10-28T11:30:00.000Z'));
      trackEvent.mockClear();
      updater = await import('../auto-updater');
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-available')!(candidate());
      autoUpdaterEvents.get('update-downloaded')!(candidate());
      vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
      autoUpdaterEvents.get('update-available')!(candidate());
      const checks = trackEvent.mock.calls.filter(
        ([event]) => event === 'app_update_check_completed'
      );
      expect(checks.at(-1)?.[1]).toMatchObject({ online: false, update_waiting_minutes: 240 });
    } finally {
      delete mockNet.isOnline;
    }
  });

  it.each([true, false])(
    'keeps cancellation on the original download when a replacement arrives (consent %s)',
    async (retainConsent) => {
      vi.useFakeTimers();
      const db = await telemetryDatabase();
      try {
        const { setDirtyState } = await import('../dirty-state-cache');
        const { initAutoUpdater, installUpdate } = await import('../auto-updater');
        initAutoUpdater(makeMockWindow() as never, { database: db });
        const available = autoUpdaterEvents.get('update-available')!;
        const downloaded = autoUpdaterEvents.get('update-downloaded')!;
        const downloadOperationId = () => {
          const row = db
            .prepare('SELECT value FROM settings WHERE key = ?')
            .get('_update_download_episode') as { value: string };
          return (JSON.parse(row.value) as { operationId: string }).operationId;
        };
        const initial = candidate();
        available(initial);
        downloaded(initial);
        const original = downloadOperationId();
        setDirtyState({ hasDirtyWork: true, details: '1 page' });
        showMessageBox.mockImplementationOnce(async () => {
          const replacement = { ...candidate('replacement-digest'), version: '2.2.0' };
          available(replacement);
          downloaded(replacement);
          if (!retainConsent)
            db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
              'false',
              'analytics_consent'
            );
          return { response: 0, checkboxChecked: false };
        });

        await expect(installUpdate('2.1.0')).resolves.toMatchObject({
          status: 'failed',
          readyVersion: '2.2.0',
        });
        expect(downloadOperationId()).not.toBe(original);
        const cancellations = trackEvent.mock.calls.filter(
          ([event, properties]) =>
            event === 'app_update_restart_decided' && properties.outcome === 'cancelled'
        );
        expect(cancellations).toHaveLength(1);
        const properties = cancellations[0][1];
        expect(properties.version).toBe('2.1.0');
        if (retainConsent) expect(properties.download_operation_id).toBe(original);
        else expect(properties).not.toHaveProperty('download_operation_id');
        expect(quitFn).not.toHaveBeenCalled();
      } finally {
        db.close();
      }
    }
  );

  it('sends app_update_available once per candidate across repeat checks and relaunches', async () => {
    vi.useFakeTimers();
    const db = await telemetryDatabase();
    const available = () =>
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_available');
    let updater = await import('../auto-updater');
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    for (let check = 0; check < 3; check += 1) {
      autoUpdaterEvents.get('update-available')!(candidate());
      await vi.advanceTimersByTimeAsync(600_000);
    }
    expect(available()).toEqual([['app_update_available', { version: '2.1.0' }]]);

    vi.resetModules();
    autoUpdaterEvents.clear();
    updater = await import('../auto-updater');
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-available')!(candidate());
    expect(available()).toHaveLength(1);

    autoUpdaterEvents.get('update-available')!(candidate('next-candidate-digest'));
    expect(available()).toHaveLength(2);
  });

  it.each(['darwin', 'win32'])(
    'records one episode for three cached callbacks on %s',
    async (platform) => {
      vi.stubGlobal('process', { ...process, platform });
      vi.useFakeTimers();
      const { initAutoUpdater } = await import('../auto-updater');
      const win = makeMockWindow();
      const db = await telemetryDatabase();
      initAutoUpdater(win as never, { database: db });
      const info = candidate();
      autoUpdaterEvents.get('update-available')!(info);
      await vi.advanceTimersByTimeAsync(125);
      autoUpdaterEvents.get('update-downloaded')!(info);
      for (let i = 0; i < 2; i += 1) {
        await vi.advanceTimersByTimeAsync(600_000);
        autoUpdaterEvents.get('update-available')!(info);
        autoUpdaterEvents.get('update-downloaded')!(info);
      }
      const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
      const receipts = listPendingAnalyticsOutboxEvents(db).filter(
        (row) => row.eventName === 'app_update_downloaded'
      );
      expect(receipts).toHaveLength(1);
      expect(receipts[0].properties).toMatchObject({
        version: '2.1.0',
        operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        occurred_at_ms: expect.any(Number),
        download_duration_ms: 125,
      });
      expect(
        win.webContents.send.mock.calls.filter(([channel]) => channel === 'update:downloaded')
      ).toHaveLength(3);
      expect(JSON.stringify(receipts)).not.toMatch(/controlled-candidate-digest|private-installer/);
      db.close();
    }
  );

  it('keeps changed immutable bytes distinct even when the target version is unchanged', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { initAutoUpdater } = await import('../auto-updater');
    const db = await telemetryDatabase();
    initAutoUpdater(makeMockWindow() as never, { database: db });
    for (const digest of ['first-controlled-digest', 'second-controlled-digest']) {
      autoUpdaterEvents.get('update-available')!(candidate(digest));
      autoUpdaterEvents.get('update-downloaded')!(candidate(digest));
    }
    const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
    const receipts = listPendingAnalyticsOutboxEvents(db).filter(
      (row) => row.eventName === 'app_update_downloaded'
    );
    expect(receipts).toHaveLength(2);
    expect(receipts[0].properties.operation_id).not.toBe(receipts[1].properties.operation_id);
    db.close();
  });

  it('a failed download settles its original episode and retry admits a distinct episode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { initAutoUpdater } = await import('../auto-updater');
    const db = await telemetryDatabase();
    initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-available')!(candidate());
    autoUpdaterEvents.get('error')!(new Error('publisherName verification failed'));
    vi.setSystemTime(1001);
    autoUpdaterEvents.get('update-available')!(candidate());
    autoUpdaterEvents.get('update-downloaded')!(candidate());
    const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
    const starts = listPendingAnalyticsOutboxEvents(db)
      .filter((row) => row.eventName === 'app_update_download_started')
      .map((row) => [row.eventName, row.properties] as const);
    const failed = trackEvent.mock.calls.filter(([event]) => event === 'app_update_error');
    const ready = listPendingAnalyticsOutboxEvents(db).filter(
      (row) => row.eventName === 'app_update_downloaded'
    );
    expect(starts).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect(ready).toHaveLength(1);
    expect(failed[0][1].operation_id).toBe(starts[0][1].operation_id);
    expect(ready[0].properties.operation_id).toBe(starts[1][1].operation_id);
    expect(starts[0][1].operation_id).not.toBe(starts[1][1].operation_id);
    db.close();
  });

  it('retains one completed episode across a process restart without storing an analytics identity', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const db = await telemetryDatabase();
    let updater = await import('../auto-updater');
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-available')!(candidate());
    autoUpdaterEvents.get('update-downloaded')!(candidate());
    vi.resetModules();
    updater = await import('../auto-updater');
    const reopened = makeMockWindow();
    updater.initAutoUpdater(reopened as never, { database: db });
    autoUpdaterEvents.get('update-available')!(candidate());
    autoUpdaterEvents.get('update-downloaded')!(candidate());
    const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
    expect(
      listPendingAnalyticsOutboxEvents(db).filter(
        (row) => row.eventName === 'app_update_downloaded'
      )
    ).toHaveLength(1);
    expect(reopened.webContents.send).toHaveBeenCalledWith('update:downloaded', {
      version: '2.1.0',
    });
    const rows = db.prepare('SELECT value FROM settings').all();
    expect(JSON.stringify(rows)).not.toMatch(/session_id|person_id|account_id|distinct_id/);
    db.close();
  });

  it('does not replay a consent-denied completion when the same cached callback returns', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    trackEvent.mockReturnValue(false);
    autoUpdaterEvents.get('update-downloaded')!(candidate());
    trackEvent.mockClear().mockReturnValue(true);
    autoUpdaterEvents.get('update-downloaded')!(candidate());
    expect(
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_downloaded')
    ).toHaveLength(0);
  });

  it.each([
    { origin: 'consented', restart: false, sameTimestamp: false },
    { origin: 'consented', restart: true, sameTimestamp: false },
    { origin: 'consented', restart: false, sameTimestamp: true },
    { origin: 'consented', restart: true, sameTimestamp: true },
    { origin: 'pre-consent', restart: false, sameTimestamp: true },
    { origin: 'pre-consent', restart: true, sameTimestamp: true },
    { origin: 'valid', restart: false, sameTimestamp: true },
    { origin: 'valid', restart: true, sameTimestamp: true },
  ])(
    'retains product timing/dedup but requires current download authority: $origin / restart=$restart / same-ms=$sameTimestamp',
    async ({ origin, restart, sameTimestamp }) => {
      vi.stubGlobal('process', { ...process, platform: 'win32' });
      vi.useFakeTimers();
      const db = await telemetryDatabase();
      const { listPendingAnalyticsOutboxEvents, purgeAnalyticsOutbox } =
        await import('../analytics-outbox');
      const consent = db
        .prepare('SELECT updated_at FROM settings WHERE key = ?')
        .get('analytics_consent') as { updated_at: number };
      if (origin === 'pre-consent')
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'analytics_consent');
      let updater = await import('../auto-updater');
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-available')!(candidate());
      await vi.advanceTimersByTimeAsync(125);
      autoUpdaterEvents.get('update-downloaded')!(candidate());
      const marker = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('_update_download_episode') as { value: string };
      const episode = JSON.parse(marker.value) as {
        operationId: string;
        startedAtMs: number;
        completedAtMs: number;
      };
      expect(episode.completedAtMs - episode.startedAtMs).toBe(125);
      if (origin !== 'valid') {
        db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('false', 'analytics_consent');
        purgeAnalyticsOutbox(db);
        db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?').run(
          'true',
          consent.updated_at + (sameTimestamp ? 0 : 1),
          'analytics_consent'
        );
      }
      trackEvent.mockClear();
      if (restart) {
        vi.resetModules();
        updater = await import('../auto-updater');
        updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      }
      for (let i = 0; i < 3; i += 1) {
        autoUpdaterEvents.get('update-available')!(candidate());
        autoUpdaterEvents.get('update-downloaded')!(candidate());
      }
      expect(
        db.prepare('SELECT value FROM settings WHERE key = ?').get('_update_download_episode')
      ).toEqual(marker);
      expect(trackEvent.mock.calls.filter(([event]) => event === 'app_update_downloaded')).toEqual(
        []
      );
      expect(await updater.installUpdate()).toEqual({ status: 'started' });
      expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
      const starts = listPendingAnalyticsOutboxEvents(db).filter(
        (row) => row.eventName === 'app_update_install_attempt'
      );
      expect(starts).toHaveLength(1);
      const decisions = trackEvent.mock.calls.filter(
        ([event]) => event === 'app_update_restart_decided'
      );
      expect(decisions).toHaveLength(1);
      if (origin === 'valid') {
        expect(starts[0].properties.download_operation_id).toBe(episode.operationId);
        expect(decisions[0][1].download_operation_id).toBe(episode.operationId);
        expect(
          listPendingAnalyticsOutboxEvents(db).filter(
            (row) => row.eventName === 'app_update_download_started'
          )
        ).toHaveLength(1);
      } else {
        expect(starts[0].properties).not.toHaveProperty('download_operation_id');
        expect(decisions[0][1]).not.toHaveProperty('download_operation_id');
        expect(JSON.stringify(starts.map((row) => row.properties))).not.toContain(
          episode.operationId
        );
        expect(JSON.stringify(trackEvent.mock.calls)).not.toContain(episode.operationId);
        expect(
          listPendingAnalyticsOutboxEvents(db).filter((row) =>
            row.eventName.startsWith('app_update_download')
          )
        ).toEqual([]);
      }
      db.close();
    }
  );

  it('keeps restart ready when the episode settings cannot be written', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    db.pragma('query_only = ON');
    const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never, { database: db });
    autoUpdaterEvents.get('update-available')!(candidate());
    expect(() => autoUpdaterEvents.get('update-downloaded')!(candidate())).not.toThrow();
    expect(isUpdateDownloaded()).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith('update:downloaded', { version: '2.1.0' });
    db.close();
  });

  it.each([
    { origin: 'valid', restart: false },
    { origin: 'valid', restart: true },
    { origin: 'revoked', restart: false },
    { origin: 'revoked', restart: true },
    { origin: 'pre-consent', restart: false },
    { origin: 'pre-consent', restart: true },
  ])(
    'keeps the force-updater first-completion lineage only with its original receipt: $origin / restart=$restart',
    async ({ origin, restart }) => {
      vi.stubGlobal('process', {
        ...process,
        platform: 'win32',
        env: { ...process.env, WAYPOINT_FORCE_UPDATER: '1' },
      });
      vi.useFakeTimers();
      const db = await telemetryDatabase();
      const electron = await import('electron');
      const wasPackaged = electron.app.isPackaged;
      Object.defineProperty(electron.app, 'isPackaged', { value: false, configurable: true });
      try {
        if (origin === 'pre-consent')
          db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
            'false',
            'analytics_consent'
          );
        let updater = await import('../auto-updater');
        updater.initAutoUpdater(makeMockWindow() as never, { database: db });
        expect(mockAutoUpdater.autoDownload).toBe(false);
        autoUpdaterEvents.get('update-available')!(candidate());
        const marker = db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('_update_download_episode') as { value: string };
        const episode = JSON.parse(marker.value) as { operationId: string; startedAtMs: number };
        if (origin !== 'valid') {
          const { purgeAnalyticsOutbox } = await import('../analytics-outbox');
          db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
            'false',
            'analytics_consent'
          );
          purgeAnalyticsOutbox(db);

          db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
            'true',
            'analytics_consent'
          );
        }
        if (restart) {
          vi.resetModules();
          updater = await import('../auto-updater');
          updater.initAutoUpdater(makeMockWindow() as never, { database: db });
          expect(mockAutoUpdater.autoDownload).toBe(false);
          autoUpdaterEvents.get('update-available')!(candidate());
        }
        await vi.advanceTimersByTimeAsync(125);
        autoUpdaterEvents.get('update-downloaded')!(candidate());
        autoUpdaterEvents.get('update-downloaded')!(candidate());
        const receipts = trackEvent.mock.calls.filter(
          ([event]) => event === 'app_update_downloaded'
        );
        expect(
          trackEvent.mock.calls.filter(([event]) => event === 'app_update_download_started')
        ).toEqual([]);
        expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
        const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
        const rows = listPendingAnalyticsOutboxEvents(db);
        const install = rows.filter((row) => row.eventName === 'app_update_install_attempt');
        expect(install).toHaveLength(1);
        if (origin === 'valid') {
          const downloaded = rows.filter((row) => row.eventName === 'app_update_downloaded');
          expect(downloaded).toHaveLength(1);
          expect(downloaded[0]).toMatchObject({
            properties: {
              operation_id: episode.operationId,
              download_duration_ms: 125,
              origin_started_at_ms: episode.startedAtMs,
              $insert_id: downloaded[0].eventId,
            },
          });
          expect(downloaded[0].eventId).not.toBe(episode.operationId);
          expect(receipts).toEqual([]);
          expect(install[0].properties.download_operation_id).toBe(episode.operationId);
          expect(rows.filter((row) => row.eventName === 'app_update_available')).toHaveLength(1);
        } else {
          expect(receipts).toHaveLength(1);
          expect(receipts[0][1]).not.toHaveProperty('operation_id');
          expect(install[0].properties).not.toHaveProperty('download_operation_id');
          expect(JSON.stringify(rows.map((row) => row.properties))).not.toContain(
            episode.operationId
          );
        }
        const retained = db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('_update_download_episode') as { value: string };
        expect(JSON.parse(retained.value)).toMatchObject({
          operationId: episode.operationId,
          startedAtMs: episode.startedAtMs,
          completedAtMs: episode.startedAtMs + 125,
        });
      } finally {
        Object.defineProperty(electron.app, 'isPackaged', {
          value: wasPackaged,
          configurable: true,
        });
        db.close();
      }
    }
  );
});

describe('accepted updater operation provenance ', () => {
  it('two authority failures plus fallback success remain one admitted check and one terminal', async () => {
    vi.doMock('../update-authority', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../update-authority')>()),
      resolveUpdateFeedUrls: () => [
        'https://one.invalid',
        'https://two.invalid',
        'https://three.invalid',
      ],
    }));
    try {
      const { initAutoUpdater } = await import('../auto-updater');
      initAutoUpdater(makeMockWindow() as never);
      mockAutoUpdater.checkForUpdates
        .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
        .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
        .mockImplementationOnce(async () => {
          autoUpdaterEvents.get('update-available')!({ version: '2.1.0' });
          return null;
        });
      await ipcInvokers.get('update:check-manual')!();
      const starts = trackEvent.mock.calls.filter(
        ([event]) => event === 'app_update_check_started'
      );
      const terminals = trackEvent.mock.calls.filter(
        ([event]) => event === 'app_update_check_completed'
      );
      const origins = trackEvent.mock.calls.filter(
        ([event]) => event === 'app_update_origin_failed'
      );
      expect(starts).toHaveLength(1);
      expect(terminals).toHaveLength(1);
      expect(terminals[0][1]).toMatchObject({
        success: true,
        operation_id: starts[0][1].operation_id,
      });
      expect(origins).toHaveLength(2);
      expect(origins.map(([, props]) => props.operation_id)).toEqual([
        starts[0][1].operation_id,
        starts[0][1].operation_id,
      ]);
      expect(trackEvent.mock.calls.filter(([event]) => event === 'app_update_error')).toEqual([]);
    } finally {
      vi.doUnmock('../update-authority');
    }
  });

  it('preserves the interrupted install intent when the fixture clears downloaded state and quits', async () => {
    const db = await telemetryDatabase();
    try {
      const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
      const updater = await import('../auto-updater');
      const { handleBeforeQuit } = await import('../quit-orchestration');
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
      expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
      const intentPath = join(userDataRoot.value, 'update-install-intent.json');
      const persisted = readFileSync(intentPath);
      const start = listPendingAnalyticsOutboxEvents(db)[0];

      updater._setUpdateDownloadedForTest(false);
      const quit = await handleBeforeQuit({
        mainWindow: null,
        freezeRenderer: vi.fn(),
        restoreRenderer: vi.fn(),
        killSidecar: vi.fn(),
        closeDatabase: vi.fn(),
        trackAppClosed: vi.fn(),
        shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
        quitApp: quitFn,
        requestSaveAll: vi.fn(),
      });

      expect(quit).toEqual({ cancelled: false });
      expect(readFileSync(intentPath)).toEqual(persisted);
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      vi.resetModules();
      (await import('../auto-updater')).checkForVersionUpgrade(db);
      expect(listPendingAnalyticsOutboxEvents(db).map(({ properties }) => properties)).toEqual([
        expect.objectContaining({
          operation_id: start.properties.operation_id,
          action_phase: 'start',
        }),
        expect.objectContaining({
          operation_id: start.properties.operation_id,
          error_code: 'same_version_relaunch',
        }),
      ]);
    } finally {
      db.close();
    }
  });

  it('same-version boot settles the original native intent once and a retry has a distinct parented identity', async () => {
    const db = await telemetryDatabase();
    const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
    let updater = await import('../auto-updater');
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
    const first = listPendingAnalyticsOutboxEvents(db)[0];
    expect(first.properties.action_phase).toBe('start');
    expect(updater.quitAndInstall()).toEqual({ status: 'started' });
    vi.resetModules();
    updater = await import('../auto-updater');
    updater.checkForVersionUpgrade(db);
    updater.checkForVersionUpgrade(db);
    const rows = listPendingAnalyticsOutboxEvents(db);
    expect(rows).toHaveLength(2);
    expect(rows[1].properties).toMatchObject({
      operation_id: first.properties.operation_id,
      action_phase: 'error',
      error_code: 'same_version_relaunch',
      outcome: 'failed',
      origin_boot_id: first.properties.origin_boot_id,
    });
    expect(rows[1].properties.update_boot_id).not.toBe(first.properties.origin_boot_id);
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
    const retry = listPendingAnalyticsOutboxEvents(db).find(
      (row) => row.properties.retry_parent_attempt_id === first.properties.operation_id
    );
    expect(retry?.properties.operation_id).not.toBe(first.properties.operation_id);
    expect(retry?.properties.action_phase).toBe('start');
    db.close();
  });

  it('retains a retry cancellation requested during an active SQLite query', async () => {
    const db = await telemetryDatabase();
    try {
      const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
      let updater = await import('../auto-updater');
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
      expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
      const original = listPendingAnalyticsOutboxEvents(db)[0];
      vi.resetModules();
      updater = await import('../auto-updater');
      updater.checkForVersionUpgrade(db);
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
      expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });

      const retry = listPendingAnalyticsOutboxEvents(db).find(
        ({ properties }) => properties.retry_parent_attempt_id === original.properties.operation_id
      );
      expect(retry?.properties.action_phase).toBe('start');

      const cancellations: Promise<void>[] = [];
      db.function('request_cancel', () => {
        cancellations.push(updater._cancelUpdateInstallIntentForTest());
        return 1;
      });
      expect(db.prepare('SELECT request_cancel() AS requested').get()).toEqual({ requested: 1 });
      expect(listPendingAnalyticsOutboxEvents(db)).toHaveLength(3);
      expect(cancellations).toHaveLength(1);
      await Promise.all(cancellations);

      expect(
        listPendingAnalyticsOutboxEvents(db).map(({ properties }) => properties)
      ).toContainEqual(
        expect.objectContaining({
          operation_id: retry?.properties.operation_id,
          retry_parent_attempt_id: original.properties.operation_id,
          action_phase: 'cancel',
          outcome: 'cancelled',
          error_code: 'quit_cancelled',
        })
      );
    } finally {
      db.close();
    }
  });

  it('an unrelated version boot cannot reuse the old install attempt as a retry parent', async () => {
    const db = await telemetryDatabase();
    const electron = await import('electron');
    const version = vi.spyOn(electron.app, 'getVersion').mockReturnValue('1.9.0');
    try {
      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('1.9.0', '_last_app_version');
      const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
      let updater = await import('../auto-updater');
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
      expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
      const [original] = listPendingAnalyticsOutboxEvents(db);
      const intentPath = join(userDataRoot.value, 'update-install-intent.json');
      expect(existsSync(intentPath)).toBe(true);

      version.mockReturnValue('2.0.0');
      vi.resetModules();
      updater = await import('../auto-updater');
      updater.checkForVersionUpgrade(db);
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
      expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });

      const rows = listPendingAnalyticsOutboxEvents(db);
      expect(rows).toHaveLength(2);
      const [, next] = rows;
      expect(next.properties.action_phase).toBe('start');
      expect(next.properties.operation_id).not.toBe(original.properties.operation_id);
      expect(next.properties).not.toHaveProperty('retry_parent_attempt_id');
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(intentPath, 'utf8'))).toMatchObject({
        fromVersion: '2.0.0',
        targetVersion: '2.1.0',
      });
    } finally {
      version.mockRestore();
      db.close();
    }
  });

  it('uses the boot ID when a download marker proves an install outside the retained intent', async () => {
    const db = await telemetryDatabase();
    const electron = await import('electron');
    const version = vi.spyOn(electron.app, 'getVersion');
    try {
      let updater = await import('../auto-updater');
      updater.initAutoUpdater(makeMockWindow() as never, { database: db });
      autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
      expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
      const original = JSON.parse(
        readFileSync(join(userDataRoot.value, 'update-install-intent.json'), 'utf8')
      );
      expect(original.measurement.launchEventId).toMatch(/^[0-9a-f-]{36}$/);

      db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(
        '2.2.0',
        '_downloaded_update_target'
      );
      version.mockReturnValue('2.2.0');
      vi.resetModules();
      updater = await import('../auto-updater');
      updater.checkForVersionUpgrade(db);

      const receipts = trackEvent.mock.calls.filter(([event]) => event === 'app_update_installed');
      expect(receipts).toHaveLength(1);
      const [, receipt] = receipts[0];
      expect(receipt).toMatchObject({
        from_version: '2.0.0',
        to_version: '2.2.0',
        update_qualification: 'exact_download_marker',
      });
      expect(receipt).not.toHaveProperty('operation_id');
      expect(receipt.$insert_id).not.toBe(original.measurement.launchEventId);
      expect(receipt.$insert_id).toBe(receipt.update_boot_id);
    } finally {
      version.mockRestore();
      db.close();
    }
  });

  it('new-version boot settles the matching native intent once with explicit qualification', async () => {
    const db = await telemetryDatabase();
    const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
    let updater = await import('../auto-updater');
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    updater.prepareUpdateInstallIntent();
    const start = listPendingAnalyticsOutboxEvents(db)[0];
    updater.quitAndInstall();
    const electron = await import('electron');
    const version = vi.spyOn(electron.app, 'getVersion').mockReturnValue('2.1.0');
    try {
      vi.resetModules();
      updater = await import('../auto-updater');
      updater.checkForVersionUpgrade(db);
      updater.checkForVersionUpgrade(db);
      expect(listPendingAnalyticsOutboxEvents(db)).toHaveLength(2);
      expect(listPendingAnalyticsOutboxEvents(db)[1].properties).toMatchObject({
        operation_id: start.properties.operation_id,
        action_phase: 'commit',
        outcome: 'succeeded',
        error_code: 'version_advanced',
      });
      const installed = trackEvent.mock.calls.filter(([event]) => event === 'app_update_installed');
      expect(installed).toHaveLength(1);
      expect(installed[0][1]).toMatchObject({
        operation_id: start.properties.operation_id,
        update_qualification: 'exact_install_intent',
      });
      expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(false);
    } finally {
      version.mockRestore();
      db.close();
    }
  });

  it('does not attach revoked origin correlation to a later same-version recovery receipt', async () => {
    const db = await telemetryDatabase();
    const { listPendingAnalyticsOutboxEvents, purgeAnalyticsOutbox } =
      await import('../analytics-outbox');
    let updater = await import('../auto-updater');
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    updater.prepareUpdateInstallIntent();
    const start = listPendingAnalyticsOutboxEvents(db)[0];
    purgeAnalyticsOutbox(db);
    vi.resetModules();
    updater = await import('../auto-updater');
    updater.checkForVersionUpgrade(db);
    const recovery = trackEvent.mock.calls.find(
      ([event, props]) =>
        event === 'app_update_error' && props.error_code === 'same_version_relaunch'
    );
    expect(recovery).toBeDefined();
    expect(recovery?.[1]).not.toHaveProperty('operation_id');
    expect(recovery?.[1]).not.toHaveProperty('origin_boot_id');
    expect(JSON.stringify(recovery?.[1])).not.toContain(start.properties.operation_id);
    expect(listPendingAnalyticsOutboxEvents(db)).toEqual([]);
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
    const retry = listPendingAnalyticsOutboxEvents(db);
    expect(retry).toHaveLength(1);
    expect(retry[0].properties.operation_id).not.toBe(start.properties.operation_id);
    expect(retry[0].properties).not.toHaveProperty('retry_parent_attempt_id');
    expect(JSON.stringify(retry[0].properties)).not.toContain(start.properties.operation_id);
    db.close();
  });

  it('does not reuse a purged in-memory retry parent after cancellation clears the intent', async () => {
    const db = await telemetryDatabase();
    const { listPendingAnalyticsOutboxEvents, purgeAnalyticsOutbox } =
      await import('../analytics-outbox');
    const updater = await import('../auto-updater');
    updater.initAutoUpdater(makeMockWindow() as never, { database: db });
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
    const start = listPendingAnalyticsOutboxEvents(db)[0];
    updater.restoreDownloadedUpdateAfterQuitCancellation();
    expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(false);

    purgeAnalyticsOutbox(db);
    expect(updater.prepareUpdateInstallIntent()).toEqual({ status: 'started' });
    const retry = listPendingAnalyticsOutboxEvents(db);
    expect(retry).toHaveLength(1);
    expect(retry[0].properties.operation_id).not.toBe(start.properties.operation_id);
    expect(retry[0].properties).not.toHaveProperty('retry_parent_attempt_id');
    expect(JSON.stringify(retry[0].properties)).not.toContain(start.properties.operation_id);
    db.close();
  });
});

describe('macOS restart preparation', () => {
  beforeEach(() => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' });
  });

  it('refuses shutdown before touching services when the accepted intent cannot be persisted', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    initAutoUpdater(makeMockWindow() as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    const originalRoot = userDataRoot.value;
    userDataRoot.value = join(originalRoot, 'not-a-directory');
    writeFileSync(userDataRoot.value, 'controlled profile refusal');
    const killSidecar = vi.fn();
    const closeDatabase = vi.fn();
    const restoreRenderer = vi.fn();
    try {
      expect(
        await handleBeforeQuit({
          mainWindow: makeMockWindow() as never,
          freezeRenderer: vi.fn(),
          restoreRenderer,
          killSidecar,
          closeDatabase,
          trackAppClosed: vi.fn(),
          shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
          quitApp: quitFn,
          requestSaveAll: vi.fn(),
        })
      ).toEqual({ cancelled: true });
      expect(killSidecar).not.toHaveBeenCalled();
      expect(closeDatabase).not.toHaveBeenCalled();
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(restoreRenderer).toHaveBeenCalledOnce();
    } finally {
      userDataRoot.value = originalRoot;
    }
  });

  it('finishes the staged restart after a later teardown failure instead of restoring stopped services', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    initAutoUpdater(makeMockWindow() as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    const restoreRenderer = vi.fn();
    const stopStatus = vi.fn();
    const killSidecar = vi.fn().mockResolvedValue(undefined);
    const result = await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer,
      showUpdateStatus: vi.fn().mockResolvedValue(stopStatus),
      killSidecar,
      closeDatabase: vi.fn().mockRejectedValue(new Error('Late service cleanup failed')),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });
    expect(killSidecar).toHaveBeenCalledOnce();
    expect(result).toEqual({ cancelled: false });
    expect(restoreRenderer).not.toHaveBeenCalled();
    expect(stopStatus).not.toHaveBeenCalled();
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledOnce();
    expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(true);
  });
  it('waits for visible update status before hiding the app and retains it across successful exit', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    initAutoUpdater(makeMockWindow() as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    const order: string[] = [];
    const statusStarted = Promise.withResolvers<void>();
    let resolveShown!: (stop: () => void) => void;
    const stop = vi.fn();
    const quitting = handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      showUpdateStatus: async (version) => {
        expect(version).toBe('2.1.0');
        order.push('starting');
        statusStarted.resolve();
        return new Promise((resolve) => {
          resolveShown = resolve;
        });
      },
      concealRenderer: () => {
        order.push('concealed');
      },
      killSidecar: () => {
        order.push('stopped');
      },
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });
    await statusStarted.promise;
    expect(order).toEqual(['starting']);
    resolveShown(stop);
    expect(await quitting).toEqual({ cancelled: false });
    expect(order).toEqual(['starting', 'concealed', 'stopped']);
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not create update status when unsaved-work cancellation keeps the app running', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const { setDirtyState } = await import('../dirty-state-cache');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    initAutoUpdater(makeMockWindow() as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    setDirtyState({ hasDirtyWork: true, details: 'unsaved page' });
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const showUpdateStatus = vi.fn();
    const result = await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      showUpdateStatus,
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });
    expect(result).toEqual({ cancelled: true });
    expect(showUpdateStatus).not.toHaveBeenCalled();
  });
  it('prepares the native update while the product remains usable and offers restart only afterward', async () => {
    mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
    const { initAutoUpdater, isUpdateDownloaded, installUpdate } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });

    expect(mockNativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(isUpdateDownloaded()).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalledWith('update:downloaded', expect.anything());
    await expect(installUpdate()).resolves.toMatchObject({ status: 'failed' });
    expect(quitFn).not.toHaveBeenCalled();
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    nativeUpdaterEvents.get('update-downloaded')!();

    expect(isUpdateDownloaded()).toBe(true);
    expect(win.webContents.send).toHaveBeenCalledWith('update:downloaded', { version: '2.1.0' });
    expect(nativeUpdaterEvents.has('update-downloaded')).toBe(false);
  });

  it('shows current download progress when a manual check joins an automatic download without restarting it', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    autoUpdaterEvents.get('update-available')!({ version: '2.1.0' });
    autoUpdaterEvents.get('download-progress')!({ percent: 42, bytesPerSecond: 1234 });
    win.webContents.send.mockClear();

    await ipcInvokers.get('update:check-manual')!();

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('update:available', {
      version: '2.1.0',
      isManual: true,
    });
    expect(win.webContents.send).toHaveBeenLastCalledWith('update:progress', {
      percent: 42,
      bytesPerSecond: 1234,
    });
    expect(win.webContents.send).not.toHaveBeenCalledWith('update:downloaded', expect.anything());
  });

  it('shows preparation when a manual check joins native verification and keeps restart unavailable', async () => {
    mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
    const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    win.webContents.send.mockClear();

    await ipcInvokers.get('update:check-manual')!();

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mockNativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith('update:available', {
      version: '2.1.0',
      isManual: true,
    });
    expect(win.webContents.send).toHaveBeenLastCalledWith('update:progress', {
      percent: 100,
      bytesPerSecond: 0,
    });
    expect(isUpdateDownloaded()).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalledWith('update:downloaded', expect.anything());
  });

  it('keeps restart unavailable after native verification fails and ignores its stale completion', async () => {
    mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
    const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    const staleCompletion = nativeUpdaterEvents.get('update-downloaded');

    autoUpdaterEvents.get('error')!(new Error('The update code signature is invalid'));
    staleCompletion?.();

    expect(mockNativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(isUpdateDownloaded()).toBe(false);
    expect(win.webContents.send).not.toHaveBeenCalledWith('update:downloaded', expect.anything());
    expect(quitFn).not.toHaveBeenCalled();
    expect(relaunchFn).not.toHaveBeenCalled();
  });

  it('does not repeat native preparation for a duplicate cached-download event', async () => {
    mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
    const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    const info = { version: '2.1.0', files: [{ sha512: 'candidate-digest', size: 123 }] };
    autoUpdaterEvents.get('update-downloaded')!(info);
    autoUpdaterEvents.get('update-downloaded')!({ ...info });
    expect(mockNativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(isUpdateDownloaded()).toBe(false);
    nativeUpdaterEvents.get('update-downloaded')!();
    expect(isUpdateDownloaded()).toBe(true);
  });

  it('keeps a prepared candidate ready when a periodic check reuses the same cached download', async () => {
    const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    const info = { version: '2.1.0', files: [{ sha512: 'candidate-digest', size: 123 }] };
    autoUpdaterEvents.get('update-downloaded')!(info);
    expect(isUpdateDownloaded()).toBe(true);
    mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
    autoUpdaterEvents.get('update-downloaded')!({ ...info });
    expect(mockNativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(isUpdateDownloaded()).toBe(true);
  });

  it('returns the prepared restart action on a manual recheck without resetting the native feed', async () => {
    const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    expect(isUpdateDownloaded()).toBe(true);
    await ipcInvokers.get('update:check-manual')!();
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mockNativeUpdater.checkForUpdates).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenLastCalledWith('update:downloaded', {
      version: '2.1.0',
    });
  });

  it('leaves the product running when the native preparation call throws', async () => {
    mockNativeUpdater.checkForUpdates.mockImplementation(() => {
      throw new Error('Squirrel preparation refused');
    });
    const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    expect(isUpdateDownloaded()).toBe(false);
    expect(nativeUpdaterEvents.has('update-downloaded')).toBe(false);
    expect(quitFn).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'download' })
    );
  });

  it('preserves asynchronous native preparation errors without retaining secret URLs', async () => {
    mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    const failure = new Error(
      'ECONNRESET https://updates.example.test/file?signature=private-value token=secret-value'
    );
    autoUpdaterEvents.get('error')!(failure);
    expect(trackEvent).toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({ stage: 'download', version: '2.1.0' })
    );
    const log = readFileSync(join(userDataRoot.value, 'logs', 'main-boot.log'), 'utf8');
    expect(log).toContain('"operation":"native-preparation"');
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ operation: 'native-preparation' })
    );
    expect(log).toContain('ECONNRESET');
    expect(log).not.toContain('private-value');
    expect(log).not.toContain('secret-value');
  });

  it('preserves the native preparation target and durable failure diagnosis', async () => {
    vi.useFakeTimers();
    mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(trackEvent).toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({ stage: 'download', version: '2.1.0' })
    );
    const log = readFileSync(join(userDataRoot.value, 'logs', 'main-boot.log'), 'utf8');
    expect(log).toContain('update_failure ');
    expect(log).toContain('"targetVersion":"2.1.0"');
    expect(log).toContain('Native update preparation timed out.');
  });

  it('bounds missing native readiness without quitting or accepting a late completion', async () => {
    vi.useFakeTimers();
    mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
    const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    const lateCompletion = nativeUpdaterEvents.get('update-downloaded');
    await vi.advanceTimersByTimeAsync(120_000);
    lateCompletion?.();
    expect(isUpdateDownloaded()).toBe(false);
    expect(quitFn).not.toHaveBeenCalled();
    expect(nativeUpdaterEvents.has('update-downloaded')).toBe(false);
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'download' })
    );
  });

  it.each(['ready', 'pending', 'timed out'])(
    'keeps the old macOS process and database open when shutdown fails after native preparation is %s',
    async (state) => {
      if (state !== 'ready') mockNativeUpdater.checkForUpdates.mockImplementation(() => undefined);
      if (state === 'timed out') vi.useFakeTimers();
      const { initAutoUpdater, isUpdateDownloaded } = await import('../auto-updater');
      const { setDirtyState } = await import('../dirty-state-cache');
      const { handleBeforeQuit } = await import('../quit-orchestration');
      const win = makeMockWindow();
      initAutoUpdater(win as never);
      autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
      if (state === 'timed out') await vi.advanceTimersByTimeAsync(120_000);
      setDirtyState({ hasDirtyWork: false, details: '' });
      const closeDatabase = vi.fn();
      const restoreRenderer = vi.fn();
      const trackAppClosed = vi.fn();
      const stopUpdateStatus = vi.fn();
      const result = await handleBeforeQuit({
        mainWindow: win as never,
        freezeRenderer: vi.fn(),
        restoreRenderer,
        showUpdateStatus: vi.fn().mockResolvedValue(stopUpdateStatus),
        killSidecar: vi.fn().mockRejectedValue(new Error('An owned sidecar did not stop')),
        closeDatabase,
        trackAppClosed,
        shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
        quitApp: quitFn,
        requestSaveAll: vi.fn(),
      });
      expect(result).toEqual({ cancelled: true });
      expect(restoreRenderer).toHaveBeenCalledOnce();
      expect(closeDatabase).not.toHaveBeenCalled();
      expect(trackAppClosed).not.toHaveBeenCalled();
      expect(quitFn).not.toHaveBeenCalled();
      expect(relaunchFn).not.toHaveBeenCalled();
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(isUpdateDownloaded()).toBe(state === 'ready');
      expect(stopUpdateStatus).toHaveBeenCalledTimes(state === 'ready' ? 1 : 0);
      expect(win.webContents.send).toHaveBeenCalledWith(
        'update:error',
        expect.objectContaining({ stage: 'install' })
      );
      if (state === 'ready') {
        expect(win.webContents.send).toHaveBeenLastCalledWith('update:downloaded', {
          version: '2.1.0',
        });
      }
    }
  );

  it('finishes a prepared update when database close throws after the worker has stopped', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const { setDirtyState } = await import('../dirty-state-cache');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    initAutoUpdater(makeMockWindow() as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    setDirtyState({ hasDirtyWork: false, details: '' });
    const restoreRenderer = vi.fn();
    const result = await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer,
      killSidecar: vi.fn(),
      closeDatabase: vi.fn().mockRejectedValue(new Error('Database close failed')),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });
    expect(result).toEqual({ cancelled: false });
    expect(restoreRenderer).not.toHaveBeenCalled();
    expect(quitFn).not.toHaveBeenCalled();
    expect(relaunchFn).not.toHaveBeenCalled();
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledOnce();
  });
});

describe('Beta channel (allowPrerelease)', () => {
  it('stable by default — allowPrerelease stays false without opts', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
  });

  it('opts.allowPrerelease=true opts the installation into prereleases', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never, { allowPrerelease: true });
    expect(mockAutoUpdater.allowPrerelease).toBe(true);
  });

  it('opts.allowPrerelease=false keeps the stable channel', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never, { allowPrerelease: false });
    expect(mockAutoUpdater.allowPrerelease).toBe(false);
  });
});

describe('Task 2: Unsaved-work guard', () => {
  it('flushes install-intent bytes before rename and directory metadata after rename', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/auto-updater.ts'), 'utf8');
    const functionStart = source.indexOf('function persistInstallIntent(');
    const functionEnd = source.indexOf('\nfunction clearInstallIntent(', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);

    const body = source.slice(functionStart, functionEnd);
    const fileFlush = body.indexOf('fsyncSync(temporaryFd)');
    const rename = body.indexOf('renameSync(temporary, destination)');
    const directoryOpen = body.indexOf('openSync(dirname(destination), fsConstants.O_RDONLY)');
    const directoryFlush = body.indexOf('fsyncSync(directoryFd)');
    expect(fileFlush).toBeGreaterThanOrEqual(0);
    expect(rename).toBeGreaterThan(fileFlush);
    expect(directoryOpen).toBeGreaterThan(rename);
    expect(directoryFlush).toBeGreaterThan(directoryOpen);
  });

  it('2.1 autoInstallOnAppQuit is set to false', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
    expect(mockAutoUpdater.disableWebInstaller).toBe(true);
  });

  it('2.2 installUpdate requests ordinary quit before the central guard authorizes native install', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater, installUpdate, _setUpdateDownloadedForTest } =
      await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: false, details: '' });

    await expect(installUpdate()).resolves.toEqual({ status: 'started' });
    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(false);
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('2.3 installUpdate shows a 2-button dialog when dirty pages exist (no fake Save All)', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater, installUpdate, _setUpdateDownloadedForTest } =
      await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: true, details: '2 unsaved pages' });

    await installUpdate();
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    const opts = showMessageBox.mock.calls[0].at(-1);
    expect(opts.buttons).toEqual(['Cancel', 'Restart Anyway']);
    expect(opts.defaultId).toBe(0);
    expect(opts.cancelId).toBe(0);
    expect(opts.message).toContain('2 unsaved pages');
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("2.4 'Restart Anyway' authorizes ordinary quit without starting the native installer early", async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater, installUpdate, _setUpdateDownloadedForTest } =
      await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: true, details: '1 page' });

    await expect(installUpdate()).resolves.toEqual({ status: 'started' });
    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not use an open restart dialog to authorize a replacement download', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater, installUpdate, getDownloadedVersion } =
      await import('../auto-updater');
    const { hasQuitConsent } = await import('../quit-orchestration');
    initAutoUpdater(makeMockWindow() as never);
    const downloaded = autoUpdaterEvents.get('update-downloaded')!;
    downloaded({ version: '2.1.0', files: [{ sha512: 'initial-candidate', size: 123 }] });
    setDirtyState({ hasDirtyWork: true, details: '1 page' });
    showMessageBox.mockImplementationOnce(async () => {
      downloaded({ version: '2.2.0', files: [{ sha512: 'replacement-candidate', size: 456 }] });
      return { response: 1, checkboxChecked: false };
    });

    await installUpdate();
    expect(showMessageBox).toHaveBeenCalledOnce();
    expect(getDownloadedVersion()).toBe('2.2.0');
    expect(quitFn).not.toHaveBeenCalled();
    expect(hasQuitConsent()).toBe(false);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('does not switch the accepted installer if a replacement arrives during shutdown', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater } = await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    const downloaded = autoUpdaterEvents.get('update-downloaded')!;
    downloaded({ version: '2.1.0', files: [{ sha512: 'initial-candidate', size: 123 }] });
    setDirtyState({ hasDirtyWork: false, details: '' });
    const relaunchApp = vi.fn();
    await handleBeforeQuit({
      mainWindow: win as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: () => {
        downloaded({ version: '2.2.0', files: [{ sha512: 'replacement-candidate', size: 456 }] });
      },
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
      relaunchApp,
    });

    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(relaunchApp).toHaveBeenCalledOnce();
  });

  it("2.5 'Cancel' returns without installing", async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater, installUpdate, _setUpdateDownloadedForTest } =
      await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: true, details: '1 page' });

    await expect(installUpdate()).resolves.toEqual({ status: 'cancelled' });
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('2.5b installUpdate sets quitConsent so before-quit does not re-prompt', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater, installUpdate, _setUpdateDownloadedForTest } =
      await import('../auto-updater');
    const { hasQuitConsent } = await import('../quit-orchestration');
    initAutoUpdater(makeMockWindow() as never);
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: true, details: '1 page' });

    expect(hasQuitConsent()).toBe(false);
    await installUpdate();
    expect(hasQuitConsent()).toBe(true);
  });

  it('2.6 dirty state cache updates from ipcMain.on handler', async () => {
    const mod = await import('../dirty-state-cache');
    mod.registerDirtyStateHandler();
    const handler = ipcHandlers.get('app:dirtyStateChanged');
    expect(handler).toBeDefined();

    handler!(
      {},
      {
        hasDirtyWork: true,
        details: '1 page, 2 sequences, 1 document',
        dirtyPageIds: ['page-a'],
        dirtySequenceDocumentIds: ['sequence-document-a', 'sequence-document-b'],
        dirtyTabIds: ['assembly-tab'],
      }
    );
    expect(mod.getDirtyState()).toEqual({
      hasDirtyWork: true,
      details: '1 page, 2 sequences, 1 document',
      dirtyPageIds: ['page-a'],
      dirtySequenceDocumentIds: ['sequence-document-a', 'sequence-document-b'],
      dirtyTabIds: ['assembly-tab'],
    });
  });

  it('2.7 dirty state cache clears when all work is saved', async () => {
    const mod = await import('../dirty-state-cache');
    mod.setDirtyState({ hasDirtyWork: true, details: 'work' });
    mod.setDirtyState({ hasDirtyWork: false, details: '' });
    expect(mod.getDirtyState().hasDirtyWork).toBe(false);
  });

  it('2.8 before-quit with updateDownloaded + clean state calls quitAndInstall', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { _setUpdateDownloadedForTest } = await import('../auto-updater');
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: false, details: '' });

    const { handleBeforeQuit } = await import('../quit-orchestration');

    const killSidecar = vi.fn();
    const closeDatabase = vi.fn();
    const trackAppClosed = vi.fn();
    const shutdownAnalytics = vi.fn().mockResolvedValue(undefined);
    const requestSaveAll = vi.fn();

    const result = await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar,
      closeDatabase,
      trackAppClosed,
      shutdownAnalytics,
      quitApp: quitFn,
      requestSaveAll,
    });

    expect(result.cancelled).toBe(false);
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(quitFn).not.toHaveBeenCalled();
  });

  it('2.8a never starts the native installer when work becomes dirty and the final quit is cancelled', async () => {
    showMessageBox
      .mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      .mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater, installUpdate, _setUpdateDownloadedForTest } =
      await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    _setUpdateDownloadedForTest(true);

    setDirtyState({ hasDirtyWork: false, details: '' });
    await expect(installUpdate()).resolves.toEqual({ status: 'started' });
    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(false);

    setDirtyState({ hasDirtyWork: true, details: '1 page' });
    const cancelled = await handleBeforeQuit({
      mainWindow: win as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(cancelled).toEqual({ cancelled: true });
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(false);
    expect(win.webContents.send).toHaveBeenCalledWith('update:downloaded', {
      version: expect.any(String),
    });

    await expect(installUpdate()).resolves.toEqual({ status: 'started' });
    const authorized = await handleBeforeQuit({
      mainWindow: win as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(authorized).toEqual({ cancelled: false });
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(true);
  });

  it('2.8c freezes renderer input before the final dirty-state read and restores it on cancel', async () => {
    showMessageBox.mockResolvedValueOnce({ response: 0, checkboxChecked: false });
    const { setDirtyState } = await import('../dirty-state-cache');
    const { initAutoUpdater, _setUpdateDownloadedForTest } = await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: false, details: '' });
    const restoreRenderer = vi.fn();
    const freezeRenderer = vi.fn(() => {
      setDirtyState({ hasDirtyWork: true, details: '1 page' });
    });

    const result = await handleBeforeQuit({
      mainWindow: win as never,
      freezeRenderer,
      restoreRenderer,
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(result).toEqual({ cancelled: true });
    expect(freezeRenderer).toHaveBeenCalledTimes(1);
    expect(showMessageBox).toHaveBeenCalledTimes(1);
    expect(restoreRenderer).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('2.8b handleBeforeQuit skips the dialog when consent was already granted upstream', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { _setUpdateDownloadedForTest } = await import('../auto-updater');
    const { handleBeforeQuit, setQuitConsentGranted } = await import('../quit-orchestration');
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: true, details: '1 page' });

    setQuitConsentGranted();

    await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('2.9 before-quit ordering: dialog BEFORE killSidecar BEFORE closeDatabase', async () => {
    const callOrder: string[] = [];
    showMessageBox.mockImplementationOnce(async () => {
      callOrder.push('dialog');
      return { response: 1, checkboxChecked: false };
    });

    const { setDirtyState } = await import('../dirty-state-cache');
    const { _setUpdateDownloadedForTest } = await import('../auto-updater');
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: true, details: '1 page' });

    const { handleBeforeQuit } = await import('../quit-orchestration');

    const killSidecar = vi.fn(() => {
      callOrder.push('killSidecar');
    });
    const closeDatabase = vi.fn(() => {
      callOrder.push('closeDatabase');
    });
    const trackAppClosed = vi.fn();
    const shutdownAnalytics = vi.fn().mockResolvedValue(undefined);
    const requestSaveAll = vi.fn();

    await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar,
      closeDatabase,
      trackAppClosed,
      shutdownAnalytics,
      quitApp: quitFn,
      requestSaveAll,
    });

    expect(callOrder[0]).toBe('dialog');
    expect(callOrder.indexOf('killSidecar')).toBeGreaterThan(callOrder.indexOf('dialog'));
    expect(callOrder.indexOf('closeDatabase')).toBeGreaterThan(callOrder.indexOf('killSidecar'));
    expect(requestSaveAll).not.toHaveBeenCalled();
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('2.9b hides the window only after the dialog, and not when the user cancels', async () => {
    const callOrder: string[] = [];
    showMessageBox.mockImplementationOnce(async () => {
      callOrder.push('dialog');
      return { response: 1, checkboxChecked: false };
    });
    const { setDirtyState } = await import('../dirty-state-cache');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    setDirtyState({ hasDirtyWork: true, details: '2 sequences' });

    const concealRenderer = vi.fn(() => {
      callOrder.push('conceal');
    });
    const restoreRenderer = vi.fn(() => {
      callOrder.push('restore');
    });
    await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer,
      concealRenderer,
      killSidecar: vi.fn(() => {
        callOrder.push('killSidecar');
      }),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(callOrder).toEqual(['dialog', 'conceal', 'killSidecar']);
    expect(restoreRenderer).not.toHaveBeenCalled();

    callOrder.length = 0;
    showMessageBox.mockImplementationOnce(async () => {
      callOrder.push('dialog');
      return { response: 0, checkboxChecked: false };
    });
    const concealOnCancel = vi.fn(() => {
      callOrder.push('conceal');
    });
    const restoreOnCancel = vi.fn(() => {
      callOrder.push('restore');
    });
    const cancelled = await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: restoreOnCancel,
      concealRenderer: concealOnCancel,
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(cancelled).toEqual({ cancelled: true });
    expect(callOrder).toEqual(['dialog', 'restore']);
    expect(concealOnCancel).not.toHaveBeenCalled();
  });

  it('2.9c reveals the window before showing the platform-appropriate dialog', async () => {
    const order: string[] = [];
    showMessageBox.mockImplementationOnce(async (...args: unknown[]) => {
      order.push('dialog');
      const opts = args.at(-1) as { buttons?: string[] };
      expect(opts.buttons).toEqual(['Cancel', 'Close Anyway']);
      return { response: 0, checkboxChecked: false };
    });
    const { showUnsavedWorkDialog } = await import('../quit-consent');
    const win = {
      ...makeMockWindow(),
      show: () => order.push('show'),
    };

    await showUnsavedWorkDialog(win as never, { staged: false, details: '2 sequences' });

    expect(order).toEqual(['show', 'dialog']);
    expect(showMessageBox.mock.calls[0]).toHaveLength(process.platform === 'win32' ? 2 : 1);
    if (process.platform === 'win32') expect(showMessageBox.mock.calls[0][0]).toBe(win);
  });

  it('2.10 closes durable app state even when sidecar process-tree cleanup fails', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { _setUpdateDownloadedForTest } = await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    _setUpdateDownloadedForTest(false);
    setDirtyState({ hasDirtyWork: false, details: '' });

    const killSidecar = vi.fn().mockRejectedValue(new Error('stubborn descendant survived'));
    const closeDatabase = vi.fn();
    const trackAppClosed = vi.fn();
    const shutdownAnalytics = vi.fn().mockResolvedValue(undefined);

    const result = await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar,
      closeDatabase,
      trackAppClosed,
      shutdownAnalytics,
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(result).toEqual({ cancelled: false });
    expect(killSidecar).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(trackAppClosed).toHaveBeenCalledTimes(1);
    expect(shutdownAnalytics).toHaveBeenCalledTimes(1);
    expect(quitFn).toHaveBeenCalledTimes(1);
  });

  it('2.11 never starts an update installer when sidecar shutdown cannot be proven', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { _setUpdateDownloadedForTest } = await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: false, details: '' });

    const killSidecar = vi.fn().mockRejectedValue(new Error('waypoint-api.exe is still alive'));
    const closeDatabase = vi.fn();
    const trackAppClosed = vi.fn();
    const shutdownAnalytics = vi.fn().mockResolvedValue(undefined);

    const result = await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar,
      closeDatabase,
      trackAppClosed,
      shutdownAnalytics,
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(result).toEqual({ cancelled: false });
    expect(killSidecar).toHaveBeenCalledTimes(1);
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(trackAppClosed).toHaveBeenCalledTimes(1);
    expect(shutdownAnalytics).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(relaunchFn).toHaveBeenCalledTimes(1);
    expect(quitFn).toHaveBeenCalledTimes(1);
  });
});

describe('Task 3: Error state + UI fixes', () => {
  it('3.1 error handler classifies stage from updater lifecycle state', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    const errorHandler = autoUpdaterEvents.get('error')!;
    const updateAvailableHandler = autoUpdaterEvents.get('update-available')!;

    errorHandler(new Error('check fail (background)'));
    const checkErrorCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:error'
    );
    expect(checkErrorCalls).toHaveLength(0);

    win.webContents.send.mockClear();
    trackEvent.mockClear();
    updateAvailableHandler({ version: '2.0.0' });
    errorHandler(new Error('download fail'));
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'download', message: expect.any(String) })
    );
    expect(trackEvent).toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({ error_class: 'update_download_failed', stage: 'download' })
    );
    expect(
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_check_completed')
    ).toEqual([
      ['app_update_check_completed', { feature_area: 'reliability', success: true, manual: false }],
    ]);
  });

  it('3.2 update:retry IPC triggers checkForUpdates()', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);

    const retryHandler = ipcInvokers.get('update:retry');
    expect(retryHandler).toBeDefined();
    await retryHandler!();
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled();
  });

  it('3.3 error during active download fires update:error with stage="download"', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-available')!({ version: '2.0.0' });
    win.webContents.send.mockClear();
    autoUpdaterEvents.get('error')!(new Error('oops'));

    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'download' })
    );
  });

  it('3.3b reports a native failure after install intent as install-stage, never duplicate check', async () => {
    const { initAutoUpdater, quitAndInstall } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-downloaded')!({ version: '2.0.0' });
    await ipcInvokers.get('update:install')!();
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(quitAndInstall()).toEqual({ status: 'started' });
    quitFn.mockClear();
    win.webContents.send.mockClear();
    autoUpdaterEvents.get('error')!(new Error('code signature did not pass validation'));

    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'install', message: expect.any(String) })
    );
    expect(trackEvent).toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({ error_class: 'update_install_failed', stage: 'install' })
    );
    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(relaunchFn).toHaveBeenCalledTimes(1);

    mockAutoUpdater.quitAndInstall.mockClear();
    quitFn.mockClear();
    await ipcInvokers.get('update:install')!();
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(quitAndInstall()).toEqual({ status: 'started' });
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('3.3c reports a synchronous native install refusal instead of leaving the UI installing', async () => {
    const { initAutoUpdater, quitAndInstall } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-downloaded')!({ version: '2.0.0' });
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('native installer refused the staged package');
    });

    await expect(ipcInvokers.get('update:install')!()).resolves.toEqual({ status: 'started' });
    expect(quitAndInstall()).toEqual({
      status: 'failed',
      message: 'native installer refused the staged package',
    });
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'install', message: expect.stringContaining('refused') })
    );
    expect(trackEvent).toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({ error_class: 'update_install_failed', stage: 'install' })
    );
  });

  it('3.3d completes a plain quit when native install refuses after product teardown', async () => {
    const { _setUpdateDownloadedForTest } = await import('../auto-updater');
    const { handleBeforeQuit } = await import('../quit-orchestration');
    _setUpdateDownloadedForTest(true);
    mockAutoUpdater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('native installer refused after teardown');
    });

    const closeDatabase = vi.fn();
    const result = await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: vi.fn(),
      closeDatabase,
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(result).toEqual({ cancelled: false });
    expect(closeDatabase).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(quitFn).toHaveBeenCalledTimes(1);
    expect(relaunchFn).toHaveBeenCalledTimes(1);
  });

  it("3.4  check-stage error classifies missing app-update.yml as 'no-manifest'", async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    win.webContents.send.mockClear();
    autoUpdaterEvents.get('error')!(
      new Error('ENOENT: no such file or directory, open app-update.yml')
    );

    const errorCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:error'
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][1]).toMatchObject({
      stage: 'check',
      isManual: true,
      reason: 'no-manifest',
    });
  });

  it("3.5  check-stage error classifies network failures as 'network'", async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    win.webContents.send.mockClear();
    autoUpdaterEvents.get('error')!(new Error('getaddrinfo ENOTFOUND github.com'));

    const errorCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:error'
    );
    expect(errorCalls[0][1]).toMatchObject({
      stage: 'check',
      reason: 'network',
    });
  });

  it("3.6  check-stage error falls back to 'unknown' when nothing matches", async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    win.webContents.send.mockClear();
    autoUpdaterEvents.get('error')!(new Error('unexpected provider response'));

    const errorCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:error'
    );
    expect(errorCalls[0][1]).toMatchObject({
      stage: 'check',
      reason: 'unknown',
    });
  });

  it('3.7  download-stage error payload omits reason (only check-stage is classified)', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-available')!({ version: '2.0.0' });
    win.webContents.send.mockClear();
    autoUpdaterEvents.get('error')!(new Error('code signature validation failed'));

    const errorCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:error'
    );
    expect(errorCalls).toHaveLength(1);
    const payload = errorCalls[0][1] as Record<string, unknown>;
    expect(payload).toMatchObject({ stage: 'download' });
    expect(payload).not.toHaveProperty('reason');
  });

  it('3.7b retries an interrupted payload from the next origin only when identity matches', async () => {
    vi.useFakeTimers();
    const candidate = {
      version: '2.0.0',
      files: [{ url: 'DNAForge-2.0.0-arm64.zip', sha512: 'same-sha512' }],
    };
    mockAutoUpdater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: candidate,
    });
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-available')!(candidate);
    autoUpdaterEvents.get('error')!(new Error('ECONNRESET during download'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: `https://downloads.dnaforge.com/humic/updates/stable/${process.arch}`,
      })
    );
    expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(
      win.webContents.send.mock.calls.filter((call: unknown[]) => call[0] === 'update:error')
    ).toHaveLength(0);
  });

  it('3.7c rejects a fallback manifest that disagrees with the original payload identity', async () => {
    vi.useFakeTimers();
    const primary = {
      version: '2.0.0',
      files: [{ url: 'DNAForge-2.0.0-arm64.zip', sha512: 'primary-sha512' }],
    };
    mockAutoUpdater.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: {
        ...primary,
        files: [{ url: 'DNAForge-2.0.0-arm64.zip', sha512: 'different-sha512' }],
      },
    });
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-available')!(primary);
    autoUpdaterEvents.get('error')!(new Error('ECONNRESET during download'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'download', message: expect.stringMatching(/disagrees/i) })
    );
  });

  it('3.7d terminal security failure invalidates a scheduled infrastructure fallback', async () => {
    vi.useFakeTimers();
    const candidate = {
      version: '2.0.0',
      files: [{ url: 'DNAForge-2.0.0-arm64.zip', sha512: 'same-sha512' }],
    };
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-available')!(candidate);
    mockAutoUpdater.setFeedURL.mockClear();
    autoUpdaterEvents.get('error')!(new Error('ECONNRESET during download'));
    autoUpdaterEvents.get('error')!(new Error('publisherName verification failed'));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockAutoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(
      win.webContents.send.mock.calls.filter((call: unknown[]) => call[0] === 'update:error')
    ).toHaveLength(1);
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'download', message: expect.stringMatching(/publisher/i) })
    );
  });

  it('3.7e terminal security failure stays terminal while the fallback manifest check is pending', async () => {
    vi.useFakeTimers();
    const candidate = {
      version: '2.0.0',
      files: [{ url: 'DNAForge-2.0.0-arm64.zip', sha512: 'same-sha512' }],
    };
    let resolveFallbackCheck: (value: { updateInfo: typeof candidate }) => void = () => {
      throw new Error('fallback manifest check resolver was not initialized');
    };
    mockAutoUpdater.checkForUpdates.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFallbackCheck = resolve;
      })
    );
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    autoUpdaterEvents.get('update-available')!(candidate);
    autoUpdaterEvents.get('error')!(new Error('ECONNRESET during download'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdaterEvents.get('error')!(new Error('publisherName verification failed'));
    resolveFallbackCheck({ updateInfo: candidate });
    await Promise.resolve();
    await Promise.resolve();

    expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(
      win.webContents.send.mock.calls.filter((call: unknown[]) => call[0] === 'update:error')
    ).toHaveLength(1);
  });

  it.each([
    {
      label: 'no-manifest',
      message: "ENOENT: open '/Applications/DNAForge.app/Contents/Resources/app-update.yml'",
      expectedReason: 'no-manifest',
    },
    {
      label: 'network',
      message: 'getaddrinfo ENOTFOUND github.com',
      expectedReason: 'network',
    },
    {
      label: 'unknown',
      message: 'YAMLException: bad indentation of a mapping entry',
      expectedReason: 'unknown',
    },
  ])(
    '3.8  trackEvent carries reason="$expectedReason" for $label-class failures',
    async ({ message, expectedReason }) => {
      const { initAutoUpdater } = await import('../auto-updater');
      initAutoUpdater(makeMockWindow() as never);

      await ipcInvokers.get('update:check-manual')!();
      autoUpdaterEvents.get('error')!(new Error(message));

      expect(trackEvent).toHaveBeenCalledWith(
        'app_update_error',
        expect.objectContaining({
          stage: 'check',
          reason: expectedReason,
          error_code: expectedReason === 'no-manifest' ? 'no_manifest' : expectedReason,
        })
      );
    }
  );
});

describe('Task 4: PostHog events (auto-updater)', () => {
  it('4.1 app_update_available event captured with version', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);

    autoUpdaterEvents.get('update-available')!({ version: '2.0.0' });
    expect(trackEvent).toHaveBeenCalledWith('app_update_available', { version: '2.0.0' });
    expect(trackEvent).toHaveBeenCalledWith('app_update_check_completed', {
      feature_area: 'reliability',
      success: true,
      manual: false,
    });
  });

  it('4.2 app_update_downloaded event captured with duration', async () => {
    vi.useFakeTimers();
    const db = await telemetryDatabase();
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never, { database: db });

    const info = {
      version: '2.0.0',
      files: [{ url: 'private-installer.zip', sha512: 'controlled-digest', size: 128 }],
    };
    autoUpdaterEvents.get('update-available')!(info);
    vi.advanceTimersByTime(125);
    autoUpdaterEvents.get('update-downloaded')!(info);

    const { listPendingAnalyticsOutboxEvents } = await import('../analytics-outbox');
    const receipts = listPendingAnalyticsOutboxEvents(db).filter(
      (row) => row.eventName === 'app_update_downloaded'
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].properties).toMatchObject({ version: '2.0.0' });
    expect(receipts[0].properties.download_duration_ms).toBeGreaterThanOrEqual(125);
    const target = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('_downloaded_update_target') as { value: string } | undefined;
    expect(target?.value).toBe('2.0.0');
    db.close();
  });

  it('4.2a persists exact durable install intent immediately before native install', async () => {
    const { initAutoUpdater, quitAndInstall } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });

    await expect(ipcInvokers.get('update:install')!()).resolves.toEqual({ status: 'started' });
    expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(false);
    expect(quitAndInstall()).toEqual({ status: 'started' });

    const persisted: unknown = JSON.parse(
      readFileSync(join(userDataRoot.value, 'update-install-intent.json'), 'utf8')
    );
    expect(persisted).toEqual({
      fromVersion: '2.0.0',
      targetVersion: '2.1.0',
      attemptedAt: expect.any(Number),
      measurement: expect.objectContaining({
        operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        terminalEventId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        originBootId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        consentEpoch: null,
      }),
    });
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('4.2b consumes the nested auto-download promise rejection without owning error state twice', async () => {
    const nestedCatch = vi.fn().mockResolvedValue(undefined);
    mockAutoUpdater.checkForUpdates.mockResolvedValueOnce({
      downloadPromise: { catch: nestedCatch },
    });
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();

    expect(nestedCatch).toHaveBeenCalledTimes(1);
    expect(nestedCatch).toHaveBeenCalledWith(expect.any(Function));
    expect(
      win.webContents.send.mock.calls.filter((call: unknown[]) => call[0] === 'update:error')
    ).toHaveLength(0);
  });

  it('4.3 app_update_error emits classifiers without the raw provider message', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);

    const rawSecret = 'HTTP 403 cookie=session-secret authorization=Bearer-private';
    autoUpdaterEvents.get('error')!(new Error(rawSecret));
    expect(trackEvent).toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({
        feature_area: 'reliability',
        stage: 'check',
        reason: 'unknown',
        error_class: 'update_check_failed',
        error_code: 'unknown',
        manual: false,
      })
    );
    expect(JSON.stringify(trackEvent.mock.calls)).not.toContain(rawSecret);
  });

  it('4.3b download errors carry the target version', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);

    autoUpdaterEvents.get('update-available')!({ version: '2.0.0' });
    autoUpdaterEvents.get('error')!(new Error('publisherName verification failed'));

    expect(trackEvent).toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({ stage: 'download', version: '2.0.0' })
    );
  });

  it('4.4 app_update_installed detects version change via settings._last_app_version', async () => {
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      '_last_app_version',
      '1.0.0',
      Date.now()
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      '_downloaded_update_target',
      '2.0.0',
      Date.now()
    );

    const { checkForVersionUpgrade } = await import('../auto-updater');
    checkForVersionUpgrade(db);

    expect(trackEvent).toHaveBeenCalledWith('app_update_installed', {
      $insert_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      from_version: '1.0.0',
      to_version: '2.0.0',
      update_qualification: 'exact_download_marker',
      update_boot_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });

    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('_last_app_version') as
      | { value: string }
      | undefined;
    expect(row?.value).toBe('2.0.0');
    expect(
      db.prepare('SELECT value FROM settings WHERE key = ?').get('_downloaded_update_target')
    ).toBeUndefined();

    db.close();
  });

  it('4.5 does not call a side-load or manual version change an updater install', async () => {
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      '_last_app_version',
      '1.0.0',
      Date.now()
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      '_legacy_unmarked_update_bridge_consumed',
      'true',
      Date.now()
    );

    const { checkForVersionUpgrade } = await import('../auto-updater');
    checkForVersionUpgrade(db);

    expect(trackEvent).not.toHaveBeenCalledWith('app_update_installed', expect.anything());

    db.close();
  });

  it('4.6 bridges one update from a published source that cannot write the target marker', async () => {
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      '_last_app_version',
      '1.0.0',
      Date.now()
    );

    const { checkForVersionUpgrade } = await import('../auto-updater');
    checkForVersionUpgrade(db);

    expect(trackEvent).toHaveBeenCalledWith('app_update_installed', {
      $insert_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      from_version: '1.0.0',
      to_version: '2.0.0',
      update_qualification: 'legacy_bridge',
      update_boot_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(
      db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('_legacy_unmarked_update_bridge_consumed')
    ).toMatchObject({ value: 'true' });
    db.close();
  });

  it('4.7 a fresh profile consumes the legacy bridge without emitting an install', async () => {
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );

    const { checkForVersionUpgrade } = await import('../auto-updater');
    checkForVersionUpgrade(db);

    expect(trackEvent).not.toHaveBeenCalledWith('app_update_installed', expect.anything());
    expect(
      db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('_legacy_unmarked_update_bridge_consumed')
    ).toMatchObject({ value: 'true' });
    db.close();
  });

  it('4.8 same-version relaunch rechecks the feed and restores retry only after exact redownload', async () => {
    vi.useFakeTimers();
    const attemptedAt = Date.now();
    writeFileSync(
      join(userDataRoot.value, 'update-install-intent.json'),
      JSON.stringify({
        fromVersion: '2.0.0',
        targetVersion: '2.1.0',
        attemptedAt,
      })
    );
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      '_last_app_version',
      '2.0.0',
      Date.now()
    );

    const { checkForVersionUpgrade, initAutoUpdater, quitAndInstall } =
      await import('../auto-updater');
    checkForVersionUpgrade(db);
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(trackEvent).toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({
        error_class: 'update_install_did_not_advance',
        error_code: 'same_version_relaunch',
        stage: 'install',
        version: '2.1.0',
      })
    );
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalledWith('update:downloaded', {
      version: '2.1.0',
    });
    expect(existsSync(join(userDataRoot.value, 'update-install-intent.json'))).toBe(true);
    await expect(ipcInvokers.get('update:install')!()).resolves.toEqual({
      status: 'failed',
      message: 'No downloaded update is ready to install.',
    });
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

    autoUpdaterEvents.get('update-downloaded')!({ version: '2.1.0' });
    expect(win.webContents.send).toHaveBeenCalledWith('update:downloaded', { version: '2.1.0' });

    await expect(ipcInvokers.get('update:install')!()).resolves.toEqual({ status: 'started' });
    expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(quitAndInstall()).toEqual({ status: 'started' });
    expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
    db.close();
  });

  it('4.8a never relabels a different freshly downloaded version as the failed install target', async () => {
    vi.useFakeTimers();
    const intentPath = join(userDataRoot.value, 'update-install-intent.json');
    writeFileSync(
      intentPath,
      JSON.stringify({
        fromVersion: '2.0.0',
        targetVersion: '2.1.0',
        attemptedAt: Date.now(),
      })
    );
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      '_last_app_version',
      '2.0.0',
      Date.now()
    );

    const { checkForVersionUpgrade, initAutoUpdater } = await import('../auto-updater');
    checkForVersionUpgrade(db);
    const win = makeMockWindow();
    initAutoUpdater(win as never);
    autoUpdaterEvents.get('update-downloaded')!({ version: '2.2.0' });

    expect(win.webContents.send).not.toHaveBeenCalledWith('update:downloaded', {
      version: '2.1.0',
    });
    expect(win.webContents.send).toHaveBeenCalledWith('update:downloaded', { version: '2.2.0' });
    expect(existsSync(intentPath)).toBe(false);
    db.close();
  });

  it.each([
    ['corrupt', '{not-json'],
    [
      'expired',
      JSON.stringify({
        fromVersion: '2.0.0',
        targetVersion: '2.1.0',
        attemptedAt: Date.now() - 24 * 60 * 60 * 1000 - 1,
      }),
    ],
  ])('4.8b clears %s install intent instead of retrying it forever', async (_label, intent) => {
    const intentPath = join(userDataRoot.value, 'update-install-intent.json');
    writeFileSync(intentPath, intent);
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      '_last_app_version',
      '2.0.0',
      Date.now()
    );

    const { checkForVersionUpgrade } = await import('../auto-updater');
    checkForVersionUpgrade(db);

    expect(existsSync(intentPath)).toBe(false);
    expect(trackEvent).not.toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({ error_code: 'same_version_relaunch' })
    );
    db.close();
  });

  it('4.9 clears durable install intent only for the exact successful version transition', async () => {
    const intentPath = join(userDataRoot.value, 'update-install-intent.json');
    writeFileSync(
      intentPath,
      JSON.stringify({
        fromVersion: '1.0.0',
        targetVersion: '2.0.0',
        attemptedAt: Date.now(),
      })
    );
    const { createTestDb } = await import('./test-db');
    const db = createTestDb();
    db.exec(
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
    );
    const insert = db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)');
    insert.run('_last_app_version', '1.0.0', Date.now());
    insert.run('_downloaded_update_target', '2.0.0', Date.now());

    const { checkForVersionUpgrade } = await import('../auto-updater');
    checkForVersionUpgrade(db);

    expect(trackEvent).toHaveBeenCalledWith('app_update_installed', {
      $insert_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      from_version: '1.0.0',
      to_version: '2.0.0',
      update_qualification: 'exact_install_intent',
      update_boot_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(existsSync(intentPath)).toBe(false);
    db.close();
  });
});

describe('Task 5: Manual-check + Retry lifecycle ', () => {
  it.each([
    'getaddrinfo ENOTFOUND updates.dnaforge.com',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_SOCKET_NOT_CONNECTED',
  ])('5.0 fails over a network check without surfacing an error: %s', async (message) => {
    mockAutoUpdater.checkForUpdates
      .mockImplementationOnce(async () => {
        const error = new Error(message);
        autoUpdaterEvents.get('error')!(error);
        throw error;
      })
      .mockResolvedValueOnce(null);
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(mockAutoUpdater.setFeedURL).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: `https://humic-labs.github.io/dnaforge-update-mirror/humic/updates/stable/${process.arch}`,
      })
    );
    expect(mockAutoUpdater.setFeedURL).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: `https://downloads.dnaforge.com/humic/updates/stable/${process.arch}`,
      })
    );
    expect(
      win.webContents.send.mock.calls.filter((call: unknown[]) => call[0] === 'update:error')
    ).toHaveLength(0);
  });

  it('5.0b never retries a signature refusal against another origin', async () => {
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(
      new Error('code signature at URL did not pass validation')
    );
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();

    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'check', isManual: true })
    );
  });

  it('5.1 update:check-manual sets the manual flag, so update-not-available forwards to renderer', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdaterEvents.get('update-not-available')!({ version: '1.0.0' });
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:no-update',
      expect.objectContaining({ version: '1.0.0' })
    );

    await ipcInvokers.get('update:check-manual')!();
    autoUpdaterEvents.get('update-not-available')!({ version: '1.0.0' });
    const starts = trackEvent.mock.calls.filter(([event]) => event === 'app_update_check_started');
    const terminals = trackEvent.mock.calls.filter(
      ([event]) => event === 'app_update_check_completed'
    );
    expect(trackEvent.mock.calls).toHaveLength(4);
    expect(starts).toHaveLength(2);
    expect(terminals).toHaveLength(2);
    expect(starts[0][1].operation_id).not.toBe(starts[1][1].operation_id);
    for (let i = 0; i < 2; i += 1)
      expect(terminals[i][1]).toMatchObject({
        feature_area: 'reliability',
        success: true,
        manual: true,
        operation_id: starts[i][1].operation_id,
        origin_started_at_ms: starts[i][1].occurred_at_ms,
        occurred_at_ms: expect.any(Number),
      });
  });

  it('5.2 background update-not-available stays silent (no manual flag set)', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    const updateNotAvailable = autoUpdaterEvents.get('update-not-available')!;
    updateNotAvailable({ version: '1.0.0' });
    updateNotAvailable({ version: '1.0.0' });
    updateNotAvailable({ version: '1.0.1' });
    const noUpdateCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:no-update'
    );
    expect(noUpdateCalls).toHaveLength(0);
    expect(trackEvent.mock.calls).toEqual([
      ['app_update_check_completed', { feature_area: 'reliability', success: true, manual: false }],
      ['app_update_check_completed', { feature_area: 'reliability', success: true, manual: false }],
      ['app_update_check_completed', { feature_area: 'reliability', success: true, manual: false }],
    ]);
  });

  it('5.3 manual-check error event forwards to renderer with isManual=true', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    win.webContents.send.mockClear();
    autoUpdaterEvents.get('error')!(new Error('manual check fail'));

    const errorCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:error'
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][1]).toMatchObject({
      stage: 'check',
      isManual: true,
    });
  });

  it('5.4 manual-flag clears after consumption — next background event is silent again', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    autoUpdaterEvents.get('update-not-available')!({ version: '1.0.0' });
    win.webContents.send.mockClear();

    autoUpdaterEvents.get('update-not-available')!({ version: '1.0.0' });
    const noUpdateCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:no-update'
    );
    expect(noUpdateCalls).toHaveLength(0);
  });

  it('5.5 manual-flag safety timer clears the flag if no event fires within the timeout', async () => {
    vi.useFakeTimers();
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    await vi.advanceTimersByTimeAsync(61_000);
    win.webContents.send.mockClear();

    autoUpdaterEvents.get('update-not-available')!({ version: '1.0.0' });
    const noUpdateCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:no-update'
    );
    expect(noUpdateCalls).toHaveLength(0);
  });

  it('5.6 update:check-manual surfaces a check-stage error if checkForUpdates rejects synchronously', async () => {
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('boom'));
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    const errorCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:error'
    );
    expect(errorCalls).toHaveLength(1);
    expect(errorCalls[0][1]).toMatchObject({
      stage: 'check',
      isManual: true,
      message: 'boom',
    });
    expect(trackEvent.mock.calls.filter(([event]) => event === 'app_update_error')).toHaveLength(1);
    expect(
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_check_completed')
    ).toEqual([
      ['app_update_check_completed', expect.objectContaining({ success: false, manual: true })],
    ]);
    autoUpdaterEvents.get('error')!(new Error('boom'));
    expect(errorCalls).toHaveLength(1);
    expect(trackEvent.mock.calls.filter(([event]) => event === 'app_update_error')).toHaveLength(1);
    expect(
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_check_completed')
    ).toHaveLength(1);
  });

  it('5.7 rejection-after-error-event does NOT double-emit (flag already consumed)', async () => {
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdaterEvents.get('error')!(new Error('boom'));
      throw new Error('boom');
    });
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    const errorCalls = win.webContents.send.mock.calls.filter(
      ([channel]) => channel === 'update:error'
    );
    expect(errorCalls).toHaveLength(1);
    expect(trackEvent.mock.calls.filter(([event]) => event === 'app_update_error')).toHaveLength(1);
    expect(
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_check_completed')
    ).toHaveLength(1);
  });

  it('5.7b scheduled rejection without an error event records one failed terminal outcome', async () => {
    vi.useFakeTimers();
    mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('background boom'));
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);

    await vi.advanceTimersByTimeAsync(30_001);

    expect(trackEvent.mock.calls.filter(([event]) => event === 'app_update_error')).toHaveLength(1);
    expect(
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_check_completed')
    ).toEqual([
      ['app_update_check_completed', expect.objectContaining({ success: false, manual: false })],
    ]);
    autoUpdaterEvents.get('error')!(new Error('background boom'));
    expect(trackEvent.mock.calls.filter(([event]) => event === 'app_update_error')).toHaveLength(1);
    expect(
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_check_completed')
    ).toHaveLength(1);
  });

  it('5.7c scheduled and manual callers share one failed updater attempt', async () => {
    vi.useFakeTimers();
    let rejectCheck: ((error: Error) => void) | undefined;
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectCheck = reject;
        })
    );
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await vi.advanceTimersByTimeAsync(30_001);
    const manualCheck = ipcInvokers.get('update:check-manual')!();
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdaterEvents.get('error')!(new Error('shared failure'));
    rejectCheck?.(new Error('shared failure'));
    await manualCheck;

    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:error',
      expect.objectContaining({ stage: 'check', isManual: true })
    );
    expect(trackEvent.mock.calls.filter(([event]) => event === 'app_update_error')).toHaveLength(1);
    expect(
      trackEvent.mock.calls.filter(([event]) => event === 'app_update_check_completed')
    ).toHaveLength(1);
  });

  it('5.7d a long-running scheduled check is not duplicated by the periodic interval', async () => {
    vi.useFakeTimers();
    let resolveCheck: (() => void) | undefined;
    mockAutoUpdater.checkForUpdates.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheck = () => resolve(null);
        })
    );
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);

    await vi.advanceTimersByTimeAsync(30_001);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    resolveCheck?.();
    await Promise.resolve();
  });

  it('5.7e manual and periodic checks are skipped while an update download is active', async () => {
    vi.useFakeTimers();
    const { initAutoUpdater } = await import('../auto-updater');
    initAutoUpdater(makeMockWindow() as never);
    autoUpdaterEvents.get('update-available')!({ version: '2.0.0' });
    mockAutoUpdater.checkForUpdates.mockClear();
    trackEvent.mockClear();

    await ipcInvokers.get('update:check-manual')!();
    await vi.advanceTimersByTimeAsync(30_001 + 10 * 60 * 1_000);

    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalledWith(
      'app_update_error',
      expect.objectContaining({ stage: 'download' })
    );
  });

  it('5.8 update:retry triggers a manual-flagged check (retry success surfaces a toast)', async () => {
    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:retry')!();
    expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdaterEvents.get('update-not-available')!({ version: '1.0.0' });
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:no-update',
      expect.objectContaining({ version: '1.0.0' })
    );
  });

  it('5.9 dev-mode short-circuit synthesizes update:no-update without calling checkForUpdates', async () => {
    vi.doMock('electron', () => ({
      app: {
        getVersion: () => '1.2.3',
        isPackaged: false,
        on: vi.fn(),
        quit: () => quitFn(),
        getPath: vi.fn(() => userDataRoot.value),
      },
      BrowserWindow: vi.fn(),
      ipcMain: {
        on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
          ipcHandlers.set(channel, cb);
        }),
        handle: vi.fn((channel: string, cb: (...args: unknown[]) => unknown) => {
          ipcInvokers.set(channel, cb);
        }),
        once: vi.fn(),
        removeHandler: vi.fn(),
        removeListener: vi.fn(),
      },
      dialog: {
        showMessageBox: (...args: unknown[]) => showMessageBox(...args),
        showErrorBox: (...args: unknown[]) => showErrorBox(...args),
      },
    }));

    const { initAutoUpdater } = await import('../auto-updater');
    const win = makeMockWindow();
    initAutoUpdater(win as never);

    await ipcInvokers.get('update:check-manual')!();
    expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith(
      'update:no-update',
      expect.objectContaining({ version: '1.2.3', isDevMode: true })
    );
  });

  it('5.10 FORCE_UPDATER allows the manual check to reach checkForUpdates in unpackaged builds', async () => {
    vi.doMock('electron', () => ({
      app: {
        getVersion: () => '1.0.0',
        isPackaged: false,
        on: vi.fn(),
        quit: () => quitFn(),
        getPath: vi.fn(() => userDataRoot.value),
      },
      BrowserWindow: vi.fn(),
      ipcMain: {
        on: vi.fn((channel: string, cb: (...args: unknown[]) => void) => {
          ipcHandlers.set(channel, cb);
        }),
        handle: vi.fn((channel: string, cb: (...args: unknown[]) => unknown) => {
          ipcInvokers.set(channel, cb);
        }),
        once: vi.fn(),
        removeHandler: vi.fn(),
        removeListener: vi.fn(),
      },
      dialog: {
        showMessageBox: (...args: unknown[]) => showMessageBox(...args),
        showErrorBox: (...args: unknown[]) => showErrorBox(...args),
      },
    }));

    const previous = process.env.WAYPOINT_FORCE_UPDATER;
    process.env.WAYPOINT_FORCE_UPDATER = '1';
    try {
      const { initAutoUpdater } = await import('../auto-updater');
      const win = makeMockWindow();
      initAutoUpdater(win as never);

      await ipcInvokers.get('update:check-manual')!();
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
      const noUpdateCalls = win.webContents.send.mock.calls.filter(
        ([channel]) => channel === 'update:no-update'
      );
      expect(noUpdateCalls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.WAYPOINT_FORCE_UPDATER;
      else process.env.WAYPOINT_FORCE_UPDATER = previous;
    }
  });
});

describe('Task 6: Quit-consent latch reset ', () => {
  it('6.1 handleBeforeQuit resets consent after running, so a leaked grant cannot suppress the next dialog', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { _setUpdateDownloadedForTest } = await import('../auto-updater');
    const { handleBeforeQuit, setQuitConsentGranted, hasQuitConsent } =
      await import('../quit-orchestration');

    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: true, details: '1 page' });
    setQuitConsentGranted();
    expect(hasQuitConsent()).toBe(true);

    await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });

    expect(hasQuitConsent()).toBe(false);
  });

  it('6.2 second handleBeforeQuit cycle prompts again after a leaked grant scenario', async () => {
    const { setDirtyState } = await import('../dirty-state-cache');
    const { _setUpdateDownloadedForTest } = await import('../auto-updater');
    const { handleBeforeQuit, setQuitConsentGranted } = await import('../quit-orchestration');

    _setUpdateDownloadedForTest(true);
    setDirtyState({ hasDirtyWork: true, details: '1 page' });

    setQuitConsentGranted();
    await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });
    expect(showMessageBox).not.toHaveBeenCalled();

    showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    await handleBeforeQuit({
      mainWindow: makeMockWindow() as never,
      freezeRenderer: vi.fn(),
      restoreRenderer: vi.fn(),
      killSidecar: vi.fn(),
      closeDatabase: vi.fn(),
      trackAppClosed: vi.fn(),
      shutdownAnalytics: vi.fn().mockResolvedValue(undefined),
      quitApp: quitFn,
      requestSaveAll: vi.fn(),
    });
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });
});

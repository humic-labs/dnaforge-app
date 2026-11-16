import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileTestDb, openFileTestDb } from '../main/__tests__/test-db';
import { AdministrationOwner } from '../main/administration-owner';
import { createAdministrationStorage } from '../main/administration-storage';
import { createAdministrationTables } from '../main/administration-schema';
import { ADMINISTRATION_SETTINGS_DEFAULTS } from '../shared/administration';
import type {
  AdministrationEvent,
  AdministrationRequest,
  AdministrationResult,
  AdministrationSettings,
  AdministrationSettingsSnapshot,
} from '../shared/administration';

const ports = vi.hoisted(() => ({
  execute: vi.fn(),
  listener: null as ((event: AdministrationEvent) => void) | null,
  apply: vi.fn(),
  capture: vi.fn<(event: string, properties: Record<string, unknown>) => boolean>(() => true),
}));
vi.mock('../platform', () => ({
  platform: () => ({
    administration: {
      execute: ports.execute,
      onChanged: (listener: (event: AdministrationEvent) => void) => {
        ports.listener = listener;
        return () => {};
      },
    },
    window: { setZoomLevel: ports.apply },
  }),
}));
vi.mock('./analytics', () => ({
  trackRendererEvent: ports.capture,
  isAnalyticsCaptureReady: () => true,
  getAnalyticsIdentifiedAccountId: () => null,
  subscribeAnalyticsCaptureReady: () => () => {},
  isAnalyticsIdentityIdentified: () => false,
  getMeaningfulActivityAuthority: () => ({
    actorKind: 'test',
    executionMode: 'automated',
    impersonated: false,
  }),
}));

function connectedPreferences() {
  const file = createFileTestDb('appearance-retry');
  file.db.exec(
    'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  );
  createAdministrationTables(file.db);
  const storage = createAdministrationStorage(() => file.db);
  storage.writeSettings(
    { ...ADMINISTRATION_SETTINGS_DEFAULTS, theme: 'light', assemblyColorScheme: 'carbon' },
    ['theme', 'displayZoom', 'assemblyColorScheme', 'webglPerformance']
  );
  const faults = openFileTestDb(file.dbPath);
  let actualZoom = 1;
  const applyZoom = (factor: number) => {
    actualZoom = factor;
    return { status: 'applied' as const, factor };
  };
  ports.apply.mockImplementation(async (factor: number) => applyZoom(factor));
  const owner = new AdministrationOwner({
    storage,
    account: async () => null,
    prepareShare: vi.fn(),
    publishShare: vi.fn(),
    migration: async () => null,
    actOnMigration: vi.fn(),
    requestApproval: async () => false,
    beginHandoff: async () => {},
    observeHandoff: vi.fn(),
    applySettings: (snapshot, keys) =>
      keys.includes('displayZoom') ? applyZoom(snapshot.values.displayZoom) : undefined,
    publish: (event) => ports.listener?.(structuredClone(event)),
  });
  ports.execute.mockImplementation(async (request: AdministrationRequest) =>
    structuredClone(await owner.execute(request, () => {}))
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = {};
  const refuse = (keys: Array<keyof AdministrationSettings>) => {
    const names: string[] = [];
    for (const [index, key] of keys.entries()) {
      for (const operation of ['INSERT', 'UPDATE']) {
        const name = `appearance_owned_${index}_${operation.toLowerCase()}`;
        names.push(name);
        faults.exec(
          `CREATE TRIGGER ${name} BEFORE ${operation} ON administration_preferences WHEN NEW.key = '${key}' BEGIN SELECT RAISE(ABORT, 'synthetic preference refusal'); END`
        );
      }
    }
    return () => {
      for (const name of names) faults.exec(`DROP TRIGGER ${name}`);
    };
  };
  return {
    storage,
    refuse,
    actualZoom: () => actualZoom,
    saved: (key: string) => file.db.prepare('SELECT value FROM settings WHERE key=?').get(key),
    close: () => {
      faults.close();
      file.cleanup();
    },
  };
}

function state(generation: number, theme: 'light' | 'dark'): AdministrationSettingsSnapshot {
  return {
    ownerId: 'owner-one',
    generation,
    revision: `native-${generation}`,
    values: { theme, displayZoom: 1, assemblyColorScheme: 'tailwind', webglPerformance: 'auto' },
    adopted: ['theme'],
    persistence: 'saved',
    unsavedKeys: [],
  };
}
beforeEach(() => {
  vi.resetModules();
  ports.execute.mockReset();
  ports.apply.mockReset();
  ports.capture.mockReset().mockReturnValue(true);
  ports.listener = null;
  localStorage.clear();
});
afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('native administration client', () => {
  it('never lets an older IPC reply replace a newer native owner observation', async () => {
    let release!: (result: AdministrationResult) => void;
    ports.execute.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const client = await import('./administration-client');
    const observations: string[] = [];
    client.subscribeAdministrationSettings((snapshot) => observations.push(snapshot.values.theme));
    const pending = client.inspectAdministrationSettings();
    ports.listener?.({ kind: 'settings', snapshot: state(2, 'dark') });
    release({ kind: 'settings', snapshot: state(1, 'light'), stateChanged: false });
    expect((await pending).values.theme).toBe('dark');
    expect(observations).toEqual(['dark']);
  });

  it('sends the exact inspected revision for a human change and does not request another approval', async () => {
    ports.execute
      .mockResolvedValueOnce({ kind: 'settings', snapshot: state(1, 'light'), stateChanged: false })
      .mockResolvedValueOnce({ kind: 'settings', snapshot: state(2, 'dark'), stateChanged: true });
    const client = await import('./administration-client');
    expect((await client.changeAdministrationSettings({ theme: 'dark' })).values.theme).toBe(
      'dark'
    );
    expect(ports.execute.mock.calls).toEqual([
      [{ operation: { kind: 'inspect-settings' } }],
      [
        {
          operation: {
            kind: 'update-settings',
            expectedRevision: 'native-1',
            patch: { theme: 'dark' },
          },
        },
      ],
    ]);
  });

  it('recovers the real display renderer and native stored value after an owned SQLite fault is removed', async () => {
    const fixture = connectedPreferences();
    try {
      const client = await import('./administration-client');
      const display = await import('./applyZoomLevel');
      await display.applyZoomLevel();
      const restore = fixture.refuse(['displayZoom']);
      await display.setDisplayZoom(1.25);
      expect(display.useDisplayZoomStore.getState().phase).toBe('unsaved');
      expect(fixture.actualZoom()).toBe(1.25);
      expect(fixture.saved('display_zoom')).toEqual({ value: '1' });
      await display.applyZoomLevel(true);
      expect(display.useDisplayZoomStore.getState().selectedFactor).toBe(1.25);
      restore();
      await display.retryDisplayZoom();
      expect(display.useDisplayZoomStore.getState().phase).toBe('saved');
      expect(fixture.saved('display_zoom')).toEqual({ value: '1.25' });
      const snapshot = await client.inspectAdministrationSettings();
      expect(snapshot.values.displayZoom).toBe(1.25);
      expect(snapshot.unsavedKeys).not.toContain('displayZoom');
      expect(
        ports.capture.mock.calls.some(
          ([, properties]) =>
            (properties as Record<string, unknown>)?.outcome_kind === 'preference_recovered'
        )
      ).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it('recovers the real palette projection without saving another failed native preference', async () => {
    const fixture = connectedPreferences();
    try {
      const client = await import('./administration-client');
      const palette = await import('../features/design/color-scheme-store');
      const store = palette.useAssemblyColorSchemeStore;
      await vi.waitFor(() => expect(store.getState().assemblyColorScheme).toBe('carbon'));
      const originalPalette = localStorage.getItem('waypoint-assembly-color-scheme');
      const restore = fixture.refuse(['theme', 'assemblyColorScheme']);
      await client.changeAdministrationSettings({ theme: 'system' });
      store.getState().setAssemblyColorScheme('okabeIto');
      await vi.waitFor(() => expect(store.getState().phase).toBe('unsaved'));
      expect(store.getState().assemblyColorScheme).toBe('okabeIto');
      expect(localStorage.getItem('waypoint-assembly-color-scheme')).toBe(originalPalette);
      expect(fixture.saved('native_assembly_color_scheme')).toEqual({ value: 'carbon' });
      restore();
      store.getState().retryPersistence();
      await vi.waitFor(() => expect(store.getState().phase).toBe('saved'));
      expect(JSON.parse(localStorage.getItem('waypoint-assembly-color-scheme')!)).toEqual({
        state: { assemblyColorScheme: 'okabeIto' },
        version: 2,
      });
      expect(fixture.saved('native_assembly_color_scheme')).toEqual({ value: 'okabeIto' });
      expect(fixture.storage.readSettings()).toMatchObject({
        assemblyColorScheme: 'okabeIto',
        theme: 'light',
      });
      const snapshot = await client.inspectAdministrationSettings();
      expect(snapshot.unsavedKeys).toEqual(['theme']);
    } finally {
      fixture.close();
    }
  });
});

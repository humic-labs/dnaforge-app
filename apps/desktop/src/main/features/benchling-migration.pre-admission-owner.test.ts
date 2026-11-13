// @vitest-environment node
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as string[],
  coordinatorOptions: [] as Array<Record<string, unknown>>,
  validatorWindowGetter: null as null | (() => unknown),
  registeredDeps: [] as Array<Record<string, unknown>>,
  activeRun: { reject: false },
  captureOrigin: vi.fn(() => null),
  publishReceipt: vi.fn(() => true),
}));

vi.mock('../analytics', () => ({
  captureOptionalTelemetryOrigin: state.captureOrigin,
  enqueueOptionalAnalyticsEventFromReceipt: state.publishReceipt,
  onAnalyticsIdentity: vi.fn(() => () => undefined),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9',
    getPath: (name: string) => `/paths/${name}`,
  },
  shell: { trashItem: vi.fn(async () => undefined) },
}));
vi.mock('../benchling-migration/coordinator', () => ({
  LocalBenchlingMigrationCoordinator: class {
    constructor(options: Record<string, unknown>) {
      state.calls.push('construct');
      state.coordinatorOptions.push(options);
    }
    async getActiveRun() {
      state.calls.push('admission');
      if (state.activeRun.reject) throw new Error('journal unreadable');
      return null;
    }
    publishTelemetry() {
      state.calls.push('publish-telemetry');
    }
  },
}));
vi.mock('../benchling-migration/renderer-validation', () => ({
  createRendererMigrationRenderValidator: (getMainWindow: () => unknown) => {
    state.validatorWindowGetter = getMainWindow;
    return 'validator';
  },
}));
vi.mock('../benchling-migration/import-destination-survey', () => ({
  surveyImportDestinations: vi.fn(),
}));
vi.mock('../benchling-migration/local-export-source-preparation', () => ({
  prepareLocalBenchlingExportSource: vi.fn((input: unknown) => input),
}));
vi.mock('../ipc/benchling-migration', () => ({
  registerBenchlingMigrationHandlers: (deps: Record<string, unknown>) => {
    state.calls.push('register-ipc');
    state.registeredDeps.push(deps);
  },
}));
vi.mock('../ipc/database', () => ({ getDb: () => 'db' }));
vi.mock('../ipc/workspace-git', () => ({ managedRootDir: () => '/managed' }));
vi.mock('../provider-reference-service', () => ({ resolveStoredProviderReference: vi.fn() }));

async function loadFeature() {
  vi.resetModules();
  return import('./benchling-migration');
}

describe('Benchling migration feature', () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.coordinatorOptions.length = 0;
    state.registeredDeps.length = 0;
    state.validatorWindowGetter = null;
    state.activeRun.reject = false;
    state.captureOrigin.mockClear();
    state.publishReceipt.mockClear();
  });

  it('wires accepted-origin capture and committed publishing before recovery admission', async () => {
    const { benchlingMigrationFeature } = await loadFeature();
    await benchlingMigrationFeature.prepare?.({ getMainWindow: () => null });
    const telemetry = state.coordinatorOptions[0]?.telemetry;
    expect(telemetry).toMatchObject({
      captureOrigin: expect.any(Function),
      publish: expect.any(Function),
    });
    if (
      !telemetry ||
      typeof telemetry !== 'object' ||
      !('captureOrigin' in telemetry) ||
      typeof telemetry.captureOrigin !== 'function' ||
      !('publish' in telemetry) ||
      typeof telemetry.publish !== 'function'
    ) {
      throw new Error('Benchling telemetry ports were not installed.');
    }
    telemetry.captureOrigin();
    const readCommitted = () => null;
    telemetry.publish(readCommitted);
    expect(state.captureOrigin).toHaveBeenCalledOnce();
    expect(state.publishReceipt).toHaveBeenCalledWith(readCommitted);
    expect(state.calls).toEqual(['construct', 'admission']);
  });

  it('builds the coordinator with a render validator that reads the live main window', async () => {
    const { benchlingMigrationFeature } = await loadFeature();
    let current: BrowserWindow | null = { id: 1 } as BrowserWindow;
    await benchlingMigrationFeature.prepare?.({ getMainWindow: () => current });
    expect(state.coordinatorOptions[0]).toMatchObject({
      globalDb: 'db',
      managedRootDir: '/managed',
      appVersion: '9.9.9',
      renderValidator: 'validator',
    });
    const recreated = { id: 2 } as BrowserWindow;
    current = recreated;
    expect(state.validatorWindowGetter?.()).toBe(recreated);
    current = null;
    expect(state.validatorWindowGetter?.()).toBeNull();
  });

  it('admits interrupted imports during prepare, before any IPC is registered', async () => {
    const { benchlingMigrationFeature } = await loadFeature();
    await benchlingMigrationFeature.prepare?.({ getMainWindow: () => null });
    expect(state.calls).toEqual(['construct', 'admission']);
  });

  it('logs a failed recovery admission instead of failing startup', async () => {
    const { benchlingMigrationFeature } = await loadFeature();
    state.activeRun.reject = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      benchlingMigrationFeature.prepare?.({ getMainWindow: () => null })
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[BenchlingMigration] startup recovery admission failed',
      expect.any(Error)
    );
    error.mockRestore();
  });

  it('refuses to register IPC before it has been prepared', async () => {
    const { benchlingMigrationFeature, preparedBenchlingMigrationCoordinator } =
      await loadFeature();
    expect(() => benchlingMigrationFeature.registerIpc?.()).toThrow(/has not been prepared/);
    expect(() => preparedBenchlingMigrationCoordinator()).toThrow(/has not been prepared/);
    expect(state.calls).toEqual([]);
  });

  it('registers its handlers with the prepared coordinator and export staging root', async () => {
    const { benchlingMigrationFeature, preparedBenchlingMigrationCoordinator } =
      await loadFeature();
    await benchlingMigrationFeature.prepare?.({ getMainWindow: () => null });
    const dispose = benchlingMigrationFeature.registerIpc?.();
    expect(dispose).toBeTypeOf('function');
    const deps = state.registeredDeps[0] as {
      coordinator: unknown;
      prepareLocalExportSource: (sourcePath: string) => unknown;
    };
    expect(deps.coordinator).toBe(preparedBenchlingMigrationCoordinator());
    expect(deps.prepareLocalExportSource('/exports/a.zip')).toEqual({
      sourcePath: '/exports/a.zip',
      stagingRootDir: '/paths/temp/dnaforge-benchling-prepared-exports',
    });
  });

  it('has no window, quit or shutdown work', async () => {
    const { benchlingMigrationFeature } = await loadFeature();
    expect(benchlingMigrationFeature.onMainWindow).toBeUndefined();
    expect(benchlingMigrationFeature.willQuit).toBeUndefined();
    expect(benchlingMigrationFeature.shutdown).toBeUndefined();
  });
});

it('passes the exact live native main-window closure from prepare into later parameterless IPC registration', async () => {
  const { benchlingMigrationFeature } = await loadFeature();
  let current: unknown = { id: 'original-main' };
  const getMainWindow = () => current;
  const prepare = benchlingMigrationFeature.prepare;
  if (!prepare) throw Error('Feature prepare missing');
  await Reflect.apply(prepare, undefined, [{ getMainWindow }]);
  const stop = benchlingMigrationFeature.registerIpc?.();
  const deps = state.registeredDeps[0];
  expect(deps?.getMainWindow).toBe(getMainWindow);
  const getter = deps?.getMainWindow;
  if (typeof getter !== 'function') throw Error('Native main-window owner getter missing');
  expect(getter()).toBe(current);
  current = { id: 'replacement-main' };
  expect(getter()).toBe(current);
  stop?.();
});

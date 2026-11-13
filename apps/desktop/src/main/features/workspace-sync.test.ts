// @vitest-environment node
import { readFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

type FakeOptions = { options: Record<string, unknown> };
type FakePublisher = FakeOptions & {
  start: Mock;
  stop: Mock;
  prepare: Mock;
  publish: Mock;
  abort: Mock;
};
type FakeScheduler = FakeOptions & { schedule: Mock; runNow: Mock; stop: Mock };
type FakeRuntime = FakeOptions & {
  db: unknown;
  recoverReplicaPullsBeforeRenderer: Mock;
  start: Mock;
  stop: Mock;
  invalidateBoundWorkspaces: Mock;
  runDueUploads: Mock;
  pullNewerRemotes: Mock;
};
type FakeCoordinator = FakeOptions & {
  deps: Record<string, unknown>;
  trigger: Mock;
  start: Mock;
  stop: Mock;
};
type Listener = (state: { status: string; session?: { accountId: string } }) => void;
type Readiness = { shellReady: boolean; loadId: string } | undefined;

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  const instances = {
    publisher: [] as FakePublisher[],
    scheduler: [] as FakeScheduler[],
    runtime: [] as FakeRuntime[],
    coordinator: [] as FakeCoordinator[],
  };
  return {
    order,
    instances,
    readiness: new Map<number, Readiness>(),
    authListener: { value: null as Listener | null },
    authState: {
      value: { status: 'signed-out' } as { status: string; session?: { accountId: string } },
    },
    unsubscribe: vi.fn(() => order.push('auth:unsubscribe')),
    statusPublisher: { invalidate: vi.fn() },
    actions: {
      listOrganizations: vi.fn(),
      syncOrganizationRegistry: vi.fn(),
      forceSync: vi.fn(),
    } as Record<string, unknown>,
    createActions: vi.fn(),
    reconcile: vi.fn(),
    recordMerge: vi.fn(),
    read: vi.fn(),
    resolve: vi.fn(),
    quiesced: vi.fn(),
    send: vi.fn(),
    ipcOn: vi.fn(),
    ipcOff: vi.fn(),
    appOn: vi.fn(),
    appOff: vi.fn(),
    cachedIds: vi.fn(),
    restoreConfigure: vi.fn(),
    restorePublish: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9',
    getPath: () => '/user-data',
    on: mocks.appOn,
    removeListener: mocks.appOff,
  },
}));
vi.mock('../../shared/ipc-contract', () => ({
  mainIpc: { on: mocks.ipcOn, removeListener: mocks.ipcOff },
  sendRendererIpc: mocks.send,
}));
vi.mock('../auth/controller', () => ({
  getAuthState: () => mocks.authState.value,
  subscribeAuthState: (listener: Listener) => {
    mocks.authListener.value = listener;
    return mocks.unsubscribe;
  },
}));
vi.mock('../ipc/database', () => ({ getDb: () => 'db' }));
vi.mock('../ipc/shell-readiness', () => ({
  getShellReadiness: (contents: { id: number }) => mocks.readiness.get(contents.id),
}));
vi.mock('../ipc/workspace-sync', () => ({
  getDefaultStatusPublisher: () => mocks.statusPublisher,
}));
vi.mock('../org-registry-sync-cache', () => ({
  listOrgRegistryCachedOrganizationIds: mocks.cachedIds,
}));
vi.mock('../org-registry-sync-coordinator', () => ({
  OrganizationRegistrySyncCoordinator: class {
    trigger: Mock = vi.fn().mockImplementation((reason: string) => {
      mocks.order.push(`registry:${reason}`);
    });
    start: Mock = vi.fn().mockImplementation(async () => {
      mocks.order.push('registry:start');
    });
    stop: Mock = vi.fn().mockImplementation(() => {
      mocks.order.push('registry:stop');
    });
    constructor(
      public deps: Record<string, unknown>,
      public options: Record<string, unknown>
    ) {
      mocks.instances.coordinator.push(this);
    }
  },
}));
vi.mock('../workspace-sync-restore-telemetry', () => ({
  configureWorkspaceSyncRestoreTelemetry: mocks.restoreConfigure,
  publishWorkspaceSyncRestoreTelemetry: mocks.restorePublish,
}));
vi.mock('../workspace-sync-actions', () => ({
  createWorkspaceSyncActionHandlers: mocks.createActions,
  withWorkspaceSyncReplacementSourceQuiesced: mocks.quiesced,
}));
vi.mock('../workspace-sync-projects', () => ({
  createWorkspaceSyncProjectsClient: () => 'client',
}));
vi.mock('../workspace-sync-reconcile-runtime', () => ({
  reconcileWorkspaceSyncConflict: mocks.reconcile,
  readWorkspaceSyncMergeConflict: mocks.read,
  resolveWorkspaceSyncMergeConflict: mocks.resolve,
}));
vi.mock('../workspace-sync-reconcile-scheduler', () => ({
  WorkspaceSyncReconcileScheduler: class {
    schedule: Mock = vi.fn();
    runNow: Mock = vi.fn().mockResolvedValue('ran-now');
    stop: Mock = vi.fn().mockImplementation(() => {
      mocks.order.push('scheduler:stop');
    });
    constructor(public options: Record<string, unknown>) {
      mocks.instances.scheduler.push(this);
    }
  },
}));
vi.mock('../workspace-sync-renewal-test-seam', () => ({
  workspaceSyncRenewalTestSeam: { actionDeps: () => ({ renewal: 'seam' }) },
}));
vi.mock('../workspace-sync-replica-publisher', () => ({
  WorkspaceSyncReplicaPublisher: class {
    start: Mock = vi.fn().mockImplementation(() => {
      mocks.order.push('publisher:start');
    });
    stop: Mock = vi.fn().mockImplementation(() => {
      mocks.order.push('publisher:stop');
    });
    prepare: Mock = vi.fn().mockResolvedValue('prepared');
    publish: Mock = vi.fn().mockResolvedValue(undefined);
    abort: Mock = vi.fn();
    constructor(public options: Record<string, unknown>) {
      mocks.instances.publisher.push(this);
    }
  },
}));
vi.mock('../workspace-sync-runtime', () => ({
  WorkspaceSyncRuntime: class {
    recoverReplicaPullsBeforeRenderer: Mock = vi.fn().mockResolvedValue({ recovered: 0 });
    start: Mock = vi.fn().mockImplementation(async () => {
      mocks.order.push('runtime:start');
      return {
        recovery: { staleReclaimed: 0, accountBlocked: 0, accountUnblocked: 0 },
        drain: { processed: 0 },
      };
    });
    stop: Mock = vi.fn().mockImplementation(async () => {
      mocks.order.push('runtime:stop');
    });
    invalidateBoundWorkspaces: Mock = vi.fn().mockImplementation((reason: string) => {
      mocks.order.push(`invalidate:${reason}`);
    });
    runDueUploads: Mock = vi.fn().mockImplementation(async () => {
      mocks.order.push('runtime:uploads');
    });
    pullNewerRemotes: Mock = vi.fn().mockImplementation(async () => {
      mocks.order.push('runtime:pull');
    });
    constructor(
      public db: unknown,
      public options: Record<string, unknown>
    ) {
      mocks.instances.runtime.push(this);
    }
  },
}));

vi.mock('../workspace-sync-status', () => ({
  recordWorkspaceSyncAutomaticMergeResult: mocks.recordMerge,
}));

import { createWorkspaceSync } from './workspace-sync';

function windowFor(id: number, destroyed = false) {
  const reload = vi.fn();
  const webContents = { id, isDestroyed: () => destroyed, reload: () => reload() };
  const window = { isDestroyed: () => destroyed, webContents } as BrowserWindow;
  return { window, webContents, reload };
}

function latest<T>(list: T[]): T {
  const item = list.at(-1);
  if (!item) throw new Error('expected an instance');
  return item;
}

function service(getMainWindow: () => BrowserWindow | null = () => null) {
  const sync = createWorkspaceSync();
  sync.startReplicaPublisher(getMainWindow);
  sync.createRuntime(getMainWindow);
  return sync;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.readiness.clear();
  mocks.authListener.value = null;
  mocks.authState.value = { status: 'signed-out' };
  Object.values(mocks.instances).forEach((list) => (list.length = 0));
  mocks.createActions.mockReturnValue(mocks.actions);
});

describe('workspace sync main service', () => {
  it('wires native restore receipts to the shared origin and committed publisher at bootstrap', async () => {
    const captureOptionalTelemetryOrigin = vi.fn(() => 'origin');
    const enqueueOptionalAnalyticsEventFromReceipt = vi.fn(() => true);
    vi.doMock('../analytics', () => ({
      trackAllowedEvent: vi.fn(),
      captureOptionalTelemetryOrigin,
      enqueueOptionalAnalyticsEventFromReceipt,
    }));
    try {
      mocks.authState.value = { status: 'signed-in', session: { accountId: 'account-a' } };
      service();
      await vi.waitFor(() => expect(mocks.restoreConfigure).toHaveBeenCalledTimes(1));
      const adapter = mocks.restoreConfigure.mock.calls[0]?.[0];
      expect(adapter.currentAccountId()).toBe('account-a');
      expect(adapter.captureOrigin()).toBe('origin');
      expect(captureOptionalTelemetryOrigin).toHaveBeenCalledWith('account-a');
      const read = () => null;
      expect(adapter.publish(read)).toBe(true);
      expect(enqueueOptionalAnalyticsEventFromReceipt).toHaveBeenCalledWith(read);
      expect(mocks.restorePublish).toHaveBeenCalledWith('db');
      mocks.authState.value = { status: 'signed-out' };
      expect(adapter.captureOrigin()).toBeNull();
      expect(adapter.currentAccountId()).toBeNull();
    } finally {
      vi.doUnmock('../analytics');
    }
  });

  it.each([
    ['runtime', 'module'],
    ['organization', 'module'],
    ['sign-out', 'module'],
    ['organization', 'callback'],
    ['sign-out', 'callback'],
  ] as const)(
    'keeps %s work independent of optional analytics %s failure',
    async (phase, failure) => {
      const rejections: unknown[] = [];
      const rejected = (reason: unknown) => rejections.push(reason);
      process.on('unhandledRejection', rejected);
      const faultInvocations: string[] = [];
      let observedFault: () => void = () => undefined;
      const faultObserved = new Promise<void>((resolve) => {
        observedFault = resolve;
      });
      const setAnalyticsOrganization = vi.fn(async () => {});
      vi.resetModules();
      vi.doMock('../analytics', () => {
        if (failure === 'callback') faultInvocations.push('module');
        return { trackAllowedEvent: () => false, setAnalyticsOrganization };
      });
      let sync: ReturnType<typeof createWorkspaceSync> | null = null;
      const listed = { ok: true, organizations: [] };
      const listOrganizations = vi.fn(async () => listed);
      mocks.createActions.mockReturnValue({ ...mocks.actions, listOrganizations });
      try {
        if (phase !== 'runtime') {
          const current = await import('./workspace-sync');
          sync = current.createWorkspaceSync();
          sync.startReplicaPublisher(() => null);
          sync.createRuntime(() => null);
          sync.createActions(vi.fn(async () => undefined));
          sync.createOrganizationRegistry();
          if (phase === 'sign-out') sync.subscribeAuth(vi.fn());
          await vi.dynamicImportSettled();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(rejections, 'The runtime must settle before the selected fault.').toEqual([]);
          expect(sync.runtime()).not.toBeNull();
          expect(listOrganizations).not.toHaveBeenCalled();
        }
        if (failure === 'module') {
          vi.doUnmock('../analytics');
          vi.resetModules();
          vi.doMock('../analytics', () => {
            faultInvocations.push('module');
            observedFault();
            throw new Error(`Controlled optional analytics ${phase} module failure`);
          });
        } else {
          setAnalyticsOrganization.mockImplementation(async () => {
            faultInvocations.push('callback');
            observedFault();
            throw new Error(`Controlled optional analytics ${phase} callback failure`);
          });
        }
        if (phase === 'runtime') {
          vi.resetModules();
          const current = await import('./workspace-sync');
          sync = current.createWorkspaceSync();
          sync.startReplicaPublisher(() => null);
          sync.createRuntime(() => null);
          expect(sync.runtime()).not.toBeNull();
          expect(mocks.instances.runtime).toHaveLength(1);
        } else if (phase === 'organization') {
          const deps = latest(mocks.instances.coordinator).deps as {
            listOrganizations: () => Promise<unknown>;
          };
          await expect(deps.listOrganizations()).resolves.toBe(listed);
          expect(listOrganizations).toHaveBeenCalledTimes(1);
        } else {
          mocks.authListener.value?.({ status: 'signed-out' });
          expect(latest(mocks.instances.runtime).invalidateBoundWorkspaces).toHaveBeenCalledWith(
            'auth_changed'
          );
        }
        await vi.dynamicImportSettled();
        await faultObserved;
        await new Promise<void>((resolve) => setImmediate(resolve));
        await vi.waitFor(() =>
          expect(faultInvocations).toEqual(
            failure === 'module' ? ['module'] : ['module', 'callback']
          )
        );
        expect(rejections).toEqual([]);
      } finally {
        await sync?.stop();
        process.removeListener('unhandledRejection', rejected);
        vi.doUnmock('../analytics');
        vi.resetModules();
      }
    }
  );

  it('retains the registered sync observation and organization updates when analytics is available', async () => {
    const trackAllowedEvent = vi.fn(() => true);
    const setAnalyticsOrganization = vi.fn();
    vi.doMock('../analytics', () => ({ trackAllowedEvent, setAnalyticsOrganization }));
    vi.resetModules();
    const current = await import('./workspace-sync');
    const observations = await import('../workspace-sync-observation');
    observations.__resetWorkspaceSyncObservationForTests();
    const sync = current.createWorkspaceSync();
    try {
      const listed = { ok: true, organizations: [] };
      mocks.createActions.mockReturnValue({
        ...mocks.actions,
        listOrganizations: async () => listed,
      });
      sync.startReplicaPublisher(() => null);
      sync.createRuntime(() => null);
      await vi.dynamicImportSettled();
      observations.observeWorkspaceSync({ sync_operation: 'upload', sync_outcome: 'uploaded' });
      expect(trackAllowedEvent).toHaveBeenCalledExactlyOnceWith('workspace_sync_observed', {
        feature_area: 'workspace',
        sync_operation: 'upload',
        sync_outcome: 'uploaded',
      });
      sync.createActions(vi.fn(async () => undefined));
      sync.createOrganizationRegistry();
      const deps = latest(mocks.instances.coordinator).deps as {
        listOrganizations: () => Promise<unknown>;
      };
      await expect(deps.listOrganizations()).resolves.toBe(listed);
      sync.subscribeAuth(vi.fn());
      mocks.authListener.value?.({ status: 'signed-out' });
      await vi.dynamicImportSettled();
      expect(setAnalyticsOrganization.mock.calls).toEqual([[null], [null]]);
    } finally {
      await sync.stop();
      observations.__resetWorkspaceSyncObservationForTests();
      vi.doUnmock('../analytics');
      vi.resetModules();
    }
  });

  it('lets the replica publisher reach only the current, ready renderer load', () => {
    let current: BrowserWindow | null = null;
    service(() => current);
    const options = latest(mocks.instances.publisher).options as {
      getTarget: () => unknown;
      send: (target: { id: number; generation: string }, event: unknown) => void;
      reloadTarget: (target: { id: number; generation: string }) => void;
      subscribeAck: (listener: (id: number, ack: unknown) => void) => () => void;
    };
    expect(mocks.order).toEqual(['publisher:start']);
    expect(options.getTarget()).toBeNull();

    const { window, webContents, reload } = windowFor(7);
    current = window;
    mocks.readiness.set(7, { shellReady: false, loadId: 'load-1' });
    expect(options.getTarget()).toBeNull();
    mocks.readiness.set(7, { shellReady: true, loadId: 'load-1' });
    expect(options.getTarget()).toMatchObject({ id: 7, generation: 'load-1' });

    options.send({ id: 7, generation: 'load-1' }, { replica: 1 });
    expect(mocks.send).toHaveBeenCalledWith(webContents, 'cloudSync:replicaApplied', {
      replica: 1,
    });
    expect(() => options.send({ id: 7, generation: 'load-0' }, {})).toThrow(
      'Replica refresh target is no longer available.'
    );
    options.reloadTarget({ id: 7, generation: 'load-0' });
    expect(reload).not.toHaveBeenCalled();
    options.reloadTarget({ id: 7, generation: 'load-1' });
    expect(reload).toHaveBeenCalledTimes(1);

    const acks: unknown[] = [];
    const dispose = options.subscribeAck((id, ack) => acks.push([id, ack]));
    const handler = mocks.ipcOn.mock.calls[0]?.[1] as (event: unknown, ack: unknown) => void;
    expect(mocks.ipcOn.mock.calls[0]?.[0]).toBe('cloudSync:replicaAppliedAck');
    handler({ sender: { id: 7 } }, 'ok');
    dispose();
    expect(acks).toEqual([[7, 'ok']]);
    expect(mocks.ipcOff).toHaveBeenCalledWith('cloudSync:replicaAppliedAck', handler);
  });

  it('wires the runtime and reconciliation to one replica publisher and status publisher', async () => {
    let current: BrowserWindow | null = null;
    service(() => current);
    const publisher = latest(mocks.instances.publisher);
    const runtime = latest(mocks.instances.runtime);
    const scheduler = latest(mocks.instances.scheduler);
    const options = runtime.options as {
      appVersion: string;
      uploadSnapshotRoot: string;
      statusPublisher: unknown;
      isRendererReady: () => boolean;
      prepareReplicaApply: (event: unknown) => unknown;
      onConflictDetected: (uuid: string) => void;
    };

    expect(runtime.db).toBe('db');
    expect(options).toMatchObject({
      appVersion: '9.9.9',
      uploadSnapshotRoot: '/user-data/workspace-sync-upload-snapshots',
      statusPublisher: mocks.statusPublisher,
      replicaClient: 'client',
    });
    expect(options.isRendererReady()).toBe(false);
    const { window } = windowFor(3);
    current = window;
    mocks.readiness.set(3, { shellReady: true, loadId: 'load-3' });
    expect(options.isRendererReady()).toBe(true);
    await expect(options.prepareReplicaApply({ e: 1 })).resolves.toBe('prepared');
    expect(publisher.prepare).toHaveBeenCalledWith({ e: 1 });
    options.onConflictDetected('ws-1');
    expect(scheduler.schedule).toHaveBeenCalledWith('ws-1');

    const schedulerOptions = scheduler.options as {
      reconcile: (uuid: string) => unknown;
      onSettled: (
        uuid: string,
        result: { ok: boolean; outcome?: string; message?: string }
      ) => void;
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    schedulerOptions.reconcile('ws-2');
    const deps = mocks.reconcile.mock.calls[0]?.[2] as {
      appVersion: string;
      invalidateStatus: (uuid: string) => void;
      withWorkspaceQuiesced: (uuid: string, operation: () => unknown) => unknown;
    };
    expect(mocks.reconcile).toHaveBeenCalledWith('db', 'ws-2', deps);
    expect(deps.appVersion).toBe('9.9.9');
    deps.invalidateStatus('ws-2');
    expect(mocks.statusPublisher.invalidate).toHaveBeenCalledWith('ws-2', 'queue_changed');
    const operation = vi.fn();
    deps.withWorkspaceQuiesced('ws-2', operation);
    expect(mocks.quiesced).toHaveBeenCalledWith(runtime, 'ws-2', operation);
    schedulerOptions.onSettled('ws-2', { ok: true, outcome: 'merged' });
    expect(runtime.runDueUploads).toHaveBeenCalledTimes(1);
    schedulerOptions.onSettled('ws-2', { ok: true, outcome: 'unchanged' });
    expect(runtime.runDueUploads).toHaveBeenCalledTimes(1);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.statusPublisher.invalidate.mockClear();
    const failed = { ok: false, message: 'Workspace manifest is not restorable' };
    schedulerOptions.onSettled('ws-2', failed);
    expect(mocks.recordMerge).toHaveBeenLastCalledWith('db', 'ws-2', failed, expect.any(Number));
    expect(mocks.statusPublisher.invalidate).toHaveBeenCalledWith('ws-2', 'queue_changed');
    expect(runtime.runDueUploads).toHaveBeenCalledTimes(1);
  });

  it('creates actions, the organization registry and the IPC dependencies in order', () => {
    const sync = service();
    expect(sync.ipcDependencies()).toBeUndefined();
    expect(() => sync.createOrganizationRegistry()).toThrow('Workspace sync actions is not ready.');

    const openExternal = vi.fn(async () => undefined);
    expect(sync.createActions(openExternal)).toBe(mocks.actions);
    const actionOptions = mocks.createActions.mock.calls[0]?.[1] as {
      runtime: unknown;
      statusPublisher: unknown;
      openExternal: unknown;
      reconcile: { run: (uuid: string) => unknown };
      renewal: string;
    };
    expect(mocks.createActions.mock.calls[0]?.[0]).toBe('db');
    expect(actionOptions).toMatchObject({
      runtime: latest(mocks.instances.runtime),
      statusPublisher: mocks.statusPublisher,
      openExternal,
      renewal: 'seam',
    });
    actionOptions.reconcile.run('ws-1');
    expect(latest(mocks.instances.scheduler).runNow).toHaveBeenCalledWith('ws-1');
    expect(sync.ipcDependencies()).toEqual({
      statusPublisher: mocks.statusPublisher,
      actions: mocks.actions,
    });

    sync.createOrganizationRegistry();
    const coordinator = latest(mocks.instances.coordinator);
    expect(mocks.appOn).toHaveBeenCalledWith('browser-window-focus', expect.any(Function));
    (mocks.appOn.mock.calls[0]?.[1] as () => void)();
    expect(coordinator.trigger).toHaveBeenCalledWith('focus');
  });

  it('keeps scientific restore actions attached to the same renderer replica lifecycle', async () => {
    const sync = service();
    sync.createActions(vi.fn(async () => undefined));
    const publisher = latest(mocks.instances.publisher);
    const options = mocks.createActions.mock.calls[0]?.[1] as {
      scientificReplica: {
        onReplicaPreparing: (event: unknown) => Promise<unknown>;
        onReplicaApplied: (preparationId: string, event: unknown) => Promise<void>;
        onReplicaAborted: (preparationId: string, event: unknown) => void;
      };
    };
    const event = { workspaceUuid: 'ws-1', source: 'scientific-history' };
    await expect(options.scientificReplica.onReplicaPreparing(event)).resolves.toBe('prepared');
    await options.scientificReplica.onReplicaApplied('prepared', event);
    options.scientificReplica.onReplicaAborted('prepared', event);
    expect(publisher.prepare).toHaveBeenCalledWith(event);
    expect(publisher.publish).toHaveBeenCalledWith('prepared', event);
    expect(publisher.abort).toHaveBeenCalledWith('prepared', event);
  });

  it('refuses a registry without the organization actions', () => {
    mocks.createActions.mockReturnValue({ forceSync: vi.fn() });
    const sync = service();
    sync.createActions(vi.fn(async () => undefined));
    expect(() => sync.createOrganizationRegistry()).toThrow(
      'Organization Registry background sync actions are unavailable.'
    );
  });

  it('reacts to auth in the original order and starts the registry before the runtime', async () => {
    const sync = service();
    sync.createActions(vi.fn(async () => undefined));
    sync.createOrganizationRegistry();
    sync.subscribeAuth(() => mocks.order.push('signed-in-hook'));
    mocks.order.length = 0;

    mocks.authListener.value?.({ status: 'signed-out' });
    expect(mocks.order).toEqual(['invalidate:auth_changed']);

    mocks.order.length = 0;
    mocks.authListener.value?.({ status: 'signed-in' });
    await vi.waitFor(() => expect(mocks.order).toContain('runtime:pull'));
    expect(mocks.order).toEqual([
      'invalidate:auth_changed',
      'signed-in-hook',
      'registry:auth',
      'runtime:uploads',
      'runtime:pull',
    ]);

    mocks.order.length = 0;
    sync.start();
    await vi.waitFor(() => expect(mocks.order).toEqual(['registry:start', 'runtime:start']));
  });

  it('finishes due uploads before a screen-ready pull while retaining invalidation', async () => {
    const sync = service();
    const runtime = latest(mocks.instances.runtime);
    let finishUploads: (() => void) | undefined;
    runtime.runDueUploads.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          mocks.order.push('runtime:uploads');
          finishUploads = resolve;
        })
    );
    sync.pullAfterRendererReady();
    sync.invalidateBoundWorkspaces('dirty_changed');
    expect(mocks.order).toEqual(['publisher:start', 'runtime:uploads', 'invalidate:dirty_changed']);
    expect(runtime.pullNewerRemotes).not.toHaveBeenCalled();
    expect(finishUploads).toBeTypeOf('function');
    finishUploads?.();
    await vi.waitFor(() => expect(runtime.pullNewerRemotes).toHaveBeenCalledTimes(1));
    expect(mocks.order).toEqual([
      'publisher:start',
      'runtime:uploads',
      'invalidate:dirty_changed',
      'runtime:pull',
    ]);
    expect(sync.runtime()).toBe(runtime);
  });

  it('stops in the original order and only once', async () => {
    const sync = service();
    sync.createActions(vi.fn(async () => undefined));
    sync.createOrganizationRegistry();
    sync.subscribeAuth(() => undefined);
    const focusListener = mocks.appOn.mock.calls[0]?.[1];
    mocks.order.length = 0;

    await sync.stop();

    expect(mocks.order).toEqual([
      'auth:unsubscribe',
      'registry:stop',
      'publisher:stop',
      'scheduler:stop',
      'runtime:stop',
    ]);
    expect(mocks.appOff).toHaveBeenCalledWith('browser-window-focus', focusListener);
    expect(sync.runtime()).toBeNull();

    mocks.order.length = 0;
    await sync.stop();
    expect(mocks.order).toEqual(['scheduler:stop']);
  });

  it('keeps every start and stop call at its original position in the main-process root', () => {
    const root = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const at = (text: string) => {
      expect(root.split(text), text).toHaveLength(2);
      return root.indexOf(text);
    };
    const startup = [
      'workspaceSync.startReplicaPublisher(() => mainWindowRef);',
      'workspaceSync.createRuntime(() => mainWindowRef);',
      'await workspaceSync.recoverReplicaPullsBeforeRenderer();',
      'await purgeExpiredTrashedWorkspaces(getDb(), managedRootDir())',
      'await prepareMainFeatures(mainFeatureContext);',
      'workspaceSync.createActions((url) => shell.openExternal(url), mainFeatureContext.getMainWindow);',
      'workspaceSync.createOrganizationRegistry();',
      'registerAllIpcHandlers({',
      'workspaceSync.subscribeAuth(() => mainFeaturesSignedIn(mainFeatureContext));',
      'workspaceSync.start();',
      "workspaceSync.invalidateBoundWorkspaces('dirty_changed');",
    ].map(at);
    expect(startup).toEqual([...startup].sort((a, b) => a - b));
    expect(startup.at(-1)).toBeLessThan(
      root.lastIndexOf('const mainWindow = await createWindow();')
    );

    const quit = [
      "name: 'native document renderer publisher'",
      "{ name: 'workspace sync runtime', run: () => workspaceSync.stop() },",
      "{ name: 'database', run: closeDatabase },",
    ].map(at);
    expect(quit).toEqual([...quit].sort((a, b) => a - b));
    expect(root).not.toMatch(/workspaceSyncRuntimeRef|stopWorkspaceSyncRuntime/);
  });
});

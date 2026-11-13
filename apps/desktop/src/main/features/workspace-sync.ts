import {
  configureWorkspaceSyncRestoreTelemetry,
  publishWorkspaceSyncRestoreTelemetry,
} from '../workspace-sync-restore-telemetry';
import { app, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { mainIpc, sendRendererIpc } from '../../shared/ipc-contract';
import { getAuthState, subscribeAuthState } from '../auth/controller';
import { getDb } from '../ipc/database';
import { getShellReadiness } from '../ipc/shell-readiness';
import { getDefaultStatusPublisher } from '../ipc/workspace-sync';
import { listOrgRegistryCachedOrganizationIds } from '../org-registry-sync-cache';
import { OrganizationRegistrySyncCoordinator } from '../org-registry-sync-coordinator';
import { subscribeOrganizationRegistryPublicationWake } from '../org-registry-publication-wake';
import {
  createWorkspaceSyncActionHandlers,
  withWorkspaceSyncReplacementSourceQuiesced,
} from '../workspace-sync-actions';
import { createWorkspaceSyncProjectsClient } from '../workspace-sync-projects';
import {
  readWorkspaceSyncMergeConflict,
  reconcileWorkspaceSyncConflict,
  resolveWorkspaceSyncMergeConflict,
  type WorkspaceSyncReconcileDeps,
} from '../workspace-sync-reconcile-runtime';
import { analyticsOrganizationId } from '../../shared/analytics-organization';
import {
  bindWorkspaceSyncObservationSink,
  observeWorkspaceSyncReconcile,
} from '../workspace-sync-observation';
import { WorkspaceSyncReconcileScheduler } from '../workspace-sync-reconcile-scheduler';
import { workspaceSyncRenewalTestSeam } from '../workspace-sync-renewal-test-seam';
import { WorkspaceSyncReplicaPublisher } from '../workspace-sync-replica-publisher';
import { WorkspaceSyncRuntime } from '../workspace-sync-runtime';
import {
  configureWorkspaceSyncUploadTelemetry,
  publishWorkspaceSyncUploadTelemetry,
} from '../workspace-sync-upload-telemetry';
import {
  configureWorkspaceSyncRecoveryTelemetry,
  publishWorkspaceSyncRecoveryTelemetry,
} from '../workspace-sync-recovery-telemetry';
import {
  configureWorkspaceSyncEnablementTelemetry,
  publishWorkspaceSyncEnablementTelemetry,
} from '../workspace-sync-enablement-telemetry';
import { recordWorkspaceSyncAutomaticMergeResult } from '../workspace-sync-status';

type GetMainWindow = () => BrowserWindow | null;
type StatusPublisher = ReturnType<typeof getDefaultStatusPublisher>;
type WorkspaceSyncActions = ReturnType<typeof createWorkspaceSyncActionHandlers>;
type InvalidationReason = Parameters<WorkspaceSyncRuntime['invalidateBoundWorkspaces']>[0];

function runOptionalAnalytics(operation: (analytics: typeof import('../analytics')) => void): void {
  void import('../analytics').then(operation).catch(() => {});
}

export function createWorkspaceSync() {
  let runtime: WorkspaceSyncRuntime | null = null;
  let replicaPublisher: WorkspaceSyncReplicaPublisher | null = null;
  let reconcileScheduler: WorkspaceSyncReconcileScheduler | null = null;
  let authUnsubscribe: (() => void) | null = null;
  let organizationRegistry: OrganizationRegistrySyncCoordinator | null = null;
  let organizationRegistryFocusListener: (() => void) | null = null;
  let unsubscribeRegistryPublication: (() => void) | null = null;
  let statusPublisher: StatusPublisher | null = null;
  let reconcileDeps: WorkspaceSyncReconcileDeps | null = null;
  let actions: WorkspaceSyncActions | null = null;

  function required<T>(value: T | null, part: string): T {
    if (value === null) throw new Error(`Workspace sync ${part} is not ready.`);
    return value;
  }

  function startReplicaPublisher(getMainWindow: GetMainWindow): void {
    replicaPublisher = new WorkspaceSyncReplicaPublisher({
      getTarget: () => {
        const window = getMainWindow();
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null;
        const readiness = getShellReadiness(window.webContents);
        if (!readiness?.shellReady) return null;
        return {
          id: window.webContents.id,
          generation: readiness.loadId,
          isDestroyed: () => window.isDestroyed() || window.webContents.isDestroyed(),
        };
      },
      send: (target, event) => {
        const window = getMainWindow();
        if (
          !window ||
          window.isDestroyed() ||
          window.webContents.isDestroyed() ||
          window.webContents.id !== target.id ||
          getShellReadiness(window.webContents)?.loadId !== target.generation
        ) {
          throw new Error('Replica refresh target is no longer available.');
        }
        sendRendererIpc(window.webContents, 'cloudSync:replicaApplied', event);
      },
      subscribeAck: (listener) => {
        const handler = (event: Electron.IpcMainEvent, ack: unknown): void => {
          listener(event.sender.id, ack);
        };
        mainIpc.on('cloudSync:replicaAppliedAck', handler);
        return () => {
          mainIpc.removeListener('cloudSync:replicaAppliedAck', handler);
        };
      },
      reloadTarget: (target) => {
        const window = getMainWindow();
        if (
          !window ||
          window.isDestroyed() ||
          window.webContents.isDestroyed() ||
          window.webContents.id !== target.id ||
          getShellReadiness(window.webContents)?.loadId !== target.generation
        ) {
          return;
        }
        window.webContents.reload();
      },
      warn: (message) => console.warn(message),
    });
    replicaPublisher.start();
  }

  function createRuntime(getMainWindow: GetMainWindow): void {
    runOptionalAnalytics((analytics) => {
      const { trackAllowedEvent } = analytics;
      bindWorkspaceSyncObservationSink((observation) =>
        trackAllowedEvent('workspace_sync_observed', observation)
      );
      const captureOrigin = () => {
        const auth = getAuthState();
        return auth.status === 'signed-in'
          ? analytics.captureOptionalTelemetryOrigin(auth.session.accountId)
          : null;
      };
      const currentAccountId = () => {
        const auth = getAuthState();
        return auth.status === 'signed-in' ? auth.session.accountId : null;
      };
      configureWorkspaceSyncUploadTelemetry({
        captureOrigin,
        currentAccountId,
        publish: (readCommitted) =>
          analytics.enqueueOptionalAnalyticsEventFromReceipt(readCommitted),
      });
      configureWorkspaceSyncRecoveryTelemetry({
        captureOrigin,
        currentAccountId,
        publish: (readCommitted) =>
          analytics.enqueueOptionalAnalyticsEventFromReceipt(readCommitted),
      });
      configureWorkspaceSyncEnablementTelemetry({
        captureOrigin,
        currentAccountId,
        publish: (readCommitted) =>
          analytics.enqueueOptionalAnalyticsEventFromReceipt(readCommitted),
      });
      publishWorkspaceSyncUploadTelemetry(getDb());
      publishWorkspaceSyncRecoveryTelemetry(getDb());
      configureWorkspaceSyncRestoreTelemetry({
        captureOrigin,
        currentAccountId,
        publish: (readCommitted) =>
          analytics.enqueueOptionalAnalyticsEventFromReceipt(readCommitted),
      });
      publishWorkspaceSyncEnablementTelemetry(getDb());
      publishWorkspaceSyncRestoreTelemetry(getDb());
    });
    const publisher = getDefaultStatusPublisher();
    statusPublisher = publisher;
    const deps: WorkspaceSyncReconcileDeps = {
      appVersion: app.getVersion(),
      prepareReplicaApply: (event) => replicaPublisher?.prepare(event) ?? Promise.resolve(null),
      publishReplicaApplied: (preparationId, event) =>
        replicaPublisher?.publish(preparationId, event) ?? Promise.resolve(),
      abortReplicaApply: (preparationId, event) => replicaPublisher?.abort(preparationId, event),
      withWorkspaceQuiesced: (workspaceUuid, operation) =>
        runtime
          ? withWorkspaceSyncReplacementSourceQuiesced(runtime, workspaceUuid, operation)
          : operation(),
      invalidateStatus: (workspaceUuid) => publisher.invalidate(workspaceUuid, 'queue_changed'),
    };
    reconcileDeps = deps;
    reconcileScheduler = new WorkspaceSyncReconcileScheduler({
      reconcile: (workspaceUuid) => reconcileWorkspaceSyncConflict(getDb(), workspaceUuid, deps),
      onSettled: (workspaceUuid, result) => {
        try {
          recordWorkspaceSyncAutomaticMergeResult(getDb(), workspaceUuid, result, Date.now());
          publisher.invalidate(workspaceUuid, 'queue_changed');
        } catch (error) {
          console.warn(`[WorkspaceSyncReconcile] ${workspaceUuid}: status not recorded`, error);
        }
        observeWorkspaceSyncReconcile(workspaceUuid, result);
        if (result.ok) {
          console.log(`[WorkspaceSyncReconcile] ${workspaceUuid}: ${result.outcome}`);
          if (result.outcome === 'merged') void runtime?.runDueUploads();
        } else {
          console.warn(`[WorkspaceSyncReconcile] ${workspaceUuid}: ${result.message}`);
        }
      },
    });
    runtime = new WorkspaceSyncRuntime(getDb(), {
      appVersion: app.getVersion(),
      uploadSnapshotRoot: join(app.getPath('userData'), 'workspace-sync-upload-snapshots'),
      statusPublisher: publisher,
      replicaClient: createWorkspaceSyncProjectsClient(),
      isRendererReady: () => {
        const contents = getMainWindow()?.webContents;
        return !!contents && !!getShellReadiness(contents)?.shellReady;
      },
      prepareReplicaApply: (event) => replicaPublisher?.prepare(event) ?? Promise.resolve(null),
      publishReplicaApplied: (preparationId, event) =>
        replicaPublisher?.publish(preparationId, event) ?? Promise.resolve(),
      abortReplicaApply: (preparationId, event) => replicaPublisher?.abort(preparationId, event),
      onConflictDetected: (workspaceUuid) => reconcileScheduler?.schedule(workspaceUuid),
    });
  }

  function recoverReplicaPullsBeforeRenderer() {
    return required(runtime, 'runtime').recoverReplicaPullsBeforeRenderer();
  }

  function createActions(
    openExternal: (url: string) => Promise<void>,
    getMainWindow: GetMainWindow = () => null
  ): WorkspaceSyncActions {
    const deps = required(reconcileDeps, 'reconciliation');
    actions = createWorkspaceSyncActionHandlers(getDb(), {
      runtime: required(runtime, 'runtime'),
      statusPublisher: required(statusPublisher, 'status publisher'),
      onRegistryChanged: (event) => {
        const window = getMainWindow();
        if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
          sendRendererIpc(window.webContents, 'cloudSync:organizationRegistryChanged', event);
        }
      },
      openExternal,
      scientificReplica: {
        onReplicaPreparing: (event) => replicaPublisher?.prepare(event) ?? Promise.resolve(null),
        onReplicaApplied: (preparationId, event) =>
          replicaPublisher?.publish(preparationId, event) ?? Promise.resolve(),
        onReplicaAborted: (preparationId, event) => replicaPublisher?.abort(preparationId, event),
      },
      reconcile: {
        run: (workspaceUuid) =>
          reconcileScheduler
            ? reconcileScheduler.runNow(workspaceUuid)
            : reconcileWorkspaceSyncConflict(getDb(), workspaceUuid, deps),
        read: (workspaceUuid) => readWorkspaceSyncMergeConflict(getDb(), workspaceUuid),
        resolve: (workspaceUuid, request) =>
          resolveWorkspaceSyncMergeConflict(getDb(), workspaceUuid, request, deps),
      },
      ...workspaceSyncRenewalTestSeam.actionDeps(),
    });
    return actions;
  }

  function createOrganizationRegistry(): void {
    const { listOrganizations, syncOrganizationRegistry } = required(actions, 'actions');
    if (!listOrganizations || !syncOrganizationRegistry) {
      throw new Error('Organization Registry background sync actions are unavailable.');
    }
    const coordinator = new OrganizationRegistrySyncCoordinator(
      {
        listOrganizations: async () => {
          const listed = await listOrganizations();
          if (listed.ok) {
            const organizationId = analyticsOrganizationId(listed.organizations);
            runOptionalAnalytics(({ setAnalyticsOrganization }) =>
              setAnalyticsOrganization(organizationId)
            );
          }
          return listed;
        },
        listCachedOrganizationIds: async () => {
          const authState = getAuthState();
          if (authState.status !== 'signed-in') return [];
          return listOrgRegistryCachedOrganizationIds(getDb(), {
            accountId: authState.session.accountId,
          });
        },
        syncOrganizationRegistry: (orgId) => syncOrganizationRegistry(orgId),
      },
      { shouldRun: () => getAuthState().status === 'signed-in' }
    );
    organizationRegistry = coordinator;
    unsubscribeRegistryPublication = subscribeOrganizationRegistryPublicationWake(getDb(), {
      currentAccountId: () => {
        const auth = getAuthState();
        return auth.status === 'signed-in' ? auth.session.accountId : null;
      },
      wake: () => {
        void coordinator.trigger('publication');
      },
      warn: (message) => console.warn(`[OrgRegistrySync] ${message}`),
    });
    organizationRegistryFocusListener = () => {
      void coordinator.trigger('focus');
    };
    app.on('browser-window-focus', organizationRegistryFocusListener);
  }

  function ipcDependencies() {
    return actions && statusPublisher ? { statusPublisher, actions } : undefined;
  }

  function subscribeAuth(onSignedIn: () => void): void {
    const coordinator = required(organizationRegistry, 'organization registry');
    authUnsubscribe = subscribeAuthState((state) => {
      runtime?.invalidateBoundWorkspaces('auth_changed');
      if (state.status !== 'signed-in') {
        runOptionalAnalytics(({ setAnalyticsOrganization }) => setAnalyticsOrganization(null));
        return;
      }
      onSignedIn();
      void coordinator.trigger('auth');
      const current = runtime;
      if (!current) return;
      void (async () => {
        await current.runDueUploads();
        await current.pullNewerRemotes();
      })().catch((err) => {
        console.warn(
          '[WorkspaceSyncRuntime] Auth-triggered sync retry failed:',
          err instanceof Error ? err.message : err
        );
      });
    });
  }

  function start(): void {
    void required(organizationRegistry, 'organization registry').start();
    void required(runtime, 'runtime')
      .start()
      .then((result) => {
        if (
          result.recovery.staleReclaimed > 0 ||
          result.recovery.accountBlocked > 0 ||
          result.recovery.accountUnblocked > 0 ||
          result.drain.processed > 0
        ) {
          console.log('[WorkspaceSyncRuntime] startup', result);
        }
      })
      .catch((err) => {
        console.warn(
          '[WorkspaceSyncRuntime] Startup failed:',
          err instanceof Error ? err.message : err
        );
      });
  }

  function invalidateBoundWorkspaces(reason: InvalidationReason): void {
    runtime?.invalidateBoundWorkspaces(reason);
  }

  function pullAfterRendererReady(): void {
    const current = runtime;
    if (!current) return;
    void (async () => {
      await current.runDueUploads();
      await current.pullNewerRemotes();
    })().catch((error) => {
      console.warn(
        '[WorkspaceSyncRuntime] Screen-ready sync retry failed:',
        error instanceof Error ? error.message : String(error)
      );
    });
  }

  async function stop(): Promise<void> {
    authUnsubscribe?.();
    authUnsubscribe = null;
    unsubscribeRegistryPublication?.();
    unsubscribeRegistryPublication = null;
    organizationRegistry?.stop();
    organizationRegistry = null;
    if (organizationRegistryFocusListener) {
      app.removeListener('browser-window-focus', organizationRegistryFocusListener);
      organizationRegistryFocusListener = null;
    }
    const current = runtime;
    runtime = null;
    replicaPublisher?.stop();
    reconcileScheduler?.stop();
    replicaPublisher = null;
    await current?.stop();
  }

  return {
    startReplicaPublisher,
    createRuntime,
    recoverReplicaPullsBeforeRenderer,
    createActions,
    createOrganizationRegistry,
    ipcDependencies,
    subscribeAuth,
    start,
    invalidateBoundWorkspaces,
    pullAfterRendererReady,
    stop,
    runtime: (): WorkspaceSyncRuntime | null => runtime,
  };
}

export type WorkspaceSyncService = ReturnType<typeof createWorkspaceSync>;

export const workspaceSync = createWorkspaceSync();

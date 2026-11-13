import { app } from 'electron';
import updaterPackage from 'electron-updater';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { getPriority } from 'node:os';

import type { BenchlingMigrationInstallState } from '../shared/benchling-migration-action-journal';
import { cancelRendererToolCallsForTurn, type AgentToolsBridgeServer } from './agent-tools-bridge';
import { getActiveFlowNonceForTest, getActiveLoopbackRedirectUriForTest } from './auth/controller';
import {
  getActiveStoredSession,
  getAllStoredSessions,
  setActiveAccount,
  updateSessionTokens,
} from './auth/session-store';
import {
  _cancelUpdateInstallIntentForTest,
  _emitUpdateDownloadedForTest,
  _setUpdateDownloadedForTest,
  installUpdate,
  prepareUpdateInstallIntent,
} from './auto-updater';
import { setMigrationJournalObserverForTest } from './benchling-migration/action-journal';
import { getDirtyState } from './dirty-state-cache';
import { preparedBenchlingMigrationCoordinator } from './features/benchling-migration';
import {
  setHostedCodexApprovalObserverForTest,
  didHostedCodexApprovalObservationFailForTest,
  type HostedCodexApprovalObservation,
} from './hosted-codex/hosted-gateway-workflow';
import { getDb } from './ipc/database';
import {
  createNativeDocumentMutationBarrier,
  type createNativeDocumentRendererPublisher,
} from './native-document-renderer';
import { nativeDocumentSettlementTestSeam } from './native-document-settlement-test-seam';
import {
  setSequenceSaveAfterProductForTest,
  type SequenceSaveProductCheckpoint,
} from './sequence-save-publication-test-seam';
import { setSequenceSaveVerificationForTest } from './sequence-save-verification-test-seam';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import { handleBeforeQuit } from './quit-orchestration';
import {
  getTestHealthProbeLatchState,
  getTestRefreshResultLatchState,
  killSidecar,
  releaseTestHealthProbe,
  releaseTestRefreshResult,
  setTestSidecarStatus,
  getSidecarProcessPid,
} from './sidecar';
import { sidecarFetch, sidecarSessionAuthority } from './sidecar-session-runtime';
import { setSequenceImportBeforeClaimForTest } from './workspace-git/import';
import {
  acquireWorkspaceSyncMutationLease,
  withWorkspaceMutation,
  workspaceMutationWaiterCountForTest,
} from './workspace-sync-mutation-lease';
import { openWorkspaceSyncProject } from './workspace-sync-projects';
import { workspaceSyncRenewalTestSeam } from './workspace-sync-renewal-test-seam';
import type { WorkspaceSyncRuntime } from './workspace-sync-runtime';
import { buildWorkspaceSyncSnapshot } from './workspace-sync-snapshotter';

export interface MainTestBridgeDeps {
  getAgentToolsBridge(): AgentToolsBridgeServer | null;
  getWorkspaceSyncRuntime(): WorkspaceSyncRuntime | null;
  getNativeDocumentRendererPublisher(): ReturnType<
    typeof createNativeDocumentRendererPublisher
  > | null;
}

export function installMainTestBridge(deps: MainTestBridgeDeps): void {
  const bundleRequire = createRequire(import.meta.url);
  let hostedApprovals: HostedCodexApprovalObservation[] | null = null;
  let hostedApprovalsTruncated = false;
  let migrationBarrier: {
    workspacePath: string;
    state: BenchlingMigrationInstallState;
    hit: boolean;
    release?: () => void;
  } | null = null;
  let sequenceImportClaimBarrier: {
    path: string | null;
    wait: Promise<void>;
    release: () => void;
  } | null = null;
  let heldSequenceImportLeaseRelease: (() => void) | null = null;
  let sequenceSaveProductPause: {
    packageId: string;
    checkpoint: SequenceSaveProductCheckpoint | null;
    wait: Promise<void>;
    release(): void;
  } | null = null;
  let sequenceSaveVerificationFault: {
    documentId: string;
    message: string;
    hits: number;
  } | null = null;
  setSequenceSaveVerificationForTest((documentId) => {
    const fault = sequenceSaveVerificationFault;
    if (!fault || fault.hits > 0 || fault.documentId !== documentId) return;
    fault.hits += 1;
    throw new Error(fault.message);
  });
  setSequenceSaveAfterProductForTest(async (checkpoint) => {
    const pause = sequenceSaveProductPause;
    if (!pause || pause.packageId !== checkpoint.packageId) return;
    pause.checkpoint = checkpoint;
    await pause.wait;
  });
  setSequenceImportBeforeClaimForTest(async (path) => {
    const barrier = sequenceImportClaimBarrier;
    if (!barrier) return;
    barrier.path = path;
    await barrier.wait;
  });
  setMigrationJournalObserverForTest(async (workspacePath, journal) => {
    const barrier = migrationBarrier;
    if (
      !barrier ||
      barrier.hit ||
      barrier.workspacePath !== workspacePath ||
      !journal.allocations.some((allocation) => allocation.installState === barrier.state)
    )
      return;
    barrier.hit = true;
    await new Promise<void>((resolve) => {
      barrier.release = resolve;
    });
  });

  let finalizationBarrier: { hit: boolean; wait: Promise<void>; release(): void } | null = null;
  const benchlingMigrationCoordinator = preparedBenchlingMigrationCoordinator();
  const unlockMigration = benchlingMigrationCoordinator.unlock.bind(benchlingMigrationCoordinator);
  benchlingMigrationCoordinator.unlock = async (runId) => {
    const barrier = finalizationBarrier;
    if (barrier) {
      barrier.hit = true;
      await barrier.wait;
    }
    return unlockMigration(runId);
  };

  type MainTestGlobals = typeof globalThis & {
    __waypointTest?: unknown;
    __quitAndInstallCalled?: boolean;
    __origQuitAndInstall?: () => void;
  };
  const testGlobals = globalThis as MainTestGlobals;
  testGlobals.__waypointTest = {
    beginHostedApprovalObservation: () => {
      if (hostedApprovals !== null) throw new Error('Hosted approval observation is active.');
      hostedApprovals = [];
      hostedApprovalsTruncated = false;
      setHostedCodexApprovalObserverForTest((observation) => {
        if (hostedApprovals === null) return;
        if (hostedApprovals.length >= 128) {
          hostedApprovalsTruncated = true;
          return;
        }
        hostedApprovals.push(structuredClone(observation));
        if (hostedApprovals.length === 128) hostedApprovalsTruncated = true;
      });
    },
    readHostedApprovalObservation: () => {
      if (hostedApprovals === null) throw new Error('Hosted approval observation is inactive.');
      return {
        observations: structuredClone(hostedApprovals),
        truncated: hostedApprovalsTruncated,
        incomplete: didHostedCodexApprovalObservationFailForTest(),
      };
    },
    finishHostedApprovalObservation: () => {
      if (hostedApprovals === null) throw new Error('Hosted approval observation is inactive.');
      const observations = hostedApprovals;
      const truncated = hostedApprovalsTruncated;
      const incomplete = didHostedCodexApprovalObservationFailForTest();
      setHostedCodexApprovalObserverForTest(undefined);
      hostedApprovals = null;
      hostedApprovalsTruncated = false;
      return { observations: structuredClone(observations), truncated, incomplete };
    },
    failNativeDocumentSettlementForTest: (mode: 'before-send' | 'after-response') => {
      nativeDocumentSettlementTestSeam.failure = mode;
      nativeDocumentSettlementTestSeam.attempts = 0;
    },
    getNativeDocumentSettlementAttemptsForTest: () => nativeDocumentSettlementTestSeam.attempts,
    pauseNativeDocumentSettlementForTest: () => {
      if (nativeDocumentSettlementTestSeam.pause)
        throw new Error('A settlement is already paused.');
      let release: () => void = () => {};
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      nativeDocumentSettlementTestSeam.pause = { actionId: null, wait, release };
    },
    getPausedNativeDocumentActionForTest: () => nativeDocumentSettlementTestSeam.pause?.actionId,
    releaseNativeDocumentSettlementForTest: () => {
      nativeDocumentSettlementTestSeam.pause?.release();
      nativeDocumentSettlementTestSeam.pause = null;
    },
    failSequenceSaveVerificationForTest: (documentId: string, message: string) => {
      if (!documentId || sequenceSaveVerificationFault)
        throw new Error('A Save verification fault requires one unarmed document identity.');
      sequenceSaveVerificationFault = { documentId, message, hits: 0 };
    },
    finishSequenceSaveVerificationFaultForTest: () => {
      const hits = sequenceSaveVerificationFault?.hits ?? 0;
      sequenceSaveVerificationFault = null;
      return hits;
    },
    pauseSequenceSaveAfterProductForTest: (packageId: string) => {
      if (!packageId || sequenceSaveProductPause)
        throw new Error('A sequence Save product pause requires one unarmed package identity.');
      let release = () => {};
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      sequenceSaveProductPause = { packageId, checkpoint: null, wait, release };
    },
    getPausedSequenceSaveProductForTest: () => sequenceSaveProductPause?.checkpoint ?? null,
    releaseSequenceSaveAfterProductForTest: () => {
      sequenceSaveProductPause?.release();
      sequenceSaveProductPause = null;
    },
    probeNativeDocumentMutationForTest: async (input: {
      documentId: string;
      workspaceRoot: string;
    }) => {
      if (!deps.getNativeDocumentRendererPublisher())
        throw new Error('Native document publisher unavailable.');
      const resolve = createNativeSequenceDocumentResolver({
        db: getDb,
        workspaceRoots: () => [input.workspaceRoot],
      });
      const target = { operationId: 'native-barrier-probe', targetDocumentId: input.documentId };
      const first = await resolve(target);
      return withWorkspaceMutation(first.workspaceRoot, async () => {
        const current = await resolve(target);
        if (
          current.sourcePath !== first.sourcePath ||
          current.workspaceRoot !== first.workspaceRoot
        ) {
          throw new Error('The document moved before its editing barrier was acquired.');
        }
        const publisher = deps.getNativeDocumentRendererPublisher();
        if (!publisher) throw new Error('Native document publisher stopped.');
        const barrier = await createNativeDocumentMutationBarrier(
          publisher,
          crypto.randomUUID()
        )(current);
        try {
          return {
            documentId: current.documentId,
            sourcePath: current.sourcePath,
            display: await barrier.finish(),
          };
        } finally {
          barrier.abort('unchanged');
        }
      });
    },

    replayPendingRendererRefreshForTest: (workspaceId: number) => {
      const runtime = deps.getWorkspaceSyncRuntime();
      if (!runtime) throw new Error('Workspace sync runtime is not running.');
      return runtime.replayPendingRendererRefreshForTest(workspaceId);
    },
    callRendererToolForTest: (request: Parameters<AgentToolsBridgeServer['callTool']>[0]) => {
      const bridge = deps.getAgentToolsBridge();
      if (!bridge) throw new Error('Renderer bridge unavailable');
      return bridge.callTool(request);
    },
    cancelRendererToolCallsForTurn,
    pauseSequenceImportBeforeClaimForTest: () => {
      if (sequenceImportClaimBarrier) {
        throw new Error('A sequence import destination claim is already paused.');
      }
      let release: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      sequenceImportClaimBarrier = { path: null, wait, release };
    },
    sequenceImportClaimBarrierPathForTest: () => sequenceImportClaimBarrier?.path ?? null,
    releaseSequenceImportBeforeClaimForTest: () => {
      sequenceImportClaimBarrier?.release();
      sequenceImportClaimBarrier = null;
    },
    holdWorkspaceMutationLeaseForTest: async (workspaceRoot: string) => {
      if (heldSequenceImportLeaseRelease) {
        throw new Error('A workspace mutation lease is already held by the test bridge.');
      }
      heldSequenceImportLeaseRelease = await acquireWorkspaceSyncMutationLease(workspaceRoot);
    },
    workspaceMutationWaiterCountForTest,
    releaseWorkspaceMutationLeaseForTest: () => {
      heldSequenceImportLeaseRelease?.();
      heldSequenceImportLeaseRelease = null;
    },

    callAgentTool: (request: {
      turnId: string;
      toolName: string;
      args: unknown;
      actionId: string;
    }) => {
      const bridge = deps.getAgentToolsBridge();
      if (!bridge) throw new Error('Agent tools bridge is not running.');
      return bridge.callTool(request);
    },
    pauseMigrationFinalization: () => {
      if (finalizationBarrier) throw new Error('Migration finalization barrier is already armed.');
      let release: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      finalizationBarrier = { hit: false, wait, release };
    },
    migrationFinalizationBarrierHit: () => finalizationBarrier?.hit ?? false,
    releaseMigrationFinalizationBarrier: () => {
      finalizationBarrier?.release();
      finalizationBarrier = null;
    },
    pauseMigrationAtJournalState: (
      workspacePath: string,
      state: BenchlingMigrationInstallState
    ) => {
      if (migrationBarrier) throw new Error('Migration journal barrier is already armed.');
      migrationBarrier = { workspacePath, state, hit: false };
    },
    migrationJournalBarrierHit: () => migrationBarrier?.hit ?? false,
    stopSidecarBeforeCrashTest: killSidecar,
    releaseMigrationJournalBarrier: () => {
      migrationBarrier?.release?.();
      migrationBarrier = null;
    },

    listStoredAccountIds: async () =>
      (await getAllStoredSessions()).map((session) => session.accountId),
    activateStoredAccount: (accountId: string) => setActiveAccount(accountId),
    expireActiveAccessToken: async () => {
      const session = await getActiveStoredSession();
      if (!session) throw new Error('No active desktop session to expire.');
      await updateSessionTokens(session.accountId, {
        accessToken: session.accessToken,
        accessTokenExpiresAt: new Date(0).toISOString(),
        refreshToken: session.refreshToken,
      });
      return session.accountId;
    },
    armAccountSwitchAfterSyncRenewal: (accountId: string) => {
      workspaceSyncRenewalTestSeam.switchToAccountId = accountId;
    },
    disarmAccountSwitchAfterSyncRenewal: () => {
      workspaceSyncRenewalTestSeam.switchToAccountId = null;
      workspaceSyncRenewalTestSeam.hits = 0;
    },
    syncRenewalAccountSwitchHits: () => workspaceSyncRenewalTestSeam.hits,
    buildWorkspaceSyncSnapshot: (workspaceUuid: string) =>
      buildWorkspaceSyncSnapshot(getDb(), { workspaceUuid, appVersion: app.getVersion() }),
    restoreWorkspaceSyncSnapshot: async (
      bundle: import('@waypoint/share-bundle').WorkspaceSyncBundle,
      managedRootDir: string
    ) => {
      const remoteWorkspaceId = '84a15fce-4cd5-4d0e-865d-251361543911';
      const versionId = '01a04a98-507d-4962-be79-ed79c5306ae9';
      const now = new Date().toISOString();
      const restored = await openWorkspaceSyncProject(getDb(), {
        remoteWorkspaceId,
        managedRootDir,
        getActiveAccountId: () => 'synthetic-native-layout-account',
        client: {
          listWorkspaces: async () => [
            {
              workspaceId: remoteWorkspaceId,
              clientWorkspaceId: bundle.workspace.id,
              displayName: bundle.workspace.name,
              owner: { kind: 'personal', accountId: 'synthetic-native-layout-account' },
              latest: {
                versionId,
                versionNumber: 1,
                contentSha256: bundle.provenance.contentSha256,
              },
              storageBytesUsed: 0,
              versionCount: 1,
              updatedAt: now,
              lastSeenAt: now,
              deviceId: 'synthetic-native-layout-device',
            },
          ],
          downloadLatest: async () => ({
            workspaceId: remoteWorkspaceId,
            version: {
              id: versionId,
              versionNumber: 1,
              contentSha256: bundle.provenance.contentSha256,
              sizeBytes: Buffer.byteLength(JSON.stringify(bundle)),
              fileCount: bundle.files.length,
              createdAt: now,
            },
            bundle,
          }),
        },
      });
      if (!restored.ok) throw new Error(restored.message);
      const workspace = getDb()
        .prepare('SELECT path FROM workspaces WHERE repo_uuid = ?')
        .get(restored.workspaceUuid) as { path: string } | undefined;
      if (!workspace) throw new Error('Restored project record is missing.');
      return workspace.path;
    },
    getDirtyState,
    installUpdate,
    prepareUpdateInstallIntentForTest: prepareUpdateInstallIntent,
    cancelUpdateInstallIntentForTest: _cancelUpdateInstallIntentForTest,
    emitUpdaterDownloadForTest: _emitUpdateDownloadedForTest,
    setUpdateDownloaded: _setUpdateDownloadedForTest,

    probeFailedSidecarUpdateHandoff: async () => {
      let nativeInstallerRequested = false;
      let relaunchRequested = false;
      let quitRequested = false;

      _setUpdateDownloadedForTest(true);
      try {
        const result = await handleBeforeQuit({
          mainWindow: null,
          freezeRenderer: () => undefined,
          restoreRenderer: () => undefined,
          killSidecar: async () => {
            throw new Error(' simulated resident sidecar');
          },
          closeDatabase: () => undefined,
          trackAppClosed: () => undefined,
          shutdownAnalytics: async () => undefined,
          quitApp: () => {
            quitRequested = true;
          },
          requestSaveAll: async () => undefined,
          relaunchApp: () => {
            relaunchRequested = true;
          },
          installDownloadedUpdate: () => {
            nativeInstallerRequested = true;
            return { status: 'started' };
          },
        });

        return {
          ...result,
          nativeInstallerRequested,
          relaunchRequested,
          quitRequested,
        };
      } finally {
        _setUpdateDownloadedForTest(false);
      }
    },

    getActiveLoopbackRedirectUri: getActiveLoopbackRedirectUriForTest,
    getActiveFlowNonce: getActiveFlowNonceForTest,
    listBackups: (dir: string): string[] =>
      readdirSync(dir).filter((f) => f.startsWith('dnaforge-backup-')),
    readBackupTables: (backupPath: string): string[] => {
      const Database = bundleRequire('better-sqlite3') as typeof import('better-sqlite3');
      const db = new Database(backupPath);
      try {
        return (
          db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
            name: string;
          }[]
        ).map((r) => r.name);
      } finally {
        db.close();
      }
    },
    joinPath: join,
    getUserDataPath: (): string => app.getPath('userData'),
    getQuitAndInstallCalled: (): boolean => Boolean(testGlobals.__quitAndInstallCalled),
    getSidecarSessionState: () => {
      if (app.isPackaged || process.env.NODE_ENV !== 'test') {
        throw new Error('Sidecar session introspection is available only in the test harness');
      }
      const snapshot = sidecarSessionAuthority.snapshot();
      return {
        owner: snapshot.owner,
        generation: snapshot.generation,
        state: snapshot.state,

        token: snapshot.token,
      };
    },
    getSidecarHealthProbeLatchState: getTestHealthProbeLatchState,
    getOwnedSidecarScheduling: () => {
      const pid = getSidecarProcessPid();
      if (pid === null) return { pid: null, priority: null, lowered: false };
      const priority = getPriority(pid);
      return { pid, priority, lowered: priority > getPriority(process.pid) };
    },
    releaseSidecarHealthProbe: releaseTestHealthProbe,
    getSidecarRefreshResultLatchState: getTestRefreshResultLatchState,
    releaseSidecarRefreshResult: releaseTestRefreshResult,
    setSidecarStatus: setTestSidecarStatus,
    sidecarRequest: async (path: string) => {
      const response = await sidecarFetch(path);
      return {
        status: response.status,
        body: await response.text(),
      };
    },
    stubQuitAndInstall: (onInstall?: () => void) => {
      testGlobals.__quitAndInstallCalled = false;
      const eu = updaterPackage;
      testGlobals.__origQuitAndInstall = eu.autoUpdater.quitAndInstall;
      eu.autoUpdater.quitAndInstall = () => {
        testGlobals.__quitAndInstallCalled = true;
        onInstall?.();
      };
    },
    restoreQuitAndInstall: () => {
      if (testGlobals.__origQuitAndInstall) {
        const eu = updaterPackage;
        eu.autoUpdater.quitAndInstall = testGlobals.__origQuitAndInstall;
        delete testGlobals.__origQuitAndInstall;
      }
    },
  };
}

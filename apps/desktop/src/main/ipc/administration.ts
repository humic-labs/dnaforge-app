import type Database from 'better-sqlite3';
import { nativeTheme, type BrowserWindow } from 'electron';
import { AdministrationOwner } from '../administration-owner';
import { createAdministrationStorage } from '../administration-storage';
import {
  getActiveSession,
  getAuthState,
  startSignIn,
  subscribeAuthState,
} from '../auth/controller';
import { requestAgentUserInputWithRenderer } from '../agent-confirm';
import { buildDeepSharePreflight } from '../deep-share/preflight';
import {
  createDeepSharePublishClient,
  publishReviewedDeepShare,
  toDeepShareReview,
} from '../deep-share/publish';
import { createDesktopSyncClient } from '../desktop-sync-client';
import { preparedBenchlingMigrationCoordinator } from '../features/benchling-migration';
import { toBenchlingMigrationRunView } from './benchling-migration';
import { applySendingWindowZoom } from './window';
import { assertCommittedDatabaseReadAllowed } from '../workspace-sync-database-fence';
import { assertKnownWorkspaceContentWritable } from '../workspace-content-write-access';
import { handleGroup, sendRendererIpc } from '../../shared/ipc-contract';
import { administrationContract } from '../../shared/ipc/administration.contract';
import type {
  AdministrationEvent,
  AdministrationHandoff,
  AdministrationRequest,
  AdministrationResult,
} from '../../shared/administration';
import type { ComputeProviderSummary } from '../../shared/compute-ipc';
import {
  createNativeAgentGrantAuthorizer,
  createNativeAgentGrantInspector,
} from '../agent-grant-authority';
import { managedRootDir } from './workspace-git';
import {
  createAuthenticatedDeepShareImportClient,
  importShareIntoManagedWorkspace,
  prepareDeepShareImport,
} from '../workspace-sync-import-share';
import { parseImportShareUrl } from '../workspace-sync-import-share-url';
import { resolve } from 'node:path';

export interface NativeAdministrationDependencies {
  getDb(): Database.Database;
  getMainWindow(): BrowserWindow | null;
  forceSync(workspaceUuid: string): Promise<{ ok: boolean; message?: string }>;
  appVersion: string;
  sidecarFetch(path: string | URL, init?: RequestInit): Promise<Response>;
  listProviders(): Promise<ComputeProviderSummary[]>;
  captureWorkspace(root: string): () => void;
}

export function createNativeAdministrationCommands(
  deps: NativeAdministrationDependencies
): AdministrationOwner {
  const inspectGrant = createNativeAgentGrantInspector(deps.sidecarFetch, 'ADMINISTRATION');
  const publish = (event: AdministrationEvent) => {
    const window = deps.getMainWindow();
    if (window && !window.isDestroyed())
      sendRendererIpc(window.webContents, 'administration:changed', event);
  };
  const observeHandoff = async (
    target: AdministrationHandoff
  ): Promise<{ completed: boolean; cancelled?: boolean; message: string }> => {
    if (target.purpose === 'sign-in') {
      const session = await getActiveSession();
      const state = getAuthState();
      const cancelled =
        !session &&
        (state.status === 'signed-out' ||
          state.status === 'error' ||
          state.status === 'unavailable');
      return {
        completed: Boolean(session),
        ...(cancelled ? { cancelled: true } : {}),
        message: session
          ? 'The native sign-in owner reports a signed-in session.'
          : cancelled
            ? 'The native sign-in flow ended without a signed-in session. Prepare a new handoff to try again.'
            : 'Complete the existing sign-in flow.',
      };
    }
    if (target.purpose === 'provider-setup') {
      const provider = (await deps.listProviders()).find((value) => value.id === target.providerId);
      if (!provider)
        throw new Error('ADMINISTRATION_PROVIDER_NOT_FOUND: This provider is not installed.');
      return {
        completed: provider.connected,
        message: provider.connected
          ? 'The existing provider owner reports a connected credential.'
          : 'Complete provider setup in Settings.',
      };
    }
    const grant = await inspectGrant(target.agentIdentityId);
    const completed = Boolean(
      grant &&
      grant.scopes !== null &&
      !grant.revokedAt &&
      (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now())
    );
    return {
      completed,
      message: completed
        ? 'The existing access owner reports the exact selected active grant.'
        : 'The selected grant is not currently active. Complete the existing Agent Access flow.',
    };
  };
  const owner = new AdministrationOwner({
    storage: createAdministrationStorage(deps.getDb),
    captureTargetAuthority: async (target) => {
      if (target.kind === 'handoff' || target.kind === 'share-import') return () => {};
      const db = deps.getDb();
      const root =
        target.kind === 'share'
          ? (
              db
                .prepare(
                  'SELECT path FROM workspaces WHERE repo_uuid = ? AND archived_at IS NULL AND trashed_at IS NULL'
                )
                .get(target.selection.workspaceUuid) as { path: string } | undefined
            )?.path
          : (await preparedBenchlingMigrationCoordinator().getRun(target.runId)).workspacePath;
      if (!root)
        throw new Error(
          'ADMINISTRATION_WORKSPACE_UNAVAILABLE: The exact selected project is unavailable.'
        );
      const enrolled = deps.captureWorkspace(root);
      const assertCurrent = () => {
        enrolled();
        assertCommittedDatabaseReadAllowed(db);
        assertKnownWorkspaceContentWritable(db, root);
      };
      assertCurrent();
      return assertCurrent;
    },
    authorizeAgent: createNativeAgentGrantAuthorizer(deps.sidecarFetch, 'ADMINISTRATION'),
    account: async () => {
      const session = await getActiveSession();
      return session
        ? {
            accountId: session.accountId,
            desktopSessionId: session.desktopSessionId,
            ...(session.email ? { email: session.email } : {}),
          }
        : null;
    },
    prepareShare: async (selection) => {
      const db = deps.getDb();
      assertCommittedDatabaseReadAllowed(db);
      const root = (
        db
          .prepare(
            'SELECT path FROM workspaces WHERE repo_uuid = ? AND archived_at IS NULL AND trashed_at IS NULL'
          )
          .get(selection.workspaceUuid) as { path: string } | undefined
      )?.path;
      if (!root)
        throw new Error(
          'ADMINISTRATION_WORKSPACE_UNAVAILABLE: The selected project is unavailable.'
        );
      const enrolled = deps.captureWorkspace(root);
      enrolled();
      assertKnownWorkspaceContentWritable(db, root);
      const preflight = await buildDeepSharePreflight(db, selection);
      enrolled();
      assertCommittedDatabaseReadAllowed(db);
      assertKnownWorkspaceContentWritable(db, preflight.workspace.path);
      return toDeepShareReview(preflight);
    },
    prepareShareImport: async (sourceUrl, expectedAccountId) => {
      const source = parseImportShareUrl(sourceUrl);
      if (!source)
        throw new Error(
          'ADMINISTRATION_SHARE_LINK_INVALID: Use the native import link supplied by the share owner.'
        );
      const db = deps.getDb();
      const root = resolve(managedRootDir());
      const assertCurrent = () => {
        assertCommittedDatabaseReadAllowed(db);
        if (resolve(managedRootDir()) !== root)
          throw new Error(
            'ADMINISTRATION_DESTINATION_CHANGED: The managed project location changed. Prepare this import again.'
          );
      };
      assertCurrent();
      const prepared = await prepareDeepShareImport({
        ...source,
        managedRootDir: root,
        db,
        client: createAuthenticatedDeepShareImportClient(
          createDesktopSyncClient(),
          expectedAccountId
        ),
      });
      const shortId = source.shortId;
      source.token = '';
      assertCurrent();
      return {
        review: prepared.review,
        assertCurrent,
        apply: async (assertAuthority) => {
          const result = await importShareIntoManagedWorkspace({
            shortId,
            token: '',
            managedRootDir: root,
            db,
            prepared,
            assertAuthority: async () => {
              assertCurrent();
              await assertAuthority();
              assertCurrent();
            },
          });
          return {
            workspaceUuid: result.workspaceUuid,
            displayName: result.displayName,
            repoPath: result.repoPath,
            warnings: result.warnings,
          };
        },
      };
    },
    publishShare: (selection, reviewedDigest, expectedAccountId, assertAuthority) =>
      publishReviewedDeepShare(
        deps.getDb(),
        { ...selection, reviewedDigest },
        {
          forceSync: async (workspaceUuid) => {
            await assertAuthority();
            const result = await deps.forceSync(workspaceUuid);
            await assertAuthority();
            return result;
          },
          assertAuthority,
          appVersion: deps.appVersion,
          client: createDeepSharePublishClient(createDesktopSyncClient(), expectedAccountId),
          buildPreflight: async (db, input) => {
            const preflight = await buildDeepSharePreflight(db, input);
            assertCommittedDatabaseReadAllowed(db);
            assertKnownWorkspaceContentWritable(db, preflight.workspace.path);
            return preflight;
          },
        }
      ),
    migration: async (runId) => {
      const coordinator = preparedBenchlingMigrationCoordinator();
      const run = runId ? await coordinator.getRun(runId) : await coordinator.getActiveRun();
      return run ? toBenchlingMigrationRunView(run) : null;
    },
    actOnMigration: async (runId, operation) =>
      toBenchlingMigrationRunView(await preparedBenchlingMigrationCoordinator()[operation](runId)),
    requestApproval: async (action, signal) => {
      const questionId = `administration:${action.id}:${action.revision}`;
      const answer = await requestAgentUserInputWithRenderer(
        deps.getMainWindow(),
        {
          provider: 'application',
          questions: [
            {
              id: questionId,
              header:
                action.target.kind === 'share'
                  ? 'Publish share'
                  : action.target.kind === 'share-import'
                    ? 'Import private fork'
                    : 'Unlock import',
              prompt: action.effects.join('\n'),
              options: [
                {
                  id: 'confirm',
                  label: 'Continue once',
                  description: 'Apply only this exact prepared action.',
                },
                { id: 'cancel', label: 'Cancel', description: 'Leave this action unexecuted.' },
              ],
              multiSelect: false,
              allowFreeText: false,
            },
          ],
        },
        Math.max(1, Math.min(30 * 60_000, Date.parse(action.expiresAt) - Date.now())),
        signal
      );
      return (
        answer.outcome === 'submitted' &&
        answer.answers[questionId]?.selectedOptionIds.length === 1 &&
        answer.answers[questionId]?.selectedOptionIds[0] === 'confirm'
      );
    },
    beginHandoff: async (target) => {
      if (target.purpose === 'sign-in') {
        const result = await startSignIn();
        if (!result.ok)
          throw new Error(
            'ADMINISTRATION_SIGN_IN_UNAVAILABLE: The existing sign-in owner could not start.'
          );
      } else {
        if (!deps.getMainWindow())
          throw new Error(
            'ADMINISTRATION_HUMAN_FLOW_UNAVAILABLE: Open the desktop to continue this human action.'
          );
        await observeHandoff(target);
        publish({ kind: 'handoff', target });
      }
    },
    observeHandoff,
    applySettings: (snapshot, keys) => {
      if (keys.includes('theme')) nativeTheme.themeSource = snapshot.values.theme;
      if (!keys.includes('displayZoom')) return;
      const window = deps.getMainWindow();
      if (!window || window.isDestroyed()) return { status: 'unavailable' };
      const result = applySendingWindowZoom(
        window,
        window.webContents.id,
        snapshot.values.displayZoom,
        process.platform === 'win32',
        nativeTheme.shouldUseDarkColors
      );
      return result;
    },
    publish,
  });
  subscribeAuthState(() => {
    void owner.invalidatePendingAccountActions().catch(() => {});
  });
  return owner;
}

export function registerAdministrationHandlers(
  deps: Pick<NativeAdministrationDependencies, 'getDb' | 'getMainWindow'>,
  owner: AdministrationOwner
): AdministrationOwner {
  handleGroup(administrationContract, {
    execute: (event, request: AdministrationRequest): Promise<AdministrationResult> => {
      const assertCurrent = () => {
        const window = deps.getMainWindow();
        if (
          !window ||
          window.isDestroyed() ||
          event.sender.isDestroyed() ||
          window.webContents.id !== event.sender.id
        )
          throw new Error('ADMINISTRATION_CALLER_UNAVAILABLE: The current desktop caller changed.');
        assertCommittedDatabaseReadAllowed(deps.getDb());
      };
      return owner.execute(
        request,
        assertCurrent,
        undefined,
        request.operation.kind === 'execute-action'
          ? {
              actionId: request.operation.actionId,
              expectedRevision: request.operation.expectedRevision,
            }
          : undefined
      );
    },
  });
  return owner;
}

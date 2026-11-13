import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WorkspaceSyncAccessListing } from '../shared/workspace-sync-ipc';
import { waitForWorkspaceSyncDatabase } from '../db/workspace-sync-retry';

import type {
  OrganizationDeletionImpactResult,
  OrganizationRegistryClaimPreparationRequest,
  OrganizationRegistryClaimPreparationResult,
  OrganizationRegistryClaimRequest,
  OrganizationRegistryClaimResult,
  OrganizationRegistryConfigurationRequest,
  OrganizationRegistryConfigurationResult,
  OrganizationRegistryConflictResolutionRequest,
  OrganizationRegistryConflictResolutionResult,
  OrganizationRegistryMutationRequest,
  OrganizationRegistryMutationResult,
  OrganizationRegistryReadResult,
  OrganizationRegistryCachedOrganizationsResult,
  OrganizationRegistryRecordSyncStatusResult,
  OrganizationRegistrySavedRecordReviewResult,
  OrganizationRegistrySavedRecordResolutionRequest,
  OrganizationRegistrySavedRecordResolutionResult,
  OrganizationRegistryRecordDetailsRequest,
  OrganizationRegistryRecordDetailsResult,
  OrganizationRegistrySyncHealthResult,
  OrganizationRegistrySyncResult,
  OrganizationRegistryChangedEvent,
  OrganizationRegistryView,
} from '../shared/org-registry-sync';
import { getActiveStoredSession, type StoredSession } from './auth/session-store';
import {
  enqueueOrgRegistryMutation,
  listOrgRegistryCachedOrganizationIds,
  readOrgRegistrySyncState,
  orgRegistryMutationFingerprint,
  readOrgRegistryCache,
  readOrgRegistryMutationReceipt,
  readOrgRegistrySyncDetails,
  resolveOrgRegistryConflict,
} from './org-registry-sync-cache';
import {
  createOrganizationRegistryClient,
  type OrganizationRegistryClient,
} from './org-registry-sync-client';
import {
  syncOrganizationRegistry as runOrganizationRegistrySync,
  type OrganizationRegistrySyncResult as WorkerSyncResult,
} from './org-registry-sync-worker';
import { readOrCreateWorkspaceSyncDeviceId } from './workspace-sync-device';
import { prepareOrganizationRegistryClaimInDb } from './org-registry-claim';
import {
  enrollOrgRegistryRecordInTx,
  readOrgRegistryRecordSyncStatus,
} from './org-registry-record-sync';
import {
  parseOrganizationRegistryClaimRequest,
  parseOrganizationRegistryRecordSyncEntityId,
  parseOrganizationRegistrySavedRecordResolutionRequest,
  parseOrganizationRegistryRecordDetailsRequest,
} from '../shared/org-registry-sync';
import { readOrganizationRegistryRecordDetailsInDb } from './org-registry-record-details';
import { readCheckedOrganizationRecordReview } from './org-registry-record-review';
import {
  readPendingSavedRecordResolution,
  resolveSavedOrganizationRecord,
} from './org-registry-record-resolution';
import {
  withWorkspaceMutation,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';

export interface OrganizationRegistryActionHandlers {
  prepareOrganizationRegistryClaim(
    orgId: string,
    request: OrganizationRegistryClaimPreparationRequest
  ): Promise<OrganizationRegistryClaimPreparationResult>;
  claimOrganizationRegistryEntity(
    orgId: string,
    request: OrganizationRegistryClaimRequest
  ): Promise<OrganizationRegistryClaimResult>;
  getOrganizationRegistryRecordSyncStatus(
    entityId: string
  ): Promise<OrganizationRegistryRecordSyncStatusResult>;
  getOrganizationRegistrySavedRecordReview(
    orgId: string,
    entityId: string
  ): Promise<OrganizationRegistrySavedRecordReviewResult>;
  resolveOrganizationRegistrySavedRecord(
    orgId: string,
    request: OrganizationRegistrySavedRecordResolutionRequest
  ): Promise<OrganizationRegistrySavedRecordResolutionResult>;
  listCachedOrganizationRegistries(): Promise<OrganizationRegistryCachedOrganizationsResult>;
  getOrganizationRegistry(orgId: string): Promise<OrganizationRegistryReadResult>;
  getOrganizationRegistryRecordDetails(
    orgId: string,
    request: OrganizationRegistryRecordDetailsRequest
  ): Promise<OrganizationRegistryRecordDetailsResult>;
  syncOrganizationRegistry(orgId: string): Promise<OrganizationRegistrySyncResult>;
  mutateOrganizationRegistry(
    orgId: string,
    request: OrganizationRegistryMutationRequest
  ): Promise<OrganizationRegistryMutationResult>;
  configureOrganizationRegistry(
    orgId: string,
    request: OrganizationRegistryConfigurationRequest
  ): Promise<OrganizationRegistryConfigurationResult>;
  getOrganizationRegistrySyncHealth(orgId: string): Promise<OrganizationRegistrySyncHealthResult>;
  getOrganizationDeletionImpact(orgId: string): Promise<OrganizationDeletionImpactResult>;
  resolveOrganizationRegistryConflict(
    orgId: string,
    request: OrganizationRegistryConflictResolutionRequest
  ): Promise<OrganizationRegistryConflictResolutionResult>;
}

export interface OrganizationRegistryActionDeps {
  onRegistryChanged?: (event: OrganizationRegistryChangedEvent) => void;
  getActiveSession?: () => Promise<StoredSession | null>;
  getDeviceId?: (db: Database.Database) => string;
  client?: OrganizationRegistryClient;
  sync?: typeof runOrganizationRegistrySync;
  nowMs?: () => number;
  createMutationId?: () => string;
  readHomeAccess?: (
    remoteWorkspaceId: string,
    expectedAccountId: string
  ) => Promise<WorkspaceSyncAccessListing>;
}

export function createOrganizationRegistryActionHandlers(
  db: Database.Database,
  deps: OrganizationRegistryActionDeps = {}
): OrganizationRegistryActionHandlers {
  const activeSession = deps.getActiveSession ?? getActiveStoredSession;
  const registryClient = deps.client ?? createOrganizationRegistryClient();
  const sync = deps.sync ?? runOrganizationRegistrySync;
  const nowMs = deps.nowMs ?? Date.now;
  const createMutationId = deps.createMutationId ?? randomUUID;
  const getDeviceId =
    deps.getDeviceId ?? ((database) => readOrCreateWorkspaceSyncDeviceId(database));
  const syncTails = new Map<string, Promise<void>>();

  const context = async (
    signedOutMessage: string
  ): Promise<
    { accountId: string; clientId: string } | { ok: false; code: 'SIGNED_OUT'; message: string }
  > => {
    const session = await activeSession();
    if (!session) return { ok: false, code: 'SIGNED_OUT', message: signedOutMessage };
    return {
      accountId: session.accountId,
      clientId: `desktop:${getDeviceId(db)}`,
    };
  };

  const assertCurrentAccount = async (accountId: string): Promise<void> => {
    if ((await activeSession())?.accountId !== accountId) {
      throw Object.assign(
        new Error('The active account changed. Review the Registry under the current account.'),
        { code: 'FORBIDDEN' }
      );
    }
  };

  const runSync = async (
    orgId: string,
    syncContext: { accountId: string; clientId: string }
  ): Promise<WorkerSyncResult> => {
    const key = `${syncContext.accountId}:${orgId}`;
    const previous = syncTails.get(key) ?? Promise.resolve();
    const scheduled = previous.then(() =>
      sync(db, {
        orgId,
        accountId: syncContext.accountId,
        clientId: syncContext.clientId,
        client: registryClient,
        now: nowMs,
      })
    );

    const tail = scheduled.then(
      () => undefined,
      () => undefined
    );
    syncTails.set(key, tail);
    try {
      const result = await scheduled;
      await assertCurrentAccount(syncContext.accountId);
      deps.onRegistryChanged?.({ accountId: syncContext.accountId, orgId });
      return result;
    } finally {
      if (syncTails.get(key) === tail) syncTails.delete(key);
    }
  };

  return {
    listCachedOrganizationRegistries: async () => {
      const resolved = await context('Sign in to open your cached organization Registries.');
      if ('ok' in resolved) return resolved;
      try {
        await assertCurrentAccount(resolved.accountId);
        const organizationIds = listOrgRegistryCachedOrganizationIds(db, resolved).filter(
          (orgId) =>
            readOrgRegistrySyncState(db, { accountId: resolved.accountId, orgId })
              .accessGeneration !== null
        );
        return { ok: true, accountId: resolved.accountId, organizationIds };
      } catch (error) {
        return actionError(error, 'Could not read cached organization Registries.');
      }
    },
    prepareOrganizationRegistryClaim: async (orgId, request) => {
      const resolved = await context('Sign in to register this saved record.');
      if ('ok' in resolved) return resolved;
      try {
        const claim = await prepareOrganizationRegistryClaimInDb(
          db,
          { ...resolved, orgId },
          request,
          { assertCurrentAccount: () => assertCurrentAccount(resolved.accountId) }
        );
        await assertCurrentAccount(resolved.accountId);
        return { ok: true, claim };
      } catch (error) {
        return actionError(error, 'Could not prepare the saved record for registration.');
      }
    },

    claimOrganizationRegistryEntity: async (orgId, rawRequest) => {
      const resolved = await context('Sign in to register this saved record.');
      if ('ok' in resolved) return resolved;
      try {
        const request = parseOrganizationRegistryClaimRequest(rawRequest);
        const readOwner = db.prepare(
          `SELECT w.id, w.path FROM lims_entity e
           JOIN workspaces w ON w.id = e.workspace_id WHERE e.id = ?`
        );
        const owner = readOwner.get(request.entityId) as { id: number; path: string } | undefined;
        if (!owner)
          throw new Error('Registration requires the saved record’s verified home project.');
        const { claim, fingerprint } = await withWorkspaceMutation(owner.path, async () => {
          const currentOwner = readOwner.get(request.entityId) as
            | { id: number; path: string }
            | undefined;
          if (
            !currentOwner ||
            currentOwner.id !== owner.id ||
            workspaceMutationRootIdentity(currentOwner.path) !==
              workspaceMutationRootIdentity(owner.path)
          ) {
            throw new Error('Registration requires another review: the record’s home changed.');
          }
          const claim = await prepareOrganizationRegistryClaimInDb(
            db,
            { ...resolved, orgId },
            request,
            { assertCurrentAccount: () => assertCurrentAccount(resolved.accountId) }
          );
          await assertCurrentAccount(resolved.accountId);
          if (claim.sourceRevision !== request.sourceRevision) {
            throw new Error(
              'Registration requires another review: the saved record, definition or home changed.'
            );
          }
          const fingerprint = orgRegistryMutationFingerprint('entity.create', claim.payload);
          db.transaction(() => {
            enqueueOrgRegistryMutation(db, {
              ...resolved,
              orgId,
              mutationId: request.mutationId,
              operation: 'entity.create',
              payload: claim.payload,
              now: nowMs(),
            });
            enrollOrgRegistryRecordInTx(db, {
              ...resolved,
              orgId,
              mutationId: request.mutationId,
              claim,
              now: nowMs(),
            });
          })();
          return { claim, fingerprint };
        });

        const syncResult = await runSync(orgId, resolved);
        const registry = registryView(db, orgId, resolved.accountId);
        const pending = registry.pendingMutations.find(
          (entry) => entry.mutationId === request.mutationId
        );
        if (pending?.status === 'failed' || pending?.status === 'conflict') {
          return {
            ok: false,
            code: 'INVALID_REQUEST',
            message:
              pending.errorMessage ??
              'The organization rejected this registration. Review the record before retrying.',
          };
        }
        if (syncResult.status === 'access_revoked') {
          return {
            ok: false,
            code: 'FORBIDDEN',
            message: 'Organization access was removed before registration was confirmed.',
          };
        }
        const receipt = readOrgRegistryMutationReceipt(db, {
          ...resolved,
          orgId,
          mutationId: request.mutationId,
        });
        const canonical = registry.entities.find((entity) => entity.id === claim.sourceEntityId);
        const registered =
          receipt?.operation === 'entity.create' &&
          receipt.requestFingerprint === fingerprint &&
          registry.state.cursor >= receipt.eventSeq &&
          canonical?.homeWorkspaceId === claim.homeWorkspaceId;
        return {
          ok: true,
          mutationId: request.mutationId,
          registration: registered ? 'registered' : 'queued',
          sync: syncResult,
          registry,
        };
      } catch (error) {
        return actionError(error, 'Could not register the saved record.');
      }
    },

    getOrganizationRegistryRecordSyncStatus: async (rawEntityId) => {
      const session = await activeSession();
      if (!session)
        return {
          ok: false,
          code: 'SIGNED_OUT',
          message: 'Sign in to view organization synchronization.',
        };
      try {
        const entityId = parseOrganizationRegistryRecordSyncEntityId(rawEntityId);
        const status = readOrgRegistryRecordSyncStatus(db, {
          accountId: session.accountId,
          entityId,
        });
        return {
          ok: true,
          accountId: session.accountId,
          status: status
            ? {
                ...status,
                pendingResolution: readPendingSavedRecordResolution(db, session.accountId, status),
              }
            : null,
        };
      } catch (error) {
        return actionError(error, 'Could not read registered record synchronization.');
      }
    },

    getOrganizationRegistrySavedRecordReview: async (orgId, rawEntityId) => {
      const session = await activeSession();
      if (!session)
        return {
          ok: false,
          code: 'SIGNED_OUT',
          message: 'Sign in to review organization changes.',
        };
      try {
        const entityId = parseOrganizationRegistryRecordSyncEntityId(rawEntityId);
        const { displayed } = await readCheckedOrganizationRecordReview(
          db,
          { orgId, entityId, accountId: session.accountId },
          () => assertCurrentAccount(session.accountId)
        );
        return { ok: true, review: displayed };
      } catch (error) {
        return actionError(error, 'Could not review the saved and organization versions.');
      }
    },

    resolveOrganizationRegistrySavedRecord: async (orgId, rawRequest) => {
      const resolved = await context('Sign in to apply the reviewed record change.');
      if ('ok' in resolved) return resolved;
      try {
        const request = parseOrganizationRegistrySavedRecordResolutionRequest(rawRequest);

        const result = await waitForWorkspaceSyncDatabase(() =>
          resolveSavedOrganizationRecord(db, {
            ...resolved,
            orgId,
            request,
            getActiveAccountId: async () => (await activeSession())?.accountId ?? null,
            refresh: () => runSync(orgId, resolved),
            readHomeAccess:
              deps.readHomeAccess ??
              (async (remoteWorkspaceId, expectedAccountId) => {
                const { createWorkspaceSyncAccessClient } = await import('./workspace-sync-access');
                return createWorkspaceSyncAccessClient().listAccess(
                  remoteWorkspaceId,
                  expectedAccountId
                );
              }),
          })
        );
        return { ok: true, ...result };
      } catch (error) {
        return actionError(error, 'Could not apply the reviewed record change.');
      }
    },

    getOrganizationRegistryRecordDetails: async (orgId, rawRequest) => {
      const session = await activeSession();
      if (!session)
        return {
          ok: false,
          code: 'SIGNED_OUT',
          message: 'Sign in to view organization Registry Details.',
        };
      try {
        const request = parseOrganizationRegistryRecordDetailsRequest(rawRequest);
        const details = await readOrganizationRegistryRecordDetailsInDb(
          db,
          { orgId, accountId: session.accountId },
          request,
          () => assertCurrentAccount(session.accountId)
        );
        return { ok: true, details };
      } catch (error) {
        return actionError(error, 'Could not load organization Registry Details.');
      }
    },

    getOrganizationRegistry: async (orgId) => {
      const resolved = await context('Sign in to view the organization Registry.');
      if ('ok' in resolved) return resolved;
      return {
        ok: true,
        registry: registryView(db, orgId, resolved.accountId),
      };
    },

    syncOrganizationRegistry: async (orgId) => {
      const resolved = await context('Sign in to synchronize the organization Registry.');
      if ('ok' in resolved) return resolved;
      try {
        const syncResult = await runSync(orgId, resolved);
        return {
          ok: true,
          sync: syncResult,
          registry: registryView(db, orgId, resolved.accountId),
        };
      } catch (error) {
        return actionError(error, 'Could not synchronize the organization Registry.');
      }
    },

    mutateOrganizationRegistry: async (orgId, request) => {
      const resolved = await context('Sign in to change the organization Registry.');
      if ('ok' in resolved) return resolved;
      try {
        if (request.operation === 'entity.create' && request.payload.claimProvenance != null) {
          throw new Error('A local record requires the reviewed saved-record registration action.');
        }
        enqueueOrgRegistryMutation(db, {
          orgId,
          accountId: resolved.accountId,
          clientId: resolved.clientId,
          mutationId: request.mutationId,
          operation: request.operation,
          payload: request.payload,
          now: nowMs(),
        });
        const syncResult = await runSync(orgId, resolved);
        return {
          ok: true,
          mutationId: request.mutationId,
          sync: syncResult,
          registry: registryView(db, orgId, resolved.accountId),
        };
      } catch (error) {
        return actionError(error, 'Could not queue the Registry change.');
      }
    },

    configureOrganizationRegistry: async (orgId, request) => {
      const resolved = await context('Sign in to configure the organization Registry.');
      if ('ok' in resolved) return resolved;
      try {
        const configured = await registryClient.configure({
          orgId,
          accountId: resolved.accountId,
          ...request,
        });
        await runSync(orgId, resolved);
        return {
          ok: true,
          cursor: configured.cursor,
          registry: registryView(db, orgId, resolved.accountId),
        };
      } catch (error) {
        return actionError(error, 'Could not configure the organization Registry.');
      }
    },

    getOrganizationRegistrySyncHealth: async (orgId) => {
      const resolved = await context('Sign in to view Registry sync health.');
      if ('ok' in resolved) return resolved;
      try {
        return {
          ok: true,
          health: await registryClient.getSyncHealth({
            orgId,
            accountId: resolved.accountId,
          }),
        };
      } catch (error) {
        return actionError(error, 'Could not load Registry sync health.');
      }
    },

    getOrganizationDeletionImpact: async (orgId) => {
      const resolved = await context('Sign in to inspect organization deletion impact.');
      if ('ok' in resolved) return resolved;
      try {
        return {
          ok: true,
          impact: await registryClient.getDeletionImpact({
            orgId,
            accountId: resolved.accountId,
          }),
        };
      } catch (error) {
        return actionError(error, 'Could not inspect organization deletion impact.');
      }
    },

    resolveOrganizationRegistryConflict: async (orgId, request) => {
      const resolved = await context('Sign in to resolve the Registry conflict.');
      if ('ok' in resolved) return resolved;
      try {
        const local = resolveOrgRegistryConflict(db, {
          orgId,
          accountId: resolved.accountId,
          conflictId: request.conflictId,
          resolution: request.resolution,
          replacementMutationId:
            request.resolution === 'retry_against_latest' ? createMutationId() : undefined,
          replacementPayload: request.replacementPayload,
          now: nowMs(),
        });
        if (local.mutationId) await runSync(orgId, resolved);
        return {
          ok: true,
          registry: registryView(db, orgId, resolved.accountId),
          ...(local.mutationId ? { mutationId: local.mutationId } : {}),
        };
      } catch (error) {
        return actionError(error, 'Could not resolve the Registry conflict.');
      }
    },
  };
}

function registryView(
  db: Database.Database,
  orgId: string,
  accountId: string
): OrganizationRegistryView {
  const cache = readOrgRegistryCache(db, { orgId, accountId });
  const details = readOrgRegistrySyncDetails(db, { orgId, accountId });
  return {
    orgId,
    ...cache,
    pendingMutations: details.mutations,
    conflicts: details.conflicts,
  };
}

function actionError(
  error: unknown,
  fallback: string
): {
  ok: false;
  code:
    | 'INVALID_REQUEST'
    | 'NOT_CONFIGURED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'SYNC_ERROR'
    | 'REVIEW_CHANGED';
  message: string;
} {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  if (
    code === 'NOT_CONFIGURED' ||
    code === 'FORBIDDEN' ||
    code === 'NOT_FOUND' ||
    code === 'REVIEW_CHANGED'
  ) {
    return {
      ok: false,
      code,
      message: error instanceof Error ? error.message : fallback,
    };
  }
  if (error instanceof Error && /must|requires|not found|already used/i.test(error.message)) {
    return { ok: false, code: 'INVALID_REQUEST', message: error.message };
  }
  return {
    ok: false,
    code: 'SYNC_ERROR',
    message: error instanceof Error ? error.message : fallback,
  };
}

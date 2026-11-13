import type { OrganizationSavedSequenceSnapshot } from './org-registry-saved-sequence-snapshot-contract';
import { accessSync, constants, statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import type { WorkspaceSyncAccessListing } from '../shared/workspace-sync-ipc';
import { updateWorkspaceSyncAccessRecord } from './workspace-sync-access-record';
import type {
  OrganizationRegistryRecordSyncStatus,
  OrganizationRegistrySavedRecordResolutionRequest,
} from '../shared/org-registry-sync';
import {
  publishReviewedEntityArtifactResolution,
  readReviewedEntityArtifactResolutionIdentity,
  resumeReviewedEntityArtifactResolution,
} from './entity-artifact-mutations';
import {
  publishReviewedPrimerArtifactResolution,
  readReviewedPrimerArtifactResolutionIdentity,
  resumeReviewedPrimerArtifactResolution,
} from './primer-artifact-mutations';
import {
  publishReviewedSequencePackageResolution,
  readPendingSequenceKeepSavedIdentity,
  resumeReviewedSequencePackageResolution,
} from './sequence-package-record-resolution';
import { assertLimsSafetyNotQuarantined } from './lims-safety-quarantine';
import { resolveDatabaseRegisteredRecordInTx } from './org-registry-local-mutations';
import { readCheckedOrganizationRecordReview } from './org-registry-record-review';
import type { OrganizationSavedPrimerSnapshot } from './org-registry-saved-primer-snapshot-contract';
import type { OrgRegistryRecordReview } from './org-registry-record-sync';
import { readOrgRegistryRecordReview } from './org-registry-record-sync';
import { readOrgRegistrySyncState } from './org-registry-sync-cache';
import type { OrganizationRegistrySyncResult } from './org-registry-sync-worker';
import { assertWorkspaceMigrationActionsSettled } from './workspace-migration-admission';
import {
  assertRendererDatabaseStatementAllowed,
  notifyRendererDatabaseStatementSettled,
} from './workspace-sync-database-fence';
import {
  withWorkspaceMutation,
  workspaceMutationRootIdentity,
} from './workspace-sync-mutation-lease';

const operationId = (resolutionId: string) => `org-record-resolution:${resolutionId}`;

export function readPendingSavedRecordResolution(
  db: Database.Database,
  accountId: string,
  status: OrganizationRegistryRecordSyncStatus | null
): OrganizationRegistrySavedRecordResolutionRequest | null {
  if (!status || status.status !== 'publication_pending') return null;
  const scope = { accountId, orgId: status.orgId };
  const generation = readOrgRegistrySyncState(db, scope).accessGeneration;
  if (!generation) return null;
  const binding = db
    .prepare(
      'SELECT authority_kind FROM org_registry_local_records WHERE org_id=? AND account_id=? AND entity_id=?'
    )
    .get(status.orgId, accountId, status.entityId) as { authority_kind: string } | undefined;
  const readIdentity =
    binding?.authority_kind === 'primer_artifact'
      ? readReviewedPrimerArtifactResolutionIdentity
      : binding?.authority_kind === 'sequence_package'
        ? readPendingSequenceKeepSavedIdentity
        : readReviewedEntityArtifactResolutionIdentity;
  const pending = readIdentity(db, {
    ...scope,
    entityId: status.entityId,
    resolutionId: status.mutationId,
    operationId: operationId(status.mutationId),
    verifiedAccessGeneration: generation,
  });
  return pending
    ? {
        entityId: pending.entityId,
        resolutionId: pending.resolutionId,
        choice: pending.choice,
        sourceRevision: pending.sourceRevision,
      }
    : null;
}

export async function resolveSavedOrganizationRecord(
  db: Database.Database,
  input: {
    accountId: string;
    orgId: string;
    request: OrganizationRegistrySavedRecordResolutionRequest;
    getActiveAccountId: () => Promise<string | null>;
    refresh: () => Promise<OrganizationRegistrySyncResult>;
    readSavedSequenceSnapshot?: (
      review: OrgRegistryRecordReview
    ) => Promise<OrganizationSavedSequenceSnapshot>;
    readSavedPrimerSnapshot?: (
      review: OrgRegistryRecordReview
    ) => Promise<OrganizationSavedPrimerSnapshot>;
    readHomeAccess: (
      remoteWorkspaceId: string,
      expectedAccountId: string
    ) => Promise<WorkspaceSyncAccessListing>;
  }
) {
  const runDatabase = <T>(work: () => T): T => {
    assertRendererDatabaseStatementAllowed(db);
    try {
      return work();
    } finally {
      notifyRendererDatabaseStatementSettled(db);
    }
  };
  const assertCurrentAccount = async () => {
    if ((await input.getActiveAccountId()) !== input.accountId)
      throw Object.assign(new Error('The active account changed. Review the record again.'), {
        code: 'FORBIDDEN',
      });
  };
  await assertCurrentAccount();
  const refreshed = await input.refresh();
  await assertCurrentAccount();
  if (refreshed.status !== 'ready')
    throw Object.assign(
      new Error(
        refreshed.errorMessage ?? 'Verify organization access before applying this change.'
      ),
      {
        code: refreshed.status === 'access_revoked' ? 'FORBIDDEN' : 'SYNC_ERROR',
      }
    );
  const scope = { accountId: input.accountId, orgId: input.orgId };
  let generation = runDatabase(() => readOrgRegistrySyncState(db, scope).accessGeneration);
  if (!generation) throw new Error('Current organization access could not be verified.');
  const identity = {
    ...input.request,
    ...scope,
    operationId: operationId(input.request.resolutionId),
  };
  const readOwner = db.prepare(`
    SELECT w.id,w.path,w.repo_uuid,b.workspace_uuid,b.owner_account_id,b.owner_org_id,
      b.remote_workspace_id,b.access_role,b.access_source,b.updated_at,b.enabled,b.detached_reason,
      r.workspace_id AS enrolled_workspace_id,
      r.workspace_uuid AS enrolled_workspace_uuid,r.home_workspace_id
    FROM org_registry_local_records r JOIN lims_entity e ON e.id=r.entity_id
    JOIN workspaces w ON w.id=e.workspace_id
    LEFT JOIN workspace_sync_bindings b ON b.workspace_id=w.id
    WHERE r.entity_id=? AND r.account_id=? AND r.org_id=?
  `);
  type Home = {
    id: number;
    path: string;
    repo_uuid: string;
    workspace_uuid: string;
    owner_account_id: string;
    owner_org_id: string;
    remote_workspace_id: string;
    enrolled_workspace_id: number;
    enrolled_workspace_uuid: string;
    home_workspace_id: string;
    access_role: string | null;
    access_source: string | null;
    updated_at: number;
    enabled: number;
    detached_reason: string | null;
  };
  const readHome = () =>
    runDatabase(() => readOwner.get(identity.entityId, input.accountId, input.orgId)) as
      | Home
      | undefined;
  const owner = readHome();
  if (
    !owner ||
    owner.id !== owner.enrolled_workspace_id ||
    owner.repo_uuid !== owner.enrolled_workspace_uuid ||
    owner.workspace_uuid !== owner.repo_uuid ||
    owner.owner_account_id !== input.accountId ||
    owner.owner_org_id !== input.orgId ||
    owner.remote_workspace_id !== owner.home_workspace_id
  )
    throw new Error('The saved record’s verified organization home is unavailable.');
  let organizationPrimerSnapshot: OrganizationSavedPrimerSnapshot | undefined;
  let organizationSequenceSnapshot: OrganizationSavedSequenceSnapshot | undefined;
  const retainedResolution = runDatabase(() =>
    db
      .prepare(
        'SELECT 1 FROM org_registry_record_resolutions WHERE resolution_id=? AND org_id=? AND account_id=? AND entity_id=? AND publication_operation_id=?'
      )
      .get(
        identity.resolutionId,
        identity.orgId,
        identity.accountId,
        identity.entityId,
        identity.operationId
      )
  );
  if (identity.choice === 'use_remote' && !retainedResolution) {
    const beforeDownload = await readCheckedOrganizationRecordReview(
      db,
      identity,
      assertCurrentAccount,
      runDatabase
    );
    if (beforeDownload.displayed.sourceRevision !== identity.sourceRevision)
      throw Object.assign(
        new Error('The saved or organization version changed. Review the latest versions.'),
        { code: 'REVIEW_CHANGED' }
      );
    if (beforeDownload.review.binding.authority === 'primer_artifact') {
      const readSnapshot =
        input.readSavedPrimerSnapshot ??
        (await import('./org-registry-saved-primer-snapshot')).readOrganizationSavedPrimerSnapshot;
      organizationPrimerSnapshot = await readSnapshot(beforeDownload.review);
    } else if (beforeDownload.review.binding.authority === 'sequence_package') {
      const readSnapshot =
        input.readSavedSequenceSnapshot ??
        (await import('./org-registry-saved-sequence-snapshot'))
          .readOrganizationSavedSequenceSnapshot;
      organizationSequenceSnapshot = await readSnapshot(beforeDownload.review);
    }
    if (organizationPrimerSnapshot || organizationSequenceSnapshot) {
      await assertCurrentAccount();

      const afterDownload = await input.refresh();
      await assertCurrentAccount();
      if (afterDownload.status !== 'ready')
        throw Object.assign(
          new Error(
            afterDownload.errorMessage ?? 'Current organization access could not be verified.'
          ),
          {
            code: afterDownload.status === 'access_revoked' ? 'FORBIDDEN' : 'SYNC_ERROR',
          }
        );
      generation = runDatabase(() => readOrgRegistrySyncState(db, scope).accessGeneration);
      if (!generation) throw new Error('Current organization access could not be verified.');
    }
  }

  const access = await input.readHomeAccess(owner.remote_workspace_id, input.accountId);
  await assertCurrentAccount();
  if (
    access.workspaceId !== owner.remote_workspace_id ||
    access.owner.kind !== 'org' ||
    access.owner.orgId !== input.orgId
  )
    throw new Error('Current project access does not match this registered record’s home.');
  const verifiedGeneration = generation;
  const result = await withWorkspaceMutation(owner.path, async () => {
    await assertCurrentAccount();
    const current = readHome();
    if (
      !isDeepStrictEqual(current, owner) ||
      !current ||
      workspaceMutationRootIdentity(current.path) !== workspaceMutationRootIdentity(owner.path)
    )
      throw new Error(
        'The saved record’s home or recorded access changed. Retry after reviewing its current access.'
      );
    runDatabase(() =>
      updateWorkspaceSyncAccessRecord(db, {
        workspaceId: owner.id,
        role: access.viewer.role,
        source: access.viewer.sources[0]?.kind ?? 'owner',
        sharedWithOthers:
          access.owner.kind === 'org' || access.grants.length > 0 || access.invites.length > 0,
        nowMs: Date.now(),
      })
    );
    if (
      access.viewer.role !== 'owner' &&
      access.viewer.role !== 'manager' &&
      access.viewer.role !== 'editor'
    )
      throw Object.assign(
        new Error(
          'Write access to this record’s home project is required to apply the reviewed change.'
        ),
        { code: 'FORBIDDEN' }
      );
    runDatabase(() => assertLimsSafetyNotQuarantined(db));
    try {
      if (!statSync(owner.path).isDirectory()) throw new Error('Not a project directory.');
      accessSync(owner.path, constants.R_OK | constants.W_OK);
    } catch {
      throw new Error('The saved record’s home project must be available and writable.');
    }
    await assertWorkspaceMigrationActionsSettled(owner.path);
    await assertCurrentAccount();
    const currentReview = runDatabase(() =>
      readOrgRegistryRecordReview(db, {
        ...scope,
        entityId: identity.entityId,
        expectedAccessGeneration: verifiedGeneration,
      })
    );
    if (!currentReview) throw new Error('This saved record has no organization registration.');
    const context = {
      db,
      runDatabase,
      getActiveAccountId: input.getActiveAccountId,
    };
    const authority = currentReview.binding.authority;
    if (
      authority === 'entity_artifact' ||
      authority === 'primer_artifact' ||
      authority === 'sequence_package'
    ) {
      const verified = { ...identity, verifiedAccessGeneration: verifiedGeneration };

      const resumed =
        authority === 'entity_artifact'
          ? await resumeReviewedEntityArtifactResolution({ ...context, resolution: verified })
          : authority === 'primer_artifact'
            ? await resumeReviewedPrimerArtifactResolution({ ...context, ...verified })
            : await resumeReviewedSequencePackageResolution(context, verified);
      if (resumed) return resumed;
      const checked = await readCheckedOrganizationRecordReview(
        db,
        { ...scope, entityId: identity.entityId },
        assertCurrentAccount,
        runDatabase
      );
      if (checked.displayed.sourceRevision !== identity.sourceRevision)
        throw Object.assign(
          new Error('The saved or organization version changed. Review the latest versions.'),
          { code: 'REVIEW_CHANGED' }
        );
      const request = { ...identity, review: checked.review };
      if (authority === 'entity_artifact')
        return publishReviewedEntityArtifactResolution({
          ...context,
          request,
          verifiedAccessGeneration: verifiedGeneration,
        });
      if (authority === 'primer_artifact')
        return publishReviewedPrimerArtifactResolution({
          ...context,
          request,
          verifiedAccessGeneration: verifiedGeneration,
          organizationSnapshot: organizationPrimerSnapshot,
        });
      const locator = readManagedSequenceDocumentRef(
        checked.sequence?.entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]
      );
      if (!locator || locator.packageId !== identity.entityId)
        throw new Error('The reviewed sequence package location is unavailable.');
      return publishReviewedSequencePackageResolution(context, {
        workspaceRoot: owner.path,
        packageRoot: locator.packageRoot,
        request,
        organizationSnapshot: organizationSequenceSnapshot,
        verifiedAccessGeneration: verifiedGeneration,
      });
    }
    if (currentReview.binding.authority !== 'database')
      throw Object.assign(
        new Error(
          'Applying an organization version to this saved document type is not supported yet.'
        ),
        { code: 'UNSUPPORTED' }
      );

    return runDatabase(() =>
      db.transaction(() =>
        resolveDatabaseRegisteredRecordInTx(db, {
          request: { ...identity, review: currentReview },
          verifiedAccessGeneration: verifiedGeneration,
        })
      )()
    );
  });
  await assertCurrentAccount();
  return result;
}

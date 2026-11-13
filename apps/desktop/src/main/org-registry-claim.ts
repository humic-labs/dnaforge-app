import { withUserMessage } from '@waypoint/user-messages';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { limsEntityFromRow, type LimsEntityRow } from '../shared/lims';
import {
  parseOrganizationRegistryClaimPreparationRequest,
  type OrganizationRegistryClaimPreparationRequest,
  type PreparedOrganizationRegistryClaim,
} from '../shared/org-registry-sync';
import { readOrgRegistryCache } from './org-registry-sync-cache';
import { registrySourceEligibilitySql } from './registry-source-eligibility';
import { isWorkspaceSyncRemoteUuid } from './workspace-sync-remote-id';
import { isEntityRecordArtifactProjection } from '../shared/registry-file-types';
import { readCheckedEntityArtifactSnapshot } from './entity-artifact-mutations';
import {
  orgRegistryRecordPublicationAuthority,
  orgRegistryPublicationFields,
} from './org-registry-record-sync';
import { readCheckedPrimerArtifactSnapshot } from './primer-artifact-reader';
import { readCheckedManagedSequenceRegistrySnapshot } from './sequence-package-revision-publication';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import {
  assertRendererDatabaseStatementAllowed,
  notifyRendererDatabaseStatementSettled,
} from './workspace-sync-database-fence';

interface ClaimHome {
  id: number;
  name: string;
  path: string;
  repo_uuid: string | null;
  archived_at: number | null;
  trashed_at: number | null;
  workspace_uuid: string | null;
  owner_account_id: string | null;
  owner_org_id: string | null;
  remote_workspace_id: string | null;
  access_role: string | null;
  detached_reason: string | null;
}

export async function prepareOrganizationRegistryClaimInDb(
  db: Database.Database,
  context: { orgId: string; accountId: string; clientId: string },
  input: OrganizationRegistryClaimPreparationRequest,
  options: { assertCurrentAccount?: () => Promise<void> } = {}
): Promise<PreparedOrganizationRegistryClaim> {
  const request = parseOrganizationRegistryClaimPreparationRequest(input);
  const runDatabase = <T>(work: () => T): T => {
    assertRendererDatabaseStatementAllowed(db);
    try {
      return work();
    } finally {
      notifyRendererDatabaseStatementSettled(db);
    }
  };
  const assertCurrentAccount =
    options.assertCurrentAccount ??
    (async () => {
      const { getActiveStoredSession } = await import('./auth/session-store');
      if ((await getActiveStoredSession())?.accountId !== context.accountId)
        throw Object.assign(
          new Error('The active account changed. Review the Registry under the current account.'),
          { code: 'FORBIDDEN' }
        );
    });
  await assertCurrentAccount();
  const readSource = runDatabase(() =>
    db.prepare(
      `SELECT * FROM lims_entity WHERE id = ? AND tombstone = 0
    AND archived_at IS NULL AND (${registrySourceEligibilitySql(db)})`
    )
  );
  const row = runDatabase(() => readSource.get(request.entityId)) as LimsEntityRow | undefined;
  if (!row) throw new Error('Registration requires an available, active saved Registry record.');
  const entity = limsEntityFromRow(row);
  const authority = runDatabase(() => orgRegistryRecordPublicationAuthority(db, entity));
  if (entity.workspaceId === null) {
    throw new Error(
      'Registration requires the saved record’s verified home project. Resolve its project first.'
    );
  }
  const readHome = db.prepare(
    `SELECT w.id, w.name, w.path, w.repo_uuid,
      w.archived_at, w.trashed_at, b.workspace_uuid, b.owner_account_id,
      b.owner_org_id, b.remote_workspace_id, b.access_role, b.detached_reason
    FROM workspaces w LEFT JOIN workspace_sync_bindings b ON b.workspace_id = w.id
    WHERE w.id = ?`
  );
  const home = runDatabase(() => readHome.get(entity.workspaceId)) as ClaimHome | undefined;
  if (!home || !home.repo_uuid || home.archived_at !== null || home.trashed_at !== null) {
    throw new Error(
      'Registration requires an available, active home project. Restore its project first.'
    );
  }
  if (home.detached_reason || home.access_role === 'viewer') {
    throw new Error('Registration requires write access to the record’s home project.');
  }
  try {
    if (!statSync(home.path).isDirectory()) throw new Error('Not a project directory.');
    accessSync(home.path, constants.R_OK | constants.W_OK);
  } catch {
    throw new Error('Registration requires the available, writable home project on this device.');
  }
  if (
    home.workspace_uuid !== home.repo_uuid ||
    home.owner_account_id !== context.accountId ||
    home.owner_org_id !== context.orgId ||
    !isWorkspaceSyncRemoteUuid(home.remote_workspace_id)
  ) {
    throw withUserMessage(
      new Error(
        'Registration requires an existing organization home project for this account. Set up its project through the project sharing controls first.'
      ),
      'registry.organizationHomeRequired'
    );
  }

  const readSavedBindings = () =>
    runDatabase(() =>
      db
        .prepare(
          `SELECT f.id, f.entity_id, f.workspace_id, f.path, f.relative_path, f.file_kind, f.status, f.object_uuid,
    c.status AS catalogStatus, c.locator AS catalogLocator, c.type AS catalogType,
    c.workspace_id AS catalogWorkspaceId, c.storage_type AS storageType
    FROM catalog_entity_files f JOIN catalog_entities c ON c.id=f.entity_id
    WHERE f.entity_id=? AND f.status='current' ORDER BY f.id`
        )
        .all(entity.id)
    );
  const savedBindings = readSavedBindings();
  const registry = runDatabase(() => readOrgRegistryCache(db, context));
  const schema = registry.schemas.find((candidate) => candidate.id === request.schemaId);
  if (
    !schema ||
    schema.currentRevisionId !== request.schemaRevisionId ||
    (schema.baseKind !== entity.kind && schema.name !== entity.kind) ||
    schema.archived === true ||
    schema.archivedAt != null
  ) {
    throw new Error(
      'Registration requires the current compatible organization definition. Refresh and review the record again.'
    );
  }
  const artifact = isEntityRecordArtifactProjection(entity.fields)
    ? await readCheckedEntityArtifactSnapshot({
        db,
        runDatabase,
        entityId: entity.id,
      })
    : null;
  const primer =
    authority === 'primer_artifact'
      ? await readCheckedPrimerArtifactSnapshot({ db, runDatabase, entityId: entity.id })
      : null;
  const locator = readManagedSequenceDocumentRef(entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
  if (authority === 'sequence_package' && (!locator || locator.packageId !== entity.id))
    throw new Error('Registration requires the saved sequence package’s verified identity.');
  const sequence =
    authority === 'sequence_package' && locator
      ? await readCheckedManagedSequenceRegistrySnapshot(
          {
            db,
            runDatabase,
            getActiveAccountId: async () => {
              await assertCurrentAccount();
              return context.accountId;
            },
          },
          { entityId: entity.id, workspaceRoot: home.path, packageRoot: locator.packageRoot }
        )
      : null;
  await assertCurrentAccount();
  {
    const latestRegistry = runDatabase(() => readOrgRegistryCache(db, context));
    if (
      !isDeepStrictEqual(
        runDatabase(() => readSource.get(entity.id)),
        row
      ) ||
      !isDeepStrictEqual(
        runDatabase(() => readHome.get(entity.workspaceId)),
        home
      ) ||
      !isDeepStrictEqual(readSavedBindings(), savedBindings) ||
      latestRegistry.state.accessGeneration !== registry.state.accessGeneration ||
      !isDeepStrictEqual(
        latestRegistry.schemas.find((candidate) => candidate.id === request.schemaId),
        schema
      )
    ) {
      throw new Error(
        'Registration requires another review: the saved record, definition or home changed.'
      );
    }
  }
  const payload = {
    id: entity.id,
    homeWorkspaceId: home.remote_workspace_id,
    schemaId: request.schemaId,
    schemaRevisionId: request.schemaRevisionId,
    kind: entity.kind,
    name: entity.name,
    fields: orgRegistryPublicationFields(entity, authority),
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    claimProvenance: {
      kind: 'desktop_local_claim',
      clientId: context.clientId,
      localEntityId: entity.id,
      localRegistryId: entity.registryId,
      localHomeProjectUuid: home.repo_uuid,
    },
  };
  const sourceRevision = createHash('sha256')
    .update(
      JSON.stringify({
        context: {
          orgId: context.orgId,
          accountId: context.accountId,
          clientId: context.clientId,
        },
        entity: row,
        home,
        ...(primer || sequence ? { savedBindings } : {}),
        schema,
        payload,
        ...(primer
          ? {
              primer: {
                owner: primer.owner,
                schemaSnapshot: primer.schemaSnapshot,
                sha256: primer.sha256,
              },
            }
          : {}),
        ...(sequence
          ? {
              sequence: {
                packageId: sequence.document.id,
                formatVersion: sequence.document.formatVersion,
                markerSha256: sequence.markerSha256,
                productSha256: sequence.productSha256,
                publicationDigest: sequence.publicationDigest,
              },
            }
          : {}),
        ...(artifact
          ? {
              artifact: {
                owner: artifact.owner,
                fileSchema: artifact.fileSchema,
                sha256: artifact.sha256,
              },
            }
          : {}),
      })
    )
    .digest('hex');
  return {
    mutationId: randomUUID(),
    sourceEntityId: entity.id,
    sourceRegistryId: entity.registryId,
    sourceRevision,
    homeWorkspaceId: home.remote_workspace_id,
    homeProjectUuid: home.repo_uuid,
    homeProjectName: home.name,
    payload,
  };
}

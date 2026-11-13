import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { LIMS_REGISTRATION_STATUSES, limsEntityFromRow, type LimsEntityRow } from '../shared/lims';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import type {
  OrganizationRegistrySavedRecordReview,
  OrganizationRegistrySavedRecordVersion,
} from '../shared/org-registry-sync';
import { readCheckedEntityArtifactSnapshot } from './entity-artifact-mutations';
import { readCheckedPrimerArtifactSnapshot } from './primer-artifact-reader';
import { readCheckedManagedSequenceRegistrySnapshot } from './sequence-package-revision-publication';
import { readOrgRegistryRecordReview } from './org-registry-record-sync';
import {
  registeredRecordResolutionSourceRevision,
  registeredSpecializedRecordFingerprint,
} from './org-registry-local-mutations';
import {
  assertRendererDatabaseStatementAllowed,
  notifyRendererDatabaseStatementSettled,
} from './workspace-sync-database-fence';

export async function readCheckedOrganizationRecordReview(
  db: Database.Database,
  input: { accountId: string; orgId: string; entityId: string },
  assertCurrentAccount: () => Promise<void>,
  runDatabase: <T>(work: () => T) => T = (work) => {
    assertRendererDatabaseStatementAllowed(db);
    try {
      return work();
    } finally {
      notifyRendererDatabaseStatementSettled(db);
    }
  }
) {
  const review = runDatabase(() => readOrgRegistryRecordReview(db, input));
  if (!review) throw new Error('This saved record has no organization registration.');
  const readSavedOwner = () =>
    runDatabase(() => ({
      row: db.prepare('SELECT * FROM lims_entity WHERE id=?').get(input.entityId) as
        | LimsEntityRow
        | undefined,
      home: db
        .prepare('SELECT id,path,repo_uuid FROM workspaces WHERE id=?')
        .get(review.binding.workspaceId) as
        | { id: number; path: string; repo_uuid: string }
        | undefined,
      files: db
        .prepare(
          `SELECT f.id, f.entity_id, f.workspace_id, f.path, f.relative_path, f.file_kind, f.status, f.object_uuid,
    c.status AS catalogStatus, c.locator AS catalogLocator, c.type AS catalogType, c.workspace_id AS catalogWorkspaceId,
      c.storage_type AS storageType FROM catalog_entity_files f JOIN catalog_entities c ON c.id=f.entity_id
      WHERE f.entity_id=? AND f.status='current' ORDER BY f.id`
        )
        .all(input.entityId),
    }));
  const savedOwner = readSavedOwner();
  if (!savedOwner.row || !savedOwner.home)
    throw new Error('The saved record’s owning project is unavailable.');
  const entity = limsEntityFromRow(savedOwner.row);
  const file =
    review.binding.authority === 'entity_artifact'
      ? await readCheckedEntityArtifactSnapshot({
          db,
          runDatabase,
          entityId: input.entityId,
        })
      : null;
  const primer =
    review.binding.authority === 'primer_artifact'
      ? await readCheckedPrimerArtifactSnapshot({ db, runDatabase, entityId: input.entityId })
      : null;
  const locator = readManagedSequenceDocumentRef(entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
  if (
    review.binding.authority === 'sequence_package' &&
    (!locator || locator.packageId !== input.entityId)
  )
    throw new Error('The saved sequence package identity changed. Review it again.');
  const sequence =
    review.binding.authority === 'sequence_package' && locator
      ? await readCheckedManagedSequenceRegistrySnapshot(
          {
            db,
            runDatabase,
            getActiveAccountId: async () => {
              await assertCurrentAccount();
              return input.accountId;
            },
          },
          {
            entityId: input.entityId,
            workspaceRoot: savedOwner.home.path,
            packageRoot: locator.packageRoot,
          }
        )
      : null;
  if (
    !['database', 'entity_artifact', 'primer_artifact', 'sequence_package'].includes(
      review.binding.authority
    )
  )
    throw new Error('Reviewing this saved document type is not supported yet.');
  await assertCurrentAccount();
  if (
    runDatabase(() => readOrgRegistryRecordReview(db, input)?.sourceRevision) !==
      review.sourceRevision ||
    !isDeepStrictEqual(readSavedOwner(), savedOwner)
  )
    throw new Error('The record changed while its versions were read. Review them again.');
  const savedOwnerIdentity = { home: savedOwner.home, files: savedOwner.files };
  const specializedFingerprint =
    primer || sequence
      ? registeredSpecializedRecordFingerprint(
          primer ? 'primer_artifact' : 'sequence_package',
          savedOwnerIdentity,
          primer ? primer.sha256 : sequence!.publicationDigest.sha256
        )
      : null;
  const sourceRevision = registeredRecordResolutionSourceRevision(
    review.sourceRevision,
    file?.sha256 ?? specializedFingerprint
  );
  const displayed: OrganizationRegistrySavedRecordReview = {
    accountId: input.accountId,
    orgId: input.orgId,
    entityId: input.entityId,
    sourceRevision,
    localEventSeq: Number(review.localEventSeq),
    organizationRevision: review.canonical.revision,
    local: savedVersion(review.local),
    organization: savedVersion({
      ...review.canonical,
      archived: review.canonical.archivedAt != null,
    }),
  };
  return { review, file, primer, sequence, displayed, savedOwnerIdentity };
}

function savedVersion(value: Record<string, unknown>): OrganizationRegistrySavedRecordVersion {
  if (
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !value.fields ||
    typeof value.fields !== 'object' ||
    Array.isArray(value.fields) ||
    !LIMS_REGISTRATION_STATUSES.some((status) => status === value.registrationStatus) ||
    (value.domainStatus !== null && typeof value.domainStatus !== 'string') ||
    typeof value.archived !== 'boolean'
  )
    throw new Error('The record version is incomplete. Refresh the organization Registry.');
  return {
    id: value.id,
    name: value.name,
    fields: value.fields as Record<string, unknown>,
    registrationStatus:
      value.registrationStatus as OrganizationRegistrySavedRecordVersion['registrationStatus'],
    domainStatus: value.domainStatus as string | null,
    archived: value.archived,
  };
}

import {
  assertOrganizationSavedSequenceSnapshot,
  type OrganizationSavedSequenceSnapshot,
} from './org-registry-saved-sequence-snapshot-contract';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { computeChecksum } from '@waypoint/sequence-utils';
import { parseSequenceFileAsDocument } from '../shared/parse-sequence-file';
import type Database from 'better-sqlite3';
import {
  fromPackageRelative,
  parseSequencePackageDocument,
  SEQUENCE_PACKAGE_FORMAT_VERSION,
  sequencePackagePaths,
  type SequencePackageDocument,
} from '../db/sequence-package';
import { readSequenceProductSummary } from '../db/entity-substrate/sequence-product-summary-runtime';
import {
  projectManagedSequenceRegistry,
  managedSequenceProjectionVersionForExistingRecord,
  type ManagedSequenceProjectionVersion,
  semanticManagedSequenceProjectionFields,
  type ManagedSequenceRegistryProjection,
} from '../shared/managed-sequence-registry-projection';
import {
  MANAGED_SEQUENCE_DOCUMENT_FIELD,
  readManagedSequenceDocumentRef,
} from '../shared/managed-sequence-document';
import { limsEntityFromRow, type LimsEntity } from '../shared/lims';
import { parseLimsEntitySnapshot } from '../shared/lims-entity-snapshot';
import { canonicalWorkspacePath } from './primer-artifact-files';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import { createNativeSequenceDocumentResolver } from './native-sequence-document-resolver';
import { registrySchemaSnapshotForEntity } from './lims-registry-projection';
import { getEntityRowById, updateLimsEntityInsideTx } from './lims-engine-core';
import { applyPublishedSequenceLifecycleInsideTx } from './lims-entity-lifecycle';
import {
  captureOrgRegistryRecordPublicationInTx,
  prepareOrgRegistryRecordResolutionInTx,
  captureOrgRegistryRecordResolutionPublicationInTx,
  settleOrgRegistryRecordResolutionInTx,
  readOrgRegistryResolutionPublicationAdmissionInDb,
  readOrgRegistryRecordResolutionRetryReview,
  markOrgRegistryRecordPublicationReadyInTx,
  orgRegistrySequencePackagePublicationDigest,
  readOrgRegistryPublicationAdmissionInDb,
  type OrgRegistryPublicationAdmission,
  type OrgRegistryRecordReview,
} from './org-registry-record-sync';
import {
  registeredRecordResolutionIdentity,
  registeredRecordResolutionRequestHash,
  assertRegisteredRecordResolutionAccessInDb,
  type RegisteredRecordResolutionIdentity,
  type RegisteredRecordResolutionRequest,
  type VerifiedRegisteredRecordResolution,
} from './org-registry-local-mutations';

export interface RegisteredSequencePackagePublicationContext {
  db: Database.Database;
  runDatabase<T>(work: () => T): T;
  getActiveAccountId(): Promise<string | null>;

  organizationResolution?: VerifiedRegisteredRecordResolution;

  lifecyclePublication?: true;
}

export function createRegisteredSequencePackagePublicationContext(input: {
  db: Database.Database;
  runDatabase<T>(work: () => T): T;
  getActiveAccountId?: () => Promise<string | null>;
}): RegisteredSequencePackagePublicationContext {
  return {
    ...input,
    getActiveAccountId:
      input.getActiveAccountId ??
      (async () =>
        (await (await import('./auth/session-store')).getActiveStoredSession())?.accountId ?? null),
  };
}

const INTENT_SCHEMA = 'waypoint.registered-sequence-publication.v1' as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;

export type RegisteredSequencePublicationIntent = {
  schema: typeof INTENT_SCHEMA;
  accountId: string;
  operationId: string;
  revisionId: string;
  requestFingerprint: string;
  admission: OrgRegistryPublicationAdmission;
  markerSha256: string;
  productSha256: string;
  formatVersion: number;
  desired: ManagedSequenceRegistryProjection;
  lifecycle?: NonNullable<SequencePackageDocument['entity']['lifecycle']>;
  organizationResolution?: RegisteredRecordResolutionIdentity;
};

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
function same(left: unknown, right: unknown): boolean {
  return canonicalNativeMutationRequest(left) === canonicalNativeMutationRequest(right);
}
function matchesSavedSchema(
  current: ReturnType<typeof registrySchemaSnapshotForEntity>,
  saved: ManagedSequenceRegistryProjection['schemaSnapshot']
) {
  const { description: currentDescription, ...currentDefinition } = current;
  const { description: savedDescription, ...savedDefinition } = saved;

  return (
    same(currentDefinition, savedDefinition) &&
    (savedDescription === undefined || (currentDescription ?? null) === savedDescription)
  );
}
function projectedValue(entity: LimsEntity) {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    fields: semanticManagedSequenceProjectionFields(entity.fields),
    schemaRevisionId: entity.schemaRevisionId,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
  };
}
function desiredValue(desired: ManagedSequenceRegistryProjection) {
  const { schemaSnapshot: _schemaSnapshot, ...value } = desired;
  return value;
}

async function admission(
  context: RegisteredSequencePackagePublicationContext,
  entityId: string
): Promise<OrgRegistryPublicationAdmission | null> {
  const enrolled = context.runDatabase(() =>
    Boolean(
      context.db.prepare('SELECT 1 FROM org_registry_local_records WHERE entity_id=?').get(entityId)
    )
  );
  if (!enrolled) return null;
  const accountId = await context.getActiveAccountId();
  return context.runDatabase(() =>
    readOrgRegistryPublicationAdmissionInDb(context.db, { entityId, accountId })
  );
}

async function assertNativeOwner(
  context: RegisteredSequencePackagePublicationContext,
  input: { workspaceRoot: string; packageRoot: string; packageId: string },
  entity: LimsEntity
): Promise<void> {
  if (
    !UUID.test(input.packageId) ||
    entity.id !== input.packageId ||
    (entity.tombstone && !context.lifecyclePublication && !context.organizationResolution)
  )
    throw new Error('Only an active UUID sequence package can publish organization changes.');
  const locator = readManagedSequenceDocumentRef(entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD]);
  if (!locator || locator.packageId !== input.packageId)
    throw new Error('The registered sequence package locator changed.');
  const [packageRoot, locatorRoot, workspaceRoot] = await Promise.all([
    realpath(input.packageRoot),
    realpath(locator.packageRoot),
    realpath(input.workspaceRoot),
  ]);
  if (packageRoot !== locatorRoot)
    throw new Error('The registered sequence package has another local location.');
  const resolve = createNativeSequenceDocumentResolver({
    db: () => context.db,
    workspaceRoots: () => [workspaceRoot],
    allowArchived: context.lifecyclePublication || Boolean(context.organizationResolution),
  });

  const native = await context.runDatabase(() =>
    resolve({ operationId: 'registered-sequence-publication', targetDocumentId: input.packageId })
  );
  if (native.workspaceRoot !== workspaceRoot || dirname(native.sourcePath) !== packageRoot)
    throw new Error('The registered sequence package does not match its current native owner.');
}

async function projection(
  document: SequencePackageDocument,
  productContent: string,
  projectionVersion?: ManagedSequenceProjectionVersion,
  markerContent?: string
) {
  if (document.formatVersion !== SEQUENCE_PACKAGE_FORMAT_VERSION)
    throw new Error('The sequence package requires migration before registered publication.');
  if (
    document.product.genBankChecksum &&
    document.product.genBankChecksum !== `sha256:${hash(productContent)}`
  )
    throw new Error('The sequence package product digest does not match its saved bytes.');
  if (
    document.product.sequenceChecksum &&
    document.product.sequenceChecksum !==
      (await computeChecksum(
        parseSequenceFileAsDocument(productContent, document.product.file).sequence.sequence
      ))
  )
    throw new Error('The sequence package base digest does not match its saved product.');
  const value = await projectManagedSequenceRegistry(
    document,
    await readSequenceProductSummary(productContent),
    projectionVersion,
    markerContent
  );
  return { ...value, fields: semanticManagedSequenceProjectionFields(value.fields) };
}

export async function readCheckedManagedSequencePair(
  context: RegisteredSequencePackagePublicationContext,
  input: { entityId: string; workspaceRoot: string; packageRoot: string }
) {
  const entity = context.runDatabase(() =>
    limsEntityFromRow(getEntityRowById(context.db, input.entityId))
  );
  await assertNativeOwner(context, { ...input, packageId: input.entityId }, entity);
  const markerContent = await readContained(
    input.workspaceRoot,
    sequencePackagePaths(input.packageRoot).metaPath
  );
  const raw = JSON.parse(markerContent) as { formatVersion?: unknown };
  if (raw.formatVersion !== SEQUENCE_PACKAGE_FORMAT_VERSION)
    throw new Error('The sequence package requires its supported migration before registration.');
  const document = parseSequencePackageDocument(markerContent);
  if (document.id !== input.entityId) throw new Error('The sequence package identity changed.');
  const productContent = await readContained(
    input.workspaceRoot,
    sequencePackagePaths(input.packageRoot, { productFile: document.product.file }).productPath
  );
  const projected = await projection(
    document,
    productContent,
    managedSequenceProjectionVersionForExistingRecord(entity.fields),
    markerContent
  );
  const schema = context.runDatabase(() => registrySchemaSnapshotForEntity(context.db, entity));
  if (
    entity.tombstone !== (document.entity.lifecycle?.archived ?? false) ||
    entity.archivedAt !== (document.entity.lifecycle?.archivedAt ?? null) ||
    !same(projectedValue(entity), desiredValue(projected)) ||
    !matchesSavedSchema(schema, projected.schemaSnapshot)
  )
    throw Object.assign(
      new Error(
        'Sequence package bytes and Registry projection disagree. Preserve both versions and reconcile before another review.'
      ),
      { code: 'REVIEW_CHANGED' }
    );
  await assertNativeOwner(context, { ...input, packageId: input.entityId }, entity);
  if (
    !same(
      context.runDatabase(() => limsEntityFromRow(getEntityRowById(context.db, input.entityId))),
      entity
    )
  )
    throw new Error('The sequence Registry record changed while checking its saved bytes.');
  const markerSha256 = hash(markerContent);
  const productSha256 = hash(productContent);
  if (
    hash(
      await readContained(input.workspaceRoot, sequencePackagePaths(input.packageRoot).metaPath)
    ) !== markerSha256 ||
    hash(
      await readContained(
        input.workspaceRoot,
        sequencePackagePaths(input.packageRoot, { productFile: document.product.file }).productPath
      )
    ) !== productSha256
  )
    throw new Error('The sequence package files changed while their saved identity was checked.');
  return {
    entity,
    document,
    markerContent,
    productContent,
    markerSha256,
    productSha256,
    publicationDigest: orgRegistrySequencePackagePublicationDigest({
      packageId: document.id,
      formatVersion: document.formatVersion,
      markerSha256,
      productSha256,
    }),
    projection: projected,
  };
}

export async function assertRegisteredSequencePackageCurrent(
  context: RegisteredSequencePackagePublicationContext,
  input: {
    workspaceRoot: string;
    packageRoot: string;
    markerContent: string;
    productContent?: string;
  }
): Promise<OrgRegistryPublicationAdmission | null> {
  const document = parseSequencePackageDocument(input.markerContent);
  const checked = await admission(context, document.id);
  if (!checked) return null;
  const snapshot = await readCheckedManagedSequencePair(context, {
    ...input,
    entityId: document.id,
  });
  if (
    snapshot.markerContent !== input.markerContent ||
    (input.productContent !== undefined && snapshot.productContent !== input.productContent) ||
    !same(snapshot.entity, checked.entity)
  )
    throw new Error('The registered sequence bytes changed during publication admission.');
  const current = await admission(context, document.id);
  if (!current || !same(current, checked))
    throw new Error('The registered sequence record changed while checking its saved bytes.');
  return checked;
}

export async function prepareRegisteredSequencePublication(
  context: RegisteredSequencePackagePublicationContext,
  input: {
    workspaceRoot: string;
    packageRoot: string;
    beforeMarkerContent: string;
    beforeProductContent: string;
    nextMarkerContent: string;
    nextProductContent: string;
    operationId: string;
    revisionId: string;
    requestFingerprint: string;
  }
): Promise<RegisteredSequencePublicationIntent | undefined> {
  const checked = await assertRegisteredSequencePackageCurrent(context, {
    ...input,
    markerContent: input.beforeMarkerContent,
    productContent: input.beforeProductContent,
  });
  if (!checked) return undefined;
  const document = parseSequencePackageDocument(input.nextMarkerContent);
  const beforeLifecycle = parseSequencePackageDocument(input.beforeMarkerContent).entity
    .lifecycle ?? { archived: false, archivedAt: null };
  const afterLifecycle = document.entity.lifecycle ?? { archived: false, archivedAt: null };
  if (!same(beforeLifecycle, afterLifecycle) && !context.lifecyclePublication)
    throw new Error(
      'Use the Registry Archive or Restore action to change saved sequence lifecycle.'
    );
  const desired = await projection(
    document,
    input.nextProductContent,
    undefined,
    input.nextMarkerContent
  );
  const currentSchema = context.runDatabase(() =>
    registrySchemaSnapshotForEntity(context.db, checked.entity)
  );
  if (
    desired.id !== checked.entity.id ||
    desired.kind !== checked.entity.kind ||
    desired.schemaRevisionId !== checked.entity.schemaRevisionId ||
    !matchesSavedSchema(currentSchema, desired.schemaSnapshot)
  )
    throw new Error(
      'A registered sequence publication cannot change identity or its pinned definition.'
    );

  if (
    desired.schemaSnapshot.fields.some(
      (field) =>
        field.type === 'formula_result' &&
        desired.fields[field.key] &&
        typeof desired.fields[field.key] === 'object' &&
        (desired.fields[field.key] as { compatibility?: unknown; stale?: unknown })
          .compatibility === 'unsupported' &&
        (desired.fields[field.key] as { stale?: unknown }).stale !== true
    ) &&
    !same(desired.fields, semanticManagedSequenceProjectionFields(checked.entity.fields))
  )
    throw new Error(
      'This sequence definition requires a supported formula publication before saving.'
    );
  const current = await admission(context, document.id);
  if (!current || !same(current, checked))
    throw new Error('The registered sequence record changed before publication.');
  return {
    schema: INTENT_SCHEMA,
    accountId: checked.bindings[0].accountId,
    operationId: input.operationId,
    revisionId: input.revisionId,
    requestFingerprint: input.requestFingerprint,
    admission: checked,
    markerSha256: hash(input.nextMarkerContent),
    productSha256: hash(input.nextProductContent),
    formatVersion: document.formatVersion,
    desired,
    ...(document.entity.lifecycle ? { lifecycle: document.entity.lifecycle } : {}),
  };
}

export function parseRegisteredSequencePublicationIntent(
  value: unknown
): RegisteredSequencePublicationIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Registered sequence publication intent is invalid.');
  const intent = value as RegisteredSequencePublicationIntent;
  if (
    intent.schema !== INTENT_SCHEMA ||
    !intent.accountId ||
    !intent.operationId ||
    !intent.revisionId ||
    !/^sha256:[a-f0-9]{64}$/.test(intent.requestFingerprint) ||
    !DIGEST.test(intent.markerSha256) ||
    !DIGEST.test(intent.productSha256) ||
    intent.formatVersion !== SEQUENCE_PACKAGE_FORMAT_VERSION ||
    !intent.admission?.entity ||
    !Array.isArray(intent.admission.bindings) ||
    !intent.admission.bindings.length ||
    !intent.desired ||
    intent.desired.id !== intent.admission.entity.id ||
    intent.admission.bindings.some(
      (binding) =>
        binding.accountId !== intent.accountId ||
        binding.entityId !== intent.desired.id ||
        binding.authorityKind !== 'sequence_package'
    )
  )
    throw new Error('Registered sequence publication intent has an invalid identity or digest.');
  if (
    intent.lifecycle &&
    (typeof intent.lifecycle.archived !== 'boolean' ||
      (intent.lifecycle.archived
        ? !Number.isSafeInteger(intent.lifecycle.archivedAt) ||
          Number(intent.lifecycle.archivedAt) < 0
        : intent.lifecycle.archivedAt !== null))
  )
    throw new Error('Registered sequence lifecycle intent is invalid.');
  if (intent.organizationResolution) {
    const identity = registeredRecordResolutionIdentity(intent.organizationResolution);
    if (
      identity.accountId !== intent.accountId ||
      identity.entityId !== intent.desired.id ||
      identity.operationId !== intent.operationId ||
      intent.requestFingerprint !== `sha256:${registeredRecordResolutionRequestHash(identity)}`
    )
      throw new Error('The retained sequence resolution identity changed.');
  }
  return intent;
}

export async function assertRegisteredSequencePublicationAccess(
  context: RegisteredSequencePackagePublicationContext,
  input: { workspaceRoot: string; packageRoot: string; intent: RegisteredSequencePublicationIntent }
): Promise<OrgRegistryPublicationAdmission> {
  const intent = parseRegisteredSequencePublicationIntent(input.intent);
  if ((await context.getActiveAccountId()) !== intent.accountId)
    throw new Error(
      'Sign in with the account that registered this sequence to finish its saved publication.'
    );
  const resolution = verifiedSequenceResolution(context, intent);
  const readAdmission = async () => {
    if ((await context.getActiveAccountId()) !== intent.accountId)
      throw new Error('The active account changed while checking the sequence publication.');
    return resolution
      ? context.runDatabase(() =>
          readOrgRegistryResolutionPublicationAdmissionInDb(context.db, resolution)
        )
      : admission(context, intent.desired.id);
  };
  const current = await readAdmission();
  if (!current || !same(current.bindings, intent.admission.bindings))
    throw new Error(
      'The saved sequence publication no longer has its reviewed organization connection.'
    );
  await assertNativeOwner(context, { ...input, packageId: intent.desired.id }, current.entity);
  const verified = await readAdmission();
  if (!verified || !same(verified.bindings, intent.admission.bindings))
    throw new Error('The registered sequence connection changed while checking its native owner.');
  return current;
}

export function hasSettledRegisteredSequencePublicationInDb(
  context: RegisteredSequencePackagePublicationContext,
  intent: RegisteredSequencePublicationIntent
): boolean {
  const publicationDigest = orgRegistrySequencePackagePublicationDigest({
    packageId: intent.desired.id,
    formatVersion: intent.formatVersion,
    markerSha256: intent.markerSha256,
    productSha256: intent.productSha256,
  });
  if (intent.organizationResolution) {
    const retained = readSequenceResolutionRow(context.db, intent.organizationResolution);
    if (!retained || !same(retained.plan.intent, intent))
      throw new Error('The sequence journal no longer matches its retained approval.');
    if (retained.row.status !== 'settled') return false;
    const result = parseLimsEntitySnapshot(JSON.parse(retained.row.published_entity_json!));
    if (
      retained.row.publication_authority !== publicationDigest.authority ||
      retained.row.publication_sha256 !== publicationDigest.sha256 ||
      result.eventSeq !== retained.row.published_local_event_seq ||
      Number(result.eventSeq) <= Number(intent.admission.entity.eventSeq) ||
      result.tombstone !== (intent.lifecycle?.archived ?? false) ||
      result.archivedAt !== (intent.lifecycle?.archivedAt ?? null) ||
      !same(projectedValue(result), desiredValue(intent.desired))
    )
      throw new Error('The settled sequence approval has a different published result.');
    return true;
  }
  const prior = context.db
    .prepare(
      `SELECT org_id,account_id,entity_id,local_event_seq,publication_authority,publication_sha256,payload_json,status FROM org_registry_record_publications WHERE entity_id=? AND operation_id=?`
    )
    .all(intent.desired.id, intent.operationId) as Array<{
    org_id: string;
    account_id: string;
    entity_id: string;
    local_event_seq: number;
    publication_authority: string;
    publication_sha256: string;
    payload_json: string;
    status: string;
  }>;
  const expectedPayload = {
    id: intent.desired.id,
    name: intent.desired.name,
    fields: intent.desired.fields,
    registrationStatus: intent.desired.registrationStatus,
    domainStatus: intent.desired.domainStatus,
    archived: intent.lifecycle?.archived ?? false,
  };
  if (prior.length) {
    if (
      prior.length !== intent.admission.bindings.length ||
      prior.some(
        (row) =>
          !intent.admission.bindings.some(
            (binding) => binding.orgId === row.org_id && binding.accountId === row.account_id
          ) ||
          row.publication_authority !== publicationDigest.authority ||
          row.publication_sha256 !== publicationDigest.sha256 ||
          row.local_event_seq <= (intent.admission.entity.eventSeq ?? 0) ||
          row.status === 'publication_pending' ||
          row.local_event_seq !== prior[0].local_event_seq ||
          !same(JSON.parse(row.payload_json), expectedPayload)
      )
    )
      throw new Error(
        'The registered sequence operation has a different durable publication receipt.'
      );
    const audit = context.db
      .prepare(
        `SELECT event_seq,event_type,batch_id,before,after FROM lims_audit WHERE event_seq>? AND event_seq<=? AND subject_table='lims_entity' AND subject_id=? ORDER BY event_seq`
      )
      .all(intent.admission.entity.eventSeq, prior[0].local_event_seq, intent.desired.id) as Array<{
      event_seq: number;
      event_type: string;
      batch_id: string | null;
      before: string;
      after: string;
    }>;
    const lifecycle = intent.lifecycle ?? { archived: false, archivedAt: null };
    const lifecycleChanged =
      intent.admission.entity.tombstone !== lifecycle.archived ||
      intent.admission.entity.archivedAt !== lifecycle.archivedAt;
    const first = audit[0],
      last = audit.at(-1);
    if (
      !first ||
      !last ||
      audit.length !== (lifecycleChanged ? 2 : 1) ||
      first.event_type !== 'entity_updated' ||
      audit.some((event) => event.batch_id !== intent.operationId) ||
      !same(JSON.parse(first.before), intent.admission.entity) ||
      !same(
        projectedValue(parseLimsEntitySnapshot(JSON.parse(first.after))),
        desiredValue(intent.desired)
      ) ||
      (lifecycleChanged &&
        (last.event_type !== (lifecycle.archived ? 'entity_archived' : 'entity_restored') ||
          !same(JSON.parse(last.before), JSON.parse(first.after))))
    )
      throw new Error('The original registered sequence publication audit is unavailable.');
    const result = parseLimsEntitySnapshot(JSON.parse(last.after));
    if (
      result.eventSeq !== prior[0].local_event_seq ||
      result.tombstone !== lifecycle.archived ||
      result.archivedAt !== lifecycle.archivedAt ||
      !same(projectedValue(result), desiredValue(intent.desired))
    )
      throw new Error(
        'The saved sequence publication lifecycle receipt differs from its installed marker.'
      );

    return true;
  }
  return false;
}

export async function settleRegisteredSequencePublication(
  context: RegisteredSequencePackagePublicationContext,
  input: { workspaceRoot: string; packageRoot: string; intent: RegisteredSequencePublicationIntent }
): Promise<void> {
  const intent = parseRegisteredSequencePublicationIntent(input.intent);
  if (intent.organizationResolution) {
    await assertRegisteredSequencePublicationAccess(context, input);
    if (context.runDatabase(() => hasSettledRegisteredSequencePublicationInDb(context, intent)))
      return;
  }
  const markerContent = await readContained(
    input.workspaceRoot,
    sequencePackagePaths(input.packageRoot).metaPath
  );
  const document = parseSequencePackageDocument(markerContent);
  const revision = document.versionHistory.revisions.find((item) =>
    intent.organizationResolution
      ? item.id === intent.revisionId
      : item.operationId === intent.operationId
  );
  if (
    !revision ||
    revision.id !== intent.revisionId ||
    (!intent.organizationResolution && revision.requestFingerprint !== intent.requestFingerprint) ||
    document.versionHistory.headId !== intent.revisionId
  )
    throw new Error(
      'The installed sequence history does not match its retained publication request.'
    );
  const productContent = await readContained(
    input.workspaceRoot,
    sequencePackagePaths(input.packageRoot, { productFile: document.product.file }).productPath
  );
  if (
    hash(markerContent) !== intent.markerSha256 ||
    hash(productContent) !== intent.productSha256 ||
    !same(
      document.entity.lifecycle ?? { archived: false, archivedAt: null },
      intent.lifecycle ?? { archived: false, archivedAt: null }
    ) ||
    !same(
      await projection(
        document,
        productContent,
        managedSequenceProjectionVersionForExistingRecord(intent.desired.fields),
        markerContent
      ),
      intent.desired
    )
  )
    throw new Error(
      'The installed sequence pair does not match its retained registered publication.'
    );
  await assertRegisteredSequencePublicationAccess(context, input);
  const publicationDigest = orgRegistrySequencePackagePublicationDigest({
    packageId: document.id,
    formatVersion: document.formatVersion,
    markerSha256: intent.markerSha256,
    productSha256: intent.productSha256,
  });
  context.runDatabase(() =>
    context.db.transaction(() => {
      const resolution = verifiedSequenceResolution(context, intent);
      const current = resolution
        ? readOrgRegistryResolutionPublicationAdmissionInDb(context.db, resolution)
        : readOrgRegistryPublicationAdmissionInDb(context.db, {
            entityId: document.id,
            accountId: intent.accountId,
          });
      if (!current || !same(current.bindings, intent.admission.bindings))
        throw new Error('The sequence publication connection changed.');
      if (hasSettledRegisteredSequencePublicationInDb(context, intent)) return;
      if (!same(current.entity, intent.admission.entity))
        throw new Error(
          'The local sequence projection changed before its saved publication settled.'
        );
      let entity = updateLimsEntityInsideTx(context.db, {
        id: document.id,
        expectedEventSeq: intent.admission.entity.eventSeq!,
        name: intent.desired.name,
        fields: {
          ...intent.desired.fields,
          [MANAGED_SEQUENCE_DOCUMENT_FIELD]: current.entity.fields[MANAGED_SEQUENCE_DOCUMENT_FIELD],
        },
        replaceFields: true,
        workspaceId: current.entity.workspaceId,
        projectionSchema: {
          kind: intent.desired.kind,
          schemaRevisionId: intent.desired.schemaRevisionId,
          schemaSnapshot: intent.desired.schemaSnapshot,
        },
        registrationStatus: intent.desired.registrationStatus,
        domainStatus: intent.desired.domainStatus,
        actor: 'workspace-reconcile',
        batchId: intent.operationId,
      });
      const lifecycle = document.entity.lifecycle ?? { archived: false, archivedAt: null };
      if (entity.tombstone !== lifecycle.archived || entity.archivedAt !== lifecycle.archivedAt)
        entity = applyPublishedSequenceLifecycleInsideTx(
          context.db,
          {
            id: entity.id,
            expectedEventSeq: entity.eventSeq!,
            operationId: intent.operationId,
            actor: 'workspace-reconcile',
          },
          lifecycle
        );
      if (!same(projectedValue(entity), desiredValue(intent.desired)))
        throw new Error('The audited sequence projection differs from the installed package.');
      const now = Date.now();
      if (resolution) {
        captureOrgRegistryRecordResolutionPublicationInTx(context.db, {
          accountId: resolution.accountId,
          resolutionId: resolution.resolutionId,
          operationId: intent.operationId,
          entity,
          publicationDigest,
          verifiedAccessGeneration: resolution.verifiedAccessGeneration,
          now,
        });
        settleOrgRegistryRecordResolutionInTx(context.db, {
          accountId: resolution.accountId,
          resolutionId: resolution.resolutionId,
          operationId: intent.operationId,
          entity,
          publicationDigest,
          verifiedAccessGeneration: resolution.verifiedAccessGeneration,
          now,
        });
      } else {
        captureOrgRegistryRecordPublicationInTx(context.db, {
          accountId: intent.accountId,
          operationId: intent.operationId,
          entity,
          publicationDigest,
          now,
        });
        markOrgRegistryRecordPublicationReadyInTx(context.db, {
          operationId: intent.operationId,
          entityId: entity.id,
          publicationDigest,
          now,
        });
      }
    })()
  );
}

export async function assertUnversionedSequencePackageMutationAllowed(
  context: RegisteredSequencePackagePublicationContext,
  paths: readonly string[]
): Promise<void> {
  const enrolled = context.runDatabase(() =>
    context.db
      .prepare(
        `SELECT l.fields,w.path AS workspace_path FROM org_registry_local_records r JOIN lims_entity l ON l.id=r.entity_id JOIN workspaces w ON w.id=r.workspace_id WHERE r.authority_kind='sequence_package'`
      )
      .all()
  ) as Array<{ fields: string; workspace_path: string }>;
  if (!enrolled.length) return;
  const inside = (value: string) =>
    value === '' || (!isAbsolute(value) && value !== '..' && !value.startsWith(`..${sep}`));
  const refuse = () => {
    throw new Error(
      'This operation cannot yet preserve the organization connection of a registered sequence package. Use its versioned Save or Metadata action.'
    );
  };
  for (const row of enrolled) {
    const workspace = resolve(row.workspace_path);
    for (const path of paths) {
      const target = resolve(path);
      if (inside(relative(target, workspace))) refuse();
      if (!inside(relative(workspace, target))) continue;
      const locator = readManagedSequenceDocumentRef(
        (JSON.parse(row.fields) as Record<string, unknown>)[MANAGED_SEQUENCE_DOCUMENT_FIELD]
      );
      if (!locator) throw new Error('A registered sequence has no checked package location.');
      const [packageRoot, safe] = await Promise.all([
        canonicalWorkspacePath({
          workspaceRoot: row.workspace_path,
          path: locator.packageRoot,
          allowMissing: true,
          artifactNoun: 'registered sequence package',
        }),
        canonicalWorkspacePath({
          workspaceRoot: row.workspace_path,
          path,
          allowMissing: true,
          artifactNoun: 'registered sequence package',
        }),
      ]);
      if (
        inside(relative(packageRoot.candidate, safe.candidate)) ||
        inside(relative(safe.candidate, packageRoot.candidate))
      )
        refuse();
    }
  }
}

async function readContained(workspaceRoot: string, path: string): Promise<string> {
  return readFile(
    (
      await canonicalWorkspacePath({
        workspaceRoot,
        path,
        artifactNoun: 'registered sequence package',
      })
    ).candidate,
    'utf8'
  );
}

export type SequenceKeepSavedPublicationPlan = {
  schema: 'waypoint.sequence-keep-saved.v1' | 'waypoint.sequence-use-organization.v1';
  identity: RegisteredRecordResolutionIdentity;
  workspaceRoot: string;
  packageRoot: string;
  markerContent: string;
  productSnapshotPath: string;
  organizationSnapshot?: OrganizationSavedSequenceSnapshot;
  beforeMarkerContent?: string;
  beforeProductSnapshotPath?: string;
  intent: RegisteredSequencePublicationIntent;
};
type SequenceResolutionRow = {
  resolution_id: string;
  account_id: string;
  org_id: string;
  entity_id: string;
  publication_operation_id: string;
  choice: string;
  status: string;
  publication_request_json: string | null;
  review_json: string;
  publication_authority: string | null;
  publication_sha256: string | null;
  published_entity_json: string | null;
  published_local_event_seq: number | null;
};

function parseSequenceKeepSavedPlan(value: unknown): SequenceKeepSavedPublicationPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The retained sequence approval has no saved publication plan.');
  const plan = value as SequenceKeepSavedPublicationPlan;
  const identity = registeredRecordResolutionIdentity(plan.identity);
  const intent = parseRegisteredSequencePublicationIntent(plan.intent);
  if (
    (identity.choice === 'keep_saved'
      ? plan.schema !== 'waypoint.sequence-keep-saved.v1' || plan.organizationSnapshot !== undefined
      : plan.schema !== 'waypoint.sequence-use-organization.v1' ||
        !plan.organizationSnapshot ||
        typeof plan.beforeMarkerContent !== 'string' ||
        typeof plan.beforeProductSnapshotPath !== 'string') ||
    typeof plan.workspaceRoot !== 'string' ||
    typeof plan.packageRoot !== 'string' ||
    typeof plan.markerContent !== 'string' ||
    typeof plan.productSnapshotPath !== 'string' ||
    !same(identity, intent.organizationResolution) ||
    hash(plan.markerContent) !== intent.markerSha256
  )
    throw new Error('The retained sequence approval has a different identity or marker.');
  const marker = parseSequencePackageDocument(plan.markerContent);
  const revision = marker.versionHistory.revisions.find((entry) => entry.id === intent.revisionId);
  if (
    marker.id !== identity.entityId ||
    marker.formatVersion !== intent.formatVersion ||
    !same(
      marker.entity.lifecycle ?? { archived: false, archivedAt: null },
      intent.lifecycle ?? { archived: false, archivedAt: null }
    ) ||
    marker.versionHistory.headId !== intent.revisionId ||
    !revision ||
    revision.productSnapshot.path !== plan.productSnapshotPath ||
    revision.productSnapshot.sha256 !== `sha256:${intent.productSha256}`
  )
    throw new Error('The retained sequence approval has a different immutable product snapshot.');
  if (identity.choice === 'use_remote') {
    const before = parseSequencePackageDocument(plan.beforeMarkerContent!);
    const priorHead = before.versionHistory.revisions.find(
      (revision) => revision.id === before.versionHistory.headId
    );
    if (
      before.id !== identity.entityId ||
      before.product.file !== marker.product.file ||
      !priorHead ||
      priorHead.productSnapshot.path !== plan.beforeProductSnapshotPath ||
      plan.organizationSnapshot!.markerContent !== plan.markerContent ||
      plan.organizationSnapshot!.productSha256 !== intent.productSha256
    )
      throw new Error('The retained sequence source or preimage changed.');
    fromPackageRelative(plan.beforeProductSnapshotPath!, plan.packageRoot);
  }

  fromPackageRelative(plan.productSnapshotPath, plan.packageRoot);
  return plan;
}

function readSequenceResolutionRow(
  db: Database.Database,
  identity: RegisteredRecordResolutionIdentity
) {
  const row = db
    .prepare('SELECT * FROM org_registry_record_resolutions WHERE resolution_id=?')
    .get(identity.resolutionId) as SequenceResolutionRow | undefined;
  if (!row) return null;
  if (
    row.account_id !== identity.accountId ||
    row.org_id !== identity.orgId ||
    row.entity_id !== identity.entityId ||
    row.publication_operation_id !== identity.operationId ||
    row.choice !== identity.choice ||
    !row.publication_request_json
  )
    throw new Error('The sequence resolution ID belongs to another choice or publication.');
  const plan = parseSequenceKeepSavedPlan(JSON.parse(row.publication_request_json));
  if (!same(plan.identity, identity))
    throw new Error('The sequence resolution ID was reused for another saved source or choice.');
  return { row, plan };
}

function verifiedSequenceResolution(
  context: RegisteredSequencePackagePublicationContext,
  intent: RegisteredSequencePublicationIntent
): VerifiedRegisteredRecordResolution | undefined {
  if (!intent.organizationResolution) return undefined;
  const verified = context.organizationResolution;
  if (verified && same(registeredRecordResolutionIdentity(verified), intent.organizationResolution))
    return verified;
  if (
    !verified &&
    context.runDatabase(() => hasSettledRegisteredSequencePublicationInDb(context, intent))
  )
    return undefined;
  throw new Error(
    'Refresh current organization access and Retry the original reviewed sequence choice.'
  );
}

export async function prepareSequenceKeepSavedPublication(
  context: RegisteredSequencePackagePublicationContext,
  input: {
    workspaceRoot: string;
    packageRoot: string;
    checked: Awaited<ReturnType<typeof readCheckedManagedSequencePair>>;
    organizationSnapshot?: OrganizationSavedSequenceSnapshot;
    request: RegisteredRecordResolutionRequest;
    verifiedAccessGeneration: string;
  }
): Promise<SequenceKeepSavedPublicationPlan> {
  const identity = registeredRecordResolutionIdentity(input.request);
  if ((await context.getActiveAccountId()) !== identity.accountId)
    throw new Error('Sign in with the registered sequence account before resolving it.');
  const current = await admission(context, identity.entityId);
  const checked = await readCheckedManagedSequencePair(
    { ...context, lifecyclePublication: true },
    {
      ...input,
      entityId: identity.entityId,
    }
  );
  if (!current || !same(current.entity, input.checked.entity) || !same(checked, input.checked))
    throw Object.assign(new Error('The saved sequence changed. Review it again.'), {
      code: 'REVIEW_CHANGED',
    });
  const revisionId = checked.document.versionHistory.headId;
  const head = checked.document.versionHistory.revisions.find((entry) => entry.id === revisionId);
  if (!revisionId || !head || head.productSnapshot.sha256 !== `sha256:${checked.productSha256}`)
    throw new Error('The saved sequence requires its existing verified history before resolution.');
  const snapshot = await readContained(
    input.workspaceRoot,
    fromPackageRelative(head.productSnapshot.path, input.packageRoot)
  );
  if (hash(snapshot) !== checked.productSha256)
    throw new Error('The approved sequence product snapshot is missing or changed.');
  const organizationSnapshot =
    identity.choice === 'use_remote'
      ? await assertOrganizationSavedSequenceSnapshot(
          input.organizationSnapshot,
          input.request.review
        )
      : undefined;
  const chosenDocument = organizationSnapshot
    ? parseSequencePackageDocument(organizationSnapshot.markerContent)
    : checked.document;
  const chosenHead = chosenDocument.versionHistory.revisions.find(
    (entry) => entry.id === chosenDocument.versionHistory.headId
  );
  if (!chosenHead) throw new Error('The approved sequence has no verified history head.');
  if (
    organizationSnapshot &&
    (chosenDocument.product.file !== checked.document.product.file ||
      checked.document.members.some((member) => member.role === 'assembly-working-copy'))
  )
    throw new Error(
      'Resolve the current sequence product location or assembly draft before replacing its saved version.'
    );
  const chosenProjection = organizationSnapshot
    ? await projection(
        chosenDocument,
        organizationSnapshot.productContent,
        3,
        organizationSnapshot.markerContent
      )
    : checked.projection;
  if (
    chosenProjection.id !== checked.entity.id ||
    chosenProjection.kind !== checked.entity.kind ||
    chosenProjection.schemaRevisionId !== checked.entity.schemaRevisionId ||
    !matchesSavedSchema(
      context.runDatabase(() => registrySchemaSnapshotForEntity(context.db, checked.entity)),
      chosenProjection.schemaSnapshot
    )
  )
    throw new Error('The approved sequence cannot change its identity or pinned definition.');
  if (organizationSnapshot) {
    for (const member of organizationSnapshot.members) {
      try {
        const bytes = await readFile(
          (
            await canonicalWorkspacePath({
              workspaceRoot: input.workspaceRoot,
              path: fromPackageRelative(member.path, input.packageRoot),
              allowMissing: true,
              artifactNoun: 'saved sequence member',
            })
          ).candidate
        );
        if (createHash('sha256').update(bytes).digest('hex') !== member.contentSha256)
          throw new Error(
            'An existing sequence member differs from the approved immutable source. Preserve both versions before resolving it.'
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  const plan: SequenceKeepSavedPublicationPlan = {
    schema: organizationSnapshot
      ? 'waypoint.sequence-use-organization.v1'
      : 'waypoint.sequence-keep-saved.v1',
    identity,
    workspaceRoot: input.workspaceRoot,
    packageRoot: input.packageRoot,
    markerContent: organizationSnapshot?.markerContent ?? checked.markerContent,
    productSnapshotPath: chosenHead.productSnapshot.path,
    ...(organizationSnapshot
      ? {
          organizationSnapshot,
          beforeMarkerContent: checked.markerContent,
          beforeProductSnapshotPath: head.productSnapshot.path,
        }
      : {}),
    intent: {
      schema: INTENT_SCHEMA,
      accountId: identity.accountId,
      operationId: identity.operationId,
      revisionId: chosenHead.id,
      requestFingerprint: `sha256:${registeredRecordResolutionRequestHash(identity)}`,
      admission: current,
      markerSha256: organizationSnapshot?.markerSha256 ?? checked.markerSha256,
      productSha256: organizationSnapshot?.productSha256 ?? checked.productSha256,
      formatVersion: chosenDocument.formatVersion,
      desired: chosenProjection,
      ...(chosenDocument.entity.lifecycle ? { lifecycle: chosenDocument.entity.lifecycle } : {}),
      organizationResolution: identity,
    },
  };
  parseSequenceKeepSavedPlan(plan);
  if ((await context.getActiveAccountId()) !== identity.accountId)
    throw new Error('The active account changed while preparing the sequence resolution.');
  context.runDatabase(() =>
    context.db.transaction(() => {
      const review = assertRegisteredRecordResolutionAccessInDb(context.db, {
        ...identity,
        verifiedAccessGeneration: input.verifiedAccessGeneration,
      });
      const live = readOrgRegistryPublicationAdmissionInDb(context.db, {
        entityId: identity.entityId,
        accountId: identity.accountId,
      });
      if (!same(review, input.request.review) || !same(live, current))
        throw Object.assign(
          new Error('The saved sequence or organization review changed. Review it again.'),
          { code: 'REVIEW_CHANGED' }
        );
      prepareOrgRegistryRecordResolutionInTx(context.db, {
        ...identity,
        review: input.request.review,
        publicationOperationId: identity.operationId,
        now: Date.now(),
      });
      const stored = context.db
        .prepare(
          'SELECT publication_request_json FROM org_registry_record_resolutions WHERE resolution_id=?'
        )
        .get(identity.resolutionId) as { publication_request_json: string | null };
      if (
        stored.publication_request_json &&
        !same(JSON.parse(stored.publication_request_json), plan)
      )
        throw new Error(
          'The reviewed sequence operation already retains a different publication plan.'
        );
      context.db
        .prepare(
          'UPDATE org_registry_record_resolutions SET publication_request_json=? WHERE resolution_id=? AND publication_request_json IS NULL'
        )
        .run(JSON.stringify(plan), identity.resolutionId);
    })()
  );
  return plan;
}

export async function readRetainedSequenceKeepSavedPublication(
  context: RegisteredSequencePackagePublicationContext,
  verified: VerifiedRegisteredRecordResolution
) {
  const identity = registeredRecordResolutionIdentity(verified);
  if ((await context.getActiveAccountId()) !== identity.accountId)
    throw new Error('Sign in with the account that approved this saved sequence choice.');
  const retained = context.runDatabase(() => readSequenceResolutionRow(context.db, identity));
  if (!retained) return null;
  if (retained.plan.organizationSnapshot)
    await assertOrganizationSavedSequenceSnapshot(
      retained.plan.organizationSnapshot,
      JSON.parse(retained.row.review_json) as OrgRegistryRecordReview
    );
  await assertRegisteredSequencePublicationAccess(
    { ...context, organizationResolution: verified },
    {
      ...retained.plan,
      intent: retained.plan.intent,
    }
  );
  const settled = context.runDatabase(() =>
    hasSettledRegisteredSequencePublicationInDb(context, retained.plan.intent)
  );
  return {
    plan: retained.plan,
    result: settled
      ? parseLimsEntitySnapshot(JSON.parse(retained.row.published_entity_json!))
      : null,
  };
}

export function readPendingSequenceKeepSavedIdentity(
  db: Database.Database,
  input: {
    accountId: string;
    orgId: string;
    entityId: string;
    resolutionId: string;
    operationId: string;
    verifiedAccessGeneration: string;
  }
): RegisteredRecordResolutionIdentity | null {
  const review = readOrgRegistryRecordResolutionRetryReview(db, {
    ...input,
    expectedAccessGeneration: input.verifiedAccessGeneration,
  });
  if (!review || review.binding.authority !== 'sequence_package')
    throw new Error('The pending sequence approval is outside the current organization scope.');
  const row = db
    .prepare(
      'SELECT status,publication_request_json FROM org_registry_record_resolutions WHERE resolution_id=? AND account_id=? AND org_id=? AND entity_id=? AND publication_operation_id=?'
    )
    .get(input.resolutionId, input.accountId, input.orgId, input.entityId, input.operationId) as
    | { status: string; publication_request_json: string | null }
    | undefined;
  if (!row || row.status === 'settled' || !row.publication_request_json) return null;
  const identity = parseSequenceKeepSavedPlan(JSON.parse(row.publication_request_json)).identity;
  if (
    identity.resolutionId !== input.resolutionId ||
    identity.accountId !== input.accountId ||
    identity.orgId !== input.orgId ||
    identity.entityId !== input.entityId ||
    identity.operationId !== input.operationId
  )
    throw new Error('The pending saved sequence request identity changed.');
  return identity;
}

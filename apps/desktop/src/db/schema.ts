import {
  sqliteTable,
  text,
  integer,
  real,
  blob,
  primaryKey,
  foreignKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const entityProjectionSources = sqliteTable(
  'entity_projection_sources',
  {
    adapterKind: text('adapter_kind').notNull(),
    entityId: text('entity_id').notNull(),
    workspaceKey: text('workspace_key').notNull(),
    relativePath: text('relative_path').notNull(),
    projectionVersion: integer('projection_version').notNull(),
    synchronizedFingerprint: text('synchronized_fingerprint').notNull(),
    synchronizedAt: integer('synchronized_at', {
      mode: 'timestamp_ms',
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.adapterKind,
        table.entityId,
        table.workspaceKey,
        table.relativePath,
        table.projectionVersion,
      ],
    }),
  ]
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const remoteEndpointProfiles = sqliteTable('remote_endpoint_profiles', {
  endpointId: text('endpoint_id').primaryKey(),
  displayName: text('display_name').notNull(),
  sshTarget: text('ssh_target').notNull().unique(),
  lastConnectedAt: integer('last_connected_at', {
    mode: 'timestamp_ms',
  }).notNull(),
  lastValidatedAt: integer('last_validated_at', {
    mode: 'timestamp_ms',
  }).notNull(),
  observedPlatform: text('observed_platform'),
  lastFailureCode: text('last_failure_code'),
  lastFailureMessage: text('last_failure_message'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  lastOpenedAt: integer('last_opened_at', { mode: 'timestamp_ms' }),
  repoUuid: text('repo_uuid'),
  originPath: text('origin_path'),
  archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
  trashedAt: integer('trashed_at', { mode: 'timestamp_ms' }),
  accessMode: text('access_mode', { enum: ['writable', 'reference'] })
    .notNull()
    .default('writable'),
});

export const scientificWorkspaceIdentities = sqliteTable('scientific_workspace_identities', {
  workspaceId: integer('workspace_id')
    .primaryKey()
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  logicalWorkspaceId: text('logical_workspace_id').notNull(),
  remoteWorkspaceId: text('remote_workspace_id'),
});

export const scientificRevisionRecords = sqliteTable(
  'scientific_revision_records',
  {
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    recordId: text('record_id').notNull(),
    recordKind: text('record_kind').notNull(),
    canonicalJson: text('canonical_json').notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.recordId] })]
);

export const scientificRevisionRefs = sqliteTable(
  'scientific_revision_refs',
  {
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    refName: text('ref_name').notNull(),
    head: text('head'),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.refName] }),
    foreignKey({
      columns: [table.workspaceId, table.head],
      foreignColumns: [scientificRevisionRecords.workspaceId, scientificRevisionRecords.recordId],
    }),
  ]
);

export const scientificRevisionBlobs = sqliteTable(
  'scientific_revision_blobs',
  {
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    blobHash: text('blob_hash').notNull(),
    byteLength: integer('byte_length').notNull(),
    bytes: blob('bytes', { mode: 'buffer' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.blobHash] })]
);

export const scientificMaterializationJobs = sqliteTable(
  'scientific_materialization_jobs',
  {
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    versionId: text('version_id').notNull(),
    operationId: text('operation_id').notNull(),
    baseVersionId: text('base_version_id'),
    payloadVersion: integer('payload_version').notNull(),
    deliveryKind: text('delivery_kind', { enum: ['local-acceptance', 'history-adoption'] })
      .notNull()
      .default('local-acceptance'),
    manifestJson: text('manifest_json').notNull(),
    status: text('status', { enum: ['pending', 'blocked', 'succeeded'] }).notNull(),
    progressJson: text('progress_json').notNull().default('[]'),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.versionId] }),
    uniqueIndex('scientific_materialization_operation').on(table.workspaceId, table.operationId),
    foreignKey({
      columns: [table.workspaceId, table.versionId],
      foreignColumns: [scientificRevisionRecords.workspaceId, scientificRevisionRecords.recordId],
    }),
    foreignKey({
      columns: [table.workspaceId, table.baseVersionId],
      foreignColumns: [scientificRevisionRecords.workspaceId, scientificRevisionRecords.recordId],
    }),
    index('idx_scientific_materialization_pending')
      .on(table.workspaceId, table.createdAt)
      .where(sql`${table.status} != 'succeeded'`),
  ]
);

export const workspaceSyncDevice = sqliteTable('workspace_sync_device', {
  id: integer('id').primaryKey(),
  deviceId: text('device_id').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const workspaceSyncBindings = sqliteTable('workspace_sync_bindings', {
  workspaceId: integer('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  workspaceUuid: text('workspace_uuid').notNull().unique(),
  ownerAccountId: text('owner_account_id').notNull(),
  ownerOrgId: text('owner_org_id'),
  remoteWorkspaceId: text('remote_workspace_id'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
  remoteLatestVersionId: text('remote_latest_version_id'),
  remoteLatestVersionNumber: integer('remote_latest_version_number'),
  remoteLatestContentSha256: text('remote_latest_content_sha256'),
  lastAckedLocalHeadSha: text('last_acked_local_head_sha'),
  lastUploadedAt: integer('last_uploaded_at', { mode: 'timestamp' }),
  lastDownloadedAt: integer('last_downloaded_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  remoteOwnerAccountId: text('remote_owner_account_id'),
  accessRole: text('access_role'),
  accessSource: text('access_source'),
  sharedWithOthers: integer('shared_with_others', { mode: 'boolean' }).notNull().default(false),
  detachedReason: text('detached_reason'),
});

export const workspaceSyncQueue = sqliteTable('workspace_sync_queue', {
  id: text('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  operation: text('operation').notNull(),
  status: text('status').notNull(),
  idempotencyKey: text('idempotency_key').unique(),
  baseRemoteVersionId: text('base_remote_version_id'),
  localHeadSha: text('local_head_sha'),
  bundleContentSha256: text('bundle_content_sha256'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp' }),
  lockedAt: integer('locked_at', { mode: 'timestamp' }),
  lockedByDeviceId: text('locked_by_device_id').references(() => workspaceSyncDevice.deviceId, {
    onDelete: 'set null',
  }),
  errorCode: text('error_code'),
  errorMessage: text('error_message'),
  acceptedOperationId: text('accepted_operation_id'),
  acceptedOperationStartedAt: integer('accepted_operation_started_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const workspaceSyncRendererDeliveries = sqliteTable('workspace_sync_renderer_deliveries', {
  id: text('id').primaryKey().notNull(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  workspaceUuid: text('workspace_uuid'),
  workspaceRoot: text('workspace_root'),
  ownerAccountId: text('owner_account_id'),
  remoteWorkspaceId: text('remote_workspace_id'),
  remoteVersionId: text('remote_version_id'),
  localHeadSha: text('local_head_sha'),
  payloadVersion: integer('payload_version').notNull(),
  payloadJson: text('payload_json'),
  state: text('state', {
    enum: ['pending', 'needs_attention', 'succeeded'],
  }).notNull(),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  settledAt: integer('settled_at', { mode: 'timestamp_ms' }),
});

export const workspaceSyncUploadSnapshots = sqliteTable('workspace_sync_upload_snapshots', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => workspaceSyncQueue.id, { onDelete: 'cascade' }),
  contentSha256: text('content_sha256').notNull(),
  bundleJson: text('bundle_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const workspaceSyncVersions = sqliteTable('workspace_sync_versions', {
  id: text('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  remoteVersionId: text('remote_version_id').notNull().unique(),
  versionNumber: integer('version_number').notNull(),
  contentSha256: text('content_sha256').notNull(),
  localHeadSha: text('local_head_sha'),
  fileCount: integer('file_count').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  excludedSummaryJson: text('excluded_summary_json'),
  createdByAccountId: text('created_by_account_id'),
  createdByDisplay: text('created_by_display'),
  status: text('status').notNull(),
  isLatest: integer('is_latest', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
});

export const workspaceSyncMergeConflicts = sqliteTable('workspace_sync_merge_conflicts', {
  id: text('id').primaryKey(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  workspaceUuid: text('workspace_uuid').notNull(),
  baseRemoteVersionId: text('base_remote_version_id'),
  remoteVersionId: text('remote_version_id').notNull(),
  remoteVersionNumber: integer('remote_version_number'),
  remoteAuthor: text('remote_author'),
  localHeadSha: text('local_head_sha'),
  status: text('status').notNull(),
  conflictsJson: text('conflicts_json').notNull(),
  payloadJson: text('payload_json').notNull(),
  resolutionJson: text('resolution_json'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
});

export const workspaceSyncRestoreLocks = sqliteTable('workspace_sync_restore_locks', {
  workspaceId: integer('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  lockId: text('lock_id').notNull().unique(),
  sourceRemoteVersionId: text('source_remote_version_id'),
  remoteWorkspaceId: text('remote_workspace_id'),
  ownerAccountId: text('owner_account_id'),
  ownerOrgId: text('owner_org_id'),
  status: text('status').notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  errorMessage: text('error_message'),
});

export const orgRegistrySyncState = sqliteTable('org_registry_sync_state', {
  accessGeneration: text('access_generation'),
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  clientId: text('client_id').notNull(),
  cursor: integer('cursor').notNull().default(0),
  status: text('status').notNull().default('idle'),
  lastPullAt: integer('last_pull_at', { mode: 'timestamp_ms' }),
  lastPushAt: integer('last_push_at', { mode: 'timestamp_ms' }),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const orgRegistryCache = sqliteTable('org_registry_cache', {
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  recordType: text('record_type').notNull(),
  recordId: text('record_id').notNull(),
  payloadJson: text('payload_json').notNull(),
  eventSeq: integer('event_seq').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const orgRegistrySnapshotTransfer = sqliteTable('org_registry_snapshot_transfer', {
  accessGeneration: text('access_generation'),
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  clientId: text('client_id').notNull(),
  snapshotId: text('snapshot_id'),
  cursor: integer('cursor'),
  totalRecords: integer('total_records'),
  nextAfter: integer('next_after').notNull().default(0),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
  downloadComplete: integer('download_complete').notNull().default(0),
  bootstrapComplete: integer('bootstrap_complete').notNull().default(0),
});

export const orgRegistrySnapshotRecord = sqliteTable('org_registry_snapshot_record', {
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  ordinal: integer('ordinal').notNull(),
  recordType: text('record_type').notNull(),
  recordId: text('record_id').notNull(),
  payloadJson: text('payload_json').notNull(),
});

export const orgRegistryOutbox = sqliteTable('org_registry_outbox', {
  mutationId: text('mutation_id').primaryKey(),
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  clientId: text('client_id').notNull(),
  operation: text('operation').notNull(),
  payloadJson: text('payload_json').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  status: text('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at', { mode: 'timestamp_ms' }),
  lastErrorCode: text('last_error_code'),
  lastErrorMessage: text('last_error_message'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const orgRegistryMutationReceipts = sqliteTable('org_registry_mutation_receipts', {
  mutationId: text('mutation_id').primaryKey(),
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  clientId: text('client_id').notNull(),
  operation: text('operation').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  eventSeq: integer('event_seq').notNull(),
  status: text('status').notNull(),
  responseJson: text('response_json').notNull(),
  acknowledgedAt: integer('acknowledged_at', {
    mode: 'timestamp_ms',
  }).notNull(),
});

export const orgRegistryLocalRecords = sqliteTable('org_registry_local_records', {
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  entityId: text('entity_id').notNull(),
  clientId: text('client_id').notNull(),
  workspaceId: integer('workspace_id').notNull(),
  workspaceUuid: text('workspace_uuid').notNull(),
  homeWorkspaceId: text('home_workspace_id').notNull(),
  kind: text('kind').notNull(),
  localSchemaRevisionId: text('local_schema_revision_id').notNull(),
  authorityKind: text('authority_kind').notNull(),
  schemaId: text('schema_id').notNull(),
  schemaRevisionId: text('schema_revision_id').notNull(),
  claimMutationId: text('claim_mutation_id').notNull().unique(),
  claimSourceRevision: text('claim_source_revision').notNull(),
  claimLocalEventSeq: integer('claim_local_event_seq').notNull(),
  acknowledgedMutationId: text('acknowledged_mutation_id'),
  acknowledgedLocalEventSeq: integer('acknowledged_local_event_seq'),
  reviewedResolutionId: text('reviewed_resolution_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const orgRegistryRecordPublications = sqliteTable('org_registry_record_publications', {
  mutationId: text('mutation_id').primaryKey(),
  lifecycleMutationId: text('lifecycle_mutation_id').notNull().unique(),
  phase: text('phase').notNull(),
  operationId: text('operation_id').notNull(),
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  entityId: text('entity_id').notNull(),
  localEventSeq: integer('local_event_seq').notNull(),
  publicationAuthority: text('publication_authority').notNull(),
  publicationSha256: text('publication_sha256').notNull(),
  payloadJson: text('payload_json').notNull(),
  status: text('status').notNull(),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const orgRegistryRecordResolutions = sqliteTable('org_registry_record_resolutions', {
  resolutionId: text('resolution_id').primaryKey(),
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  entityId: text('entity_id').notNull(),
  choice: text('choice').notNull(),
  publicationOperationId: text('publication_operation_id').notNull().unique(),
  reviewJson: text('review_json').notNull(),
  desiredJson: text('desired_json').notNull(),

  publicationRequestJson: text('publication_request_json'),
  status: text('status').notNull(),
  publicationAuthority: text('publication_authority'),
  publicationSha256: text('publication_sha256'),
  publishedEntityJson: text('published_entity_json'),
  publishedLocalEventSeq: integer('published_local_event_seq'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  settledAt: integer('settled_at', { mode: 'timestamp_ms' }),
});

export const orgRegistryRecordPublicationSupersessions = sqliteTable(
  'org_registry_record_publication_supersessions',
  {
    mutationId: text('mutation_id').primaryKey(),
    resolutionId: text('resolution_id').notNull(),
    supersededAt: integer('superseded_at', { mode: 'timestamp_ms' }).notNull(),
  }
);

export const orgRegistryConflicts = sqliteTable('org_registry_conflicts', {
  id: text('id').primaryKey(),
  mutationId: text('mutation_id').notNull().unique(),
  orgId: text('org_id').notNull(),
  accountId: text('account_id').notNull(),
  operation: text('operation').notNull(),
  localPayloadJson: text('local_payload_json').notNull(),
  errorCode: text('error_code').notNull(),
  errorMessage: text('error_message').notNull(),
  detailsJson: text('details_json'),
  status: text('status').notNull().default('open'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
});

export const indexedFiles = sqliteTable('indexed_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  name: text('name').notNull(),
  extension: text('extension').notNull(),
  sizeBytes: integer('size_bytes'),
  modifiedAt: integer('modified_at', { mode: 'timestamp' }),
  indexedAt: integer('indexed_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  metadata: text('metadata', { mode: 'json' }),
});

export const sequences = sqliteTable('sequences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  documentId: text('document_id').unique(),
  fileId: integer('file_id')
    .notNull()
    .references(() => indexedFiles.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  length: integer('length').notNull(),
  sequenceType: text('sequence_type'),
  circular: integer('circular', { mode: 'boolean' }).default(false),
  sequence: text('sequence'),
});

export const pages = sqliteTable('pages', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content', { mode: 'json' }).notNull(),
  date: integer('date', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const catalogEntities = sqliteTable('catalog_entities', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  locator: text('locator').notNull().unique(),
  storageType: text('storage_type').notNull(),
  status: text('status').notNull().default('active'),
  workspaceId: integer('workspace_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const catalogEntityFiles = sqliteTable('catalog_entity_files', {
  id: text('id').primaryKey(),
  entityId: text('entity_id')
    .notNull()
    .references(() => catalogEntities.id, { onDelete: 'cascade' }),
  workspaceId: integer('workspace_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  path: text('path').notNull().unique(),
  relativePath: text('relative_path'),
  fileKind: text('file_kind').notNull(),
  contentHash: text('content_hash'),
  sequenceFingerprint: text('sequence_fingerprint'),
  objectUuid: text('object_uuid'),
  sizeBytes: integer('size_bytes'),
  modifiedAt: integer('modified_at', { mode: 'timestamp' }),
  status: text('status').notNull().default('current'),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }),
  missingSince: integer('missing_since', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const catalogEntityLinks = sqliteTable('catalog_entity_links', {
  id: text('id').primaryKey(),
  sourceEntityId: text('source_entity_id')
    .notNull()
    .references(() => catalogEntities.id, { onDelete: 'cascade' }),
  relation: text('relation').notNull(),
  targetEntityId: text('target_entity_id')
    .notNull()
    .references(() => catalogEntities.id, { onDelete: 'cascade' }),
  confidence: text('confidence').notNull().default('suggested'),
  evidence: text('evidence', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const catalogEntityEvents = sqliteTable('catalog_entity_events', {
  id: text('id').primaryKey(),
  entityId: text('entity_id')
    .notNull()
    .references(() => catalogEntities.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  actor: text('actor').notNull().default('user'),
  summary: text('summary'),
  payload: text('payload', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const catalogProviderBindings = sqliteTable('catalog_provider_bindings', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  stableObjectId: text('stable_object_id').notNull(),
  objectClass: text('object_class').notNull(),
  entityId: text('entity_id')
    .notNull()
    .references(() => catalogEntities.id, { onDelete: 'cascade' }),
  bindingKind: text('binding_kind').notNull(),
  providerAccountHint: text('provider_account_hint'),
  canonicalUrl: text('canonical_url'),
  evidenceJson: text('evidence_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const nativeCatalogPublicationOutbox = sqliteTable('native_catalog_publication_outbox', {
  operationId: text('operation_id').primaryKey().notNull(),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
});

export const meaningfulActivityPending = sqliteTable('meaningful_activity_pending', {
  actionId: text('action_id').primaryKey().notNull(),
  workflow: text('workflow').notNull(),
  workflowAction: text('workflow_action').notNull(),
  workflowStatus: text('workflow_status').notNull(),
  initiatedAtMs: integer('initiated_at_ms').notNull(),
  qualifiedAtMs: integer('qualified_at_ms').notNull(),
  valueDelivered: integer('value_delivered', { mode: 'boolean' }),
  usableResult: integer('usable_result', { mode: 'boolean' }),
  selectedCount: integer('selected_count'),
  appSessionId: text('app_session_id').notNull(),
  uploadState: text('upload_state').notNull(),
  boundAccountId: text('bound_account_id'),
  identityResolution: text('identity_resolution'),
  historical: integer('historical', { mode: 'boolean' }).notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  expiresAtMs: integer('expires_at_ms').notNull(),
  sentAtMs: integer('sent_at_ms'),
});

export const analyticsEventOutbox = sqliteTable('analytics_event_outbox', {
  eventId: text('event_id').primaryKey().notNull(),
  eventName: text('event_name').notNull(),
  payloadSchemaVersion: integer('payload_schema_version').notNull(),
  referenceKind: text('reference_kind').notNull(),
  referenceId: text('reference_id').notNull(),
  propertiesJson: text('properties_json').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  sendAttempts: integer('send_attempts').notNull(),
  lastAttemptAtMs: integer('last_attempt_at_ms'),
  sentAtMs: integer('sent_at_ms'),
  originJson: text('origin_json'),
});

export const catalogWorkspacePlacements = sqliteTable('catalog_workspace_placements', {
  entityId: text('entity_id')
    .primaryKey()
    .references(() => catalogEntities.id, { onDelete: 'cascade' }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  parentRelativePath: text('parent_relative_path').notNull(),
  displayName: text('display_name').notNull(),
  normalizedSiblingName: text('normalized_sibling_name').notNull(),
  presentationKind: text('presentation_kind').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const limsSchemas = sqliteTable('lims_schema', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  name: text('name').notNull(),
  displayName: text('display_name').notNull(),
  description: text('description'),
  fields: text('fields', { mode: 'json' }).notNull(),
  currentRevisionId: text('current_revision_id'),
  version: integer('version').notNull().default(1),
  builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
  workspaceId: integer('workspace_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  actor: text('actor'),
  eventSeq: integer('event_seq'),
  tombstone: integer('tombstone', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
});

export const limsSchemaRevisions = sqliteTable('lims_schema_revision', {
  id: text('id').primaryKey(),
  schemaId: text('schema_id')
    .notNull()
    .references(() => limsSchemas.id, { onDelete: 'restrict' }),
  version: integer('version').notNull(),
  fields: text('fields', { mode: 'json' }).notNull(),
  actor: text('actor'),
  workspaceId: integer('workspace_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  eventSeq: integer('event_seq'),
  tombstone: integer('tombstone', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
});

export const limsEntities = sqliteTable('lims_entity', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  schemaId: text('schema_id').references(() => limsSchemas.id, {
    onDelete: 'restrict',
  }),
  schemaRevisionId: text('schema_revision_id')
    .notNull()
    .references(() => limsSchemaRevisions.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  fields: text('fields', { mode: 'json' }).notNull(),
  registrationStatus: text('registration_status').notNull(),
  domainStatus: text('domain_status'),
  registryId: text('registry_id'),
  workspaceId: integer('workspace_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  actor: text('actor'),
  eventSeq: integer('event_seq'),
  tombstone: integer('tombstone', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
});

export const limsLinks = sqliteTable('lims_link', {
  id: text('id').primaryKey(),
  fromEntityId: text('from_entity_id')
    .notNull()
    .references(() => limsEntities.id, { onDelete: 'restrict' }),
  toEntityId: text('to_entity_id')
    .notNull()
    .references(() => limsEntities.id, { onDelete: 'restrict' }),
  type: text('type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  workspaceId: integer('workspace_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  actor: text('actor'),
  eventSeq: integer('event_seq'),
  tombstone: integer('tombstone', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
});

export const limsAudit = sqliteTable('lims_audit', {
  id: text('id').primaryKey(),
  eventSeq: integer('event_seq').notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  idempotencyKey: text('idempotency_key').notNull(),
  operationId: text('operation_id'),
  eventType: text('event_type').notNull(),
  subjectTable: text('subject_table'),
  subjectId: text('subject_id'),
  batchId: text('batch_id'),
  actor: text('actor'),
  actorClientId: text('actor_client_id'),
  actorUserId: text('actor_user_id'),
  workspaceId: integer('workspace_id').references(() => workspaces.id, {
    onDelete: 'set null',
  }),
  before: text('before', { mode: 'json' }),
  after: text('after', { mode: 'json' }),
  payload: text('payload', { mode: 'json' }),
  prevHash: text('prev_hash'),
  hash: text('hash'),
  tombstone: integer('tombstone', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const limsEventSequence = sqliteTable('lims_event_sequence', {
  id: integer('id').primaryKey(),
  nextEventSeq: integer('next_event_seq').notNull(),
});

export const computeJobs = sqliteTable('compute_jobs', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  toolId: text('tool_id').notNull(),
  label: text('label'),
  settingsHash: text('settings_hash').notNull(),
  settingsJson: text('settings_json').notNull(),
  resultTargetJson: text('result_target_json'),
  requestJson: text('request_json'),
  requestHash: text('request_hash'),
  inputFilesJson: text('input_files_json'),
  idempotencyKey: text('idempotency_key'),
  providerJobRef: text('provider_job_ref'),
  state: text('state').notNull(),
  providerState: text('provider_state').notNull().default(''),
  costEstimate: real('cost_estimate'),
  costEstimateUnit: text('cost_estimate_unit'),
  costActual: real('cost_actual'),
  costActualUnit: text('cost_actual_unit'),
  termsSnapshotJson: text('terms_snapshot_json'),
  workspaceRoot: text('workspace_root'),
  sourcePath: text('source_path'),
  sourceName: text('source_name'),
  importedPathsJson: text('imported_paths_json'),
  importDetailsJson: text('import_details_json'),
  lastError: text('last_error'),
  pollCount: integer('poll_count').notNull().default(0),
  nextPollAt: integer('next_poll_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const chatTurns = sqliteTable('chat_turns', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  routeKind: text('route_kind').notNull(),
  hostId: text('host_id').notNull(),
  provider: text('provider'),
  model: text('model'),
  transport: text('transport'),
  authorityProfileId: text('authority_profile_id'),
  permissionMode: text('permission_mode'),
  routeSnapshotJson: text('route_snapshot_json', { mode: 'json' }).notNull(),
  status: text('status').notNull(),
  terminalReason: text('terminal_reason'),
  error: text('error'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

export const agentSessions = sqliteTable('agent_sessions', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id'),
  turnId: text('turn_id'),
  provider: text('provider').notNull(),
  authorityProfileId: text('authority_profile_id').notNull(),
  authorityClass: text('authority_class').notNull(),
  releaseMode: text('release_mode').notNull(),
  permissionModeLabel: text('permission_mode_label'),
  status: text('status').notNull(),
  cwd: text('cwd').notNull(),
  outputRoot: text('output_root'),
  providerConversationId: text('provider_conversation_id'),
  providerVersionsJson: text('provider_versions_json', {
    mode: 'json',
  }).notNull(),
  authorityJson: text('authority_json', { mode: 'json' }).notNull(),
  terminalReason: text('terminal_reason'),
  telemetryHadWorkspaceContext: integer('telemetry_had_workspace_context', {
    mode: 'boolean',
  })
    .notNull()
    .default(false),
  telemetryContinuation: integer('telemetry_continuation', { mode: 'boolean' })
    .notNull()
    .default(false),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
});

export const agentProviderSessionBindings = sqliteTable('agent_provider_session_bindings', {
  conversationId: text('conversation_id').primaryKey(),
  provider: text('provider').notNull(),
  providerSessionId: text('provider_session_id').notNull(),
  accountFingerprint: text('account_fingerprint').notNull(),
  sourceSnapshotId: text('source_snapshot_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const conversationLineage = sqliteTable('conversation_lineage', {
  conversationId: text('conversation_id').primaryKey(),
  parentConversationId: text('parent_conversation_id').notNull(),
  relation: text('relation').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const agentCapabilityInvocations = sqliteTable('agent_capability_invocations', {
  turnId: text('turn_id').primaryKey(),
  conversationId: text('conversation_id'),
  snapshotId: text('snapshot_id').notNull(),
  capabilityId: text('capability_id').notNull(),
  provider: text('provider').notNull(),
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  source: text('source'),
  appliedAt: integer('applied_at', { mode: 'timestamp' }).notNull(),
});

export const messageAttachments = sqliteTable('message_attachments', {
  messageId: text('message_id').notNull(),
  attachmentId: text('attachment_id').notNull(),
  position: integer('position').notNull().default(0),
  name: text('name').notNull(),
  mediaType: text('media_type').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256').notNull(),
  kind: text('kind').notNull(),
});

export const agentStructuredOutputs = sqliteTable('agent_structured_outputs', {
  turnId: text('turn_id').primaryKey(),
  schemaJson: text('schema_json', { mode: 'json' }).notNull(),
  rawResult: text('raw_result').notNull(),
  validationStatus: text('validation_status').notNull(),
  parsedJson: text('parsed_json', { mode: 'json' }),
  validationError: text('validation_error'),
  artifactId: text('artifact_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const agentTraceEvents = sqliteTable('agent_trace_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  provider: text('provider').notNull(),
  eventType: text('event_type').notNull(),
  renderSnapshotJson: text('render_snapshot_json', { mode: 'json' }).notNull(),
  terminal: text('terminal'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const agentOutputArtifacts = sqliteTable('agent_output_artifacts', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => agentSessions.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  relativePath: text('relative_path'),
  kind: text('kind').notNull(),
  action: text('action').notNull(),
  attribution: text('attribution').notNull(),
  checksum: text('checksum'),
  provenanceId: text('provenance_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const entityReferences = sqliteTable('entity_references', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  displayLabel: text('display_label').notNull(),
  locator: text('locator').notNull(),
  deepLinkParams: text('deep_link_params', { mode: 'json' }),
  data: text('data', { mode: 'json' }),
  source: text('source').notNull(),
  status: text('status').notNull().default('created'),
  workspaceScope: text('workspace_scope'),
  workspaceRootPath: text('workspace_root_path'),
  createdAt: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
  updatedAt: integer('updated_at')
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type EntityReferenceRow = typeof entityReferences.$inferSelect;
export type NewEntityReferenceRow = typeof entityReferences.$inferInsert;

export const entityReferenceRevisions = sqliteTable('entity_reference_revisions', {
  id: text('id').primaryKey(),
  referenceId: text('reference_id').notNull(),
  revisionNumber: integer('revision_number').notNull(),
  changedBy: text('changed_by').notNull(),
  changeType: text('change_type').notNull(),
  previousState: text('previous_state', { mode: 'json' }),
  newState: text('new_state', { mode: 'json' }),
  createdAt: integer('created_at')
    .notNull()
    .$defaultFn(() => Date.now()),
});

export type RevisionRow = typeof entityReferenceRevisions.$inferSelect;

export const messageReferences = sqliteTable('message_references', {
  messageId: text('message_id').notNull(),
  referenceId: text('reference_id').notNull(),
  position: integer('position').notNull().default(0),
});

export const graphNodes = sqliteTable('graph_nodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  fileId: integer('file_id').references(() => indexedFiles.id, {
    onDelete: 'set null',
  }),
  name: text('name').notNull(),
  filePath: text('file_path').notNull(),
  length: integer('length').notNull(),
  circular: integer('circular', { mode: 'boolean' }).default(false),
  nodeType: text('node_type').notNull().default('sequence'),
  sourceResolution: text('source_resolution'),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const graphEdges = sqliteTable('graph_edges', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: integer('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceNodeId: integer('source_node_id')
    .notNull()
    .references(() => graphNodes.id, { onDelete: 'cascade' }),
  targetNodeId: integer('target_node_id')
    .notNull()
    .references(() => graphNodes.id, { onDelete: 'cascade' }),
  method: text('method').notNull(),
  confidence: integer('confidence').notNull(),
  isManual: integer('is_manual', { mode: 'boolean' }).default(false),
  isVerified: integer('is_verified', { mode: 'boolean' }).default(false),
  metadata: text('metadata', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type WorkspaceSyncDevice = typeof workspaceSyncDevice.$inferSelect;
export type NewWorkspaceSyncDevice = typeof workspaceSyncDevice.$inferInsert;
export type WorkspaceSyncBinding = typeof workspaceSyncBindings.$inferSelect;
export type NewWorkspaceSyncBinding = typeof workspaceSyncBindings.$inferInsert;
export type WorkspaceSyncQueueRow = typeof workspaceSyncQueue.$inferSelect;
export type NewWorkspaceSyncQueueRow = typeof workspaceSyncQueue.$inferInsert;
export type WorkspaceSyncVersion = typeof workspaceSyncVersions.$inferSelect;
export type NewWorkspaceSyncVersion = typeof workspaceSyncVersions.$inferInsert;
export type WorkspaceSyncRestoreLock = typeof workspaceSyncRestoreLocks.$inferSelect;
export type NewWorkspaceSyncRestoreLock = typeof workspaceSyncRestoreLocks.$inferInsert;
export type IndexedFile = typeof indexedFiles.$inferSelect;
export type NewIndexedFile = typeof indexedFiles.$inferInsert;
export type Sequence = typeof sequences.$inferSelect;
export type NewSequence = typeof sequences.$inferInsert;
export type CatalogEntity = typeof catalogEntities.$inferSelect;
export type NewCatalogEntity = typeof catalogEntities.$inferInsert;
export type CatalogEntityFile = typeof catalogEntityFiles.$inferSelect;
export type NewCatalogEntityFile = typeof catalogEntityFiles.$inferInsert;
export type CatalogEntityLink = typeof catalogEntityLinks.$inferSelect;
export type NewCatalogEntityLink = typeof catalogEntityLinks.$inferInsert;
export type CatalogEntityEvent = typeof catalogEntityEvents.$inferSelect;
export type NewCatalogEntityEvent = typeof catalogEntityEvents.$inferInsert;
export type CatalogProviderBinding = typeof catalogProviderBindings.$inferSelect;
export type NewCatalogProviderBinding = typeof catalogProviderBindings.$inferInsert;
export type CatalogWorkspacePlacement = typeof catalogWorkspacePlacements.$inferSelect;
export type NewCatalogWorkspacePlacement = typeof catalogWorkspacePlacements.$inferInsert;
export type LimsSchema = typeof limsSchemas.$inferSelect;
export type NewLimsSchema = typeof limsSchemas.$inferInsert;
export type LimsSchemaRevision = typeof limsSchemaRevisions.$inferSelect;
export type NewLimsSchemaRevision = typeof limsSchemaRevisions.$inferInsert;
export type LimsEntityRow = typeof limsEntities.$inferSelect;
export type NewLimsEntityRow = typeof limsEntities.$inferInsert;
export type LimsLinkRow = typeof limsLinks.$inferSelect;
export type NewLimsLinkRow = typeof limsLinks.$inferInsert;
export type LimsAuditRow = typeof limsAudit.$inferSelect;
export type NewLimsAuditRow = typeof limsAudit.$inferInsert;
export type LimsEventSequenceRow = typeof limsEventSequence.$inferSelect;
export type NewLimsEventSequenceRow = typeof limsEventSequence.$inferInsert;
export type AgentSession = typeof agentSessions.$inferSelect;
export type NewAgentSession = typeof agentSessions.$inferInsert;
export type AgentTraceEvent = typeof agentTraceEvents.$inferSelect;
export type NewAgentTraceEvent = typeof agentTraceEvents.$inferInsert;
export type AgentOutputArtifact = typeof agentOutputArtifacts.$inferSelect;
export type NewAgentOutputArtifact = typeof agentOutputArtifacts.$inferInsert;
export type PageRow = typeof pages.$inferSelect;
export type NewPageRow = typeof pages.$inferInsert;
export type GraphNodeRow = typeof graphNodes.$inferSelect;
export type NewGraphNodeRow = typeof graphNodes.$inferInsert;
export type GraphEdgeRow = typeof graphEdges.$inferSelect;
export type NewGraphEdgeRow = typeof graphEdges.$inferInsert;

export const molecularCatalogMolecules = sqliteTable('molecular_catalog_molecules', {
  id: text('id').primaryKey(),
  identityVersion: integer('identity_version').notNull(),
  kind: text('kind').notNull(),
  sequence: text('sequence').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const molecularCatalogCoordinates = sqliteTable('molecular_catalog_coordinates', {
  id: text('id').primaryKey(),
  format: text('format').notNull(),
  sha256: text('sha256').notNull(),
  byteCount: integer('byte_count').notNull(),
  bytes: blob('bytes', { mode: 'buffer' }).notNull(),
  inventoryCountsJson: text('inventory_counts_json').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const molecularCatalogObservations = sqliteTable('molecular_catalog_observations', {
  id: text('id').primaryKey(),
  coordinateId: text('coordinate_id')
    .notNull()
    .references(() => molecularCatalogCoordinates.id),
  sourceKey: text('source_key').notNull().unique(),
  sourceKind: text('source_kind').notNull(),
  label: text('label').notNull(),
  originJson: text('origin_json').notNull(),
  runJson: text('run_json'),
  metricsJson: text('metrics_json').notNull(),
  provenanceJson: text('provenance_json').notNull(),
  createdAt: integer('created_at').notNull(),
});
export const molecularCatalogPredictionRequests = sqliteTable(
  'molecular_catalog_prediction_requests',
  {
    observationId: text('observation_id')
      .primaryKey()
      .references(() => molecularCatalogObservations.id),
    clientSha256: text('client_sha256').notNull(),
    providerSha256: text('provider_sha256').notNull(),
    model: text('model').notNull(),
    modelVersion: text('model_version').notNull(),
    receiptJson: text('receipt_json').notNull(),
    createdAt: integer('created_at').notNull(),
  }
);
export const molecularCatalogChains = sqliteTable('molecular_catalog_chains', {
  id: text('id').primaryKey(),
  coordinateId: text('coordinate_id')
    .notNull()
    .references(() => molecularCatalogCoordinates.id),
  normalizerVersion: integer('normalizer_version').notNull(),
  chainKey: text('chain_key').notNull(),
  inventoryJson: text('inventory_json').notNull(),
});
export const molecularCatalogMappings = sqliteTable(
  'molecular_catalog_mappings',
  {
    observationId: text('observation_id')
      .notNull()
      .references(() => molecularCatalogObservations.id),
    moleculeId: text('molecule_id')
      .notNull()
      .references(() => molecularCatalogMolecules.id),
    chainId: text('chain_id')
      .notNull()
      .references(() => molecularCatalogChains.id),
    algorithmVersion: integer('algorithm_version').notNull(),
    relationship: text('relationship').notNull(),
    status: text('status').notNull(),
    mappingJson: text('mapping_json').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.observationId, table.moleculeId, table.chainId, table.algorithmVersion],
    }),
  ]
);

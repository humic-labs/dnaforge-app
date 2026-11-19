import type Database from 'better-sqlite3';
import {
  assertRetiredBenchlingUndoSettled,
  hasRetiredBenchlingUndoStorage,
  retireBenchlingUndoStorage,
} from './schema-retire-benchling-undo';
import { app } from 'electron';
import { copyFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { trackEvent } from './analytics';
import {
  SchemaMigrationFailedWithoutBackupError,
  SchemaMigrationNotAuthorizedError,
  SchemaMigrationRecoveredError,
  SchemaMigrationRecoveryFailedError,
  SchemaUpgradeBackupRequiredError,
  SchemaVersionTooNewError,
} from './native-module-error';
import { pickCanonicalBinding } from '../shared/catalog-canonical-binding';
import { workspaceScopeKey, WORKSPACE_SCOPE_SEP } from '../shared/workspace-scoped-identity';
import {
  NOTEBOOK_PROJECTION_ID_COLUMNS,
  NOTEBOOK_PROJECTION_LOCATOR_COLUMNS,
  PAGE_LOCATOR_PREFIX,
} from '../shared/catalog-projection-refs';
import {
  databaseBackupCreatedAtMs,
  flushFileAndParentDirectoryRequired,
  inspectCompatibleDatabaseFile,
  parseDatabaseBackupFilename,
  restoreDatabaseBackupNonDestructively,
  type DatabaseRecoveryDependencies,
} from './database-recovery';
import { RELEASE_BUILD_IDENTITY } from './release-stamp';
import { createHostedContributionLocalDeclineTable } from './hosted-contribution-local-decline';
import { createAgentStateCapsuleTable } from './hosted-codex/agent-state-capsule';
import { migrateLegacyWorkspaceSyncRendererRefresh } from './workspace-sync-renderer-refresh-pending';
import { CURRENT_SCHEMA_VERSION } from './schema-version';
import { createAdministrationTables } from './administration-schema';
import { createWorkReminderTables } from './work-reminder-schema';
import { createScientificObjectTables } from './scientific-object-schema';
import { createCatalogNameSearchIndex } from './catalog-name-search-index';
import { createNotebookReferenceProjectionTables } from './notebook-reference-projection';
import { installSavedEntityRowHistory } from './saved-entity-row-versions';
import { createSavedFileSourceTables } from './saved-file-sources-schema';
import { createNotebookSavedReferenceRetention } from './notebook-saved-reference-retention';
import {
  createScientificHistoryIdentityTable,
  migrateScientificHistoryIdentity,
} from './scientific-history-schema';

export { CURRENT_SCHEMA_VERSION } from './schema-version';
export const DATABASE_WRITER_IDENTITY_KEY = 'database_last_writer';

const BACKUP_PREFIX = 'dnaforge-backup-v';
const BACKUPS_TO_KEEP = 2;

export interface DatabaseWriterIdentity {
  version: string;
  isReleaseBuild: boolean;
  fingerprint: string;
  writtenAt: number;
}

export interface SchemaBuildPolicy {
  migrationAllowed: boolean;
  writer: DatabaseWriterIdentity;
}

export function backupDatabase(
  db: Database.Database,
  dbPath: string,
  deps: DatabaseRecoveryDependencies = {}
): string | null {
  let backupPath: string | null = null;
  try {
    const version = db.pragma('user_version', { simple: true }) as number;
    backupPath = join(dirname(dbPath), `${BACKUP_PREFIX}${version}-${Date.now()}.db`);

    const checkpoint = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy?: number;
      log?: number;
      checkpointed?: number;
    }>;
    const cp = checkpoint?.[0];
    if (cp) {
      const busy = cp.busy ?? 0;
      const log = cp.log ?? 0;
      const checkpointed = cp.checkpointed ?? 0;
      if (busy !== 0 || (log >= 0 && checkpointed >= 0 && checkpointed < log)) {
        console.warn(
          `[Schema] backup refused: wal_checkpoint busy=${busy} log=${log} checkpointed=${checkpointed}; another handle is holding WAL frames`
        );
        return null;
      }
    }
    copyFileSync(dbPath, backupPath);
    (deps.flushBackupFile ?? flushFileAndParentDirectoryRequired)(backupPath);

    db.prepare('ATTACH DATABASE ? AS dnaforge_upgrade_backup').run(backupPath);
    try {
      if (
        db.pragma('dnaforge_upgrade_backup.quick_check(1)', { simple: true }) !== 'ok' ||
        db.pragma('dnaforge_upgrade_backup.user_version', { simple: true }) !== version
      )
        throw new Error('The database upgrade backup failed its schema or integrity check.');
    } finally {
      db.exec('DETACH DATABASE dnaforge_upgrade_backup');
    }
    (deps.flushBackupFile ?? flushFileAndParentDirectoryRequired)(backupPath);

    return backupPath;
  } catch (err) {
    if (backupPath && existsSync(backupPath)) {
      try {
        unlinkSync(backupPath);
      } catch {}
    }
    console.warn('[Schema] Backup failed; migrations requiring recovery will be refused:', err);
    return null;
  }
}

export function cleanupOldBackups(
  dir: string,
  keepCount = BACKUPS_TO_KEEP,
  deps: DatabaseRecoveryDependencies = {}
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  const backups = entries
    .map((f) => {
      const parsed = parseDatabaseBackupFilename(f);
      if (!parsed) return null;
      const full = join(dir, f);
      const schemaVersion = inspectCompatibleDatabaseFile(
        full,
        CURRENT_SCHEMA_VERSION,
        parsed.schemaVersion,
        deps
      );
      if (schemaVersion === null) return null;
      return {
        full,
        createdAtMs: databaseBackupCreatedAtMs(full),
        version: schemaVersion,
      };
    })
    .filter(
      (
        backup
      ): backup is {
        full: string;
        createdAtMs: number;
        version: number;
      } => backup !== null
    )
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  if (backups.length <= keepCount || keepCount <= 0) return;

  const minimumVersion = Math.min(...backups.map((backup) => backup.version));
  const minimumVersionRecoveryPoint = backups.find((backup) => backup.version === minimumVersion);
  const keep = new Set<string>();
  if (minimumVersionRecoveryPoint) keep.add(minimumVersionRecoveryPoint.full);
  for (const backup of backups) {
    if (keep.size >= keepCount) break;
    keep.add(backup.full);
  }

  for (const backup of backups) {
    if (keep.has(backup.full)) continue;
    try {
      unlinkSync(backup.full);
    } catch {}
  }
}

function restoreFromBackup(
  db: Database.Database,
  dbPath: string,
  backupPath: string,
  versionBeforeMigration: number,
  recoveryDependencies: DatabaseRecoveryDependencies
): string {
  try {
    db.close();
  } catch {}

  return restoreDatabaseBackupNonDestructively(
    dbPath,
    backupPath,
    versionBeforeMigration,
    CURRENT_SCHEMA_VERSION,
    Date.now(),
    recoveryDependencies
  ).preRestorePath;
}

function migrationWouldBeDestructive(db: Database.Database): boolean {
  if (
    Number(db.pragma('user_version', { simple: true })) < 45 &&
    tableExists(db, 'org_registry_local_records')
  )
    return true;
  if (hasRetiredBenchlingUndoStorage(db)) return true;
  const oldBindings = db
    .prepare(`SELECT name FROM pragma_table_info('primer_bindings') WHERE name = 'computed_at'`)
    .all() as { name: string }[];
  if (oldBindings.length > 0) return true;

  const oldPrimers = db
    .prepare(`SELECT name FROM pragma_table_info('primers') WHERE name = 'target_sequence_id'`)
    .all() as { name: string }[];
  if (oldPrimers.length > 0) return true;

  const directionCol = db
    .prepare(`SELECT name FROM pragma_table_info('primers') WHERE name = 'direction'`)
    .all() as { name: string }[];
  if (directionCol.length > 0) return true;
  const primerPairsTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='primer_pairs'`)
    .all() as { name: string }[];
  if (primerPairsTable.length > 0) return true;
  const primerBindingsDdl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='primer_bindings'`)
    .get() as { sql?: string } | undefined;
  if (primerBindingsDdl?.sql) {
    const strandCol = db
      .prepare(`SELECT [notnull] FROM pragma_table_info('primer_bindings') WHERE name = 'strand'`)
      .all() as { notnull: number }[];
    const strandIsNotNull = strandCol[0]?.notnull === 1;
    const hasStrandCheck = /CHECK\s*\(\s*strand\s+IN\s*\(\s*1\s*,\s*-1\s*\)\s*\)/i.test(
      primerBindingsDdl.sql
    );
    if (!strandIsNotNull || !hasStrandCheck) return true;
  }

  const featuresTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='features'`)
    .all() as { name: string }[];
  if (featuresTable.length > 0) return true;
  if (tableExists(db, 'genome_sessions')) return true;
  if (tableExists(db, 'lims_audit') && !limsAuditHasCurrentEnvelopeConstraints(db)) {
    return true;
  }
  if (tableExists(db, 'catalog_workspace_placements') && !catalogPlacementsSupportRecords(db)) {
    return true;
  }
  return false;
}

export function ensureSchema(
  db: Database.Database,
  dbPath: string,
  recoveryDependencies: DatabaseRecoveryDependencies = {}
): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  const isVirginDatabase =
    version === 0 &&
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
        )
        .get() as { count: number }
    ).count === 0;

  if (version > CURRENT_SCHEMA_VERSION) {
    trackEvent('app_schema_refused', {
      db_version: version,
      build_version: app.getVersion(),
      is_release: RELEASE_BUILD_IDENTITY.isReleaseBuild,
    });
    throw new SchemaVersionTooNewError({
      dbVersion: version,
      supportedVersion: CURRENT_SCHEMA_VERSION,
      appVersion: app.getVersion(),
    });
  }

  assertRetiredBenchlingUndoSettled(db);

  if (version >= CURRENT_SCHEMA_VERSION) {
    repairCurrentSchemaWithLimsWriteGuards(db, false, false);
    return;
  }

  const backupPath =
    dbPath === ':memory:' ? null : backupDatabase(db, dbPath, recoveryDependencies);
  if (dbPath !== ':memory:') {
    trackEvent('app_migration_backup', {
      from_version: version,
      success: backupPath !== null,
    });
  }

  const requiresUpgradeRecoveryBackup = !isVirginDatabase && version < CURRENT_SCHEMA_VERSION;
  if (
    backupPath === null &&
    dbPath !== ':memory:' &&
    (requiresUpgradeRecoveryBackup || migrationWouldBeDestructive(db))
  ) {
    trackEvent('app_migration_result', {
      from_version: version,
      to_version: CURRENT_SCHEMA_VERSION,
      success: false,
      restored_from_backup: false,
    });
    throw new SchemaUpgradeBackupRequiredError({ dbPath: dirname(dbPath) });
  }

  let migrationSucceeded = true;
  let terminalError: unknown = null;
  let restoredFromBackup = false;

  try {
    if (!isVirginDatabase && version < 45) installSavedEntityRowHistory(db, true);
    if (version < 1) {
      migrateToV1(db);
    }
    if (version < 2) {
      migrateToV2(db);
    }
    if (version < 3) {
      migrateToV3(db);
    }
    if (version < 4) {
      migrateToV4(db);
    }
    if (version < 5) {
      migrateToV5(db);
    }
    if (version < 6) {
      migrateToV6(db);
    }
    if (version < 7) {
      migrateToV7(db);
    }
    if (version < 8) {
      migrateToV8(db);
    }
    if (version < 9) {
      migrateToV9(db);
    }
    if (version < 10) {
      migrateToV10(db);
    }
    if (version < 11) {
      migrateToV11(db);
    }
    if (version < 12) {
      migrateToV12(db);
    }
    if (version < 13) {
      migrateToV13(db);
    }
    if (version < 14) {
      migrateToV14(db);
    }
    if (version < 15) {
      migrateToV15(db);
    }
    if (version < 16) {
      migrateToV16(db);
    }
    if (version < 17) {
      migrateToV17(db);
    }
    if (version < 18) {
      migrateToV18(db);
    }
    if (version < 19) {
      migrateToV19(db);
    }
    if (version < 20) {
      migrateToV20(db);
    }
    if (version < 21) {
      migrateToV21(db);
    }
    if (version < 22) {
      migrateToV22(db);
    }
    if (version < 23) {
      migrateToV23(db);
    }
    if (version < 24) {
      migrateToV24(db);
    }
    if (version < 25) {
      migrateToV25(db);
    }
    if (version < 26) {
      migrateToV26(db);
    }
    if (version < 27) {
      migrateToV27(db);
    }
    if (version < 28) {
      migrateToV28(db);
    }
    if (version < 29) {
      migrateToV29(db);
    }
    if (version < 32) {
      retireBenchlingUndoStorage(db);
    }
    if (version < 33) {
      migrateToV33(db);
    }
    if (version < 34) {
      createWorkspaceSyncRendererDeliveries(db);
    }
    if (version < 35) {
      migrateToV35(db);
    }
    if (version < 36) {
      migrateToV36(db);
    }
    if (version < 37) {
      migrateToV37(db);
    }
    if (version < 38) {
      migrateToV38(db);
    }
    if (version < 39) {
      createEntityProjectionSourcesTable(db);
    }
    if (version < 40) {
      createMolecularCatalogTables(db);
    }
    if (version < 41) {
      createGraphPersistenceTables(db);
    }
    if (version < 44) {
      createOrgRegistryScopedSyncTables(db);
      createOrgRegistryRecordSyncTables(db);
      migrateToV42(db);
      migrateScientificHistoryIdentity(db);
      createCatalogNameSearchIndex(db);
    }

    if (version < 45) {
      migrateToV42(db);
      migrateScientificHistoryIdentity(db);
      createOrgRegistryScopedSyncTables(db);
      createOrgRegistryRecordSyncTables(db);
      migrateToV45(db);
    }

    if (version < 46) createAdministrationTables(db);
    if (version < 47) ensureWorkspaceSyncOperationIdentityColumns(db);
    if (version < 48) migrateAgentSessionStopStates(db);
    if (version < 49) createNotebookReferenceProjectionTables(db);
    if (version < 50) createNotebookSavedReferenceRetention(db);

    repairCurrentSchemaWithLimsWriteGuards(db, version < 26, isVirginDatabase);
  } catch (err) {
    migrationSucceeded = false;

    if (backupPath) {
      try {
        const preRestorePath = restoreFromBackup(
          db,
          dbPath,
          backupPath,
          version,
          recoveryDependencies
        );
        restoredFromBackup = true;
        console.log('[Schema] Migration failed, restored from backup');
        terminalError = new SchemaMigrationRecoveredError({
          migrationError: err,
          backupPath,
          backupCreatedAtLabel: formatBackupDate(backupPath),
          preRestorePath,
        });
      } catch (restoreErr) {
        console.error('[Schema] Restore failed:', restoreErr);
        terminalError = new SchemaMigrationRecoveryFailedError({
          migrationError: err,
          recoveryError: restoreErr,
          backupPath,
          dbPath,
        });
      }
    } else {
      terminalError = new SchemaMigrationFailedWithoutBackupError(err);
    }
  }

  trackEvent('app_migration_result', {
    from_version: version,
    to_version: CURRENT_SCHEMA_VERSION,
    success: migrationSucceeded,
    restored_from_backup: restoredFromBackup,
  });

  if (migrationSucceeded) {
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    if (backupPath) {
      cleanupOldBackups(dirname(dbPath), BACKUPS_TO_KEEP, recoveryDependencies);
    }
  } else {
    throw terminalError;
  }
}

export function ensureSchemaForBuild(
  db: Database.Database,
  dbPath: string,
  policy: SchemaBuildPolicy
): void {
  assertSchemaBuildCompatible(db, policy);
  const version = db.pragma('user_version', { simple: true }) as number;

  if (version === CURRENT_SCHEMA_VERSION && !policy.migrationAllowed) {
    recordDatabaseWriterIdentity(db, policy.writer);
    return;
  }

  ensureSchema(db, dbPath);
  recordDatabaseWriterIdentity(db, policy.writer);
}

export function assertSchemaBuildCompatible(
  db: Database.Database,
  policy: Pick<SchemaBuildPolicy, 'migrationAllowed'>
): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version > CURRENT_SCHEMA_VERSION)
    throw new SchemaVersionTooNewError({
      dbVersion: version,
      supportedVersion: CURRENT_SCHEMA_VERSION,
      appVersion: app.getVersion(),
    });
  if (version < CURRENT_SCHEMA_VERSION && !policy.migrationAllowed)
    throw new SchemaMigrationNotAuthorizedError(version);
}

function recordDatabaseWriterIdentity(db: Database.Database, writer: DatabaseWriterIdentity): void {
  const settingsExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'`)
    .get();
  if (!settingsExists) return;

  const value = JSON.stringify({
    last_writer_version: writer.version,
    last_writer_is_release: writer.isReleaseBuild,
    last_writer_fingerprint: writer.fingerprint,
    last_writer_at: writer.writtenAt,
  });
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(DATABASE_WRITER_IDENTITY_KEY, value, writer.writtenAt);
}

function formatBackupDate(backupPath: string): string {
  try {
    return new Date(databaseBackupCreatedAtMs(backupPath)).toLocaleString();
  } catch {
    return 'unknown date';
  }
}

function repairCurrentSchema(db: Database.Database): void {
  createAdministrationTables(db);
  createCatalogNameSearchIndex(db);
  ensureConversationTitleLock(db);
  createHostedContributionLocalDeclineTable(db);
  createRemoteEndpointProfilesTable(db);
  createAgentStateCapsuleTable(db);
  createCatalogProviderBindingsTable(db);
  createCatalogWorkspacePlacementsTable(db);
  createNativeCatalogPublicationOutbox(db);
  createMeaningfulActivityPendingTable(db);
  createAnalyticsEventOutboxTable(db);
  createAgentProviderSessionControlTables(db);
  createEntityProjectionSourcesTable(db);
  createNotebookReferenceProjectionTables(db);
  createNotebookSavedReferenceRetention(db);
  createGraphPersistenceTables(db);
  createComputeJobTables(db);
  createScientificObjectTables(db);
  createScientificHistoryIdentityTable(db);
  safeAddColumn(
    db,
    'scientific_materialization_jobs',
    'delivery_kind',
    "TEXT NOT NULL DEFAULT 'local-acceptance' CHECK(delivery_kind IN ('local-acceptance', 'history-adoption'))"
  );
  createMolecularCatalogTables(db);
  ensureLimsAuditEventEnvelope(db);
  db.transaction(() => {
    createWorkspaceSyncTables(db);
    ensureWorkspaceSyncRestoreIdentityColumns(db);
    createWorkspaceSyncIndexes(db);
    createWorkspaceSyncRendererDeliveries(db);
    createOrgRegistrySyncTables(db);
    createOrgRegistryScopedSyncTables(db);
    createOrgRegistryRecordSyncTables(db, true);

    migrateLegacyWorkspaceSyncRendererRefresh(db);
    createWorkspaceSyncRestoreIdentityIndex(db);
    createLimsSafetyQuarantineSchema(db);
  })();
  safeAddColumn(db, 'workspace_sync_versions', 'excluded_summary_json', 'TEXT');
  ensureWorkspaceSyncSharedProjectColumns(db);
  safeAddColumn(db, 'agent_sessions', 'provider_conversation_id', 'TEXT');
  safeAddColumn(
    db,
    'agent_sessions',
    'telemetry_had_workspace_context',
    'INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_had_workspace_context IN (0, 1))'
  );
  safeAddColumn(
    db,
    'agent_sessions',
    'telemetry_continuation',
    'INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_continuation IN (0, 1))'
  );
  migrateAgentSessionStopStates(db);
  ensureEntityReferenceWorkspaceScope(db);
  ensureCatalogSequenceFingerprint(db);
  ensureOneCurrentBindingPerEntity(db);
  ensureSequenceDocumentIdentity(db);
  if (ensureWorkspaceAccessModeColumn(db)) {
    backfillReferenceWorkspaceAccess(db);
  }
  createWorkReminderTables(db);
}

function ensureCatalogSequenceFingerprint(db: Database.Database): void {
  if (!tableExists(db, 'catalog_entity_files')) return;
  safeAddColumn(db, 'catalog_entity_files', 'sequence_fingerprint', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_catalog_entity_files_sequence_fingerprint
    ON catalog_entity_files(sequence_fingerprint)
    WHERE sequence_fingerprint IS NOT NULL
  `);
}

function ensureConversationTitleLock(db: Database.Database): void {
  if (!tableExists(db, 'conversations') || tableHasColumn(db, 'conversations', 'title_locked')) {
    return;
  }
  db.exec(`
    ALTER TABLE conversations
    ADD COLUMN title_locked INTEGER NOT NULL DEFAULT 0
      CHECK(title_locked IN (0, 1))
  `);
  db.exec('UPDATE conversations SET title_locked = 1');
}

function repairCurrentSchemaWithLimsWriteGuards(
  db: Database.Database,
  snapshotLegacyCandidates: boolean,
  completeVirginScan: boolean
): void {
  db.transaction(() => {
    dropLimsSafetyWriteGuards(db);
    repairCurrentSchema(db);
    if (snapshotLegacyCandidates) {
      snapshotLegacyLimsScanCandidates(db);
    }
    if (completeVirginScan) {
      db.exec(`
        UPDATE lims_safety_legacy_scan_state
        SET status = 'completed', completed_at = 0
        WHERE id = 1
          AND NOT EXISTS (SELECT 1 FROM lims_safety_legacy_scan_candidates)
          AND NOT EXISTS (SELECT 1 FROM lims_audit)
      `);
    }
    createLimsSafetyWriteGuards(db);
    createSavedFileSourceTables(db);
    installSavedEntityRowHistory(db);
  })();
}

function migrateToV19(db: Database.Database): void {
  ensureEntityReferenceWorkspaceScope(db);
  console.log('[Schema] migrateToV19 complete (workspace-scoped entity references)');
}

function migrateToV20(db: Database.Database): void {
  ensureLimsAuditEventEnvelope(db);
  if (limsAuditHasCurrentEnvelopeConstraints(db)) {
    console.log('[Schema] migrateToV20 complete (LIMS audit constraints already current)');
    return;
  }

  db.transaction(() => {
    db.exec(`ALTER TABLE lims_audit RENAME TO lims_audit_v19`);
    createLimsAuditTable(db);
    db.exec(`
      INSERT INTO lims_audit (
        id, event_seq, schema_version, idempotency_key, operation_id,
        event_type, subject_table, subject_id, batch_id, actor,
        actor_client_id, actor_user_id, workspace_id, before, after,
        payload, prev_hash, hash, tombstone, created_at
      )
      SELECT
        id,
        event_seq,
        COALESCE(schema_version, 0),
        COALESCE(NULLIF(idempotency_key, ''), 'lims:v0:' || id),
        operation_id,
        event_type,
        subject_table,
        subject_id,
        batch_id,
        actor,
        actor_client_id,
        actor_user_id,
        workspace_id,
        before,
        after,
        payload,
        prev_hash,
        hash,
        tombstone,
        created_at
      FROM lims_audit_v19
    `);
    db.exec(`DROP TABLE lims_audit_v19`);
    createLimsIndexes(db);
  })();

  console.log('[Schema] migrateToV20 complete (canonical LIMS audit constraints)');
}

function migrateToV21(db: Database.Database): void {
  createHostedContributionLocalDeclineTable(db);
  console.log('[Schema] migrateToV21 complete (local Research Contribution Not-now receipt)');
}

function migrateToV22(db: Database.Database): void {
  createAgentStateCapsuleTable(db);
  console.log('[Schema] migrateToV22 complete (Hosted Codex AgentStateCapsule store)');
}

function migrateToV23(db: Database.Database): void {
  createCatalogProviderBindingsTable(db);
  console.log('[Schema] migrateToV23 complete (durable catalog provider bindings)');
}

function migrateToV24(db: Database.Database): void {
  createWorkspaceSyncUploadSnapshotsTable(db);
  console.log('[Schema] migrateToV24 complete (durable workspace sync upload snapshots)');
}

function migrateToV25(db: Database.Database): void {
  ensureWorkspaceSyncRestoreIdentityColumns(db);
  createWorkspaceSyncRestoreIdentityIndex(db);
  console.log('[Schema] migrateToV25 complete (identity-bound workspace restore intents)');
}

function migrateToV26(db: Database.Database): void {
  createLimsSafetyQuarantineSchema(db);
  console.log('[Schema] migrateToV26 complete (legacy LIMS activation quarantine)');
}

function snapshotLegacyLimsScanCandidates(db: Database.Database): void {
  if (!tableExists(db, 'workspaces')) return;
  db.exec(`
    INSERT OR IGNORE INTO lims_safety_legacy_scan_candidates (workspace_id)
    SELECT id FROM workspaces
  `);
}

function migrateToV27(db: Database.Database): void {
  ensureSequenceDocumentIdentity(db);
  console.log('[Schema] migrateToV27 complete (logical sequence document identity)');
}

function migrateToV28(db: Database.Database): void {
  createCatalogWorkspacePlacementsTable(db, false);
  console.log('[Schema] migrateToV28 complete (normalized catalog workspace placements)');
}

function migrateToV29(db: Database.Database): void {
  createNativeCatalogPublicationOutbox(db);
  if (!tableExists(db, 'catalog_workspace_placements') || catalogPlacementsSupportRecords(db)) {
    createCatalogWorkspacePlacementsTable(db);
    return;
  }
  db.transaction(() => {
    db.exec('ALTER TABLE catalog_workspace_placements RENAME TO catalog_workspace_placements_v28');
    createCatalogWorkspacePlacementsTable(db);
    db.exec(`
      INSERT INTO catalog_workspace_placements (
        entity_id, workspace_id, parent_relative_path, display_name,
        normalized_sibling_name, presentation_kind, status, created_at, updated_at
      ) SELECT entity_id, workspace_id, parent_relative_path, display_name,
        normalized_sibling_name, presentation_kind, status, created_at, updated_at
      FROM catalog_workspace_placements_v28;
      DROP TABLE catalog_workspace_placements_v28;
    `);
    createCatalogWorkspacePlacementsTable(db);
  })();
}

function migrateToV33(db: Database.Database): void {
  createMeaningfulActivityPendingTable(db);
  createAnalyticsEventOutboxTable(db);
  console.log('[Schema] migrateToV33 complete (telemetry receipts and analytics outbox)');
}

function createGraphPersistenceTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      file_id INTEGER REFERENCES indexed_files(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      length INTEGER NOT NULL,
      circular INTEGER DEFAULT 0,
      node_type TEXT NOT NULL DEFAULT 'sequence',
      source_resolution TEXT,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS graph_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      source_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      target_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      confidence INTEGER NOT NULL DEFAULT 0,
      is_manual INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_nodes_workspace ON graph_nodes(workspace_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_workspace ON graph_edges(workspace_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_source ON graph_edges(source_node_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_graph_edges_target ON graph_edges(target_node_id)`);
}

function migrateToV35(db: Database.Database): void {
  createAgentProviderSessionControlTables(db);
  console.log('[Schema] migrateToV35 complete (agent capability controls)');
}

function migrateToV36(db: Database.Database): void {
  if (!tableExists(db, 'workspaces')) {
    console.log('[Schema] migrateToV36 skipped (workspaces table absent)');
    return;
  }
  ensureWorkspaceAccessModeColumn(db);

  backfillReferenceWorkspaceAccess(db);
  console.log('[Schema] migrateToV36 complete (durable workspace access)');
}

function migrateToV37(db: Database.Database): void {
  if (!tableExists(db, 'settings')) {
    console.log('[Schema] migrateToV37 skipped (settings table absent)');
    return;
  }
  const marker = db
    .prepare(`SELECT value FROM settings WHERE key = 'default_workspace_path'`)
    .get() as { value: string | null } | undefined;
  if (marker?.value && tableExists(db, 'workspaces')) {
    db.prepare(
      `UPDATE workspaces SET name = 'My Project' WHERE path = ? AND name = 'My Workspace'`
    ).run(marker.value);
  }
  db.prepare(`DELETE FROM settings WHERE key = 'default_workspace_path'`).run();
  console.log('[Schema] migrateToV37 complete (default project marker retired)');
}

function createRemoteEndpointProfilesTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remote_endpoint_profiles (
      endpoint_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      ssh_target TEXT NOT NULL UNIQUE,
      last_connected_at INTEGER NOT NULL,
      last_validated_at INTEGER NOT NULL,
      observed_platform TEXT,
      last_failure_code TEXT,
      last_failure_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_remote_endpoint_profiles_recent
      ON remote_endpoint_profiles(last_connected_at DESC);
  `);
}

function migrateToV38(db: Database.Database): void {
  createOrgRegistrySyncTables(db);
  console.log('[Schema] migrateToV38 complete (organization Registry sync cache)');
}

function createEntityProjectionSourcesTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS entity_projection_sources (
    adapter_kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    projection_version INTEGER NOT NULL CHECK(projection_version >= 1),
    synchronized_fingerprint TEXT NOT NULL,
    synchronized_at INTEGER NOT NULL,
    PRIMARY KEY(adapter_kind, entity_id, workspace_key, relative_path, projection_version)
  )`);
}

function migrateToV42(db: Database.Database): void {
  createScientificObjectTables(db);
  console.log('[Schema] migrateToV42 complete (accepted scientific objects)');
}

function ensureWorkspaceAccessModeColumn(db: Database.Database): boolean {
  if (!tableExists(db, 'workspaces') || tableHasColumn(db, 'workspaces', 'access_mode')) {
    return false;
  }
  db.exec(`
    ALTER TABLE workspaces
    ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'writable'
      CHECK(access_mode IN ('writable', 'reference'))
  `);
  return true;
}

function backfillReferenceWorkspaceAccess(db: Database.Database): void {
  if (!tableExists(db, 'catalog_entities')) {
    return;
  }

  const roots = db
    .prepare(
      `SELECT ce.workspace_id, w.path AS workspace_path, ce.metadata
       FROM catalog_entities ce
       JOIN workspaces w ON w.id = ce.workspace_id
       WHERE ce.type = 'folder'
         AND ce.storage_type = 'file'
         AND ce.locator = 'file://' || w.path
         AND ce.workspace_id IS NOT NULL`
    )
    .all() as Array<{
    workspace_id: number;
    workspace_path: string;
    metadata: string | null;
  }>;
  const markReference = db.prepare(`UPDATE workspaces SET access_mode = 'reference' WHERE id = ?`);

  for (const root of roots) {
    if (!root.metadata) continue;
    try {
      const metadata = JSON.parse(root.metadata) as Record<string, unknown>;
      if (
        metadata.pinned === true &&
        metadata.fileKind === 'folder' &&
        metadata.path === root.workspace_path
      ) {
        markReference.run(root.workspace_id);
      }
    } catch {}
  }
}

function createMeaningfulActivityPendingTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meaningful_activity_pending (
    action_id TEXT PRIMARY KEY NOT NULL,
    workflow TEXT NOT NULL CHECK(length(workflow) BETWEEN 1 AND 64),
    workflow_action TEXT NOT NULL CHECK(length(workflow_action) BETWEEN 1 AND 64),
    workflow_status TEXT NOT NULL CHECK(length(workflow_status) BETWEEN 1 AND 64),
    initiated_at_ms INTEGER NOT NULL CHECK(initiated_at_ms > 0),
    qualified_at_ms INTEGER NOT NULL CHECK(qualified_at_ms >= initiated_at_ms),
    value_delivered INTEGER CHECK(value_delivered IN (0, 1)),
    usable_result INTEGER CHECK(usable_result IN (0, 1)),
    selected_count INTEGER CHECK(selected_count IS NULL OR selected_count >= 0),
    app_session_id TEXT NOT NULL CHECK(length(app_session_id) BETWEEN 1 AND 64),
    upload_state TEXT NOT NULL CHECK(upload_state IN ('pending', 'sent', 'expired')),
    bound_account_id TEXT,
    identity_resolution TEXT CHECK(identity_resolution IN ('direct_session', 'linked_later')),
    historical INTEGER NOT NULL DEFAULT 0 CHECK(historical IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= created_at_ms),
    sent_at_ms INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_meaningful_activity_pending_delivery
    ON meaningful_activity_pending(upload_state, app_session_id, expires_at_ms);`);
}

function createAnalyticsEventOutboxTable(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_event_outbox (
    event_id TEXT PRIMARY KEY NOT NULL,
    event_name TEXT NOT NULL CHECK(length(event_name) BETWEEN 1 AND 96),
    payload_schema_version INTEGER NOT NULL CHECK(payload_schema_version >= 1),
    reference_kind TEXT NOT NULL CHECK(length(reference_kind) BETWEEN 1 AND 64),
    reference_id TEXT NOT NULL CHECK(length(reference_id) BETWEEN 1 AND 512),
    properties_json TEXT NOT NULL CHECK(json_valid(properties_json)),
    created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
    send_attempts INTEGER NOT NULL DEFAULT 0 CHECK(send_attempts >= 0),
    last_attempt_at_ms INTEGER,
    sent_at_ms INTEGER,
    origin_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_analytics_event_outbox_delivery
    ON analytics_event_outbox(sent_at_ms, created_at_ms, event_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_event_outbox_reference
    ON analytics_event_outbox(reference_kind, reference_id);`);
  safeAddColumn(db, 'analytics_event_outbox', 'origin_json', 'TEXT');
}

function createNativeCatalogPublicationOutbox(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS native_catalog_publication_outbox (
    operation_id TEXT PRIMARY KEY NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_native_catalog_publication_workspace
    ON native_catalog_publication_outbox(workspace_id);`);
}

function catalogPlacementsSupportRecords(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'catalog_workspace_placements'"
    )
    .get();
  return (
    typeof row === 'object' &&
    row !== null &&
    'sql' in row &&
    typeof row.sql === 'string' &&
    /presentation_kind\s+IN\s*\([^)]*'record'/iu.test(row.sql)
  );
}

function ensureSequenceDocumentIdentity(db: Database.Database): void {
  if (!tableExists(db, 'sequences')) return;
  safeAddColumn(db, 'sequences', 'document_id', 'TEXT');
  db.transaction(() => {
    db.exec(`
      UPDATE sequences
      SET document_id = 'legacy-sequence:' || id
      WHERE document_id IS NULL OR trim(document_id) = ''
    `);
    if (tableExists(db, 'catalog_entity_files')) {
      db.exec(`
        UPDATE sequences
        SET document_id = (
          SELECT cef.entity_id
          FROM indexed_files AS f
          JOIN catalog_entity_files AS cef ON cef.path = f.path
          WHERE f.id = sequences.file_id
          ORDER BY cef.updated_at DESC
          LIMIT 1
        )
        WHERE id IN (
          SELECT MIN(s.id)
          FROM sequences AS s
          JOIN indexed_files AS f ON f.id = s.file_id
          JOIN catalog_entity_files AS cef ON cef.path = f.path
          GROUP BY cef.entity_id
        )
      `);
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sequences_document_id
      ON sequences(document_id)
    `);
  })();
}

function limsAuditHasCurrentEnvelopeConstraints(db: Database.Database): boolean {
  if (!tableExists(db, 'lims_audit')) return false;
  const columns = db.prepare(`PRAGMA table_info('lims_audit')`).all() as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const schemaVersion = columns.find((column) => column.name === 'schema_version');
  const idempotencyKey = columns.find((column) => column.name === 'idempotency_key');
  return (
    schemaVersion?.notnull === 1 &&
    schemaVersion.dflt_value === '1' &&
    idempotencyKey?.notnull === 1
  );
}

function ensureEntityReferenceWorkspaceScope(db: Database.Database): void {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entity_references'`)
    .get();
  if (!tableExists) return;
  safeAddColumn(db, 'entity_references', 'workspace_scope', 'TEXT');
  safeAddColumn(db, 'entity_references', 'workspace_root_path', 'TEXT');
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_entity_refs_workspace_scope ON entity_references(workspace_scope)`
  );
}

function migrateToV1(db: Database.Database): void {
  migratePrimerSchema(db);

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_opened_at INTEGER
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        extension TEXT NOT NULL,
        size_bytes INTEGER,
        modified_at INTEGER,
        indexed_at INTEGER NOT NULL,
        metadata TEXT
      )
    `);

    db.exec(`
      -- Lazy FK-index for the primers subsystem. The source of truth for
      -- sequence data is FILES (.gb/.fasta in workspaces), not this table.
      -- The sequence column is never populated in production; see
      -- ensureSequenceIdentity.
      CREATE TABLE IF NOT EXISTS sequences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL REFERENCES indexed_files(id) ON DELETE CASCADE,
        document_id TEXT,
        name TEXT NOT NULL,
        description TEXT,
        length INTEGER NOT NULL,
        sequence_type TEXT,
        circular INTEGER DEFAULT 0,
        sequence TEXT
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS pages (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        date INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    createCatalogTables(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    safeAddColumn(db, 'conversations', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
    safeAddColumn(db, 'conversations', 'provider', 'TEXT');
    safeAddColumn(db, 'conversations', 'model', 'TEXT');

    db.exec(
      `UPDATE conversations SET provider = 'anthropic', model = 'claude-sonnet-4-20250514' WHERE provider IS NULL`
    );

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    createAgentSessionTables(db);

    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_references (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        display_label TEXT NOT NULL,
        locator TEXT NOT NULL,
        deep_link_params TEXT,
        data TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        workspace_scope TEXT,
        workspace_root_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    safeAddColumn(db, 'entity_references', 'workspace_scope', 'TEXT');
    safeAddColumn(db, 'entity_references', 'workspace_root_path', 'TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS entity_reference_revisions (
        id TEXT PRIMARY KEY,
        reference_id TEXT NOT NULL REFERENCES entity_references(id) ON DELETE CASCADE,
        revision_number INTEGER NOT NULL,
        changed_by TEXT NOT NULL,
        change_type TEXT NOT NULL,
        previous_state TEXT,
        new_state TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS message_references (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        reference_id TEXT NOT NULL REFERENCES entity_references(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (message_id, reference_id)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS primers (
        id TEXT PRIMARY KEY,
        catalog_number TEXT UNIQUE,
        name TEXT NOT NULL,
        sequence TEXT NOT NULL,
        direction TEXT,
        length INTEGER NOT NULL,
        tm REAL,
        gc_percent REAL,
        origin TEXT,
        origin_details TEXT,
        status TEXT DEFAULT 'designed',
        vendor TEXT,
        order_date INTEGER,
        application TEXT,
        scale TEXT,
        purification TEXT,
        modifications TEXT,
        stock_location TEXT,
        concentration REAL,
        notes TEXT,
        workspace_id INTEGER REFERENCES workspaces(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS primer_pairs (
        id TEXT PRIMARY KEY,
        forward_primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE,
        reverse_primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE,
        expected_product_size INTEGER,
        application TEXT,
        created_at INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS primer_bindings (
        id TEXT PRIMARY KEY,
        primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE,
        sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        binding_start INTEGER NOT NULL,
        binding_end INTEGER NOT NULL,
        strand INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(primer_id, sequence_id, binding_start)
      )
    `);

    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_indexed_files_workspace ON indexed_files(workspace_id)`
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sequences_file ON sequences(file_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_path)`
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_refs_locator ON entity_references(locator)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_entity_refs_workspace_scope ON entity_references(workspace_scope)`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_entity_ref_revisions ON entity_reference_revisions(reference_id)`
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_primers_workspace ON primers(workspace_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_primer_bindings_primer ON primer_bindings(primer_id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_primer_bindings_sequence ON primer_bindings(sequence_id)`
    );
    createCatalogIndexes(db);
    createAgentSessionIndexes(db);
  })();

  console.log('[Schema] Database schema initialized (v1)');
}

function safeAddColumn(db: Database.Database, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch {}
}

function createCatalogTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_entities (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      locator TEXT NOT NULL UNIQUE,
      storage_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_entity_files (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      path TEXT NOT NULL UNIQUE,
      relative_path TEXT,
      file_kind TEXT NOT NULL,
      content_hash TEXT,
      size_bytes INTEGER,
      modified_at INTEGER,
      status TEXT NOT NULL DEFAULT 'current',
      last_seen_at INTEGER,
      missing_since INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_entity_links (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      target_entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      confidence TEXT NOT NULL DEFAULT 'suggested',
      evidence TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(source_entity_id, relation, target_entity_id)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_entity_events (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      summary TEXT,
      payload TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  createCatalogProviderBindingsTable(db);
  createRemoteEndpointProfilesTable(db);
}

function createCatalogProviderBindingsTable(db: Database.Database): void {
  if (!tableExists(db, 'catalog_entities')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_provider_bindings (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      stable_object_id TEXT NOT NULL,
      object_class TEXT NOT NULL,
      entity_id TEXT NOT NULL REFERENCES catalog_entities(id) ON DELETE CASCADE,
      binding_kind TEXT NOT NULL CHECK(binding_kind IN ('observed', 'reviewed')),
      provider_account_hint TEXT,
      canonical_url TEXT,
      evidence_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(provider, stable_object_id, object_class, entity_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_provider_bindings_identity ON catalog_provider_bindings(provider, stable_object_id, object_class)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_provider_bindings_entity ON catalog_provider_bindings(entity_id)`
  );
}

function createCatalogWorkspacePlacementsTable(
  db: Database.Database,
  includeCustomRecords = true
): void {
  if (!tableExists(db, 'catalog_entities') || !tableExists(db, 'workspaces')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalog_workspace_placements (
      entity_id TEXT PRIMARY KEY REFERENCES catalog_entities(id) ON DELETE CASCADE,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      parent_relative_path TEXT NOT NULL,
      display_name TEXT NOT NULL CHECK(length(display_name) > 0),
      normalized_sibling_name TEXT NOT NULL CHECK(length(normalized_sibling_name) > 0),
      presentation_kind TEXT NOT NULL CHECK(presentation_kind IN ('strain', 'sequence'${includeCustomRecords ? ", 'record'" : ''})),
      status TEXT NOT NULL CHECK(status IN ('active', 'hidden')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_workspace_placements_active_sibling
    ON catalog_workspace_placements (
      workspace_id,
      parent_relative_path,
      normalized_sibling_name
    )
    WHERE status = 'active'
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_catalog_workspace_placements_parent
    ON catalog_workspace_placements (
      workspace_id,
      parent_relative_path,
      status,
      normalized_sibling_name,
      entity_id
    )
  `);
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  return (
    db.prepare(`SELECT name FROM pragma_table_info(?) WHERE name = ?`).all(table, column).length > 0
  );
}

function tableExists(db: Database.Database, table: string): boolean {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).all(table)
      .length > 0
  );
}

function createCatalogIndexes(db: Database.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_entities_type ON catalog_entities(type)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entities_workspace ON catalog_entities(workspace_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_files_entity ON catalog_entity_files(entity_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_files_workspace ON catalog_entity_files(workspace_id)`
  );
  if (tableHasColumn(db, 'catalog_entity_files', 'status')) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_catalog_entity_files_status ON catalog_entity_files(status)`
    );
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_links_source ON catalog_entity_links(source_entity_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_links_target ON catalog_entity_links(target_entity_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_events_entity ON catalog_entity_events(entity_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_catalog_entity_events_type ON catalog_entity_events(event_type)`
  );
}

function createLimsTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_schema (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('entity', 'relationship_type')),
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT,
      fields TEXT NOT NULL,
      current_revision_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      builtin INTEGER NOT NULL DEFAULT 0 CHECK(builtin IN (0, 1)),
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      actor TEXT,
      event_seq INTEGER,
      tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      UNIQUE(kind, name)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_schema_revision (
      id TEXT PRIMARY KEY,
      schema_id TEXT NOT NULL REFERENCES lims_schema(id) ON DELETE RESTRICT,
      version INTEGER NOT NULL,
      fields TEXT NOT NULL,
      actor TEXT,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      event_seq INTEGER,
      tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0, 1)),
      created_at INTEGER NOT NULL,
      archived_at INTEGER,
      UNIQUE(schema_id, version)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_entity (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      schema_id TEXT REFERENCES lims_schema(id) ON DELETE RESTRICT,
      schema_revision_id TEXT NOT NULL REFERENCES lims_schema_revision(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      registry_id TEXT,
      fields TEXT NOT NULL,
      registration_status TEXT NOT NULL CHECK(registration_status IN ('tracked', 'registered', 'drifted', 'unresolved')),
      domain_status TEXT,
      -- ⚠️ NOT A SCOPE. The registry is GLOBAL (one catalog per installation); the
      -- registry query has no workspace predicate (see lims-registry-projection.ts).
      -- This column is ORIGIN PROVENANCE, read only by lims-git-export/lims-export-sync
      -- to decide which workspaces to materialize. No production import writes it
      -- non-null. Full model: docs/REGISTRY_MODEL.md.
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      actor TEXT,
      event_seq INTEGER,
      tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_id_scheme (
      kind TEXT PRIMARY KEY,
      prefix TEXT NOT NULL,
      pad_width INTEGER NOT NULL DEFAULT 6,
      next_seq INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_link (
      id TEXT PRIMARY KEY,
      from_entity_id TEXT NOT NULL REFERENCES lims_entity(id) ON DELETE RESTRICT,
      to_entity_id TEXT NOT NULL REFERENCES lims_entity(id) ON DELETE RESTRICT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      actor TEXT,
      event_seq INTEGER,
      tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      UNIQUE(from_entity_id, to_entity_id, type)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_event_sequence (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      next_event_seq INTEGER NOT NULL
    )
  `);

  createLimsAuditTable(db);
}

function createLimsAuditTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_audit (
      id TEXT PRIMARY KEY,
      event_seq INTEGER NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT NOT NULL,
      operation_id TEXT,
      event_type TEXT NOT NULL,
      subject_table TEXT,
      subject_id TEXT,
      batch_id TEXT,
      actor TEXT,
      actor_client_id TEXT,
      actor_user_id TEXT,
      workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL,
      before TEXT,
      after TEXT,
      payload TEXT,
      prev_hash TEXT,
      hash TEXT,
      tombstone INTEGER NOT NULL DEFAULT 0 CHECK(tombstone IN (0, 1)),
      created_at INTEGER NOT NULL
    )
  `);
}

function createLimsIndexes(db: Database.Database): void {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_schema_kind_name ON lims_schema(kind, name)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_lims_schema_revision_schema ON lims_schema_revision(schema_id, version)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_entity_kind ON lims_entity(kind)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_entity_name ON lims_entity(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_entity_schema ON lims_entity(schema_revision_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_lims_entity_active_file_sequence_path
     ON lims_entity(trim(json_extract(fields, '$.sequence.relPath')))
     WHERE tombstone = 0
       AND archived_at IS NULL
       AND json_extract(fields, '$.sequence.mode') = 'file'
       AND json_type(fields, '$.sequence.relPath') = 'text'`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_entity_workspace ON lims_entity(workspace_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_lims_entity_registration ON lims_entity(registration_status)`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lims_entity_registry_id ON lims_entity(registry_id) WHERE registry_id IS NOT NULL`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_link_from ON lims_link(from_entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_link_to ON lims_link(to_entity_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_link_type ON lims_link(type)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_lims_audit_subject ON lims_audit(subject_table, subject_id)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_audit_batch ON lims_audit(batch_id)`);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_lims_audit_idempotency_key ON lims_audit(idempotency_key)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_lims_audit_event_type ON lims_audit(event_type)`);
}

const LIMS_SAFETY_GUARDED_TABLES = [
  'lims_schema',
  'lims_schema_revision',
  'lims_entity',
  'lims_id_scheme',
  'lims_link',
  'lims_event_sequence',
  'lims_audit',
] as const;

function createLimsSafetyQuarantineSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lims_safety_quarantine (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      status TEXT NOT NULL CHECK(status IN ('quarantined', 'resolved')),
      reason TEXT NOT NULL CHECK(length(reason) > 0),
      evidence_kind TEXT NOT NULL CHECK(
        evidence_kind IN ('cloud_restore', 'share_import', 'audit_integrity')
      ),
      evidence_workspace_id INTEGER NOT NULL,
      evidence_json TEXT NOT NULL CHECK(length(evidence_json) > 0),
      detected_at INTEGER NOT NULL,
      resolved_at INTEGER CHECK(
        (status = 'quarantined' AND resolved_at IS NULL) OR
        (status = 'resolved' AND resolved_at IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS lims_safety_legacy_scan_candidates (
      workspace_id INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS lims_safety_legacy_scan_state (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
      last_workspace_id INTEGER NOT NULL DEFAULT 0 CHECK(last_workspace_id >= 0),
      unresolved_reason TEXT,
      unresolved_evidence_json TEXT,
      unresolved_detected_at INTEGER,
      completed_at INTEGER CHECK(
        (status = 'pending' AND completed_at IS NULL) OR
        (status = 'completed' AND completed_at IS NOT NULL)
      )
    );
  `);
  safeAddColumn(
    db,
    'lims_safety_legacy_scan_state',
    'last_workspace_id',
    'INTEGER NOT NULL DEFAULT 0 CHECK(last_workspace_id >= 0)'
  );
  safeAddColumn(db, 'lims_safety_legacy_scan_state', 'unresolved_reason', 'TEXT');
  safeAddColumn(db, 'lims_safety_legacy_scan_state', 'unresolved_evidence_json', 'TEXT');
  safeAddColumn(db, 'lims_safety_legacy_scan_state', 'unresolved_detected_at', 'INTEGER');
  db.exec(`
    INSERT OR IGNORE INTO lims_safety_legacy_scan_state (
      id, status, last_workspace_id, unresolved_reason,
      unresolved_evidence_json, unresolved_detected_at, completed_at
    ) VALUES (1, 'pending', 0, NULL, NULL, NULL, NULL)
  `);
}

function createLimsSafetyWriteGuards(db: Database.Database): void {
  for (const table of LIMS_SAFETY_GUARDED_TABLES) {
    if (!tableExists(db, table)) continue;
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const trigger = `guard_lims_quarantine_${table}_${operation.toLowerCase()}`;
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
      db.exec(`
        CREATE TRIGGER ${trigger}
        BEFORE ${operation} ON ${table}
        WHEN EXISTS (
          SELECT 1 FROM lims_safety_quarantine
          WHERE id = 1 AND status = 'quarantined'
        )
        OR EXISTS (SELECT 1 FROM lims_safety_legacy_scan_candidates)
        OR EXISTS (
          SELECT 1 FROM lims_safety_legacy_scan_state
          WHERE id = 1 AND status = 'pending'
        )
        BEGIN
          SELECT RAISE(ABORT, 'LIMS_SAFETY_QUARANTINED');
        END
      `);
    }
  }
}

function dropLimsSafetyWriteGuards(db: Database.Database): void {
  for (const table of LIMS_SAFETY_GUARDED_TABLES) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const trigger = `guard_lims_quarantine_${table}_${operation.toLowerCase()}`;
      db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    }
  }
}

function migrateAgentSessionStopStates(db: Database.Database): void {
  if (!tableExists(db, 'agent_sessions')) return;
  db.exec(`
    UPDATE agent_sessions
    SET status = CASE WHEN completed_at IS NULL THEN 'stopping' ELSE 'stop_unconfirmed' END
    WHERE status = 'stop_requested'
  `);
}

function createAgentSessionTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      authority_profile_id TEXT NOT NULL,
      authority_class TEXT NOT NULL,
      release_mode TEXT NOT NULL,
      permission_mode_label TEXT,
      status TEXT NOT NULL,
      cwd TEXT NOT NULL,
      output_root TEXT,
      provider_conversation_id TEXT,
      provider_versions_json TEXT NOT NULL,
      authority_json TEXT NOT NULL,
      terminal_reason TEXT,
      telemetry_had_workspace_context INTEGER NOT NULL DEFAULT 0
        CHECK(telemetry_had_workspace_context IN (0, 1)),
      telemetry_continuation INTEGER NOT NULL DEFAULT 0
        CHECK(telemetry_continuation IN (0, 1)),
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);

  safeAddColumn(db, 'agent_sessions', 'provider_conversation_id', 'TEXT');
  safeAddColumn(
    db,
    'agent_sessions',
    'telemetry_had_workspace_context',
    'INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_had_workspace_context IN (0, 1))'
  );
  safeAddColumn(
    db,
    'agent_sessions',
    'telemetry_continuation',
    'INTEGER NOT NULL DEFAULT 0 CHECK(telemetry_continuation IN (0, 1))'
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_trace_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      provider TEXT NOT NULL,
      event_type TEXT NOT NULL,
      render_snapshot_json TEXT NOT NULL,
      terminal TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(session_id, sequence)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_output_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      relative_path TEXT,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      attribution TEXT NOT NULL,
      checksum TEXT,
      provenance_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  createAgentProviderSessionControlTables(db);
}

function createAgentProviderSessionControlTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_provider_session_bindings (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_session_id TEXT NOT NULL,
      account_fingerprint TEXT NOT NULL,
      source_snapshot_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_lineage (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      parent_conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      relation TEXT NOT NULL CHECK(relation IN ('fork')),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_capability_invocations (
      turn_id TEXT PRIMARY KEY REFERENCES chat_turns(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      source TEXT,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind = 'text'),
      PRIMARY KEY (message_id, attachment_id)
    );

    CREATE TABLE IF NOT EXISTS agent_structured_outputs (
      turn_id TEXT PRIMARY KEY REFERENCES chat_turns(id) ON DELETE CASCADE,
      schema_json TEXT NOT NULL,
      raw_result TEXT NOT NULL,
      validation_status TEXT NOT NULL CHECK(validation_status IN ('valid', 'invalid')),
      parsed_json TEXT,
      validation_error TEXT,
      artifact_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_provider_session_bindings_provider
      ON agent_provider_session_bindings(provider);
    CREATE INDEX IF NOT EXISTS idx_conversation_lineage_parent
      ON conversation_lineage(parent_conversation_id);
    CREATE INDEX IF NOT EXISTS idx_agent_capability_invocations_conversation
      ON agent_capability_invocations(conversation_id, applied_at);
    CREATE INDEX IF NOT EXISTS idx_message_attachments_message
      ON message_attachments(message_id, position);
  `);
}

function createAgentSessionIndexes(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation ON agent_sessions(conversation_id)`
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_trace_events_session ON agent_trace_events(session_id)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_agent_output_artifacts_session ON agent_output_artifacts(session_id)`
  );
}

function createMolecularCatalogTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS molecular_catalog_molecules (
      id TEXT PRIMARY KEY, identity_version INTEGER NOT NULL, kind TEXT NOT NULL,
      sequence TEXT NOT NULL, created_at INTEGER NOT NULL,
      CHECK(kind IN ('protein','rna','dna')), UNIQUE(identity_version, kind, sequence)
    );
    CREATE TABLE IF NOT EXISTS molecular_catalog_coordinates (
      id TEXT PRIMARY KEY, format TEXT NOT NULL, sha256 TEXT NOT NULL, byte_count INTEGER NOT NULL,
      bytes BLOB NOT NULL, inventory_counts_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      CHECK(format IN ('pdb','cif','bcif')), CHECK(byte_count > 0 AND length(bytes) = byte_count),
      UNIQUE(format, sha256)
    );
    CREATE TABLE IF NOT EXISTS molecular_catalog_observations (
      id TEXT PRIMARY KEY, coordinate_id TEXT NOT NULL REFERENCES molecular_catalog_coordinates(id),
      source_key TEXT NOT NULL UNIQUE, source_kind TEXT NOT NULL, label TEXT NOT NULL,
      origin_json TEXT NOT NULL, run_json TEXT, metrics_json TEXT NOT NULL, provenance_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, CHECK(source_kind IN ('import','prediction','legacy-unverified')),
      CHECK((source_kind = 'prediction' AND run_json IS NOT NULL) OR (source_kind != 'prediction' AND run_json IS NULL))
    );
    CREATE TABLE IF NOT EXISTS molecular_catalog_chains (
      id TEXT PRIMARY KEY, coordinate_id TEXT NOT NULL REFERENCES molecular_catalog_coordinates(id),
      normalizer_version INTEGER NOT NULL, chain_key TEXT NOT NULL, inventory_json TEXT NOT NULL,
      UNIQUE(coordinate_id, normalizer_version, chain_key)
    );
    CREATE TABLE IF NOT EXISTS molecular_catalog_prediction_requests (
      observation_id TEXT PRIMARY KEY REFERENCES molecular_catalog_observations(id),
      client_sha256 TEXT NOT NULL, provider_sha256 TEXT NOT NULL,
      model TEXT NOT NULL, model_version TEXT NOT NULL, receipt_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK(length(client_sha256) = 64 AND length(provider_sha256) = 64)
    );
    CREATE TABLE IF NOT EXISTS molecular_catalog_mappings (
      observation_id TEXT NOT NULL REFERENCES molecular_catalog_observations(id),
      molecule_id TEXT NOT NULL REFERENCES molecular_catalog_molecules(id),
      chain_id TEXT NOT NULL REFERENCES molecular_catalog_chains(id), algorithm_version INTEGER NOT NULL,
      relationship TEXT NOT NULL, status TEXT NOT NULL, mapping_json TEXT NOT NULL,
      PRIMARY KEY(observation_id, molecule_id, chain_id, algorithm_version),
      CHECK(relationship IN ('exact','partial','homolog','unresolved')), CHECK(status IN ('mapped','unavailable'))
    );
    CREATE INDEX IF NOT EXISTS idx_molecular_catalog_observations_coordinate ON molecular_catalog_observations(coordinate_id);
    CREATE INDEX IF NOT EXISTS idx_molecular_catalog_chains_coordinate ON molecular_catalog_chains(coordinate_id, normalizer_version);
    CREATE INDEX IF NOT EXISTS idx_molecular_catalog_mappings_chain ON molecular_catalog_mappings(chain_id);
    CREATE INDEX IF NOT EXISTS idx_molecular_catalog_request_client ON molecular_catalog_prediction_requests(client_sha256);
    CREATE INDEX IF NOT EXISTS idx_molecular_catalog_request_provider ON molecular_catalog_prediction_requests(provider_sha256);
  `);
}

function createComputeJobTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS compute_jobs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      tool_id TEXT NOT NULL,
      label TEXT,
      settings_hash TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      provider_job_ref TEXT,
      state TEXT NOT NULL,
      provider_state TEXT NOT NULL DEFAULT '',
      cost_estimate REAL,
      cost_estimate_unit TEXT,
      cost_actual REAL,
      cost_actual_unit TEXT,
      terms_snapshot_json TEXT,
      workspace_root TEXT,
      imported_paths_json TEXT,
      last_error TEXT,
      poll_count INTEGER NOT NULL DEFAULT 0,
      next_poll_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  safeAddColumn(db, 'compute_jobs', 'result_target_json', 'TEXT');
  safeAddColumn(db, 'compute_jobs', 'source_path', 'TEXT');
  safeAddColumn(db, 'compute_jobs', 'source_name', 'TEXT');
  safeAddColumn(db, 'compute_jobs', 'import_details_json', 'TEXT');
  safeAddColumn(db, 'compute_jobs', 'request_json', 'TEXT');
  safeAddColumn(db, 'compute_jobs', 'request_hash', 'TEXT');
  safeAddColumn(db, 'compute_jobs', 'input_files_json', 'TEXT');
  safeAddColumn(db, 'compute_jobs', 'idempotency_key', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS idx_compute_jobs_request ON compute_jobs(request_hash)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_compute_jobs_idempotency
    ON compute_jobs(provider, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_compute_jobs_state ON compute_jobs(state)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_compute_jobs_provider_ref ON compute_jobs(provider, provider_job_ref)`
  );
}

function createChatTurnTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      route_kind TEXT NOT NULL,
      host_id TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      transport TEXT,
      authority_profile_id TEXT,
      permission_mode TEXT,
      route_snapshot_json TEXT NOT NULL,
      status TEXT NOT NULL,
      terminal_reason TEXT,
      error TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )
  `);

  safeAddColumn(db, 'messages', 'turn_id', 'TEXT REFERENCES chat_turns(id) ON DELETE SET NULL');
  safeAddColumn(
    db,
    'agent_sessions',
    'turn_id',
    'TEXT REFERENCES chat_turns(id) ON DELETE SET NULL'
  );
}

function createChatTurnIndexes(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_chat_turns_conversation_started ON chat_turns(conversation_id, started_at)`
  );
  if (tableExists(db, 'messages')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_turn ON messages(turn_id)`);
  }
  if (tableExists(db, 'agent_sessions')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_sessions_turn ON agent_sessions(turn_id)`);
  }
}

function createWorkspaceSyncTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sync_device (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      device_id TEXT NOT NULL UNIQUE CHECK(length(device_id) > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sync_bindings (
      workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      workspace_uuid TEXT NOT NULL UNIQUE CHECK(length(workspace_uuid) > 0),
      owner_account_id TEXT NOT NULL CHECK(length(owner_account_id) > 0),
      owner_org_id TEXT CHECK(owner_org_id IS NULL OR length(owner_org_id) > 0),
      remote_workspace_id TEXT CHECK(remote_workspace_id IS NULL OR length(remote_workspace_id) > 0),
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
      remote_latest_version_id TEXT,
      remote_latest_version_number INTEGER CHECK(remote_latest_version_number IS NULL OR remote_latest_version_number > 0),
      remote_latest_content_sha256 TEXT CHECK(remote_latest_content_sha256 IS NULL OR length(remote_latest_content_sha256) = 64),
      last_acked_local_head_sha TEXT,
      last_uploaded_at INTEGER,
      last_downloaded_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      remote_owner_account_id TEXT,
      access_role TEXT CHECK(access_role IS NULL OR access_role IN ('viewer', 'editor', 'manager', 'owner')),
      access_source TEXT CHECK(access_source IS NULL OR access_source IN ('owner', 'org_admin', 'direct', 'org_audience')),
      shared_with_others INTEGER NOT NULL DEFAULT 0 CHECK(shared_with_others IN (0, 1)),
      detached_reason TEXT CHECK(detached_reason IS NULL OR detached_reason IN ('access_removed'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sync_queue (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN ('claim', 'upload', 'refresh', 'delete_remote', 'share', 'restore')),
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'retry_wait', 'blocked', 'succeeded', 'failed', 'canceled')),
      idempotency_key TEXT UNIQUE,
      base_remote_version_id TEXT,
      local_head_sha TEXT,
      bundle_content_sha256 TEXT CHECK(bundle_content_sha256 IS NULL OR length(bundle_content_sha256) = 64),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at INTEGER,
      locked_at INTEGER,
      locked_by_device_id TEXT REFERENCES workspace_sync_device(device_id) ON DELETE SET NULL,
      error_code TEXT,
      error_message TEXT,
      accepted_operation_id TEXT,
      accepted_operation_started_at INTEGER CHECK(accepted_operation_started_at IS NULL OR accepted_operation_started_at >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  ensureWorkspaceSyncOperationIdentityColumns(db);
  createWorkspaceSyncUploadSnapshotsTable(db);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sync_versions (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      remote_version_id TEXT NOT NULL UNIQUE CHECK(length(remote_version_id) > 0),
      version_number INTEGER NOT NULL CHECK(version_number > 0),
      content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
      local_head_sha TEXT,
      file_count INTEGER NOT NULL CHECK(file_count >= 0),
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      status TEXT NOT NULL CHECK(status IN ('ready', 'failed', 'deleted')),
      is_latest INTEGER NOT NULL DEFAULT 0 CHECK(is_latest IN (0, 1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      UNIQUE(workspace_id, version_number)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sync_restore_locks (
      workspace_id INTEGER PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      lock_id TEXT NOT NULL UNIQUE CHECK(length(lock_id) > 0),
      source_remote_version_id TEXT,
      remote_workspace_id TEXT,
      owner_account_id TEXT,
      owner_org_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('restoring', 'completed', 'failed', 'canceled')),
      started_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK(expires_at > started_at),
      completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= started_at),
      error_message TEXT
    )
  `);
}

function createOrgRegistryScopedSyncTables(db: Database.Database): void {
  createOrgRegistrySyncTables(db);
  safeAddColumn(db, 'org_registry_sync_state', 'access_generation', 'TEXT');
  safeAddColumn(db, 'org_registry_snapshot_transfer', 'access_generation', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS org_registry_mutation_receipts (
    mutation_id TEXT PRIMARY KEY NOT NULL,
    org_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
    event_seq INTEGER NOT NULL CHECK(event_seq > 0),
    status TEXT NOT NULL CHECK(status IN ('applied', 'replayed')),
    response_json TEXT NOT NULL,
    acknowledged_at INTEGER NOT NULL,
    FOREIGN KEY(org_id,account_id)
      REFERENCES org_registry_sync_state(org_id,account_id) ON DELETE CASCADE
  );`);
}

function migrateToV45(db: Database.Database): void {
  const tables = [
    'org_registry_local_records',
    'org_registry_record_publications',
    'org_registry_record_resolutions',
    'org_registry_record_publication_supersessions',
  ] as const;
  db.transaction(() => {
    for (const table of tables)
      db.exec(`CREATE TEMP TABLE ${table}_v43_copy AS SELECT * FROM ${table}`);
    for (const table of [...tables].reverse()) db.exec(`DROP TABLE ${table}`);
    createOrgRegistryRecordSyncTables(db, true);
    for (const table of tables) {
      const prior = db.prepare(`PRAGMA temp.table_info(${table}_v43_copy)`).all() as Array<{
        name: string;
      }>;
      const current = db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{
        name: string;
      }>;
      const added = table === 'org_registry_record_resolutions' ? ['publication_request_json'] : [];
      const priorColumns = prior.map((column) => column.name);
      const currentColumns = current.map((column) => column.name);
      const legacyColumns = currentColumns.filter((name) => !added.includes(name));
      if (
        JSON.stringify(priorColumns) !== JSON.stringify(legacyColumns) &&
        JSON.stringify(priorColumns) !== JSON.stringify(currentColumns)
      )
        throw new Error(`Registry authority migration refuses unexpected columns in ${table}.`);
      const columns = prior.map((column) => `"${column.name.replace(/"/g, '""')}"`).join(',');
      db.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table}_v43_copy`);
      const before = db.prepare(`SELECT count(*) AS count FROM ${table}_v43_copy`).get() as {
        count: number;
      };
      const after = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
      if (before.count !== after.count)
        throw new Error(`Registry authority migration did not retain every ${table} row.`);
    }
    for (const table of tables) {
      if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length)
        throw new Error(`Registry authority migration broke a ${table} reference.`);
      db.exec(`DROP TABLE temp.${table}_v43_copy`);
    }
  })();
}

function createOrgRegistryRecordSyncTables(
  db: Database.Database,
  specializedAuthorities = false
): void {
  const authorities = specializedAuthorities
    ? "'entity_artifact','database','primer_artifact','sequence_package'"
    : "'entity_artifact','database'";
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_registry_local_records (
      org_id TEXT NOT NULL, account_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      client_id TEXT NOT NULL, workspace_id INTEGER NOT NULL, workspace_uuid TEXT NOT NULL,
      home_workspace_id TEXT NOT NULL, kind TEXT NOT NULL, local_schema_revision_id TEXT NOT NULL,
      authority_kind TEXT NOT NULL CHECK(authority_kind IN (${authorities})),
      schema_id TEXT NOT NULL, schema_revision_id TEXT NOT NULL,
      claim_mutation_id TEXT NOT NULL UNIQUE, claim_source_revision TEXT NOT NULL,
      claim_local_event_seq INTEGER NOT NULL CHECK(claim_local_event_seq>0),
      acknowledged_mutation_id TEXT, acknowledged_local_event_seq INTEGER, reviewed_resolution_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(org_id,account_id,entity_id)
    );
    CREATE TABLE IF NOT EXISTS org_registry_record_publications (
      mutation_id TEXT PRIMARY KEY NOT NULL, lifecycle_mutation_id TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL CHECK(phase IN ('first','lifecycle')), operation_id TEXT NOT NULL,
      org_id TEXT NOT NULL, account_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      local_event_seq INTEGER NOT NULL CHECK(local_event_seq>0),
      publication_authority TEXT NOT NULL CHECK(publication_authority IN (${authorities})),
      publication_sha256 TEXT NOT NULL CHECK(length(publication_sha256)=64), payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('publication_pending','ready','queued','acknowledged','failed')),
      error_message TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(org_id,account_id,entity_id,operation_id),
      UNIQUE(org_id,account_id,entity_id,local_event_seq),
      FOREIGN KEY(org_id,account_id,entity_id) REFERENCES org_registry_local_records(org_id,account_id,entity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_org_registry_record_publications_ready
      ON org_registry_record_publications(org_id,account_id,entity_id,status,local_event_seq);
    CREATE TABLE IF NOT EXISTS org_registry_record_resolutions (
      resolution_id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL, account_id TEXT NOT NULL, entity_id TEXT NOT NULL,
      choice TEXT NOT NULL CHECK(choice IN ('use_remote','keep_saved')),
      publication_operation_id TEXT NOT NULL UNIQUE,
      review_json TEXT NOT NULL, desired_json TEXT NOT NULL,
      ${specializedAuthorities ? 'publication_request_json TEXT,' : ''}
      status TEXT NOT NULL CHECK(status IN ('prepared','publication_pending','settled')),
      publication_authority TEXT CHECK(publication_authority IN (${authorities})),
      publication_sha256 TEXT CHECK(publication_sha256 IS NULL OR length(publication_sha256)=64),
      published_entity_json TEXT, published_local_event_seq INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, settled_at INTEGER,
      FOREIGN KEY(org_id,account_id,entity_id) REFERENCES org_registry_local_records(org_id,account_id,entity_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_registry_record_resolution_pending
      ON org_registry_record_resolutions(org_id,account_id,entity_id) WHERE status<>'settled';
    CREATE TABLE IF NOT EXISTS org_registry_record_publication_supersessions (
      mutation_id TEXT PRIMARY KEY NOT NULL REFERENCES org_registry_record_publications(mutation_id),
      resolution_id TEXT NOT NULL REFERENCES org_registry_record_resolutions(resolution_id),
      superseded_at INTEGER NOT NULL
    );
  `);
  if (!tableHasColumn(db, 'org_registry_local_records', 'reviewed_resolution_id'))
    db.exec('ALTER TABLE org_registry_local_records ADD COLUMN reviewed_resolution_id TEXT');
}

function createOrgRegistrySyncTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_registry_sync_state (
      org_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      client_id TEXT NOT NULL CHECK(length(client_id) BETWEEN 1 AND 200),
      cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK(status IN ('idle', 'syncing', 'ready', 'error', 'access_revoked')),
      last_pull_at INTEGER,
      last_push_at INTEGER,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS org_registry_cache (
      org_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      record_type TEXT NOT NULL
        CHECK(record_type IN (
          'id_scheme', 'schema', 'schema_revision', 'entity',
          'entity_revision', 'relationship', 'placement'
        )),
      record_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(length(payload_json) > 0),
      event_seq INTEGER NOT NULL DEFAULT 0 CHECK(event_seq >= 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, account_id, record_type, record_id),
      FOREIGN KEY (org_id, account_id)
        REFERENCES org_registry_sync_state(org_id, account_id) ON DELETE CASCADE
    );

    -- Derived transfer state; no accepted Registry row is replaced until all
    -- records and the final membership acknowledgement have been received.
    CREATE TABLE IF NOT EXISTS org_registry_snapshot_transfer (
      org_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      snapshot_id TEXT,
      cursor INTEGER CHECK(cursor IS NULL OR cursor >= 0),
      total_records INTEGER CHECK(total_records IS NULL OR total_records >= 0),
      next_after INTEGER NOT NULL DEFAULT 0 CHECK(next_after >= 0),
      expires_at INTEGER,
      download_complete INTEGER NOT NULL DEFAULT 0 CHECK(download_complete IN (0,1)),
      bootstrap_complete INTEGER NOT NULL DEFAULT 0 CHECK(bootstrap_complete IN (0,1)),
      PRIMARY KEY(org_id,account_id),
      FOREIGN KEY(org_id,account_id)
        REFERENCES org_registry_sync_state(org_id,account_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS org_registry_snapshot_record (
      org_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal > 0),
      record_type TEXT NOT NULL CHECK(record_type IN (
        'id_scheme','schema','schema_revision','entity','entity_revision','relationship','placement'
      )),
      record_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK(length(payload_json)>0),
      PRIMARY KEY(org_id,account_id,ordinal),
      UNIQUE(org_id,account_id,record_type,record_id),
      FOREIGN KEY(org_id,account_id)
        REFERENCES org_registry_snapshot_transfer(org_id,account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS org_registry_outbox (
      mutation_id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      client_id TEXT NOT NULL CHECK(length(client_id) BETWEEN 1 AND 200),
      operation TEXT NOT NULL CHECK(operation IN (
        'schema.create', 'schema.refine', 'entity.create', 'entity.update',
        'entity.archive', 'entity.restore', 'relationships.replace',
        'placement.add', 'placement.remove'
      )),
      payload_json TEXT NOT NULL CHECK(length(payload_json) > 0),
      request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'sending', 'retry_wait', 'conflict', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      next_attempt_at INTEGER,
      last_error_code TEXT,
      last_error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (org_id, account_id)
        REFERENCES org_registry_sync_state(org_id, account_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS org_registry_conflicts (
      id TEXT PRIMARY KEY NOT NULL,
      mutation_id TEXT NOT NULL UNIQUE
        REFERENCES org_registry_outbox(mutation_id) ON DELETE CASCADE,
      org_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      local_payload_json TEXT NOT NULL,
      error_code TEXT NOT NULL,
      error_message TEXT NOT NULL,
      details_json TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'resolved', 'discarded')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_org_registry_cache_entities
      ON org_registry_cache(org_id, account_id, record_type, record_id);
    CREATE INDEX IF NOT EXISTS idx_org_registry_outbox_ready
      ON org_registry_outbox(org_id, account_id, status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_org_registry_conflicts_open
      ON org_registry_conflicts(org_id, account_id, status, created_at);
  `);
}

function ensureWorkspaceSyncOperationIdentityColumns(db: Database.Database): void {
  if (!tableExists(db, 'workspace_sync_queue')) return;
  for (const [column, definition] of [
    ['accepted_operation_id', 'TEXT'],
    [
      'accepted_operation_started_at',
      'INTEGER CHECK(accepted_operation_started_at IS NULL OR accepted_operation_started_at >= 0)',
    ],
  ]) {
    if (
      !db
        .prepare("SELECT 1 FROM pragma_table_info('workspace_sync_queue') WHERE name = ?")
        .get(column)
    ) {
      db.exec(`ALTER TABLE workspace_sync_queue ADD COLUMN ${column} ${definition}`);
    }
  }
}

function createWorkspaceSyncUploadSnapshotsTable(db: Database.Database): void {
  if (!tableExists(db, 'workspace_sync_queue')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sync_upload_snapshots (
      job_id TEXT PRIMARY KEY REFERENCES workspace_sync_queue(id) ON DELETE CASCADE,
      content_sha256 TEXT NOT NULL
        CHECK(length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
      bundle_json TEXT NOT NULL CHECK(length(bundle_json) > 0),
      created_at INTEGER NOT NULL
    )
  `);
}

function ensureWorkspaceSyncSharedProjectColumns(db: Database.Database): void {
  if (tableExists(db, 'workspace_sync_bindings')) {
    safeAddColumn(db, 'workspace_sync_bindings', 'remote_owner_account_id', 'TEXT');
    safeAddColumn(
      db,
      'workspace_sync_bindings',
      'access_role',
      "TEXT CHECK(access_role IS NULL OR access_role IN ('viewer', 'editor', 'manager', 'owner'))"
    );
    safeAddColumn(
      db,
      'workspace_sync_bindings',
      'access_source',
      "TEXT CHECK(access_source IS NULL OR access_source IN ('owner', 'org_admin', 'direct', 'org_audience'))"
    );
    safeAddColumn(
      db,
      'workspace_sync_bindings',
      'shared_with_others',
      'INTEGER NOT NULL DEFAULT 0 CHECK(shared_with_others IN (0, 1))'
    );
    safeAddColumn(
      db,
      'workspace_sync_bindings',
      'detached_reason',
      "TEXT CHECK(detached_reason IS NULL OR detached_reason IN ('access_removed'))"
    );
  }
  if (tableExists(db, 'workspace_sync_versions')) {
    safeAddColumn(db, 'workspace_sync_versions', 'created_by_account_id', 'TEXT');
    safeAddColumn(db, 'workspace_sync_versions', 'created_by_display', 'TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_sync_merge_conflicts (
      id TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      workspace_uuid TEXT NOT NULL,
      base_remote_version_id TEXT,
      remote_version_id TEXT NOT NULL,
      remote_version_number INTEGER,
      remote_author TEXT,
      local_head_sha TEXT,
      status TEXT NOT NULL CHECK(status IN ('open', 'resolved', 'superseded')),
      conflicts_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      resolution_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_sync_merge_conflicts_open
      ON workspace_sync_merge_conflicts(workspace_id, status, created_at);
  `);
}

function ensureWorkspaceSyncRestoreIdentityColumns(db: Database.Database): void {
  if (!tableExists(db, 'workspace_sync_restore_locks')) return;
  safeAddColumn(db, 'workspace_sync_restore_locks', 'remote_workspace_id', 'TEXT');
  safeAddColumn(db, 'workspace_sync_restore_locks', 'owner_account_id', 'TEXT');
  safeAddColumn(db, 'workspace_sync_restore_locks', 'owner_org_id', 'TEXT');
}

function createWorkspaceSyncRestoreIdentityIndex(db: Database.Database): void {
  if (!tableExists(db, 'workspace_sync_restore_locks')) return;
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sync_restore_locks_active_identity
    ON workspace_sync_restore_locks(remote_workspace_id, owner_account_id, COALESCE(owner_org_id, ''))
    WHERE remote_workspace_id IS NOT NULL
      AND owner_account_id IS NOT NULL
      AND status IN ('restoring', 'failed');

    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sync_restore_locks_active_org_identity
    ON workspace_sync_restore_locks(remote_workspace_id, owner_org_id)
    WHERE remote_workspace_id IS NOT NULL
      AND owner_org_id IS NOT NULL
      AND status IN ('restoring', 'failed')
  `);
}

function createWorkspaceSyncIndexes(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workspace_sync_bindings_owner
     ON workspace_sync_bindings(owner_account_id, owner_org_id)`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sync_bindings_remote_workspace
     ON workspace_sync_bindings(remote_workspace_id)
     WHERE remote_workspace_id IS NOT NULL`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workspace_sync_queue_workspace_status
     ON workspace_sync_queue(workspace_id, status)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workspace_sync_queue_next_attempt
     ON workspace_sync_queue(status, next_attempt_at)
     WHERE status IN ('pending', 'retry_wait')`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workspace_sync_queue_locked_by_device
     ON workspace_sync_queue(locked_by_device_id)
     WHERE locked_by_device_id IS NOT NULL`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workspace_sync_versions_workspace_number
     ON workspace_sync_versions(workspace_id, version_number)`
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_sync_versions_latest
     ON workspace_sync_versions(workspace_id)
     WHERE is_latest = 1`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_workspace_sync_restore_locks_status
     ON workspace_sync_restore_locks(status, expires_at)`
  );
}

function migrateToV2(db: Database.Database): void {
  const hasDirectionCol =
    (
      db
        .prepare(`SELECT name FROM pragma_table_info('primers') WHERE name = 'direction'`)
        .all() as { name: string }[]
    ).length > 0;
  const hasPrimerPairsTable =
    (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='primer_pairs'`)
        .all() as { name: string }[]
    ).length > 0;
  const strandCol = db
    .prepare(`SELECT [notnull] FROM pragma_table_info('primer_bindings') WHERE name = 'strand'`)
    .all() as { notnull: number }[];
  const strandIsNotNull = strandCol[0]?.notnull === 1;
  const primerBindingsDdl = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='primer_bindings'`)
    .get() as { sql?: string } | undefined;
  const hasStrandCheck = /CHECK\s*\(\s*strand\s+IN\s*\(\s*1\s*,\s*-1\s*\)\s*\)/i.test(
    primerBindingsDdl?.sql ?? ''
  );
  const primerBindingsAtV2Shape = strandIsNotNull && hasStrandCheck;
  if (!hasDirectionCol && !hasPrimerPairsTable && primerBindingsAtV2Shape) {
    console.log('[migrateToV2] schema already at v2 — nothing to do');
    return;
  }

  db.pragma('foreign_keys = OFF');
  if (db.pragma('foreign_keys', { simple: true }) !== 0) {
    throw new Error(
      'migrateToV2 requires foreign_keys=OFF; the pragma did not take effect (open transaction?)'
    );
  }
  try {
    db.exec('BEGIN');

    if (hasDirectionCol) {
      const nullStrandRow = db
        .prepare(`SELECT COUNT(*) as c FROM primer_bindings WHERE strand IS NULL`)
        .get() as { c: number };
      if (nullStrandRow.c > 0) {
        console.log(
          `[migrateToV2] backfilling ${nullStrandRow.c} null-strand binding rows from primers.direction`
        );
        db.exec(`
          UPDATE primer_bindings
          SET strand = CASE
            WHEN trim(lower((SELECT direction FROM primers WHERE id = primer_bindings.primer_id)))
                 IN ('reverse', 'rev', '-1', '-') THEN -1
            ELSE 1
          END
          WHERE strand IS NULL
        `);
      }
    }

    if (hasDirectionCol) {
      db.exec(`
      CREATE TABLE primers_new (
        id TEXT PRIMARY KEY,
        catalog_number TEXT UNIQUE,
        name TEXT NOT NULL,
        sequence TEXT NOT NULL,
        length INTEGER NOT NULL,
        tm REAL,
        gc_percent REAL,
        origin TEXT,
        origin_details TEXT,
        status TEXT DEFAULT 'designed',
        vendor TEXT,
        order_date INTEGER,
        application TEXT,
        scale TEXT,
        purification TEXT,
        modifications TEXT,
        stock_location TEXT,
        concentration REAL,
        notes TEXT,
        workspace_id INTEGER REFERENCES workspaces(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
      db.exec(`
      INSERT INTO primers_new (
        id, catalog_number, name, sequence, length, tm, gc_percent,
        origin, origin_details, status, vendor, order_date, application,
        scale, purification, modifications, stock_location, concentration,
        notes, workspace_id, created_at, updated_at
      )
      SELECT
        id, catalog_number, name, sequence, length, tm, gc_percent,
        origin, origin_details, status, vendor, order_date, application,
        scale, purification, modifications, stock_location, concentration,
        notes, workspace_id, created_at, updated_at
      FROM primers
    `);
      db.exec('DROP TABLE primers');
      db.exec('ALTER TABLE primers_new RENAME TO primers');
    }

    db.exec('DROP TABLE IF EXISTS primer_pairs');

    if (!primerBindingsAtV2Shape) {
      db.exec(`
      CREATE TABLE primer_bindings_new (
        id TEXT PRIMARY KEY,
        primer_id TEXT NOT NULL REFERENCES primers(id) ON DELETE CASCADE,
        sequence_id INTEGER NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
        binding_start INTEGER NOT NULL,
        binding_end INTEGER NOT NULL,
        strand INTEGER NOT NULL DEFAULT 1 CHECK(strand IN (1, -1)),
        source TEXT NOT NULL DEFAULT 'manual',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(primer_id, sequence_id, binding_start)
      )
    `);
      db.exec(`
      INSERT INTO primer_bindings_new (
        id, primer_id, sequence_id, binding_start, binding_end,
        strand, source, created_at, updated_at
      )
      SELECT
        id, primer_id, sequence_id, binding_start, binding_end,
        CASE WHEN strand = -1 THEN -1 ELSE 1 END AS strand,
        source, created_at, updated_at
      FROM primer_bindings
    `);
      db.exec('DROP TABLE primer_bindings');
      db.exec('ALTER TABLE primer_bindings_new RENAME TO primer_bindings');
    }

    db.exec('CREATE INDEX IF NOT EXISTS idx_primers_workspace ON primers(workspace_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_primer_bindings_primer ON primer_bindings(primer_id)');
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_primer_bindings_sequence ON primer_bindings(sequence_id)'
    );

    db.exec('ANALYZE primers');
    db.exec('ANALYZE primer_bindings');

    const fkErrors = [
      ...(db.prepare(`PRAGMA foreign_key_check('primers')`).all() as unknown[]),
      ...(db.prepare(`PRAGMA foreign_key_check('primer_bindings')`).all() as unknown[]),
    ];
    if (fkErrors.length > 0) {
      throw new Error(`migrateToV2: foreign_key_check failed (${fkErrors.length} violations)`);
    }

    db.exec('COMMIT');

    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch (err) {
      console.warn('[migrateToV2] post-COMMIT wal_checkpoint failed:', err);
    }

    console.log('[Schema] migrateToV2 complete ');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateToV3(db: Database.Database): void {
  createCatalogTables(db);
  createCatalogIndexes(db);
  console.log('[Schema] migrateToV3 complete (workspace catalog)');
}

function migrateToV4(db: Database.Database): void {
  createCatalogTables(db);
  createCatalogIndexes(db);
  console.log('[Schema] migrateToV4 complete (workspace catalog provenance events)');
}

function migrateToV5(db: Database.Database): void {
  createCatalogTables(db);
  safeAddColumn(db, 'catalog_entity_files', 'status', "TEXT NOT NULL DEFAULT 'current'");
  safeAddColumn(db, 'catalog_entity_files', 'last_seen_at', 'INTEGER');
  safeAddColumn(db, 'catalog_entity_files', 'missing_since', 'INTEGER');
  db.exec("UPDATE catalog_entity_files SET status = 'current' WHERE status IS NULL OR status = ''");
  createCatalogIndexes(db);
  console.log('[Schema] migrateToV5 complete (catalog file lifecycle)');
}

function migrateToV6(db: Database.Database): void {
  createAgentSessionTables(db);
  createAgentSessionIndexes(db);
  console.log('[Schema] migrateToV6 complete (CLI agent session ledger)');
}

function migrateToV7(db: Database.Database): void {
  createChatTurnTables(db);
  createChatTurnIndexes(db);
  console.log('[Schema] migrateToV7 complete (chat turn attribution)');
}

function migrateToV8(db: Database.Database): void {
  db.exec('DROP INDEX IF EXISTS idx_features_sequence');
  db.exec('DROP INDEX IF EXISTS idx_features_type');
  db.exec('DROP TABLE IF EXISTS features');
  console.log('[Schema] migrateToV8 complete (dropped writer-less features table)');
}

function migrateToV9(db: Database.Database): void {
  createLimsTables(db);
  createLimsIndexes(db);
  console.log('[Schema] migrateToV9 complete (LIMS slice-1 tables)');
}

function migrateToV10(db: Database.Database): void {
  db.transaction(() => {
    try {
      db.exec(`ALTER TABLE lims_entity ADD COLUMN registry_id TEXT`);
    } catch {}
    db.exec(`
      CREATE TABLE IF NOT EXISTS lims_id_scheme (
        kind TEXT PRIMARY KEY,
        prefix TEXT NOT NULL,
        pad_width INTEGER NOT NULL DEFAULT 6,
        next_seq INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        updated_at INTEGER NOT NULL
      )
    `);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_lims_entity_registry_id ON lims_entity(registry_id) WHERE registry_id IS NOT NULL`
    );
  })();
  console.log('[Schema] migrateToV10 complete (LIMS registry IDs)');
}

function migrateToV11(db: Database.Database): void {
  db.transaction(() => {
    safeAddColumn(db, 'workspaces', 'repo_uuid', 'TEXT');
    safeAddColumn(db, 'workspaces', 'origin_path', 'TEXT');
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_repo_uuid ON workspaces(repo_uuid) WHERE repo_uuid IS NOT NULL`
    );

    if (tableExists(db, 'catalog_entity_files')) {
      safeAddColumn(db, 'catalog_entity_files', 'object_uuid', 'TEXT');
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_efiles_object_uuid ON catalog_entity_files(object_uuid) WHERE object_uuid IS NOT NULL`
      );
    }
  })();
  console.log('[Schema] migrateToV11 complete (managed git-workspace identity columns)');
}

function migrateToV12(db: Database.Database): void {
  safeAddColumn(db, 'workspaces', 'archived_at', 'INTEGER');
  console.log('[Schema] migrateToV12 complete (workspace archive)');
}

function migrateToV13(db: Database.Database): void {
  safeAddColumn(db, 'workspaces', 'trashed_at', 'INTEGER');
  console.log('[Schema] migrateToV13 complete (workspace trash)');
}

function migrateToV14(db: Database.Database): void {
  ensureLimsAuditEventEnvelope(db);
  console.log('[Schema] migrateToV14 complete (LIMS event envelope)');
}

function migrateToV15(db: Database.Database): void {
  db.transaction(() => {
    createWorkspaceSyncTables(db);
    createWorkspaceSyncIndexes(db);
  })();
  console.log('[Schema] migrateToV15 complete (desktop auto-sync local substrate)');
}

function migrateToV16(db: Database.Database): void {
  db.transaction(() => {
    createWorkspaceSyncTables(db);
    createWorkspaceSyncIndexes(db);
    safeAddColumn(db, 'workspace_sync_versions', 'excluded_summary_json', 'TEXT');
    db.exec('DROP TABLE IF EXISTS genome_sessions');
  })();
  console.log('[Schema] migrateToV16 complete (desktop sync exclusion summaries)');
}

function migrateToV17(db: Database.Database): void {
  ensureOneCurrentBindingPerEntity(db);
  console.log('[Schema] migrateToV17 complete (one-current-binding invariant + index)');
}

function ensureOneCurrentBindingPerEntity(db: Database.Database): void {
  if (!tableExists(db, 'catalog_entity_files')) return;

  db.transaction(() => {
    const currents = db
      .prepare(`SELECT id, entity_id, path FROM catalog_entity_files WHERE status = 'current'`)
      .all() as { id: string; entity_id: string; path: string }[];

    const byEntity = new Map<string, { id: string; entity_id: string; path: string }[]>();
    for (const row of currents) {
      const list = byEntity.get(row.entity_id) ?? [];
      list.push(row);
      byEntity.set(row.entity_id, list);
    }

    const demote = db.prepare(
      `UPDATE catalog_entity_files SET status = 'historical', updated_at = ? WHERE id = ?`
    );
    const hasEventsTable = tableExists(db, 'catalog_entity_events');
    const recordEvent = hasEventsTable
      ? db.prepare(
          `INSERT INTO catalog_entity_events (id, entity_id, event_type, actor, summary, payload, created_at)
           VALUES (?, ?, 'file_historical', 'migration', ?, ?, ?)`
        )
      : null;
    const now = Date.now();
    let demoted = 0;

    for (const [entityId, files] of byEntity) {
      if (files.length <= 1) continue;
      const canonical = pickCanonicalBinding(files);
      for (const file of files) {
        if (file.id === canonical.id) continue;
        demote.run(now, file.id);
        recordEvent?.run(
          `evt_v17_${file.id}`,
          entityId,
          'Duplicate current binding demoted by v17 migration',
          JSON.stringify({
            path: file.path,
            reason: 'v17-one-current-binding-migration',
          }),
          now
        );
        demoted++;
      }
    }

    if (demoted > 0) {
      console.log(`[Schema] migrateToV17 demoted ${demoted} duplicate current binding(s)`);
    }

    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_entity_files_one_current
       ON catalog_entity_files(entity_id) WHERE status = 'current'`
    );
  })();
}

function migrateToV18(db: Database.Database): void {
  if (!tableExists(db, 'catalog_entities') || !tableExists(db, 'workspaces')) return;
  const hasPages = tableExists(db, 'pages');

  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');

    const notebooks = db
      .prepare(
        `SELECT ce.id AS old_id, ce.workspace_id AS ws_id, w.repo_uuid AS repo_uuid
         FROM catalog_entities ce
         LEFT JOIN workspaces w ON w.id = ce.workspace_id
         WHERE ce.type = 'notebook'`
      )
      .all() as {
      old_id: string;
      ws_id: number | null;
      repo_uuid: string | null;
    }[];

    const idRelinkers = NOTEBOOK_PROJECTION_ID_COLUMNS.filter((c) => tableExists(db, c.table)).map(
      (c) => db.prepare(`UPDATE ${c.table} SET ${c.column} = ? WHERE ${c.column} = ?`)
    );
    const locatorRelinkers = NOTEBOOK_PROJECTION_LOCATOR_COLUMNS.filter((c) =>
      tableExists(db, c.table)
    ).map((c) => ({
      stmt: db.prepare(`UPDATE ${c.table} SET ${c.column} = ? WHERE ${c.column} = ?`),
      prefix: c.prefix,
    }));

    const entityTargetExists = db.prepare(`SELECT 1 FROM catalog_entities WHERE id = ?`);
    const pageTargetExists = hasPages ? db.prepare(`SELECT 1 FROM pages WHERE id = ?`) : null;
    const locatorTargetExists = db.prepare(`SELECT 1 FROM catalog_entities WHERE locator = ?`);
    const rekeyEntity = db.prepare(`UPDATE catalog_entities SET id = ?, locator = ? WHERE id = ?`);

    let rekeyed = 0;
    let skippedCollision = 0;
    for (const nb of notebooks) {
      const oldId = nb.old_id;
      if (oldId.includes(WORKSPACE_SCOPE_SEP)) continue;
      const scope = workspaceScopeKey(nb.repo_uuid, nb.ws_id);
      if (scope == null) continue;
      const newId = `${scope}${WORKSPACE_SCOPE_SEP}${oldId}`;
      if (newId === oldId) continue;
      if (
        entityTargetExists.get(newId) ||
        pageTargetExists?.get(newId) ||
        locatorTargetExists.get(`${PAGE_LOCATOR_PREFIX}${newId}`)
      ) {
        skippedCollision++;
        continue;
      }

      rekeyEntity.run(newId, `${PAGE_LOCATOR_PREFIX}${newId}`, oldId);
      for (const relink of idRelinkers) relink.run(newId, oldId);
      for (const { stmt, prefix } of locatorRelinkers) {
        stmt.run(`${prefix}${newId}`, `${prefix}${oldId}`);
      }
      rekeyed++;
    }

    if (rekeyed > 0 || skippedCollision > 0) {
      console.log(
        `[Schema] migrateToV18 re-keyed ${rekeyed} notebook entity id(s) to workspace scope` +
          (skippedCollision > 0 ? ` (${skippedCollision} skipped — target id already present)` : '')
      );
    }
  })();
  console.log('[Schema] migrateToV18 complete (workspace-scoped notebook identity)');
}

function ensureLimsAuditEventEnvelope(db: Database.Database): void {
  db.transaction(() => {
    createLimsTables(db);
    safeAddColumn(db, 'lims_audit', 'schema_version', 'INTEGER');
    safeAddColumn(db, 'lims_audit', 'idempotency_key', 'TEXT');
    safeAddColumn(db, 'lims_audit', 'operation_id', 'TEXT');
    safeAddColumn(db, 'lims_audit', 'actor_client_id', 'TEXT');
    safeAddColumn(db, 'lims_audit', 'actor_user_id', 'TEXT');
    safeAddColumn(db, 'lims_audit', 'prev_hash', 'TEXT');
    safeAddColumn(db, 'lims_audit', 'hash', 'TEXT');
    db.exec(`UPDATE lims_audit SET schema_version = 0 WHERE schema_version IS NULL`);
    db.exec(
      `UPDATE lims_audit
       SET idempotency_key = 'lims:v0:' || id
       WHERE idempotency_key IS NULL OR idempotency_key = ''`
    );
    db.exec(
      `UPDATE lims_audit
       SET operation_id = COALESCE(batch_id, 'op:' || id)
       WHERE operation_id IS NULL OR operation_id = ''`
    );
    db.exec(
      `UPDATE lims_audit
       SET actor_client_id = 'local-client'
       WHERE actor_client_id IS NULL OR actor_client_id = ''`
    );
    db.exec(
      `UPDATE lims_audit
       SET actor_user_id = COALESCE(actor, 'local-user')
       WHERE actor_user_id IS NULL OR actor_user_id = ''`
    );
    createLimsIndexes(db);

    const next = db
      .prepare(`SELECT COALESCE(MAX(event_seq), 0) + 1 as next FROM lims_audit`)
      .get() as { next: number };
    db.prepare(
      `INSERT INTO lims_event_sequence (id, next_event_seq)
       VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET next_event_seq = excluded.next_event_seq
       WHERE lims_event_sequence.next_event_seq < excluded.next_event_seq`
    ).run(next.next);
  })();
}

function migratePrimerSchema(db: Database.Database): void {
  const oldBindings = db
    .prepare(`SELECT name FROM pragma_table_info('primer_bindings') WHERE name = 'computed_at'`)
    .all() as { name: string }[];
  if (oldBindings.length > 0) {
    console.log('[Schema] Detected old primer schema (computed_at) — migrating');
    db.exec('DROP TABLE IF EXISTS primer_bindings');
    db.exec('DROP TABLE IF EXISTS primer_pairs');
    db.exec('DROP TABLE IF EXISTS primers');
  }

  const oldPrimers = db
    .prepare(`SELECT name FROM pragma_table_info('primers') WHERE name = 'target_sequence_id'`)
    .all() as { name: string }[];
  if (oldPrimers.length > 0) {
    console.log('[Schema] Detected old primers schema (target_sequence_id) — migrating');
    db.exec('DROP TABLE IF EXISTS primer_bindings');
    db.exec('DROP TABLE IF EXISTS primer_pairs');
    db.exec('DROP TABLE IF EXISTS primers');
  }
}

function createWorkspaceSyncRendererDeliveries(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_sync_renderer_deliveries (
    id TEXT PRIMARY KEY NOT NULL,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    workspace_uuid TEXT,
    workspace_root TEXT,
    owner_account_id TEXT,
    remote_workspace_id TEXT,
    remote_version_id TEXT,
    local_head_sha TEXT,
    payload_version INTEGER NOT NULL,
    payload_json TEXT,
    state TEXT NOT NULL CHECK(state IN ('pending', 'needs_attention', 'succeeded')),
    last_error_code TEXT,
    last_error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_sync_renderer_delivery_pending
    ON workspace_sync_renderer_deliveries(workspace_id, state, created_at, id);`);
}

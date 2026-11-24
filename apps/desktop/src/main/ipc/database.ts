import { settleNativeChatMetrics } from '../agent-session/chat-completion-telemetry';
import { withCatalogFileSource } from '../catalog-file-source-retention';
import {
  listSavedEntityRowVersions,
  recoverSavedEntityRowVersion,
  savedRowRecoveryGenerations,
} from '../saved-entity-row-recovery';
import { registerAdmittedProjectRoot } from '../admitted-project-roots';
import { toUserMessage } from '@waypoint/user-messages';
import { createUserDialogs } from '../user-dialogs';
import {
  getFastaKindAuthorityInMain,
  getFastaKindReadAuthorityInDb,
  classifyFastaInMain,
} from '../fasta-kind-authority';
import {
  createEntityReferenceInDb,
  updateEntityReferenceInDb,
  deleteEntityReferenceInDb,
  setEntityReferenceWorkspaceRootPathIfMissingInDb,
  recordEntityReferenceRevisionInDb,
} from '../entity-reference-commands';
import {
  linkCatalogEntitiesInDb,
  recordCatalogEventInDb,
  updateCatalogEntityPresentationInDb,
  archiveSupersededNotebookCatalogInDb,
} from '../catalog-association-commands';
import {
  writeCatalogWorkspacePlacementInDb,
  removeCatalogWorkspacePlacementInDb,
} from '../catalog-placement-commands';
import { restoreCatalogProviderBindingInDb } from '../catalog-provider-command';
import {
  assertCanonicalSequenceSourceInDb,
  ensureSequenceIndexInDb,
} from '../sequence-index-command';
import { handleGroup, mainIpc } from '../../shared/ipc-contract';
import { app, BrowserWindow, dialog } from 'electron';
import Database from 'better-sqlite3';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { globSync } from 'glob';
import { buildDatabaseErrorDialog } from '../native-module-error';
import { validateTerminalReferenceProposals } from '../../shared/chat-turn-ipc';
import type {
  ChatTurnIpcStatus,
  CommitChatTurnTerminalStateRequest,
  CommitChatTurnTerminalStateResult,
  CreateChatTurnWithUserMessageRequest,
} from '../../shared/chat-turn-ipc';
import type { AnalyticsConsentState } from '../../shared/analytics-types';
import type { PrimerLegacyProjectionInput } from '../../shared/primer-projection-ipc';
import type { SqliteIpcRow } from '../../shared/sqlite-ipc';
import { isAgentAttachmentManifest } from '../../shared/agent-attachments';
import { ownsAcceptedScientificEntity } from '../scientific-strain-authority';
import {
  allocatePrimerCatalogNumberInDb,
  replacePrimerLegacyProjectionInDb,
  resolvePrimerProjectionWorkspaceRootInDb,
} from '../primer-projection';
import {
  withRendererDatabaseRead,
  withRendererDatabaseStatement,
  withRendererDatabaseStatementWhenReady,
} from '../workspace-sync-database-fence';
import {
  assertLimsSafetyNotQuarantined,
  LIMS_SAFETY_QUARANTINED_ERROR_CODE,
} from '../lims-safety-quarantine';
import { withDeclaredRendererWorkspaceMutation } from './workspace-mutation-authority';
import {
  findKnownWorkspaceRoot,
  workspaceMutationRootIdentity,
} from '../workspace-sync-mutation-lease';
import {
  bindCatalogEntityFileInDb,
  catalogFileBindingAdmissionWitnessInDb,
  resolveBindingSequenceFingerprint,
} from '../catalog-file-binding';
import { readPrimerRelationshipAuthority } from '../primer-registry-relationships';
import {
  assertEnrolledPrimerPathMutationAllowed,
  assertEnrolledPrimerPhysicalMutationAllowed,
} from '../primer-artifact-mutation-guard';
import {
  parseCatalogFileBindingRequest,
  type CatalogFileBindingRequest,
} from '../../shared/catalog-binding';
import {
  ensureWorkspaceOwnerInDb,
  setCatalogFileStateInDb,
  refreshCatalogFileFingerprintsInDb,
  releaseMissingCatalogFilePathInDb,
  rebindCatalogFilesInDb,
  clearCatalogProjectionInDb,
  deleteCatalogEntityIfUnboundInDb,
  deleteCatalogEntityWithExactBindingInDb,
} from '../catalog-projection-commands';
import { withRendererEntitySql } from '../renderer-entity-sql';
import {
  catalogWorkspaceFileAdmissionWitnessInDb,
  registerCatalogEntityInDb,
  registerWorkspaceFileInDb,
  resolveWorkspaceFileSequenceFingerprintInDb,
} from '../catalog-entity-registration';
import { dbContract, type DatabaseHealth } from '../../shared/ipc/db.contract';
import { assertAdministrationSqlBoundary } from '../administration-schema';
import { admitProjectRootInMain, managedProjectStorageRoot } from '../project-filesystem-authority';
import {
  deleteNotebookPageInMain,
  mutateLegacyNotebookPageInDb,
  notebookPageWorkspaceRootInDb,
  replaceNotebookProjectionFromFileInMain,
} from '../notebook-projection-authority';
import {
  resolveNativeProjectionSourceOwner,
  settleEntityProjectionSourceInMain,
} from '../entity-projection-receipts';

let db: Database.Database | null = null;

export { armRendererTransactionCrashCleanup } from '../workspace-sync-database-fence';

function showDatabaseError(error: unknown): never {
  const { title, detail } = buildDatabaseErrorDialog(error, {
    context: 'open',
    isPackaged: app.isPackaged,
    dbPath: getDbPath(),
  });
  console.error(`[DB] FATAL: ${title}`, error);
  createUserDialogs(dialog).showErrorBox(
    toUserMessage(title, 'operation.failedTitle'),
    toUserMessage(detail, 'operation.failed')
  );
  app.exit(1);
  throw error;
}

export function getDbPath(): string {
  return join(app.getPath('userData'), 'dnaforge.db');
}

export function getDb(options: { interactive?: boolean } = {}): Database.Database {
  if (!db) {
    const dbPath = getDbPath();
    console.log('[DB] Opening database at:', dbPath);
    let opened: Database.Database | undefined;
    try {
      opened = new Database(dbPath);
      opened.pragma('journal_mode = WAL');
      opened.pragma('synchronous = FULL');
      opened.pragma('foreign_keys = ON');
      db = opened;
      console.log('[DB] Database opened successfully');
    } catch (error) {
      opened?.close();
      if (options.interactive === false) throw error;
      showDatabaseError(error);
    }
  }
  return db;
}

export function reopenDatabase(): Database.Database {
  if (db) {
    try {
      db.close();
    } catch {}
    db = null;
  }
  return getDb();
}

export function getDatabaseHealth(): DatabaseHealth {
  const dbPath = getDbPath();
  let nativeModuleArch: string | null = null;

  if (process.platform === 'darwin') {
    try {
      const matches = [
        ...globSync(
          join(
            __dirname,
            '../../../../node_modules/better-sqlite3/build/Release/better_sqlite3.node'
          )
        ),
        ...globSync(
          join(
            __dirname,
            '../../../../node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
          )
        ),
      ];
      if (matches.length > 0) {
        const fileOutput = execFileSync('file', [matches[0]], { encoding: 'utf-8' });
        nativeModuleArch = fileOutput.includes('arm64')
          ? 'arm64'
          : fileOutput.includes('x86_64')
            ? 'x86_64'
            : 'unknown';
      }
    } catch {}
  }

  try {
    const database = getDb();
    database.exec('CREATE TABLE IF NOT EXISTS _health_check (k TEXT PRIMARY KEY, v TEXT)');
    database
      .prepare('INSERT OR REPLACE INTO _health_check (k, v) VALUES (?, ?)')
      .run('check', new Date().toISOString());
    const row = database.prepare('SELECT v FROM _health_check WHERE k = ?').get('check') as
      | { v: string }
      | undefined;
    return {
      ok: !!row?.v,
      dbPath,
      nativeModuleArch,
      error: null,
      connection: {
        journalMode: database.pragma('journal_mode', { simple: true }) as string,
        foreignKeys: database.pragma('foreign_keys', { simple: true }) as number,
        schemaVersion: database.pragma('user_version', { simple: true }) as number,
      },
    };
  } catch (error) {
    return {
      ok: false,
      connection: null,
      dbPath,
      nativeModuleArch,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createChatTurnWithUserMessageInDb(
  database: Database.Database,
  input: CreateChatTurnWithUserMessageRequest,
  now = Date.now
): void {
  if (input.turn.conversation_id !== input.message.conversation_id) {
    throw new Error('Chat turn and initial message must belong to the same conversation.');
  }
  const attachments = input.attachment_manifests ?? [];
  if (
    attachments.some((attachment) => !isAgentAttachmentManifest(attachment)) ||
    new Set(attachments.map((attachment) => attachment.id)).size !== attachments.length
  ) {
    throw new Error('Chat turn attachments must be unique valid immutable manifests.');
  }

  const insert = database.transaction((request: CreateChatTurnWithUserMessageRequest) => {
    database
      .prepare(
        `INSERT INTO chat_turns (
          id, conversation_id, route_kind, host_id, provider, model, transport,
          authority_profile_id, permission_mode, route_snapshot_json, status,
          terminal_reason, error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.turn.id,
        request.turn.conversation_id,
        request.turn.route_kind,
        request.turn.host_id,
        request.turn.provider,
        request.turn.model,
        request.turn.transport,
        request.turn.authority_profile_id,
        request.turn.permission_mode,
        request.turn.route_snapshot_json,
        request.turn.status,
        request.turn.terminal_reason,
        request.turn.error,
        request.turn.started_at,
        request.turn.completed_at
      );

    database
      .prepare(
        `INSERT INTO messages (
          id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.message.id,
        request.message.conversation_id,
        request.turn.id,
        request.message.role,
        request.message.content,
        request.message.tool_name,
        request.message.tool_call_id,
        request.message.created_at
      );

    const insertReference = database.prepare(
      `INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)`
    );
    (request.reference_ids ?? []).forEach((referenceId, position) => {
      insertReference.run(request.message.id, referenceId, position);
    });

    const insertAttachment = database.prepare(
      `INSERT INTO message_attachments (
         message_id, attachment_id, position, name, media_type, size, sha256, kind
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    (request.attachment_manifests ?? []).forEach((attachment, position) => {
      insertAttachment.run(
        request.message.id,
        attachment.id,
        position,
        attachment.name,
        attachment.mediaType,
        attachment.size,
        attachment.sha256,
        attachment.kind
      );
    });

    database
      .prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`)
      .run(now(), request.message.conversation_id);
  });

  insert(input);
}

export function deleteConversationInDb(database: Database.Database, conversationId: string): void {
  if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
    throw new Error('Conversation id is required.');
  }
  const remove = database.transaction((id: string) => {
    database.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  });
  remove(conversationId);
}

export function deleteMessageInDb(database: Database.Database, messageId: string): void {
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    throw new Error('Message id is required.');
  }
  const remove = database.transaction((id: string) => {
    database.prepare('DELETE FROM messages WHERE id = ?').run(id);
  });
  remove(messageId);
}

export function commitChatTurnTerminalStateInDb(
  database: Database.Database,
  input: CommitChatTurnTerminalStateRequest,
  now = Date.now
): CommitChatTurnTerminalStateResult {
  for (const entry of input.messages) {
    if (
      entry.message.conversation_id !== input.conversation_id ||
      entry.message.turn_id !== input.turn_id
    ) {
      throw new Error('Every terminal message must belong to the committed turn.');
    }
  }
  validateTerminalReferenceProposals(input);

  const commit = database.transaction(
    (request: CommitChatTurnTerminalStateRequest): CommitChatTurnTerminalStateResult => {
      const turn = database
        .prepare('SELECT conversation_id, status FROM chat_turns WHERE id = ?')
        .get(request.turn_id) as { conversation_id: string; status: ChatTurnIpcStatus } | undefined;
      if (!turn || turn.conversation_id !== request.conversation_id) {
        throw new Error('Chat turn does not belong to the requested conversation.');
      }
      if (turn.status !== 'running') {
        return { committed: false };
      }

      for (const row of request.proposed_entity_references ?? [])
        createEntityReferenceInDb(database, row);

      const insertMessage = database.prepare(
        `INSERT INTO messages (
          id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertReference = database.prepare(
        `INSERT INTO message_references (message_id, reference_id, position)
         VALUES (?, ?, ?)`
      );
      for (const entry of request.messages) {
        const message = entry.message;
        insertMessage.run(
          message.id,
          message.conversation_id,
          request.turn_id,
          message.role,
          message.content,
          message.tool_name,
          message.tool_call_id,
          message.created_at
        );
        entry.reference_ids.forEach((referenceId, position) => {
          insertReference.run(message.id, referenceId, position);
        });
      }

      database
        .prepare(
          `UPDATE chat_turns
           SET status = ?, terminal_reason = ?, error = ?, completed_at = ?
           WHERE id = ? AND conversation_id = ? AND status = 'running'`
        )
        .run(
          request.status,
          request.terminal_reason,
          request.error,
          request.completed_at,
          request.turn_id,
          request.conversation_id
        );
      database
        .prepare('UPDATE conversations SET updated_at = ? WHERE id = ?')
        .run(now(), request.conversation_id);
      settleNativeChatMetrics(database, request);
      return { committed: true };
    }
  );

  return commit(input);
}

const RENDERER_SQL_LIMS_TABLE = /\blims_[a-z0-9_]+\b/i;
const RENDERER_SQL_LIMS_SAFETY_TABLE = /\blims_safety_[a-z0-9_]+\b/i;

class RendererLimsSafetySqlError extends Error {
  readonly code = LIMS_SAFETY_QUARANTINED_ERROR_CODE;

  constructor() {
    super('Renderer SQL cannot access DNAForge LIMS safety records.');
    this.name = 'RendererLimsSafetySqlError';
  }
}

function assertRendererSqlAllowed(database: Database.Database, sql: string): void {
  assertAdministrationSqlBoundary(sql);
  if (/\bscientific_[a-z0-9_]+\b/iu.test(sql)) {
    throw new Error(
      'Scientific accepted state must be accessed through the scientific object service.'
    );
  }
  if (/\bmolecular_catalog_[a-z0-9_]+\b/i.test(sql)) {
    throw new Error('Use the native molecular catalog API to access saved structures.');
  }
  if (RENDERER_SQL_LIMS_SAFETY_TABLE.test(sql)) {
    throw new RendererLimsSafetySqlError();
  }
  if (RENDERER_SQL_LIMS_TABLE.test(sql)) {
    assertLimsSafetyNotQuarantined(database);
  }
}

export function registerDatabaseHandlers(resolveDatabase: () => Database.Database = getDb): void {
  mainIpc.handle('db:select', (event, sql: string, params?: unknown[]) => {
    const database = resolveDatabase();
    return withRendererDatabaseRead(database, event.sender, () =>
      withRendererEntitySql(database, sql, () => {
        assertRendererSqlAllowed(database, sql);
        const stmt = database.prepare(sql);
        if (!stmt.reader || !stmt.readonly) {
          throw new Error('db:select only accepts read-only queries');
        }
        if (params && params.length > 0) {
          return stmt.all(...params) as SqliteIpcRow[];
        }
        return stmt.all() as SqliteIpcRow[];
      })
    );
  });

  mainIpc.handle(
    'db:createChatTurnWithUserMessage',
    (event, input: CreateChatTurnWithUserMessageRequest) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () => {
        createChatTurnWithUserMessageInDb(database, input);
      });
    }
  );
  mainIpc.handle(
    'db:commitChatTurnTerminalState',
    (event, input: CommitChatTurnTerminalStateRequest) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        commitChatTurnTerminalStateInDb(database, input)
      );
    }
  );
  mainIpc.handle('db:deleteConversation', (event, conversationId: string) => {
    const database = resolveDatabase();
    return withRendererDatabaseStatement(database, event.sender, () => {
      deleteConversationInDb(database, conversationId);
    });
  });
  mainIpc.handle('db:deleteMessage', (event, messageId: string) => {
    const database = resolveDatabase();
    return withRendererDatabaseStatement(database, event.sender, () => {
      deleteMessageInDb(database, messageId);
    });
  });
  handleGroup(dbContract, {
    savedRowRecoveryGenerations: (event) =>
      withRendererDatabaseRead(resolveDatabase(), event.sender, () =>
        savedRowRecoveryGenerations(resolveDatabase())
      ),
    listSavedEntityRowVersions: (event, query) =>
      withRendererDatabaseRead(resolveDatabase(), event.sender, () =>
        listSavedEntityRowVersions(resolveDatabase(), query)
      ),
    recoverSavedEntityRowVersion: async (event, request) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window) throw new Error('Saved record recovery requires an open desktop window.');
      const chosen = await dialog.showOpenDialog(window, {
        title: 'Choose a folder for the recovered SQLite record',
        buttonLabel: 'Recover a copy here',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (chosen.canceled || chosen.filePaths.length !== 1) return null;
      const database = resolveDatabase();
      return withRendererDatabaseRead(database, event.sender, () =>
        recoverSavedEntityRowVersion(database, request, chosen.filePaths[0])
      );
    },
    health: (event) => withRendererDatabaseStatement(getDb(), event.sender, getDatabaseHealth),
    createEntityReference: (event, row) =>
      withRendererDatabaseStatement(resolveDatabase(), event.sender, () =>
        createEntityReferenceInDb(resolveDatabase(), row)
      ),
    updateEntityReference: (event, id, updates) =>
      withRendererDatabaseStatement(resolveDatabase(), event.sender, () =>
        updateEntityReferenceInDb(resolveDatabase(), id, updates)
      ),
    deleteEntityReference: (event, id) =>
      withRendererDatabaseStatement(resolveDatabase(), event.sender, () =>
        deleteEntityReferenceInDb(resolveDatabase(), id)
      ),
    setEntityReferenceWorkspaceRootPathIfMissing: (event, id, root) =>
      withRendererDatabaseStatement(resolveDatabase(), event.sender, () =>
        setEntityReferenceWorkspaceRootPathIfMissingInDb(resolveDatabase(), id, root)
      ),
    recordEntityReferenceRevision: (event, input) =>
      withRendererDatabaseStatement(resolveDatabase(), event.sender, () =>
        recordEntityReferenceRevisionInDb(resolveDatabase(), input)
      ),
    linkCatalogEntities: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        linkCatalogEntitiesInDb(database, input)
      );
    },
    recordCatalogEvent: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        recordCatalogEventInDb(database, input)
      );
    },
    updateCatalogEntityPresentation: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        updateCatalogEntityPresentationInDb(database, input)
      );
    },
    writeCatalogWorkspacePlacement: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        writeCatalogWorkspacePlacementInDb(database, input)
      );
    },
    restoreCatalogProviderBinding: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        restoreCatalogProviderBindingInDb(database, input)
      );
    },
    archiveSupersededNotebookCatalog: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        archiveSupersededNotebookCatalogInDb(database, input)
      );
    },
    removeCatalogWorkspacePlacement: (event, entityId, mode) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        removeCatalogWorkspacePlacementInDb(database, entityId, mode)
      );
    },
    ensureSequenceIndex: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        ensureSequenceIndexInDb(database, input)
      );
    },
    ensureWorkspaceOwner: async (event, root, access, discovery) => {
      const database = resolveDatabase();
      const { rootPath, row } = await admitProjectRootInMain(root, {
        db: database,
        managedRootDir: managedProjectStorageRoot(),
        protectedAppDataRoot: app.getPath('userData'),
      });
      return withRendererDatabaseStatementWhenReady(database, event.sender, () => {
        if (resolveDatabase() !== database)
          throw new Error('The current database changed while waiting to mount the project.');
        const workspaceId = ensureWorkspaceOwnerInDb(
          database,
          row?.path ?? rootPath,
          access,
          discovery
        );
        registerAdmittedProjectRoot(rootPath);
        return workspaceId;
      });
    },
    setCatalogFileState: (event, path, state, reason) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        setCatalogFileStateInDb(database, path, state, reason)
      );
    },
    refreshCatalogFileFingerprints: (event, files) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        refreshCatalogFileFingerprintsInDb(database, files)
      );
    },
    releaseMissingCatalogFilePath: (event, file, replacement) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        releaseMissingCatalogFilePathInDb(database, file, replacement)
      );
    },
    assertCanonicalSequenceSource: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        assertCanonicalSequenceSourceInDb(database, input)
      );
    },
    getFastaKindReadAuthority: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        getFastaKindReadAuthorityInDb(database, input)
      );
    },
    getFastaKindAuthority: (event, input) => {
      const database = resolveDatabase();
      return getFastaKindAuthorityInMain(database, input, (operation) =>
        withRendererDatabaseStatement(database, event.sender, operation)
      );
    },
    classifyFasta: async (event, input, mutationToken) => {
      const database = resolveDatabase();
      const runDatabase = <T>(operation: () => T) =>
        withRendererDatabaseStatement(database, event.sender, operation);
      const admitted = await getFastaKindAuthorityInMain(
        database,
        { path: input.path, workspaceRoot: input.workspaceRoot },
        runDatabase
      );
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot: admitted.workspaceRoot,
        mutationPaths: [admitted.path],
        mutationToken,
        fileWrite: true,
        operation: () => classifyFastaInMain(database, input, runDatabase),
      });
    },
    registerWorkspaceFile: async (event, input, mutationToken) => {
      const database = resolveDatabase();
      const admissionWitness = withRendererDatabaseStatement(database, event.sender, () =>
        catalogWorkspaceFileAdmissionWitnessInDb(database, input)
      );
      const operation = async () => {
        const sequenceFingerprint = await resolveWorkspaceFileSequenceFingerprintInDb(
          database,
          input
        );
        return withCatalogFileSource(
          database,
          input,
          () =>
            withRendererDatabaseStatement(database, event.sender, () =>
              registerWorkspaceFileInDb(database, input, sequenceFingerprint, admissionWitness)
            ),
          (row) => row.id,()=>withRendererDatabaseStatement(database,event.sender,()=>{})
        );
      };
      if (!input.workspaceRoot) {
        if (mutationToken) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
        return operation();
      }
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot: input.workspaceRoot,
        mutationPaths: [input.path],
        mutationToken,
        operation,
      });
    },
    rebindCatalogFiles: async (event, input, mutationToken) => {
      const database = resolveDatabase();
      const operation = async () =>
        withRendererDatabaseStatement(database, event.sender, () =>
          rebindCatalogFilesInDb(database, input)
        );
      if (!input.workspaceRoot) {
        if (mutationToken) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
        return operation();
      }
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot: input.workspaceRoot,
        mutationPaths: [input.oldPath, input.newPath],
        mutationToken,
        operation,
      });
    },
    clearCatalogProjection: (event, workspaceRoot) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        clearCatalogProjectionInDb(database, workspaceRoot)
      );
    },
    deleteCatalogEntityIfUnbound: (event, entityId) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        deleteCatalogEntityIfUnboundInDb(database, entityId)
      );
    },
    deleteCatalogEntityWithExactBinding: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        deleteCatalogEntityWithExactBindingInDb(database, input)
      );
    },
    registerCatalogEntity: (event, input) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        registerCatalogEntityInDb(database, input)
      );
    },
    execute: (event, sql: string, params?: unknown[]) => {
      const database = resolveDatabase();
      return withRendererDatabaseStatement(database, event.sender, () =>
        withRendererEntitySql(database, sql, () => {
          assertRendererSqlAllowed(database, sql);
          if (
            /^\s*DELETE\s+FROM\s+primers\s+WHERE\s+id\s*=\s*\?\s+AND\s+workspace_id\s*=\s*\?\s*;?\s*$/i.test(
              sql
            )
          ) {
            if (typeof params?.[0] !== 'string')
              throw new Error('Primer retirement requires its saved identity.');
            assertEnrolledPrimerPhysicalMutationAllowed(database, [params[0]]);
          }
          const stmt = database.prepare(sql);
          const result = params && params.length > 0 ? stmt.run(...params) : stmt.run();
          return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
        })
      );
    },
    bindCatalogEntityFile: async (
      event,
      inputValue: CatalogFileBindingRequest,
      mutationToken?: string
    ) => {
      const input = parseCatalogFileBindingRequest(inputValue);
      const database = resolveDatabase();
      const admissionWitness = withRendererDatabaseStatement(database, event.sender, () =>
        catalogFileBindingAdmissionWitnessInDb(database, input)
      );
      const affectedPaths = withRendererDatabaseStatement(database, event.sender, () => {
        const workspace = input.workspaceRoot
          ? (database
              .prepare('SELECT id FROM workspaces WHERE path = ?')
              .get(input.workspaceRoot) as { id: number } | undefined)
          : undefined;
        const rows = database
          .prepare(
            `SELECT path FROM catalog_entity_files
          WHERE (entity_id = ? AND status = 'current') OR path = ?
          OR (status = 'missing' AND content_hash = ? AND object_uuid IS NOT NULL AND workspace_id IS ?)`
          )
          .all(
            input.entityId,
            input.path,
            input.contentHash?.startsWith('sha256:') ? input.contentHash : null,
            workspace?.id ?? null
          ) as Array<{ path: string }>;
        return [input.path, ...rows.map((row) => row.path)];
      });
      const roots = new Set(affectedPaths.map((path) => findKnownWorkspaceRoot(database, path)));
      const declaredRoot = input.workspaceRoot ?? findKnownWorkspaceRoot(database, input.path);
      const leaseRoot =
        declaredRoot ?? [...roots].filter((root): root is string => root !== null).sort()[0];
      const operation = async () => {
        const sequenceFingerprint = declaredRoot
          ? await resolveBindingSequenceFingerprint(database, input)
          : undefined;
        return withCatalogFileSource(
          database,
          input,
          () =>
            withRendererDatabaseStatement(database, event.sender, () => {
              assertEnrolledPrimerPhysicalMutationAllowed(database, [input.entityId]);
              assertEnrolledPrimerPathMutationAllowed(database, affectedPaths);
              return bindCatalogEntityFileInDb(
                database,
                input,
                roots,
                admissionWitness,
                sequenceFingerprint
              );
            }),
          (row) => row.entity_id,()=>withRendererDatabaseStatement(database,event.sender,()=>{})
        );
      };
      if (!declaredRoot && mutationToken) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
      if (!leaseRoot) return operation();
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot: leaseRoot,
        mutationPaths: declaredRoot ? [input.path] : [],
        additionalWorkspacePaths: affectedPaths,
        mutationToken,
        operation,
      });
    },
    allocatePrimerCatalogNumber: async (
      event,
      workspaceId?: number,
      workspaceRoot?: string,
      mutationToken?: string
    ) => {
      const database = resolveDatabase();
      if (!workspaceRoot) {
        return withRendererDatabaseStatement(database, event.sender, () =>
          allocatePrimerCatalogNumberInDb(database, workspaceId ?? 0)
        );
      }
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot,
        mutationToken,
        operation: async () =>
          withRendererDatabaseStatement(database, event.sender, () =>
            allocatePrimerCatalogNumberInDb(database, workspaceId ?? 0)
          ),
      });
    },
    replaceNotebookProjection: async (event, input, mutationToken) => {
      const database = resolveDatabase();
      if (input.workspaceRoot === null) {
        if (mutationToken)
          throw new Error('An unbound notebook projection cannot borrow a workspace capability.');
        return replaceNotebookProjectionFromFileInMain(database, input, (run) =>
          withRendererDatabaseStatement(database, event.sender, run)
        );
      }
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot: input.workspaceRoot,
        mutationPaths: [input.sourcePath],
        mutationToken,
        operation: () =>
          replaceNotebookProjectionFromFileInMain(database, input, (run) =>
            withRendererDatabaseStatement(database, event.sender, run)
          ),
      });
    },
    mutateLegacyNotebookPage: async (event, input, mutationToken) => {
      const database = resolveDatabase();
      const workspaceRoot = withRendererDatabaseStatement(database, event.sender, () =>
        notebookPageWorkspaceRootInDb(database, input.id)
      );
      const mutate = async () =>
        withRendererDatabaseStatement(database, event.sender, () =>
          mutateLegacyNotebookPageInDb(database, input)
        );
      if (!workspaceRoot) {
        if (mutationToken)
          throw new Error('An unbound legacy notebook cannot borrow a workspace capability.');
        return mutate();
      }
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot,
        mutationToken,
        operation: mutate,
      });
    },
    deleteNotebookPage: async (event, pageId, mutationToken) => {
      const database = resolveDatabase();
      const workspaceRoot = withRendererDatabaseStatement(database, event.sender, () =>
        notebookPageWorkspaceRootInDb(database, pageId)
      );
      if (!workspaceRoot) return false;
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot,
        fileWrite: true,
        mutationToken,
        operation: () =>
          deleteNotebookPageInMain(database, pageId, (run) =>
            withRendererDatabaseStatement(database, event.sender, run)
          ),
      });
    },
    settleEntityProjectionSource: async (event, input, mutationToken) => {
      const database = resolveDatabase();
      const owner = withRendererDatabaseStatement(database, event.sender, () =>
        resolveNativeProjectionSourceOwner(database, input.key)
      );
      const settle = () =>
        settleEntityProjectionSourceInMain(database, input, (run) =>
          withRendererDatabaseStatement(database, event.sender, run)
        );
      if (!owner.workspace) {
        if (mutationToken)
          throw new Error('An unbound projection cannot borrow a workspace capability.');
        return settle();
      }
      return withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot: owner.workspace.path,
        mutationPaths: [owner.sourcePath],
        mutationToken,
        operation: settle,
      });
    },
    replacePrimerProjection: async (
      event,
      input: PrimerLegacyProjectionInput,
      workspaceRoot?: string,
      mutationToken?: string
    ) => {
      const database = resolveDatabase();
      if (input.registryRelationships && !workspaceRoot)
        throw new Error('Primer Registry relationships require their owning project.');
      const nativeRoot = withRendererDatabaseStatement(database, event.sender, () =>
        resolvePrimerProjectionWorkspaceRootInDb(database, input)
      );
      if (
        nativeRoot &&
        workspaceRoot &&
        workspaceMutationRootIdentity(nativeRoot) !== workspaceMutationRootIdentity(workspaceRoot)
      ) {
        throw new Error('WORKSPACE_MUTATION_DECLARED_ROOT_MISMATCH');
      }
      const leaseRoot = nativeRoot ?? workspaceRoot;
      const operation = async () => {
        withRendererDatabaseStatement(database, event.sender, () =>
          assertEnrolledPrimerPhysicalMutationAllowed(database, [input.id])
        );
        const relationshipAuthority = leaseRoot
          ? await readPrimerRelationshipAuthority(input, leaseRoot)
          : undefined;
        return withRendererDatabaseStatement(database, event.sender, () => {
          const currentRoot = resolvePrimerProjectionWorkspaceRootInDb(database, input);
          if (
            (nativeRoot === null) !== (currentRoot === null) ||
            (nativeRoot &&
              currentRoot &&
              workspaceMutationRootIdentity(nativeRoot) !==
                workspaceMutationRootIdentity(currentRoot))
          ) {
            throw new Error('WORKSPACE_MUTATION_OWNER_CHANGED');
          }
          if (ownsAcceptedScientificEntity(database, input.id, input.workspaceId))
            throw new Error(
              'Reopen this primer to rebuild its library entry from accepted history.'
            );
          assertLimsSafetyNotQuarantined(database);
          assertEnrolledPrimerPhysicalMutationAllowed(database, [input.id]);
          replacePrimerLegacyProjectionInDb(database, input, relationshipAuthority);
        });
      };
      if (!leaseRoot) {
        if (mutationToken) throw new Error('WORKSPACE_MUTATION_TOKEN_INVALID');
        return operation();
      }
      await withDeclaredRendererWorkspaceMutation({
        db: database,
        ownerId: event.sender.id,
        workspaceRoot: leaseRoot,
        mutationToken,
        operation,
      });
    },
  });
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getConsentFromDb(): string | null {
  return getAnalyticsConsentStateFromDb().consent;
}

export function getAnalyticsConsentStateFromDb(): AnalyticsConsentState {
  try {
    const database = getDb();
    const rows = database
      .prepare(
        "SELECT key, value FROM settings WHERE key IN ('analytics_consent', 'analytics_consent_version', 'analytics_consent_basis')"
      )
      .all() as Array<{ key: string; value: string }>;
    const settings = new Map(rows.map((row) => [row.key, row.value]));
    return {
      consent: settings.get('analytics_consent') ?? null,
      version: settings.get('analytics_consent_version') ?? null,
      basis: settings.get('analytics_consent_basis') ?? null,
    };
  } catch {
    return { consent: null, version: null, basis: null };
  }
}

import { HANDLER_FAMILIES } from '../shared/file-associations';
import type { AuthorizedProjectFolder } from '../shared/agent-project-scope';
import { registryConfidenceLabel } from '../shared/strain-genome-evidence';
import { UserMessageError } from '@waypoint/user-messages';
import type { PlatformBridge } from './types';
import { googleSheetsUnavailable } from './google-sheets-unavailable';
import { DEFAULT_MCP_HTTP_PORT } from '../shared/mcp-http';
import { unavailableMemoryPressure } from '../shared/memory-pressure-unavailable';
import { HARD_CAP_BYTES } from '../shared/oversized-guard';
import type { SqliteIpcValue } from '../shared/sqlite-ipc';
import { withDurableBrowserSettings } from './durable-browser-settings';
import { createMemoryNotebookPageCommands } from './memory-notebook-pages';
import {
  LIMS_ENTITY_KINDS,
  LIMS_BUILTIN_ENTITY_SCHEMAS,
  type DnaSequenceRef,
  type FileDnaSequenceRef,
  type LimsEntity,
  type LimsGenomeGapSummary,
  type LimsLink,
  type LimsQueryRegistrySummariesInput,
  type LimsRegistryLinkedEntitySummary,
  type LimsRegistryOpenTarget,
  type LimsRegistryPreview,
  type LimsRegistryPreviewInput,
  type LimsRegistrySummary,
  type LimsRegistrySummaryPage,
  type ProteinSequenceRef,
  type LimsRegisterEntityInput,
  type LimsStrainGenomeSummariesInput,
  type LimsStrainGenomeSummariesResult,
  type LimsStrainGenomeSummary,
  type LimsAuditRow,
  type LimsDefineSchemaInput,
  type LimsRefineSchemaInput,
  type LimsSchemaRow,
  type LimsTelemetryInput,
} from '../shared/lims';
import type { ProjectableEntitySchemaRevisionSnapshot } from '../shared/entity-schema';
import { resolveEntityRecordFieldValues } from '../shared/entity-record';
import {
  MockFsModule,
  MockDialogModule,
  MockDatabaseModule,
  getMockGitStatusPorcelain,
  setFileTree,
} from '../test/platform-mocks';
import { isPathInsideAnyBoundary, normalizePathForBoundary } from '../shared/path-boundary';
import { STANDARD_SAMPLE_WORKSPACE_MANIFEST } from '../shared/sample-workspace-ipc';
import { ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1 } from '../shared/indexed-genome';
import {
  LIMS_ENTITY_QUERY_HARD_MAX,
  compareRegistrySummaries,
  endOfDayMs,
  entitySequenceSearchText,
  startOfDayMs,
} from '../shared/lims-registry';
import { deriveWorkspaceSyncStatus } from '../shared/cloud-sync-status';
import {
  parseRemoteWorkspaceId,
  parseWorkspaceSyncConflictResolution,
  parseWorkspaceSyncEnabled,
  parseWorkspaceUuid,
  workspaceSyncNotImplemented,
  type WorkspaceSyncStatusEvent,
} from '../shared/workspace-sync-ipc';
import { createBrowserMockBenchlingMigrationBridge } from './browser-mock-benchling-migration';
import { BUILT_IN_AGENT_PERMISSION_CATALOG } from '../shared/agent-permissions';

type BrowserMockApiEnv = { readonly VITE_API_URL?: string };
const BROWSER_MOCK_UNCONFIGURED_API_URL = 'http://browser-mock-sidecar.test.invalid';
let browserMockSyncSequence = 0;

export function getBrowserMockApiUrl(
  env: BrowserMockApiEnv = import.meta.env as BrowserMockApiEnv
): string {
  return env.VITE_API_URL || BROWSER_MOCK_UNCONFIGURED_API_URL;
}

function browserMockSyncStatus(workspaceUuid: string) {
  return deriveWorkspaceSyncStatus({
    workspaceUuid,
    isManagedWorkspace: false,
    syncEnabled: false,
    remoteWorkspaceId: null,
    currentLocalHeadSha: null,
    latestAckedLocalHeadSha: null,
  });
}

let mockDbInstance: {
  createEntityReference: PlatformBridge['db']['createEntityReference'];
  updateEntityReference: PlatformBridge['db']['updateEntityReference'];
  deleteEntityReference: PlatformBridge['db']['deleteEntityReference'];
  setEntityReferenceWorkspaceRootPathIfMissing: PlatformBridge['db']['setEntityReferenceWorkspaceRootPathIfMissing'];
  recordEntityReferenceRevision: PlatformBridge['db']['recordEntityReferenceRevision'];
  linkCatalogEntities: PlatformBridge['db']['linkCatalogEntities'];
  recordCatalogEvent: PlatformBridge['db']['recordCatalogEvent'];
  updateCatalogEntityPresentation: PlatformBridge['db']['updateCatalogEntityPresentation'];
  writeCatalogWorkspacePlacement: PlatformBridge['db']['writeCatalogWorkspacePlacement'];
  removeCatalogWorkspacePlacement: PlatformBridge['db']['removeCatalogWorkspacePlacement'];
  restoreCatalogProviderBinding: PlatformBridge['db']['restoreCatalogProviderBinding'];
  archiveSupersededNotebookCatalog: PlatformBridge['db']['archiveSupersededNotebookCatalog'];

  ensureSequenceIndex: PlatformBridge['db']['ensureSequenceIndex'];
  rebindCatalogFiles: PlatformBridge['db']['rebindCatalogFiles'];
  clearCatalogProjection: PlatformBridge['db']['clearCatalogProjection'];
  deleteCatalogEntityIfUnbound: PlatformBridge['db']['deleteCatalogEntityIfUnbound'];
  deleteCatalogEntityWithExactBinding: PlatformBridge['db']['deleteCatalogEntityWithExactBinding'];
  ensureWorkspaceOwner: PlatformBridge['db']['ensureWorkspaceOwner'];
  setCatalogFileState: PlatformBridge['db']['setCatalogFileState'];
  refreshCatalogFileFingerprints: PlatformBridge['db']['refreshCatalogFileFingerprints'];
  releaseMissingCatalogFilePath: PlatformBridge['db']['releaseMissingCatalogFilePath'];
  registerWorkspaceFile: PlatformBridge['db']['registerWorkspaceFile'];
  registerCatalogEntity: PlatformBridge['db']['registerCatalogEntity'];
  bindCatalogEntityFile: PlatformBridge['db']['bindCatalogEntityFile'];
  execute: (
    sql: string,
    params?: unknown[]
  ) => Promise<{ changes: number; lastInsertRowid: number }>;
  select: <T>(sql: string, params?: unknown[]) => Promise<T>;
} | null = null;

const mockLimsEntities: LimsEntity[] = [];
const mockLimsLinks: LimsLink[] = [];
const mockLimsImportBatches = new Map<string, { entityIds: string[]; linkIds: string[] }>();

export function resetBrowserMockLimsState(): void {
  mockLimsEntities.length = 0;
  mockLimsLinks.length = 0;
  mockLimsImportBatches.clear();
}

async function getMockDb() {
  if (!mockDbInstance) {
    mockDbInstance = await MockDatabaseModule.load('sqlite:waypoint-mock.db');
  }
  return mockDbInstance;
}

async function browserRegisteredProjects(): Promise<AuthorizedProjectFolder[]> {
  const rows = await (
    await getMockDb()
  ).select<
    Array<{
      path: string | null;
      name: string;
      access_mode: string;
      archived_at: number | null;
      trashed_at: number | null;
    }>
  >('SELECT path,name,access_mode,archived_at,trashed_at FROM workspaces');
  return rows.flatMap((row) => {
    const path = row.path;
    if (!path || row.archived_at != null || row.trashed_at != null) return [];
    const matches = rows.filter(
      (other) =>
        other.path && normalizePathForBoundary(other.path) === normalizePathForBoundary(path)
    );
    if (matches.length !== 1) return [];
    return [{ path, name: row.name, addedAt: 0, pinned: row.access_mode !== 'writable' }];
  });
}

const BROWSER_MOCK_KEYRING_PREFIX = 'dnaforge-browser-mock-keyring:';

function getBrowserMockKeyringKey(service: string, name: string): string {
  return `${BROWSER_MOCK_KEYRING_PREFIX}${service}:${name}`;
}

async function hasBrowserMockPassword(service: string, name: string): Promise<boolean> {
  return globalThis.localStorage?.getItem(getBrowserMockKeyringKey(service, name)) != null;
}

async function getBrowserMockPassword(service: string, name: string): Promise<string | null> {
  return globalThis.localStorage?.getItem(getBrowserMockKeyringKey(service, name)) ?? null;
}

async function setBrowserMockPassword(
  service: string,
  name: string,
  password: string
): Promise<void> {
  globalThis.localStorage?.setItem(getBrowserMockKeyringKey(service, name), password);
}

async function deleteBrowserMockPassword(service: string, name: string): Promise<void> {
  globalThis.localStorage?.removeItem(getBrowserMockKeyringKey(service, name));
}

export const browserMockBridge: PlatformBridge = {
  googleSheets: googleSheetsUnavailable,
  hostedAi: {
    readIncludedAllowance: async () => ({ status: 'unavailable', code: 'not_configured' }),
  },
  runtime: {
    ...unavailableMemoryPressure,
    getProfile: () => ({
      kind: 'browser-mock',
      isElectron: false,
      isE2e: false,
      scenarioMutationAllowed: true,
      scenarioMutationReason: 'Browser/mock runtime uses in-memory fixture state.',
    }),
    getProvenance: async () => ({
      kind: 'browser-mock',
      appName: 'waypoint-browser-mock',
      appVersion: '0.0.0-browser-mock',
      isPackaged: false,
      isReleaseBuild: false,
      appPath: null,
      execPath: null,
      cwd: null,
      userDataPath: null,
      projectRoot: null,
      apiUrl: getBrowserMockApiUrl(),
      pid: null,
      sidecarPid: null,
      startedAtMs: null,
      desktopDevPort: null,
      desktopHmrPort: null,
      nodeEnv: null,
      waypointTest: null,
      cacheContractToken: null,
      buildSourceFingerprint: null,
      sidecarSourceFingerprint: null,
    }),
  },
  molecularData: {
    retain: async () => {
      throw new Error('Retaining molecular data requires the desktop app.');
    },
    load: async () => {
      throw new Error('Loading molecular data requires the desktop app.');
    },
  },
  molecularCatalog: {
    register: async () => {
      throw new Error('The shared structure catalog requires the desktop app.');
    },
    list: async () => [],
    load: async () => {
      throw new Error('The shared structure catalog requires the desktop app.');
    },
  },
  scientificDocuments: {
    read: async () => ({
      ok: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The Electron scientific document service is unavailable in a browser mock.',
      },
    }),
    cancelRead: async () => undefined,
  },
  entityNavigation: {
    getScheme: async () => 'dnaforge-dev',
    takePending: async () => [],
    onOpen: () => () => undefined,
  },
  workTasks: {
    split: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    dates: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    reminders: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    reminderCommand: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    placements: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    finishPlacement: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    assignees: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    occurrences: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    query: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    read: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    history: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
    mutate: async () => {
      throw new Error('Project work is unavailable in this workspace.');
    },
  },
  scientificObjects: {
    catalog: async () => {
      throw new Error('Scientific objects are unavailable in this workspace.');
    },
    reconcileProjections: async () => {
      throw new Error('Scientific objects are unavailable in this workspace.');
    },
    list: async () => {
      throw new Error('Scientific objects are unavailable in this workspace.');
    },
    read: async () => {
      throw new Error('Scientific objects are unavailable in this workspace.');
    },
    submit: async () => {
      throw new Error('Scientific objects are unavailable in this workspace.');
    },
  },
  fileAssociations: {
    readPreviewBytes: (path, maxBytes) => browserMockBridge.fs.readFileBounded(path, maxBytes),
    takePendingActivations: async () => [],
    materializeQuickLookPackage: async (request) => {
      const sourceFileName = request.sourcePath.split(/[\\/]/u).pop() ?? request.sourcePath;
      const productFileName =
        request.familyId === 'snapgene'
          ? `${sourceFileName.replace(/\.dna$/iu, '')}.gb`
          : sourceFileName;
      const packageRoot = `/browser-quick-look/${sourceFileName}`;
      const productPath = `${packageRoot}/${productFileName}`;
      return {
        sourcePath: request.sourcePath,
        productPath,
        packageRoot,
        contentHash: 'b'.repeat(64),
        familyId: request.familyId,
        sourceFileName,
        records: [
          {
            recordId: 'c'.repeat(64),
            ordinal: 0,
            displayName: productFileName.replace(/\.[^.]+$/u, ''),
            sequenceLength: 1,
            circular: false,
            productPath,
          },
        ],
      };
    },
    prepareQuickLookPackage: async () => false,
    promoteQuickLookPackage: async (request) => {
      const createdNewWorkspace = request.destination.kind === 'new-workspace';
      const workspaceRoot = createdNewWorkspace
        ? `/browser-managed/${request.destination.name}`
        : request.destination.rootPath;
      const groupName =
        request.receipt.sourceFileName.replace(/\.[^.]+$/u, '') || 'Imported sequences';
      const records = request.receipt.records.map((record) => {
        const productName = record.productPath.split(/[\\/]/u).pop() ?? 'sequence.gb';
        const packageName = productName.replace(/\.[^.]+$/u, '') || 'Imported sequence';
        const relPath =
          request.receipt.records.length === 1
            ? `${packageName}/${productName}`
            : `${groupName}/${packageName}/${productName}`;
        return {
          recordId: record.recordId,
          destPath: `${workspaceRoot}/${relPath}`,
          relPath,
        };
      });
      const first = records[0];
      if (!first) throw new Error('Quick Look promotion requires at least one record.');
      return {
        destPath: first.destPath,
        relPath: first.relPath,
        committed: false,
        workspaceRoot,
        createdNewWorkspace,
        createdWorkspaceName: createdNewWorkspace ? request.destination.name : null,
        records,
      };
    },
    onOpenFiles: () => () => undefined,
    queryHandlers: async () =>
      HANDLER_FAMILIES.map((family) => ({
        familyId: family.id,
        state: 'unsupported',
        handlerName: null,
        handlerPath: null,
        defaultAction: 'none',
        detail: 'Desktop file associations are available in the desktop app.',
      })),
    requestDefault: async (familyId) => ({
      familyId,
      outcome: 'unavailable',
      detail: 'Desktop file associations are available in the desktop app.',
    }),
  },
  benchlingMigration: createBrowserMockBenchlingMigrationBridge(),
  db: withDurableBrowserSettings({
    health: async () => {
      throw new Error('Native SQLite connection diagnostics require Electron.');
    },
    assertCanonicalSequenceSource: async () => {
      throw new Error(
        'FASTA_KIND_UNSUPPORTED: Canonical FASTA source authority requires Electron.'
      );
    },
    getFastaKindReadAuthority: async () => {
      throw new Error('FASTA_KIND_UNSUPPORTED: Native FASTA kind authority requires Electron.');
    },
    getFastaKindAuthority: async () => {
      throw new Error('FASTA_KIND_UNSUPPORTED: Native FASTA kind inspection requires Electron.');
    },
    classifyFasta: async () => {
      throw new Error('FASTA_KIND_UNSUPPORTED: Native FASTA classification requires Electron.');
    },
    createEntityReference: async (row) => (await getMockDb()).createEntityReference(row),
    updateEntityReference: async (id, updates) =>
      (await getMockDb()).updateEntityReference(id, updates),
    deleteEntityReference: async (id) => (await getMockDb()).deleteEntityReference(id),
    setEntityReferenceWorkspaceRootPathIfMissing: async (id, root) =>
      (await getMockDb()).setEntityReferenceWorkspaceRootPathIfMissing(id, root),
    recordEntityReferenceRevision: async (input) =>
      (await getMockDb()).recordEntityReferenceRevision(input),
    linkCatalogEntities: async (input) => (await getMockDb()).linkCatalogEntities(input),
    recordCatalogEvent: async (input) => (await getMockDb()).recordCatalogEvent(input),
    updateCatalogEntityPresentation: async (input) =>
      (await getMockDb()).updateCatalogEntityPresentation(input),
    writeCatalogWorkspacePlacement: async (input) =>
      (await getMockDb()).writeCatalogWorkspacePlacement(input),
    removeCatalogWorkspacePlacement: async (entityId, mode) =>
      (await getMockDb()).removeCatalogWorkspacePlacement(entityId, mode),
    restoreCatalogProviderBinding: async (input) =>
      (await getMockDb()).restoreCatalogProviderBinding(input),
    archiveSupersededNotebookCatalog: async (input) =>
      (await getMockDb()).archiveSupersededNotebookCatalog(input),

    ensureSequenceIndex: async (input) => (await getMockDb()).ensureSequenceIndex(input),
    ensureWorkspaceOwner: async (root, access, discovery) =>
      (await getMockDb()).ensureWorkspaceOwner(root, access, discovery),
    setCatalogFileState: async (path, state, reason) =>
      (await getMockDb()).setCatalogFileState(path, state, reason),
    refreshCatalogFileFingerprints: async (files) =>
      (await getMockDb()).refreshCatalogFileFingerprints(files),
    releaseMissingCatalogFilePath: async (file, replacement) =>
      (await getMockDb()).releaseMissingCatalogFilePath(file, replacement),
    registerWorkspaceFile: async (input) => (await getMockDb()).registerWorkspaceFile(input),
    rebindCatalogFiles: async (input) => (await getMockDb()).rebindCatalogFiles(input),
    clearCatalogProjection: async (root) => (await getMockDb()).clearCatalogProjection(root),
    deleteCatalogEntityIfUnbound: async (id) =>
      (await getMockDb()).deleteCatalogEntityIfUnbound(id),
    deleteCatalogEntityWithExactBinding: async (input) =>
      (await getMockDb()).deleteCatalogEntityWithExactBinding(input),
    registerCatalogEntity: async (input) => {
      const db = await getMockDb();
      return db.registerCatalogEntity(input);
    },
    bindCatalogEntityFile: async (input) => {
      const db = await getMockDb();
      return db.bindCatalogEntityFile(input);
    },
    replaceNotebookProjection: async (input) =>
      createMemoryNotebookPageCommands(await getMockDb(), MockFsModule).replaceNotebookProjection(
        input
      ),
    mutateLegacyNotebookPage: async (input) =>
      createMemoryNotebookPageCommands(await getMockDb(), MockFsModule).mutateLegacyNotebookPage(
        input
      ),
    deleteNotebookPage: async (pageId) => {
      const db = await getMockDb();
      const bindings = await db.select<Array<{ path: string; file_kind: string; status: string }>>(
        'SELECT * FROM catalog_entity_files WHERE entity_id = ?',
        [pageId]
      );
      const binding = bindings.find(
        (binding) => binding.file_kind === 'waypoint-notebook' && binding.status === 'current'
      );
      if (!binding) return false;
      const trash = `${binding.path}.deleted-${crypto.randomUUID()}`;
      await MockFsModule.rename(binding.path, trash);
      await db.setCatalogFileState(binding.path, 'historical', 'notebook-deleted');
      await db.execute('DELETE FROM pages WHERE id = ?', [pageId]);
      return true;
    },
    settleEntityProjectionSource: async ({ key, fingerprint }) => {
      await (
        await getMockDb()
      ).execute(
        `INSERT INTO entity_projection_sources
         (adapter_kind, entity_id, workspace_key, relative_path, projection_version, synchronized_fingerprint, synchronized_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(adapter_kind, entity_id, workspace_key, relative_path, projection_version)
         DO UPDATE SET synchronized_fingerprint = excluded.synchronized_fingerprint, synchronized_at = excluded.synchronized_at`,
        [
          key.adapterKind,
          key.entityId,
          key.workspaceKey,
          key.relativePath,
          key.projectionVersion,
          fingerprint,
          Date.now(),
        ]
      );
    },
    execute: async (sql, params) => {
      const db = await getMockDb();
      const result = await db.execute(sql, params);
      return {
        changes: result?.changes ?? 0,
        lastInsertRowid: result?.lastInsertRowid ?? 0,
      };
    },
    select: async <T>(sql: string, params?: SqliteIpcValue[]): Promise<T> => {
      const db = await getMockDb();
      return db.select<T>(sql, params);
    },
    allocatePrimerCatalogNumber: async () => {
      const db = await getMockDb();
      const rows = await db.select<Array<{ catalog_number: string }>>(
        `SELECT catalog_number FROM primers WHERE catalog_number IS NOT NULL`
      );
      const max = rows.reduce((value, row) => {
        const match = /^P(\d+)$/.exec(row.catalog_number);
        return match ? Math.max(value, Number.parseInt(match[1], 10)) : value;
      }, 0);
      return `P${String(max + 1).padStart(3, '0')}`;
    },
    replacePrimerProjection: async (input) => {
      const db = await getMockDb();
      if (input.retireArtifact) {
        const files = await db.select<
          Array<{ relative_path: string; status: string; path: string }>
        >('SELECT * FROM catalog_entity_files WHERE entity_id = ?', [input.id]);
        const file = files.find(
          (file) => file.relative_path === input.retireArtifact!.artifactPath
        );
        if (!file || file.status === 'current' || (await browserMockBridge.fs.exists(file.path)))
          throw new Error(
            'Canonical primer retirement requires its checked file removal and historical binding.'
          );
        await db.execute('DELETE FROM primer_bindings WHERE primer_id = ?', [input.id]);
        await db.execute('DELETE FROM primers WHERE id = ?', [input.id]);
        return;
      }
      await db.execute(
        `INSERT INTO primers (
          id, catalog_number, name, sequence, length, tm, gc_percent, origin, origin_details,
          status, application, notes, workspace_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET catalog_number = excluded.catalog_number,
          name = excluded.name, sequence = excluded.sequence, length = excluded.length,
          tm = excluded.tm, gc_percent = excluded.gc_percent, origin = excluded.origin,
          origin_details = excluded.origin_details, status = excluded.status,
          application = excluded.application, notes = excluded.notes,
          workspace_id = excluded.workspace_id, updated_at = excluded.updated_at`,
        [
          input.id,
          input.catalogNumber,
          input.name,
          input.sequence,
          input.length,
          input.tm,
          input.gcPercent,
          input.origin,
          JSON.stringify(input.originDetails),
          'designed',
          input.application,
          input.notes,
          input.workspaceId,
          input.createdAt,
          input.updatedAt,
        ]
      );
      await db.execute(`DELETE FROM primer_bindings WHERE primer_id = ?`, [input.id]);
      for (const binding of input.bindings) {
        await db.execute(
          `INSERT INTO primer_bindings (
            id, primer_id, sequence_id, binding_start, binding_end, strand, source,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            binding.id,
            input.id,
            binding.sequenceId,
            binding.bindingStart,
            binding.bindingEnd,
            binding.strand,
            binding.source,
            input.createdAt,
            input.updatedAt,
          ]
        );
      }
    },
    createChatTurnWithUserMessage: async (input) => {
      const db = await getMockDb();
      await db.execute(
        `INSERT INTO chat_turns (
          id, conversation_id, route_kind, host_id, provider, model, transport,
          authority_profile_id, permission_mode, route_snapshot_json, status,
          terminal_reason, error, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.turn.id,
          input.turn.conversation_id,
          input.turn.route_kind,
          input.turn.host_id,
          input.turn.provider,
          input.turn.model,
          input.turn.transport,
          input.turn.authority_profile_id,
          input.turn.permission_mode,
          input.turn.route_snapshot_json,
          input.turn.status,
          input.turn.terminal_reason,
          input.turn.error,
          input.turn.started_at,
          input.turn.completed_at,
        ]
      );
      await db.execute(
        `INSERT INTO messages (
          id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.message.id,
          input.message.conversation_id,
          input.turn.id,
          input.message.role,
          input.message.content,
          input.message.tool_name,
          input.message.tool_call_id,
          input.message.created_at,
        ]
      );
      for (let position = 0; position < (input.reference_ids ?? []).length; position++) {
        await db.execute(
          `INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)`,
          [input.message.id, input.reference_ids?.[position], position]
        );
      }
      for (let position = 0; position < (input.attachment_manifests ?? []).length; position++) {
        const attachment = input.attachment_manifests?.[position];
        if (!attachment) continue;
        await db.execute(
          `INSERT INTO message_attachments (
             message_id, attachment_id, position, name, media_type, size, sha256, kind
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.message.id,
            attachment.id,
            position,
            attachment.name,
            attachment.mediaType,
            attachment.size,
            attachment.sha256,
            attachment.kind,
          ]
        );
      }
      await db.execute(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [
        Date.now(),
        input.message.conversation_id,
      ]);
    },
    commitChatTurnTerminalState: async (input) => {
      const db = await getMockDb();
      const rows = await db.select<Array<{ status: string; conversation_id: string }>>(
        `SELECT status, conversation_id FROM chat_turns WHERE id = ?`,
        [input.turn_id]
      );
      if (rows[0]?.conversation_id !== input.conversation_id) {
        throw new Error('Chat turn does not belong to the requested conversation.');
      }
      if (rows[0]?.status !== 'running') return { committed: false };
      const { validateTerminalReferenceProposals } = await import('../shared/chat-turn-ipc');
      validateTerminalReferenceProposals(input);
      for (const row of input.proposed_entity_references ?? []) {
        await db.execute(
          `INSERT INTO entity_references (
            id, entity_type, display_label, locator, deep_link_params, data,
            source, status, workspace_scope, workspace_root_path, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            row.id,
            row.entity_type,
            row.display_label,
            row.locator,
            row.deep_link_params,
            row.data,
            row.source,
            row.status,
            row.workspace_scope,
            row.workspace_root_path,
            row.created_at,
            row.updated_at,
          ]
        );
      }
      for (const entry of input.messages) {
        await db.execute(
          `INSERT INTO messages (
            id, conversation_id, turn_id, role, content, tool_name, tool_call_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            entry.message.id,
            entry.message.conversation_id,
            input.turn_id,
            entry.message.role,
            entry.message.content,
            entry.message.tool_name,
            entry.message.tool_call_id,
            entry.message.created_at,
          ]
        );
        for (let position = 0; position < entry.reference_ids.length; position++) {
          await db.execute(
            `INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)`,
            [entry.message.id, entry.reference_ids[position], position]
          );
        }
      }
      await db.execute(
        `UPDATE chat_turns
         SET status = ?, terminal_reason = ?, error = ?, completed_at = ?
         WHERE id = ? AND conversation_id = ? AND status = 'running'`,
        [
          input.status,
          input.terminal_reason,
          input.error,
          input.completed_at,
          input.turn_id,
          input.conversation_id,
        ]
      );
      await db.execute(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [
        Date.now(),
        input.conversation_id,
      ]);
      return { committed: true };
    },
    deleteConversation: async (id) => {
      const db = await getMockDb();
      const msgs = await db.select<Array<{ id: string }>>(
        `SELECT id FROM messages WHERE conversation_id = ?`,
        [id]
      );
      for (const msg of msgs) {
        await db.execute(`DELETE FROM message_references WHERE message_id = ?`, [msg.id]);
        await db.execute(`DELETE FROM message_attachments WHERE message_id = ?`, [msg.id]);
      }
      const turns = await db.select<Array<{ id: string }>>(
        `SELECT id FROM chat_turns WHERE conversation_id = ?`,
        [id]
      );
      for (const turn of turns) {
        await db.execute(`DELETE FROM agent_structured_outputs WHERE turn_id = ?`, [turn.id]);
        await db.execute(`DELETE FROM agent_capability_invocations WHERE turn_id = ?`, [turn.id]);
      }
      await db.execute(`DELETE FROM agent_provider_session_bindings WHERE conversation_id = ?`, [
        id,
      ]);
      await db.execute(`DELETE FROM conversation_lineage WHERE conversation_id = ?`, [id]);
      await db.execute(`DELETE FROM conversation_lineage WHERE parent_conversation_id = ?`, [id]);
      await db.execute(`DELETE FROM chat_turns WHERE conversation_id = ?`, [id]);
      await db.execute(`DELETE FROM messages WHERE conversation_id = ?`, [id]);
      await db.execute(`DELETE FROM conversations WHERE id = ?`, [id]);
    },
    deleteMessage: async (id) => {
      const db = await getMockDb();
      await db.execute(`DELETE FROM message_references WHERE message_id = ?`, [id]);
      await db.execute(`DELETE FROM message_attachments WHERE message_id = ?`, [id]);
      await db.execute(`DELETE FROM messages WHERE id = ?`, [id]);
    },
  }),
  importReview: {
    call: async () => {
      throw new Error('Native import review is unavailable in this runtime.');
    },
    snapshot: async () => {
      throw new Error('Native import review is unavailable in this runtime.');
    },
    onChanged: () => () => {},
  },
  notebook: {
    migrateLegacyProjectFiles: async () => {
      throw new Error('Native notebook commands require the desktop runtime.');
    },
    create: async () => {
      throw new Error('Native notebook commands require the desktop runtime.');
    },
    completeLegacyDraftMigration: async () => {
      throw new Error('Native notebook commands require the desktop runtime.');
    },
    execute: async () => {
      throw new Error('Native notebook commands require the desktop runtime.');
    },
    onChanged: () => () => undefined,
  },
  administration: {
    execute: async () => ({
      kind: 'failed',
      code: 'ADMINISTRATION_UNAVAILABLE',
      message: 'Native administration is unavailable in this runtime.',
      stateChanged: false,
    }),
    onChanged: () => () => {},
  },
  lims: {
    readPrimerArtifactRevisionState: async () => ({ state: 'not_enrolled' }),
    revisePrimerArtifact: async () => {
      throw new Error('Registered primer publication requires the desktop workspace.');
    },
    resumePrimerArtifactPublication: async () => {
      throw new Error('Registered primer publication requires the desktop workspace.');
    },
    reviewClassification: async () => ({ status: 'unavailable', reason: 'desktop_required' }),
    applyClassification: async () => {
      throw new Error('Sequence classification requires the desktop workspace.');
    },
    ensureSeeded: async () => {},
    defineSchema: async (input) => mockLimsDefinedSchema(input),
    refineSchema: async (input) => mockLimsRefinedSchema(input),
    registerEntity: async (input) => {
      const entity = mockLimsEntity(input);
      mockLimsEntities.push(entity);
      return entity;
    },
    repairEntityProjectionFromAudit: async (entityId) =>
      mockLimsEntities.some((entity) => entity.id === entityId),
    reconstructLegacyAcceptedPlasmid: async () => {
      throw new Error('Legacy Plasmid reconstruction requires the desktop source owner.');
    },
    upgradeLegacyEntityArtifact: async () => ({ published: false }),
    updateEntity: async (input) => {
      const entity = mockLimsEntities.find((row) => row.id === input.id);
      if (!entity) throw new Error(`LIMS entity not found: ${input.id}`);
      if (input.name !== undefined) entity.name = input.name;
      if (input.fields) {
        entity.fields = input.replaceFields ? input.fields : { ...entity.fields, ...input.fields };
      }
      if (input.projectionSchema) {
        entity.kind = input.projectionSchema.kind;
        entity.schemaId = input.projectionSchema.schemaSnapshot.schemaId;
        entity.schemaRevisionId = input.projectionSchema.schemaRevisionId;
      }
      if (input.registrationStatus) entity.registrationStatus = input.registrationStatus;
      if (input.domainStatus !== undefined) entity.domainStatus = input.domainStatus;
      if (input.workspaceId !== undefined) entity.workspaceId = input.workspaceId;
      entity.updatedAt = Date.now();
      return entity;
    },
    revertEntity: async (input) => {
      const entity = mockLimsEntities.find((row) => row.id === input.id);
      if (!entity) throw new Error(`LIMS entity not found: ${input.id}`);
      return { reverted: false, entity, reason: 'no-prior-edit' };
    },
    archiveEntity: async (input) => {
      const entity = mockLimsEntities.find((row) => row.id === input.id);
      if (!entity) throw new Error(`LIMS entity not found: ${input.id}`);
      entity.tombstone = true;
      entity.updatedAt = Date.now();
      return entity;
    },
    restoreEntity: async (input) => {
      const entity = mockLimsEntities.find((row) => row.id === input.id);
      if (!entity) throw new Error(`LIMS entity not found: ${input.id}`);
      entity.tombstone = false;
      entity.updatedAt = Date.now();
      return entity;
    },
    getEntityHistory: async (input) => {
      const entity = mockLimsEntities.find((row) => row.id === input.entityId);
      if (!entity) return [];
      return [
        {
          eventSeq: 1,
          eventType: 'entity_registered' as const,
          label: 'Registered',
          actor: entity.actor ?? null,
          at: entity.createdAt,
          changes: [{ field: 'name', label: 'Name', kind: 'added' as const, after: entity.name }],
        },
      ];
    },
    linkEntities: async (input) => {
      const link = mockLimsLink(input);
      mockLimsLinks.push(link);
      return link;
    },
    replaceOutgoingRelationships: async (input) => {
      let tombstoned = 0;
      const desired = new Set(
        input.relationships.map(
          (relationship) => `${relationship.type}\u0000${relationship.toEntityId}`
        )
      );
      for (const link of mockLimsLinks) {
        if (
          link.fromEntityId === input.entityId &&
          !link.tombstone &&
          !desired.has(`${link.type}\u0000${link.toEntityId}`)
        ) {
          link.tombstone = true;
          link.archivedAt = Date.now();
          tombstoned++;
        }
      }
      const active = [];
      for (const relationship of input.relationships) {
        const existing = mockLimsLinks.find(
          (link) =>
            link.fromEntityId === input.entityId &&
            link.toEntityId === relationship.toEntityId &&
            link.type === relationship.type
        );
        if (existing) {
          existing.payload = relationship.payload ?? {};
          existing.tombstone = false;
          existing.archivedAt = null;
          active.push(existing);
          continue;
        }
        const link = mockLimsLink({
          fromEntityId: input.entityId,
          toEntityId: relationship.toEntityId,
          type: relationship.type,
          payload: relationship.payload,
          actor: input.actor,
          workspaceId: input.workspaceId,
        });
        mockLimsLinks.push(link);
        active.push(link);
      }
      return { active, tombstoned };
    },
    queryEntities: async (input = {}) => {
      const rows = mockLimsEntities.filter((entity) => {
        if (!input.includeArchived && entity.tombstone) return false;
        if (input.id && entity.id !== input.id) return false;
        if (input.kind && entity.kind !== input.kind) return false;
        if (input.registrationStatus && entity.registrationStatus !== input.registrationStatus) {
          return false;
        }
        if (
          input.nameLike &&
          !entity.name.toLowerCase().includes(input.nameLike.trim().toLowerCase())
        ) {
          return false;
        }
        if (input.fieldEquals) {
          for (const [key, value] of Object.entries(input.fieldEquals)) {
            if (entity.fields[key] !== value) return false;
          }
        }
        return true;
      });
      const limit = Math.min(Math.max(input.limit ?? 100, 1), LIMS_ENTITY_QUERY_HARD_MAX);
      return rows.slice(0, limit);
    },
    countEntitiesByKind: async () => {
      const counts = new Map<string, number>(LIMS_ENTITY_KINDS.map((kind) => [kind, 0]));
      for (const entity of mockLimsEntities) {
        if (!entity.tombstone) {
          counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
        }
      }
      return Object.fromEntries(counts);
    },
    queryRegistrySummaries: async (input = {}) => mockQueryRegistrySummaries(input),
    getRegistryPreview: async (input) => mockGetRegistryPreview(input),
    queryRecordRelationshipTargets: async () => {
      throw new Error('Native record relationships require the desktop project catalog.');
    },
    getIdSchemes: async () => [],
    listSchemas: async () => [],
    setIdScheme: async (input) => ({
      kind: input.kind,
      prefix: input.prefix ?? '',
      padWidth: input.padWidth ?? 6,
      nextSeq: 1,
      enabled: input.enabled ?? true,
      updatedAt: Date.now(),
    }),
    backfillRegistryIds: async () => ({ assigned: 0, byKind: {} }),
    getStrainGenomeSummaries: async (input) => mockGetStrainGenomeSummaries(input),
    applyImportBatch: async (input) => {
      const batchId = input.batchId ?? crypto.randomUUID();
      const insertedEntityIds: Array<{ recordId: string; entityId: string }> = [];
      const insertedLinkIds: Array<{ recordId: string; linkId: string }> = [];
      const skippedRecordIds: string[] = [];
      const unresolvedLinks = input.records.flatMap((record) =>
        (record.unresolvedLinks ?? []).map((link) => ({ recordId: record.id, link }))
      );
      let insertedEntities = 0;
      let insertedLinks = 0;
      let skipped = 0;
      for (const record of input.records) {
        if (!record.accepted || record.duplicateOf || (record.errors && record.errors.length > 0)) {
          skipped++;
          skippedRecordIds.push(record.id);
          continue;
        }
        const entity = mockLimsEntity(record.entity);
        mockLimsEntities.push(entity);
        insertedEntityIds.push({ recordId: record.id, entityId: entity.id });
        insertedEntities++;
        for (const link of record.links ?? []) {
          const fromEntityId = link.fromEntityId ?? entity.id;
          const toEntityId = link.toEntityId ?? entity.id;
          if (fromEntityId === toEntityId) continue;
          const nextLink = {
            id: crypto.randomUUID(),
            fromEntityId,
            toEntityId,
            type: link.type,
            payload: link.payload,
            workspaceId: entity.workspaceId,
            actor: input.actor ?? 'local-user',
            eventSeq: mockLimsLinks.length + 1,
            tombstone: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archivedAt: null,
          };
          mockLimsLinks.push(nextLink);
          insertedLinkIds.push({ recordId: record.id, linkId: nextLink.id });
          insertedLinks++;
        }
      }
      mockLimsImportBatches.set(batchId, {
        entityIds: insertedEntityIds.map((row) => row.entityId),
        linkIds: insertedLinkIds.map((row) => row.linkId),
      });
      return {
        batchId,
        insertedEntities,
        insertedLinks,
        skipped,
        insertedEntityIds,
        insertedLinkIds,
        skippedRecordIds,
        unresolvedLinks,
        errors: [],
      };
    },
    undoImportBatch: async (input) => {
      const batch = mockLimsImportBatches.get(input.batchId);
      if (!batch) throw new Error(`No applied LIMS import batch found: ${input.batchId}`);
      let tombstonedEntities = 0;
      let tombstonedLinks = 0;
      for (const link of mockLimsLinks) {
        if (batch.linkIds.includes(link.id) && !link.tombstone) {
          link.tombstone = true;
          link.archivedAt = Date.now();
          tombstonedLinks++;
        }
      }
      for (const entity of mockLimsEntities) {
        if (batch.entityIds.includes(entity.id) && !entity.tombstone) {
          entity.tombstone = true;
          entity.archivedAt = Date.now();
          tombstonedEntities++;
        }
      }
      mockLimsImportBatches.delete(input.batchId);
      return {
        batchId: input.batchId,
        tombstonedEntities,
        tombstonedLinks,
        skippedEntities: batch.entityIds.length - tombstonedEntities,
        skippedLinks: batch.linkIds.length - tombstonedLinks,
      };
    },
    pendingRefs: async () => [],
    confirmPendingRef: async () => {},
    rejectPendingRefCandidate: async () => {},
    dismissPendingRef: async () => {},
    restorePendingRef: async () => {},
    getRegistrationBadgeCandidates: async (input) => {
      return mockLimsEntities
        .map((entity) => {
          const sequence = entity.fields.sequence as DnaSequenceRef | undefined;
          return !entity.tombstone &&
            sequence?.mode === 'file' &&
            sequence.documentId === input.documentId
            ? { entity, sequence: sequence as FileDnaSequenceRef }
            : null;
        })
        .filter((row): row is { entity: LimsEntity; sequence: FileDnaSequenceRef } => row !== null);
    },
    getAllPrimers: async () => {
      return mockLimsEntities
        .filter(
          (entity) => !entity.tombstone && entity.kind === 'oligo' && entity.fields.use === 'primer'
        )
        .map((entity) => {
          const sequence = entity.fields.sequence as DnaSequenceRef | undefined;
          return {
            id: `lims:${entity.id}`,
            source: 'lims' as const,
            origin:
              typeof entity.fields.source === 'string' ? (entity.fields.source as string) : null,
            name: entity.name,
            sequence: sequence?.mode === 'inline' ? sequence.bases : '',
            length: sequence?.mode === 'inline' ? sequence.length : 0,
            catalogNumber:
              typeof entity.fields.catalogNumber === 'string'
                ? (entity.fields.catalogNumber as string)
                : null,
            limsEntityId: entity.id,
            legacyPrimerId: null,
            status:
              typeof entity.fields.status === 'string' ? (entity.fields.status as string) : null,
            notes: typeof entity.fields.notes === 'string' ? (entity.fields.notes as string) : null,
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
          };
        });
    },
    seedDemoDataset: async (input = {}) => {
      if (input.reset) resetBrowserMockLimsState();
      const batchId = crypto.randomUUID();
      let insertedEntities = 0;
      let existingEntities = 0;
      let insertedLinks = 0;
      let existingLinks = 0;
      const actor = input.actor ?? 'local-user';
      const ensureEntity = (request: LimsRegisterEntityInput): LimsEntity => {
        const existing = request.id
          ? mockLimsEntities.find((entity) => entity.id === request.id && !entity.tombstone)
          : null;
        if (existing) {
          existingEntities++;
          return existing;
        }
        const entity = mockLimsEntity({ ...request, actor });
        mockLimsEntities.push(entity);
        insertedEntities++;
        return entity;
      };
      const ensureLink = (request: Parameters<typeof mockLimsLink>[0]): LimsLink => {
        const existing = mockLimsLinks.find(
          (link) =>
            link.fromEntityId === request.fromEntityId &&
            link.toEntityId === request.toEntityId &&
            link.type === request.type &&
            !link.tombstone
        );
        if (existing) {
          existingLinks++;
          return existing;
        }
        const link = mockLimsLink({ ...request, actor });
        mockLimsLinks.push(link);
        insertedLinks++;
        return link;
      };

      const organism = ensureEntity({
        id: 'demo-dna509-organism-ecoli-mg1655',
        kind: 'organism',
        name: 'Escherichia coli K-12 MG1655',
        fields: { taxid: '511145', scientificName: 'Escherichia coli str. K-12 substr. MG1655' },
      });
      const parent = ensureEntity({
        id: 'demo-dna509-genome-mg1655-region',
        kind: 'genome',
        name: 'MG1655 parent region',
        fields: {
          sequence: {
            mode: 'file',
            relPath: 'test-fixtures/sequences/linear/ecoli-mg1655-region.gb',
            topology: 'linear',
            length: 78340,
            contentHash: 'sha256:demo-parent',
            sourceFormat: 'gb',
          },
          source: 'reference',
          assemblyLevel: 'contig',
        },
      });
      const hypothesis = ensureEntity({
        id: 'demo-dna509-genome-supplied-hypothesis',
        kind: 'genome',
        name: 'Demo supplied genome hypothesis',
        fields: {
          sequence: {
            mode: 'file',
            relPath: 'browser-mock/dna509-supplied-hypothesis.gb',
            topology: 'linear',
            length: 77335,
            contentHash: 'sha256:demo-hypothesis',
            sourceFormat: 'gb',
          },
          source: 'other',
          assemblyLevel: 'contig',
          notes: 'Supplied hypothesis fixture, not WGS verified.',
        },
      });
      const verified = ensureEntity({
        id: 'demo-dna509-genome-wgs',
        kind: 'genome',
        name: 'Demo verified WGS',
        fields: {
          sequence: {
            mode: 'file',
            relPath: 'browser-mock/dna509-verified-wgs.gb',
            topology: 'linear',
            length: 77335,
            contentHash: 'sha256:demo-wgs',
            sourceFormat: 'gb',
          },
          source: 'WGS',
          assemblyLevel: 'contig',
        },
      });
      const strain = ensureEntity({
        id: 'demo-dna509-strain-argf',
        kind: 'strain',
        name: 'Demo argF deletion strain',
        fields: {
          genotypeCanonical: 'argFΔ; g.1414A>T',
          source: 'demo dataset',
          markers: ['argF deletion'],
        },
      });
      const plasmid = ensureEntity({
        id: 'demo-dna509-plasmid-puc19',
        kind: 'plasmid',
        name: 'pUC19',
        fields: {
          sequence: {
            mode: 'file',
            relPath: 'test-fixtures/sequences/circular/pUC19.gb',
            topology: 'circular',
            length: 2686,
            contentHash: 'sha256:demo-puc19',
            sourceFormat: 'gb',
          },
          markers: ['AmpR'],
          ori: 'pMB1',
        },
      });
      const primers = [
        ['demo-dna509-oligo-m13-forward', 'M13-Forward', 'GTAAAACGACGGCCAGT'],
        ['demo-dna509-oligo-m13-reverse', 'M13-Reverse', 'CAGGAAACAGCTATGAC'],
        ['demo-dna509-oligo-t7-promoter', 'T7-Promoter', 'TAATACGACTCACTATAGGG'],
        ['demo-dna509-oligo-sp6-promoter', 'SP6-Promoter', 'ATTTAGGTGACACTATAG'],
      ].map(([id, name, bases]) =>
        ensureEntity({
          id,
          kind: 'oligo',
          name,
          fields: {
            sequence: { mode: 'inline', bases, topology: 'linear', length: bases.length },
            use: 'primer',
            notes: 'Seeded from primer fixture table.',
          },
        })
      );

      ensureLink({
        fromEntityId: strain.id,
        toEntityId: organism.id,
        type: 'references',
        payload: { role: 'organism' },
      });
      ensureLink({
        fromEntityId: strain.id,
        toEntityId: parent.id,
        type: 'references',
        payload: {
          role: 'parent_genome',
          confidence: 'genotype_parent_reference',
          genotype: 'argFΔ; g.1414A>T',
        },
      });
      ensureLink({
        fromEntityId: strain.id,
        toEntityId: hypothesis.id,
        type: 'has_genome',
        payload: { confidence: 'hypothesis_supplied', method: 'supplied_genome_hypothesis' },
      });
      ensureLink({
        fromEntityId: hypothesis.id,
        toEntityId: parent.id,
        type: 'derives_from',
        payload: { method: 'supplied_genome_hypothesis' },
      });
      ensureLink({
        fromEntityId: strain.id,
        toEntityId: verified.id,
        type: 'has_genome',
        payload: { confidence: 'WGS_verified', method: 'WGS', coverage: 94 },
      });
      ensureLink({
        fromEntityId: hypothesis.id,
        toEntityId: verified.id,
        type: 'verified_by',
        payload: { method: 'WGS', coverage: 94 },
      });
      for (const primer of primers.slice(0, 2)) {
        ensureLink({
          fromEntityId: primer.id,
          toEntityId: plasmid.id,
          type: 'associated_with',
          payload: {
            role: 'intended_target',
            orientation: primer.name.includes('Reverse') ? 'reverse' : 'forward',
          },
        });
      }

      return {
        batchId,
        insertedEntities,
        existingEntities,
        insertedLinks,
        existingLinks,
        entities: [organism, parent, hypothesis, verified, strain, plasmid, ...primers],
        strainSummary: mockStrainGenomeSummary(strain.id),
        assetSources: [
          {
            role: 'parent genome',
            path: 'test-fixtures/sequences/linear/ecoli-mg1655-region.gb',
            used: true,
          },
          {
            role: 'plasmid',
            path: 'test-fixtures/sequences/circular/pUC19.gb',
            used: true,
          },
          {
            role: 'primer table',
            path: 'test-fixtures/import/primers.csv',
            used: true,
          },
        ],
      };
    },
    seedMockDemo: async (input = {}) => {
      if (input.reset) resetBrowserMockLimsState();
      const actor = input.actor ?? 'local-user';
      const batchId = crypto.randomUUID();
      let insertedOligos = 0;
      let insertedLinks = 0;
      const ensure = (request: LimsRegisterEntityInput): LimsEntity => {
        const existing = request.id
          ? mockLimsEntities.find((e) => e.id === request.id && !e.tombstone)
          : null;
        if (existing) return existing;
        const entity = mockLimsEntity({ ...request, actor });
        mockLimsEntities.push(entity);
        insertedOligos++;
        return entity;
      };
      const plasmid = ensure({
        id: 'mock-dna509-plasmid-puc19',
        kind: 'plasmid',
        name: 'pUC19 (mock demo)',
        fields: {
          sequence: {
            mode: 'file',
            relPath: 'test-fixtures/sequences/circular/pUC19.gb',
            topology: 'circular',
            length: 2686,
            contentHash: 'sha256:mock-puc19',
            sourceFormat: 'gb',
          },
          markers: ['AmpR'],
          type: 'cloning vector',
        },
      });
      const genome = ensure({
        id: 'mock-dna509-genome-scerevisiae-chr4',
        kind: 'chromosome',
        name: 'S. cerevisiae chromosome IV (mock demo)',
        fields: {
          sequence: {
            mode: 'file',
            relPath: 'test-fixtures/genomes/yeast-chrIV/chrIV.gbff',
            topology: 'linear',
            length: 1531933,
            contentHash: 'sha256:mock-scchr4',
            sourceFormat: 'gb',
          },
          moleculeType: 'chromosome',
          species: 'Saccharomyces cerevisiae',
          accessions: ['NC_001136.10'],
        },
      });
      const heroes: Array<[string, string, string, number, number, string, string]> = [
        [
          'mock-dna509-hero-omk_pucori_f',
          'oMK_pUCori_F',
          'GGGAAACGCCTGGTATCTTT',
          118,
          137,
          'forward',
          plasmid.id,
        ],
        [
          'mock-dna509-hero-omk_l4440_f',
          'oMK_L4440_F',
          'AGCGAGTCAGTGAGCGAG',
          371,
          388,
          'forward',
          plasmid.id,
        ],
        [
          'mock-dna509-hero-omk_pucrev_r',
          'oMK_pUCrev_R',
          'GTGCTGCAATGATACCGCGAGA',
          2001,
          2022,
          'reverse',
          plasmid.id,
        ],
        [
          'mock-dna509-hero-omk_sciv_f',
          'oMK_scIV_F',
          'AGTCAGCAATTTCAATTCTCCTACGTTGAA',
          760001,
          760030,
          'forward',
          genome.id,
        ],
        [
          'mock-dna509-hero-omk_sciv_r',
          'oMK_scIV_R',
          'ACCGTCACAGAAATTATAGAGGACAACGCT',
          500001,
          500030,
          'reverse',
          genome.id,
        ],
      ];
      const heroOligoIds: string[] = [];
      for (const [id, name, bases, bindingStart, bindingEnd, orientation, targetId] of heroes) {
        const oligo = ensure({
          id,
          kind: 'oligo',
          name,
          fields: {
            sequence: { mode: 'inline', bases, topology: 'linear', length: bases.length },
            use: 'primer',
          },
        });
        heroOligoIds.push(oligo.id);
        const link = mockLimsLink({
          fromEntityId: oligo.id,
          toEntityId: targetId,
          type: 'amplifies',
          payload: { role: 'binds_target', orientation, bindingStart, bindingEnd },
        });
        mockLimsLinks.push(link);
        insertedLinks++;
      }
      ['oQZ9288', 'oMK265', 'BLEN_GA_F', 'MARN_amp_Rev', 'DXN726'].forEach((name, i) =>
        ensure({
          id: `mock-dna509-oligo-${String(i).padStart(4, '0')}`,
          kind: 'oligo',
          name,
          fields: {
            sequence: { mode: 'inline', bases: 'ACGTACGTACGTACGT', topology: 'linear', length: 16 },
            use: 'primer',
          },
        })
      );
      return {
        batchId,
        insertedOligos,
        existingOligos: 0,
        plasmidId: plasmid.id,
        genomeId: genome.id,
        heroOligoIds,
        insertedLinks,
      };
    },
    seedPracticeDemo: async (input = {}) => {
      if (input.reset) resetBrowserMockLimsState();
      const actor = input.actor ?? 'local-user';
      const batchId = crypto.randomUUID();
      let insertedPlasmids = 0;
      let insertedOligos = 0;
      let sampleEntityId: string | null = null;
      const dayMs = 24 * 60 * 60 * 1000;
      const ensure = (request: LimsRegisterEntityInput): LimsEntity => {
        const existing = request.id
          ? mockLimsEntities.find((e) => e.id === request.id && !e.tombstone)
          : null;
        if (existing) return existing;
        const entity = mockLimsEntity({ ...request, actor });
        mockLimsEntities.push(entity);
        return entity;
      };
      const samplePlasmids = [
        { id: 'syn-0001', name: 'pSYN-0001', marker: 'Ampicillin', backbone: 'pGEX-4T-1' },
        { id: 'syn-0002', name: 'pSYN-0002', marker: 'Kanamycin', backbone: 'pEGFP-N1' },
        { id: 'syn-0003', name: 'pSYN-0003', marker: 'Ampicillin', backbone: 'pcDNA3.1(+)' },
      ];
      samplePlasmids.forEach((p, i) => {
        const entity = ensure({
          id: `practice-dna509-plasmid-${p.id}`,
          kind: 'plasmid',
          name: p.name,
          fields: {
            sequence: { mode: 'inline', bases: 'ACGTACGTACGTACGT', topology: 'linear', length: 16 },
            markers: [p.marker],
            type: p.backbone,
            notes: `Synthetic practice plasmid in ${p.backbone}.`,
          },
          createdAt: Date.now() - (samplePlasmids.length - i) * 30 * dayMs,
        });
        insertedPlasmids++;
        if (!sampleEntityId) sampleEntityId = entity.id;
      });
      ['Practice-F', 'Practice-R'].forEach((name, i) => {
        ensure({
          id: `practice-dna509-oligo-${name.toLowerCase()}-${i}`,
          kind: 'oligo',
          name,
          fields: {
            sequence: {
              mode: 'inline',
              bases: 'GTAAAACGACGGCCAGT',
              topology: 'linear',
              length: 17,
            },
            use: 'primer',
          },
          createdAt: Date.now() - (i + 1) * 15 * dayMs,
        });
        insertedOligos++;
      });
      return {
        batchId,
        insertedPlasmids,
        insertedOligos,
        insertedGenomeEntities: 0,
        existingEntities: 0,
        sampleEntityId,
      };
    },
    seedStarterRegistry: async (input = {}) => {
      if (input.reset) resetBrowserMockLimsState();
      const actor = input.actor ?? 'local-user';
      const batchId = crypto.randomUUID();
      let insertedEntities = 0;
      let insertedLinks = 0;
      const strainIds: string[] = [];
      const genomeIds: string[] = [];
      const ECOLI = { name: 'Escherichia coli', taxid: '562' };
      const YEAST = { name: 'Saccharomyces cerevisiae', taxid: '4932' };
      const ensure = (request: LimsRegisterEntityInput): LimsEntity => {
        const existing = request.id
          ? mockLimsEntities.find((e) => e.id === request.id && !e.tombstone)
          : null;
        if (existing) return existing;
        const entity = mockLimsEntity({ ...request, actor });
        mockLimsEntities.push(entity);
        insertedEntities++;
        return entity;
      };
      const link = (fromEntityId: string, toEntityId: string, type: string, payload = {}) => {
        mockLimsLinks.push(mockLimsLink({ fromEntityId, toEntityId, type, payload }));
        insertedLinks++;
      };
      const strain = (
        species: { name: string; taxid: string },
        id: string,
        name: string,
        genotype: string,
        parentStrainId?: string
      ) => {
        const s = ensure({
          id,
          kind: 'strain',
          name,
          fields: {
            genotypeCanonical: genotype,
            species: species.name,
            speciesTaxid: species.taxid,
            source: 'starter registry',
          },
        });
        strainIds.push(s.id);
        if (parentStrainId)
          link(s.id, parentStrainId, 'derives_from', {
            provenance: 'literature',
            sequenceDiff: 'not_computed',
          });
        return s;
      };

      const w1485 = strain(ECOLI, 'starter-strain-ecoli-w1485', 'E. coli K-12 W1485', 'F+ λ+');
      const mg1655 = strain(
        ECOLI,
        'starter-strain-ecoli-mg1655',
        'E. coli K-12 MG1655',
        'F– λ– rph-1',
        w1485.id
      );
      const mg1655Genome = ensure({
        id: 'starter-genome-ecoli-mg1655',
        kind: 'genome',
        name: 'E. coli MG1655 genome',
        fields: {
          sequence: { mode: 'unresolved' },
          assemblyLevel: 'complete_genome',
          accessions: ['GCF_000005845.2'],
        },
      });
      genomeIds.push(mg1655Genome.id);
      link(mg1655.id, mg1655Genome.id, 'has_genome', { confidence: 'reference' });
      const mg1655Chr = ensure({
        id: 'starter-chr-ecoli-mg1655',
        kind: 'chromosome',
        name: 'E. coli MG1655 chromosome',
        fields: {
          sequence: {
            mode: 'file',
            relPath: 'test-fixtures/sequences/circular/ecoli-mg1655-complete.gb',
            topology: 'circular',
            length: 4641652,
            contentHash: 'sha256:mock-mg1655',
            sourceFormat: 'gb',
          },
          moleculeType: 'chromosome',
          accessions: ['NC_000913.3'],
        },
      });
      link(mg1655Genome.id, mg1655Chr.id, 'has_part', { role: 'chromosome', chromosome: 'main' });
      strain(ECOLI, 'starter-strain-ecoli-w3110', 'E. coli K-12 W3110', 'F– λ– rph-1', w1485.id);
      strain(ECOLI, 'starter-strain-ecoli-dh5a', 'E. coli DH5α', 'F– endA1 recA1 Φ80dlacZΔM15 …');
      strain(
        ECOLI,
        'starter-strain-ecoli-bl21',
        'E. coli BL21(DE3)',
        'F– ompT hsdSB gal dcm (DE3)'
      );

      const s288c = strain(
        YEAST,
        'starter-strain-scerevisiae-s288c',
        'S. cerevisiae S288C',
        'MATα SUC2 …'
      );
      const s288cGenome = ensure({
        id: 'starter-genome-scerevisiae-s288c',
        kind: 'genome',
        name: 'S. cerevisiae S288C genome',
        fields: {
          sequence: { mode: 'unresolved' },
          assemblyLevel: 'complete_genome',
          accessions: ['GCF_000146045.2'],
        },
      });
      genomeIds.push(s288cGenome.id);
      link(s288c.id, s288cGenome.id, 'has_genome', { confidence: 'reference' });
      const chrIV = ensure({
        id: 'starter-chr-scerevisiae-iv',
        kind: 'chromosome',
        name: 'S. cerevisiae S288C chromosome IV',
        fields: {
          sequence: {
            mode: 'file',
            relPath: 'test-fixtures/genomes/yeast-chrIV/chrIV.gbff',
            topology: 'linear',
            length: 1531933,
            contentHash: 'sha256:mock-scchr4',
            sourceFormat: 'gb',
          },
          moleculeType: 'chromosome',
          accessions: ['NC_001136.10'],
        },
      });
      link(s288cGenome.id, chrIV.id, 'has_part', { role: 'chromosome', chromosome: 'IV' });
      strain(
        YEAST,
        'starter-strain-scerevisiae-by4741',
        'S. cerevisiae BY4741',
        'MATa his3Δ1 leu2Δ0 met15Δ0 ura3Δ0',
        s288c.id
      );
      strain(
        YEAST,
        'starter-strain-scerevisiae-by4742',
        'S. cerevisiae BY4742',
        'MATα his3Δ1 leu2Δ0 lys2Δ0 ura3Δ0',
        s288c.id
      );

      const oligoIds: string[] = [];
      for (let i = 1; i <= 14; i += 1) {
        const name = `oDEMO-${String(i).padStart(4, '0')}`;
        const oligo = ensure({
          id: `starter-oligo-${name.toLowerCase()}`,
          kind: 'oligo',
          name,
          fields: {
            sequence: {
              mode: 'inline',
              bases: 'ACGTACGTACGTACGTACGT',
              topology: 'linear',
              length: 20,
            },
            use: 'primer',
          },
        });
        oligoIds.push(oligo.id);
      }

      return {
        batchId,
        insertedEntities,
        existingEntities: 0,
        insertedLinks,
        strainIds,
        genomeIds,
        oligoIds,
      };
    },
    resetRegistry: async () => {
      resetBrowserMockLimsState();
      return { cleared: true as const, entityCount: 0 as const };
    },
    recordStrainParentGenome: async (input) => {
      const link = mockLimsLink({
        fromEntityId: input.strainEntityId,
        toEntityId: input.parentGenomeEntityId,
        type: 'references',
        payload: { role: 'parent_genome', confidence: 'genotype_parent_reference' },
      });
      mockLimsLinks.push(link);
      return { link, gap: mockStrainGenomeSummary(input.strainEntityId).gap };
    },
    attachGenomeHypothesis: async (input) => {
      const hasGenomeLink = mockLimsLink({
        fromEntityId: input.strainEntityId,
        toEntityId: input.hypothesisGenomeEntityId,
        type: 'has_genome',
        payload: {
          confidence: 'hypothesis_supplied',
          method: input.method ?? 'supplied_genome_hypothesis',
        },
      });
      mockLimsLinks.push(hasGenomeLink);
      let parentReferenceLink: LimsLink | undefined;
      let derivesFromLink: LimsLink | undefined;
      if (input.parentGenomeEntityId) {
        parentReferenceLink = mockLimsLink({
          fromEntityId: input.strainEntityId,
          toEntityId: input.parentGenomeEntityId,
          type: 'references',
          payload: { role: 'parent_genome', confidence: 'genotype_parent_reference' },
        });
        derivesFromLink = mockLimsLink({
          fromEntityId: input.hypothesisGenomeEntityId,
          toEntityId: input.parentGenomeEntityId,
          type: 'derives_from',
          payload: { method: input.method ?? 'supplied_genome_hypothesis' },
        });
        mockLimsLinks.push(parentReferenceLink, derivesFromLink);
      }
      return {
        hasGenomeLink,
        parentReferenceLink,
        derivesFromLink,
        gap: mockStrainGenomeSummary(input.strainEntityId).gap,
      };
    },
    attachVerifiedGenome: async (input) => {
      const hasGenomeLink = mockLimsLink({
        fromEntityId: input.strainEntityId,
        toEntityId: input.verifiedGenomeEntityId,
        type: 'has_genome',
        payload: {
          confidence: 'WGS_verified',
          method: input.method ?? 'WGS',
          coverage: input.coverage ?? null,
        },
      });
      mockLimsLinks.push(hasGenomeLink);
      let verifiedByLink: LimsLink | undefined;
      if (input.hypothesisGenomeEntityId) {
        verifiedByLink = mockLimsLink({
          fromEntityId: input.hypothesisGenomeEntityId,
          toEntityId: input.verifiedGenomeEntityId,
          type: 'verified_by',
          payload: { method: input.method ?? 'WGS', coverage: input.coverage ?? null },
        });
        mockLimsLinks.push(verifiedByLink);
      }
      return {
        hasGenomeLink,
        verifiedByLink,
        gap: mockStrainGenomeSummary(input.strainEntityId).gap,
      };
    },
    getStrainGenomeSummary: async (input) => mockStrainGenomeSummary(input.strainEntityId),
    logTelemetry: async (input) => mockLimsTelemetryRow(input),
  },
  fs: {
    listDirtyDocuments: async () => [],
    settleDirtyDocuments: async () => {
      throw new Error('Native dirty documents require the desktop runtime.');
    },
    onDirtyDocumentsChanged: () => () => {},
    sequenceDocument: async () => {
      throw new Error('Native sequence documents require the desktop runtime.');
    },
    isSequenceDocumentAvailable: async () => false,
    retainLegacySequenceDraft: async () => {
      throw new Error('Native sequence recovery requires the desktop runtime.');
    },
    completeLegacySequenceDraftMigration: async () => {
      throw new Error('Native sequence recovery requires the desktop runtime.');
    },
    subscribeSequenceDocuments: () => () => {},
    onFileDocumentFlush: () => () => {},
    acknowledgeFileDocumentFlush: async () => false,
    completeLegacyFileDraftMigration: async () => {
      throw new Error('Native draft migration requires the desktop runtime.');
    },
    retainLegacyFileDraft: async () => {
      throw new Error('Native draft migration requires the desktop runtime.');
    },
    assertFileDocumentsClean: async () => {},
    fileDocument: async () => {
      throw new Error('Native file documents require the desktop runtime.');
    },
    tableDocument: async () => {
      throw new Error('Native table documents require the desktop runtime.');
    },
    subscribeFileDocuments: () => () => {},
    beginWorkspaceMutation: async () => 'browser-workspace-mutation',
    endWorkspaceMutation: async () => undefined,
    readTextFile: (path) => MockFsModule.readTextFile(path),
    readAdmittedTextFile: async (input) => {
      const admitted =
        isPathInsideAnyBoundary(input.path, input.projectRoots) ||
        input.grantedFiles.includes(input.path);
      if (!admitted) {
        throw new Error(
          `Path access denied: ${input.path} is outside the trusted project and is not an explicitly granted file.`
        );
      }
      if (input.maxBytes !== undefined) {
        if (
          !Number.isSafeInteger(input.maxBytes) ||
          input.maxBytes <= 0 ||
          input.maxBytes > HARD_CAP_BYTES
        ) {
          throw new Error(`maxBytes must be between 1 and ${HARD_CAP_BYTES}.`);
        }
        const text = await MockFsModule.readTextFile(input.path);
        if (new TextEncoder().encode(text).byteLength > input.maxBytes) {
          throw new Error(`File exceeds ${input.maxBytes} bytes`);
        }
        return text;
      }
      return MockFsModule.readTextFile(input.path);
    },
    readTextFileSlice: async (path, maxBytes) => {
      const text = await MockFsModule.readTextFile(path);
      return { text: text.slice(0, maxBytes), bytesRead: Math.min(text.length, maxBytes) };
    },
    readFile: (path) => MockFsModule.readFile(path),
    readFileBounded: async (path, maxBytes) => {
      const bytes = await MockFsModule.readFile(path);
      if (bytes.byteLength > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
      return bytes;
    },
    sha256File: (path) => MockFsModule.sha256File(path),
    writeTextFile: async (path, content, options) => {
      if (options?.append) {
        const existing = await MockFsModule.readTextFile(path).catch(() => '');
        await MockFsModule.writeTextFile(path, existing + content);
      } else {
        await MockFsModule.writeTextFile(path, content);
      }
    },
    writeTextFileAtomic: async (input) => {
      await MockFsModule.writeTextFile(input.path, input.content);
    },
    canonicalPath: async (path) => path,
    saveSequenceDocument: async () => ({ status: 'unbound' }),
    commitSequenceDocumentHistory: async () => ({
      status: 'unavailable',
      nativeActionId: crypto.randomUUID(),
    }),
    publishSequenceMetadataRevision: async () => {
      throw new UserMessageError('metadata.revisionsNeedDesktop');
    },
    recoverLegacySequenceMetadataTransaction: async () => {
      throw new Error('Legacy sequence metadata recovery requires the desktop app.');
    },
    publishAcceptedAssemblyRevision: async () => {
      throw new Error('Accepted assembly revisions require the desktop app.');
    },
    publishSequenceUserAttachmentMutation: async () => {
      throw new Error('User attachment revisions require the desktop app.');
    },
    previewSequenceRestore: async () => {
      throw new Error('Sequence Restore requires the desktop app.');
    },
    applySequenceRestore: async () => {
      throw new Error('Sequence Restore requires the desktop app.');
    },
    publishSequenceAlignmentHistory: async () => {
      throw new Error('Native alignment history requires the desktop app.');
    },
    prepareSequenceEvidenceRun: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    activateSequenceEvidenceRun: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    completeSequenceEvidenceRun: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    failSequenceEvidenceRun: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    appendSequenceEvidenceState: async () => {
      throw new Error('Sequence evidence requires the desktop app.');
    },
    writeWorkspaceBinaryFileAtomic: async (input) => {
      const normalizedRoot = input.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const normalizedPath = input.path.replace(/\\/g, '/');
      const parts = normalizedPath.slice(normalizedRoot.length + 1).split('/');
      if (
        !normalizedPath.startsWith(`${normalizedRoot}/`) ||
        parts.some((part) => part === '..' || part === '.')
      ) {
        throw new Error('Paper source files must be saved inside the owning workspace.');
      }
      if (await MockFsModule.exists(input.path)) {
        throw new Error('A paper source artifact already exists at that location.');
      }
      await MockFsModule.writeFile(input.path, input.content);
      const digest = await crypto.subtle.digest('SHA-256', input.content);
      const contentHash = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      return { path: input.path, contentHash };
    },
    writeWorkspaceTextFileAtomic: async (input) => {
      const noun = input.artifactNoun ?? 'primer';
      const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
      const normalizedRoot = input.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const normalizedPath = input.path.replace(/\\/g, '/');
      const parts = normalizedPath.slice(normalizedRoot.length + 1).split('/');
      if (
        !normalizedPath.startsWith(`${normalizedRoot}/`) ||
        parts.some((part) => part === '..' || part === '.')
      ) {
        throw new Error(`${Noun} files must be saved inside the owning workspace.`);
      }
      const exists = await MockFsModule.exists(input.path);
      if (input.mode === 'create' && exists) {
        throw new Error(`A ${noun} artifact already exists at that location.`);
      }
      if (input.mode === 'replace' && !exists) {
        throw new Error(`${Noun} artifact no longer exists.`);
      }
      if (input.mode === 'replace') {
        if (!input.expectedContentHash) {
          throw new Error(`Replacing a ${noun} artifact requires its expected content hash.`);
        }
        const existingContent = await MockFsModule.readTextFile(input.path);
        const existingDigest = await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(existingContent)
        );
        const existingHash = Array.from(new Uint8Array(existingDigest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        if (existingHash !== input.expectedContentHash) {
          throw new Error(`${Noun} artifact changed on disk; reload before saving again.`);
        }
      }
      await MockFsModule.writeTextFile(input.path, input.content);
      const bytes = new TextEncoder().encode(input.content);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const contentHash = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      return { path: input.path, contentHash };
    },
    validateWorkspacePath: async (input) => {
      const normalizedRoot = input.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const normalizedPath = input.path.replace(/\\/g, '/');
      if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return false;
      return !normalizedPath
        .slice(normalizedRoot.length + 1)
        .split('/')
        .some((part) => part === '..' || part === '.');
    },
    contentHash: async (input) => {
      const normalizedRoot = input.workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const segments = input.workspaceRelativePath.replace(/\\/g, '/').split('/');
      if (!input.workspaceRelativePath || segments.some((s) => s === '..')) {
        throw new Error(
          `[fs:contentHash] refusing: ${input.workspaceRelativePath} resolves outside the workspace`
        );
      }
      const text = await MockFsModule.readTextFile(`${normalizedRoot}/${segments.join('/')}`);
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(text)
      );
      const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      return `sha256:${hex}`;
    },
    resolveInlineReferenceTarget: async (input) => {
      const waitForTestRelease = (
        globalThis as typeof globalThis & {
          __test?: { waitForInlineReferenceResolution?: () => Promise<void> };
        }
      ).__test?.waitForInlineReferenceResolution;
      if (waitForTestRelease) await waitForTestRelease();
      if (
        !input.segments.length ||
        input.segments.some(
          (segment) =>
            !segment ||
            segment === '.' ||
            segment === '..' ||
            segment.includes('/') ||
            segment.includes('\\')
        )
      ) {
        return { ok: false, code: 'invalid-input' };
      }
      const matches = input.roots.filter((root) => root.name === input.root);
      if (matches.length === 0) return { ok: false, code: 'root-not-found' };
      if (matches.length !== 1) return { ok: false, code: 'root-ambiguous' };

      const rootPath = matches[0].path.replace(/[\\/]+$/, '');
      const relativePath = input.segments.join('/');
      const path = `${rootPath}/${relativePath}`;
      let targetStat: Awaited<ReturnType<typeof MockFsModule.stat>>;
      try {
        targetStat = await MockFsModule.stat(path);
      } catch {
        return { ok: false, code: 'target-not-found' };
      }

      if (input.targetKind === 'structure' && !targetStat.isFile) {
        return { ok: false, code: 'wrong-kind' };
      }
      if (input.targetKind === 'sequence' && targetStat.isDirectory) {
        const markerExists = await MockFsModule.exists(`${path}/.forge/plasmid.json`);
        if (!markerExists) return { ok: false, code: 'wrong-kind' };
        return {
          ok: true,
          path,
          rootPath: matches[0].path,
          canonicalPath: path,
          canonicalRootPath: matches[0].path,
          relativePath,
          targetType: 'sequence-package',
        };
      }
      if (input.targetKind === 'workspace' && targetStat.isDirectory) {
        const markerExists = await MockFsModule.exists(`${path}/.forge/plasmid.json`);
        if (markerExists) {
          return {
            ok: true,
            path,
            rootPath: matches[0].path,
            canonicalPath: path,
            canonicalRootPath: matches[0].path,
            relativePath,
            targetType: 'sequence-package',
          };
        }
      }
      if (input.targetKind !== 'workspace' && !targetStat.isFile) {
        return { ok: false, code: 'wrong-kind' };
      }
      return {
        ok: true,
        path,
        rootPath: matches[0].path,
        canonicalPath: path,
        canonicalRootPath: matches[0].path,
        relativePath,
        targetType: targetStat.isDirectory ? 'directory' : 'file',
      };
    },
    readDir: (path) => MockFsModule.readDir(path),
    mkdir: (path) => MockFsModule.mkdir(path),
    stat: async (path) => {
      const s = await MockFsModule.stat(path);
      const now = Date.now();
      return {
        ...s,
        canonicalPath: path,
        mtime: now,
        ctime: now,
        mtimeNs: (BigInt(now) * 1_000_000n).toString(),
        ctimeNs: (BigInt(now) * 1_000_000n).toString(),
      };
    },
    exists: (path) => MockFsModule.exists(path),
    rename: (oldPath, newPath) => MockFsModule.rename(oldPath, newPath),
    move: async (sourcePath, destinationDir) => {
      const name = sourcePath.split('/').pop() ?? sourcePath;
      const destPath = `${destinationDir.replace(/\/+$/, '')}/${name}`;
      await MockFsModule.rename(sourcePath, destPath);
      return { destPath };
    },
    watchFile: async () => {},
    unwatchFile: async () => {},
  },
  dialog: {
    open: (_options) => MockDialogModule.open(),
    authorizeLocalIndexedTrack: async ({ path }) => ({
      canonicalPath: path,
      authority: 'browser-mock-local-indexed-track-authority',
    }),
    save: (_options) => MockDialogModule.save(),
  },
  path: {
    appDataDir: async () => '/tmp/waypoint-mock',
    referenceAssetCacheRoot: async () => '/tmp/waypoint-mock/reference-assets',
    referenceAssetPublicationRoot: async () => '/tmp/waypoint-mock/reference-assets',
    projectRoot: async () => null,
  },
  trackViewCommands: {
    run: async () => {
      throw new Error('Native Track View commands require the desktop app.');
    },
  },
  comparisonSources: {
    read: async () => {
      throw new Error('Comparison sources require the native desktop owner.');
    },
    readWindow: async () => {
      throw new Error('Comparison source windows require the native desktop owner.');
    },
  },
  contactSources: {
    read: async () => {
      throw new Error('Contact sources require the native desktop owner.');
    },
  },
  sequenceDataLayers: {
    run: async () => {
      throw new Error('Sequence data layers require the native desktop owner.');
    },
  },
  trackViews: {
    command: async () => {
      throw new Error('Native Track View commands require the desktop app.');
    },
    locations: async () => ({
      defaultDirectory: '/tmp/waypoint-mock/Track views',
      homeDirectory: '/tmp',
    }),
    list: async () => ({ views: [], errors: [] }),
    read: async () => {
      throw new Error('Saved Track views require the desktop app.');
    },
    save: async () => {
      throw new Error('Saving Track views requires the desktop app.');
    },
  },
  molecularDocuments: {
    reconcileSourceLinks: async () => {
      throw new Error('Molecular document source projection requires the desktop app.');
    },
    read: async () => {
      throw new Error('Molecular documents require the desktop app.');
    },
    save: async () => {
      throw new Error('Saving molecular documents requires the desktop app.');
    },
  },
  trackStore: {
    root: async () => '/tmp/waypoint-mock/tracks',
    listAssemblies: async () => [],
    listTracks: async () => [],
    readMeta: async () => {
      throw new Error('The track store requires the desktop app.');
    },
    readTrackFile: async () => {
      throw new Error('The track store requires the desktop app.');
    },
    refresh: async () => ({ seeded: 0 }),
  },
  referenceAssets: {
    setOpenVersions: async () => {},
    importLocal: async () => ({ status: 'cancelled' }),
    importHubGenome: async () => {
      throw new Error('Assembly hub import is Electron-only.');
    },
    listLocal: async () => [],
    getLocalPreparationStatus: async () => null,
    retryLocal: async () => {
      throw new Error('Local reference retry is Electron-only.');
    },
    listHosted: async () => [],
    getHostedPreparationStatus: async () => null,
    installHosted: async () => {
      throw new Error('Hosted reference installation is Electron-only.');
    },
    onPreparationProgress: () => () => {},
    onHostedInstallProgress: () => () => {},
  },
  workspace: {
    resolveProjectRoot: async () => {
      throw new Error('Native project root admission requires the desktop application.');
    },
    listRegisteredProjects: browserRegisteredProjects,
    resolveRegisteredProject: async (reference) => {
      const projects = await browserRegisteredProjects();
      const matches = projects.filter(
        (project) =>
          normalizePathForBoundary(project.path) === normalizePathForBoundary(reference) ||
          project.name === reference
      );
      return matches.length === 1 ? matches[0] : null;
    },
    setDocumentCommandRoots: async () => false,
    createSampleInstance: async (request) => {
      if (request.templateId !== STANDARD_SAMPLE_WORKSPACE_MANIFEST.templateId) {
        throw new Error(`Unknown sample workspace template: ${request.templateId}`);
      }
      const rootPath = `/tmp/waypoint-mock/Sample Workspaces/${request.templateId}/${STANDARD_SAMPLE_WORKSPACE_MANIFEST.version}/workspace`;
      setFileTree(rootPath, [{ name: 'sequences', isDirectory: true }]);
      setFileTree(`${rootPath}/sequences`, [{ name: 'circular', isDirectory: true }]);
      setFileTree(
        `${rootPath}/sequences/circular`,
        STANDARD_SAMPLE_WORKSPACE_MANIFEST.assets.map((asset) => ({
          name: asset.path.split('/').pop() ?? asset.path,
          isDirectory: false,
          content: `LOCUS       ${asset.id.slice(0, 12).padEnd(12)} 1 bp DNA circular SYN 01-JAN-2026
ORIGIN
        1 a
//`,
        }))
      );
      return {
        id: `sample:${request.templateId}:${STANDARD_SAMPLE_WORKSPACE_MANIFEST.version}`,
        templateId: request.templateId,
        version: STANDARD_SAMPLE_WORKSPACE_MANIFEST.version,
        displayName: STANDARD_SAMPLE_WORKSPACE_MANIFEST.displayName,
        rootPath,
        markerPath: `/tmp/waypoint-mock/Sample Workspaces/${request.templateId}/${STANDARD_SAMPLE_WORKSPACE_MANIFEST.version}/.dnaforge-sample-workspace.json`,
        manifest: STANDARD_SAMPLE_WORKSPACE_MANIFEST,
        writable: true,
        createdAt: Date.now(),
      };
    },
    importManaged: async () => {
      throw new Error('Managed workspace import is not available in the browser mock');
    },
    getOriginalDefaultProject: async () => ({
      status: 'unresolved',
      reason: 'identity-not-recorded',
      message: 'The browser fixture has no original desktop project.',
    }),
    identifyOriginalDefaultProject: async () => {
      throw new Error('Original project recovery requires the desktop application.');
    },
    recoverLegacyPrimerLibrary: async () => {
      throw new Error('Primer library file recovery requires the desktop app.');
    },
    createEmptyWorkspace: async (request) => ({
      rootPath: `/mock/empty-workspaces/${Date.now()}`,
      displayName: request?.name?.trim() || 'Untitled project',
      createdAt: Date.now(),
    }),
    importFile: async () => {
      throw new Error('Workspace file import is not available in the browser mock');
    },
    relocateEntityFile: async (request) => ({
      newPath: request.newPath,
      counts: {
        catalog: { updated: 0 },
        indexed: { indexedFilesMoved: 0, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
        lims: { rebasedEntityIds: [], workspaceIds: [] },
      },
    }),
    relinkMovedEntityFile: async (request) => ({
      newPath: request.newPath,
      counts: {
        catalog: { updated: 0 },
        indexed: { indexedFilesMoved: 0, staleIndexedFilesMerged: 0, primerBindingsRepointed: 0 },
        lims: { rebasedEntityIds: [], workspaceIds: [] },
      },
    }),
    importFileFromContent: async (request) => {
      const normalizedRoot = request.targetRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const fileName = request.fileName.replace(/\\/g, '/').split('/').pop() || 'sequence.gb';
      const destPath = `${normalizedRoot}/${fileName}`;
      if (request.contentBytes) {
        await MockFsModule.writeFile(destPath, new Uint8Array(request.contentBytes));
      } else {
        await MockFsModule.writeTextFile(destPath, request.content ?? '');
      }
      return { destPath, relPath: fileName, committed: false };
    },
    importSequenceFromContent: async () => ({
      kind: 'failed',
      code: 'IMPORT_FAILED',
      error: 'Native sequence import is unavailable in the browser mock.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    }),
    importFolder: async () => {
      throw new Error('Workspace folder import is not available in the browser mock');
    },
    previewImportDedup: async () => [],
    previewSequenceImport: async ({ sourcePath }) => {
      const fileName = sourcePath.replace(/\\/g, '/').split('/').pop() ?? 'sequence';
      const sourceSha256 = (await MockFsModule.sha256File(sourcePath)).replace(/^sha256:/u, '');
      return {
        kind: 'ready',
        sourcePath,
        sourceSha256,
        packages: [
          {
            name: fileName.replace(/\.[^.]+$/, ''),
            recordIndex: 0,
            recordCount: 1,
          },
        ],
      };
    },
    importFileAsNewWorkspace: async () => {
      throw new Error('Workspace-from-file import is not available in the browser mock');
    },
    registerImportedSequence: async () => {
      throw new Error('Sequence registration import is not available in the browser mock');
    },
    registerImportedSequenceFromContent: async () => {
      throw new Error('Sequence registration import is not available in the browser mock');
    },
    getPathForFile: () => '',
    purgeTrashed: async () => ({ purged: false }),
    rootStatus: async () => [],
    relinkRoot: async () => ({ status: 'rejected', reason: 'identity-unavailable' }),
    transitionLifecycle: async (request) => {
      const db = await getMockDb();
      const now = Date.now();
      switch (request.action) {
        case 'archive-by-uuid':
          return {
            changed: (
              await db.execute(
                `UPDATE workspaces SET archived_at = ? WHERE repo_uuid = ? AND trashed_at IS NULL`,
                [now, request.repoUuid]
              )
            ).changes,
          };
        case 'archive-by-path':
          return {
            changed: (
              await db.execute(
                `UPDATE workspaces SET archived_at = ? WHERE path = ? AND trashed_at IS NULL`,
                [now, request.repoPath]
              )
            ).changes,
          };
        case 'trash-by-path':
          return {
            changed: (
              await db.execute(
                `UPDATE workspaces SET trashed_at = ?, archived_at = ? WHERE path = ?`,
                [now, null, request.repoPath]
              )
            ).changes,
          };
        case 'restore-archive-by-uuid':
          return {
            changed: (
              await db.execute(`UPDATE workspaces SET archived_at = ? WHERE repo_uuid = ?`, [
                null,
                request.repoUuid,
              ])
            ).changes,
          };
        case 'restore-trash-by-uuid':
          return {
            changed: (
              await db.execute(`UPDATE workspaces SET trashed_at = ? WHERE repo_uuid = ?`, [
                null,
                request.repoUuid,
              ])
            ).changes,
          };
        case 'restore-archive-by-path':
          return {
            changed: (
              await db.execute(
                `UPDATE workspaces SET archived_at = ? WHERE path = ? AND archived_at IS NOT NULL AND trashed_at IS NULL`,
                [null, request.repoPath]
              )
            ).changes,
          };
        case 'restore-trash-by-path':
          return {
            changed: (
              await db.execute(
                `UPDATE workspaces SET trashed_at = ? WHERE path = ? AND trashed_at IS NOT NULL`,
                [null, request.repoPath]
              )
            ).changes,
          };
      }
    },
    rename: async (request) => {
      const db = await getMockDb();
      return {
        changed: (
          await db.execute(
            `UPDATE workspaces SET name = ? WHERE path = ? AND repo_uuid IS NOT NULL AND trashed_at IS NULL`,
            [request.name.trim(), request.repoPath]
          )
        ).changes,
      };
    },
    indexManagedHead: async () => ({ headCommit: null, files: [] }),
    indexManagedCatalogHead: async () => ({
      headCommit: null,
      files: [],
      scannedFileCount: 0,
      visibleFileCount: 0,
    }),
    discoverArtifacts: async () => ({
      primerArtifactPaths: [],
      entityArtifactPaths: [],
      scannedEntries: 0,
      errors: [],
    }),
    reconcileNativeRecords: async () => {
      throw new Error('Portable custom records require the desktop project engine.');
    },
    listChildren: async (request) => {
      const parentPath = request.parentRelativePath
        ? `${request.workspaceRoot.replace(/\/$/u, '')}/${request.parentRelativePath}`
        : request.workspaceRoot;
      const entries = await MockFsModule.readDir(parentPath);
      return {
        workspaceId: 0,
        parentRelativePath: request.parentRelativePath,
        entries: entries.map((entry) => ({
          kind: 'filesystem' as const,
          entryId: `filesystem:${parentPath}/${entry.name}`,
          name: entry.name,
          path: `${parentPath}/${entry.name}`,
          isDirectory: entry.isDirectory,
          isFile: entry.isFile,
        })),
        partialError: null,
      };
    },
    onImportProgress: () => () => {},
  },
  shell: {
    projectHistory: async () => {
      throw new Error('Project history requires the native desktop app.');
    },
    onProjectHistoryChanged: () => () => undefined,
    revealItemInDir: async () => {},
    trashItem: async () => {},
    fileTrash: async () => {
      throw new Error('File Trash requires the native desktop app.');
    },
    execute: async (program, args) => ({
      stdout: program === 'git' && args[0] === 'status' ? getMockGitStatusPorcelain() : '',
      stderr: '',
      code: 0,
    }),
    readGitHead: async () => null,
    cancelGitRead: async () => false,
  },
  clipboard: {
    writeText: async (text) => {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
      await navigator.clipboard.writeText(text);
    },
  },
  genome: {
    open: async (source) => ({
      sessionId: 'mock-genome-session',
      sourcePath: source.sourcePath,
      sourceFingerprint: `mock:${source.sourcePath}`,
      chrom: source.chrom ?? 'mock',
      sourceSizeBytes: source.sourceSizeBytes,
      openReady: false,
      coordinateReady: false,
      validationState: 'metadata_match',
      tracks: [
        {
          id: 'mock:sequence',
          kind: 'sequence',
          label: 'Sequence',
          state: 'metadata_pending',
          userState: 'Preparing',
        },
      ],
      openedAt: Date.now(),
    }),
    closeSession: async () => ({
      released: true,
      activeSessionCount: 0,
      cancelledRequestCount: 0,
    }),
    upgradeSessionCapabilities: async (sessionId, source) => ({
      sessionId,
      sourcePath: source.sourcePath,
      sourceFingerprint: `mock:${source.sourcePath}`,
      chrom: source.chrom ?? source.manifest?.chrom ?? 'mock',
      sourceSizeBytes: source.sourceSizeBytes,
      openReady: true,
      coordinateReady: true,
      ...(source.manifest ? { manifest: source.manifest, length: source.manifest.length } : {}),
      ...(source.intent.kind === 'reference-assembly'
        ? {
            assemblyAnnotationProductsReadiness: source.intent.annotationProductsReadiness,
            assemblySearchReadiness: source.intent.searchReadiness,
            ...(source.intent.assetGeneration
              ? { assemblyAssetGeneration: source.intent.assetGeneration }
              : {}),
            ...(source.intent.searchSource
              ? { assemblySearchSource: source.intent.searchSource }
              : {}),
          }
        : {}),
      validationState: 'metadata_match' as const,
      tracks: [],
      openedAt: Date.now(),
    }),
    getAssemblyOverview: async (request) => ({
      byChrom: Object.fromEntries(
        request.chromosomes.map((c) => [
          c.chrom,
          { chrom: c.chrom, features: [], layerTypes: [], cacheState: 'miss' as const },
        ])
      ),
      hits: 0,
      misses: request.chromosomes.length,
    }),
    readAssemblyOverviewTexture: async () => null,
    readAssemblyAnnotationRasterV2: async () => null,
    prepareAssemblyAnnotationAppearanceV1: async () => ({
      status: 'unavailable',
      reason: 'source-unavailable',
    }),
    readAssemblyCompiledBroadRasterManifestV1: async () => null,
    readAssemblyCompiledBroadRasterCellsV1: async () => ({
      contract: ASSEMBLY_COMPILED_BROAD_RASTER_WIRE_V1,
      status: 'unavailable' as const,
      reason: 'repair-not-known' as const,
    }),
    writeAssemblyOverviewTexture: async () => null,
    readAssemblyAnnotationScene: async () => null,
    readAssemblyAnnotationSceneDetailV1: async () => null,
    readAssemblyCompiledBroadInteractionV1: async () => null,
    queryAssemblyAnnotationSearch: async (_request, options) => {
      options?.signal?.throwIfAborted();
      return null;
    },
    cancelAssemblyAnnotationSearch: async () => false,
    queryAssemblyProteinSearch: async (_request, options) => {
      options?.signal?.throwIfAborted();
      return null;
    },
    cancelAssemblyProteinSearch: async () => false,
    getTrustedAssemblyAnnotationScene: () => null,
    readAssemblyAnnotationProductSetInventoryV1: async () => ({ status: 'unavailable' as const }),
    writeAssemblyAnnotationScene: async () => null,
    readAssemblyOverviewFeatures: async () => null,
    writeAssemblyOverviewFeatures: async () => null,
    init: async (manifest) => ({ length: manifest.length ?? 0 }),
    getTrackTile: async (sessionId, request, requestId = 'mock-tile') => ({
      sessionId,
      requestId,
      trackId: request.trackId,
      chrom: request.chrom,
      start: request.start,
      end: request.end,
      generation: request.generation,
      state: 'missing',
      fidelity: 'best_available',
      validationState: 'metadata_match',
      byteCount: 0,
      recordCount: 0,
    }),
    getAnnotationTile: async (sessionId, request, requestId = 'mock-annotation-tile') => ({
      sessionId,
      requestId,
      trackId: request.trackId,
      chrom: request.chrom,
      start: request.start,
      end: request.end,
      generation: request.generation,
      state: 'missing',
      fidelity: 'best_available',
      validationState: 'metadata_match',
      byteCount: 0,
      recordCount: 0,
    }),
    getDebugSnapshot: async (sessionId) => ({
      sessionId,
      sourceFingerprint: 'mock',
      sourcePath: 'mock',
      sourcePathRedacted: 'mock',
      chrom: 'mock',
      coordinateReady: false,
      validationState: 'metadata_match',
      openedAt: Date.now(),
      trackStates: [],
      open: {
        acceptedAt: Date.now(),
        shellCreatedAt: Date.now(),
        status: 'source_accepted',
      },
      budgets: {
        maxSequenceWindowBases: 0,
        maxAnnotationViewportTileBases: 0,
        maxAnnotationViewportTileBytes: 0,
      },
      queues: {
        pendingRequests: 0,
        recentRequestCount: 0,
        workerCount: 0,
      },
      recentRequests: [],
    }),
    getSession: async (sessionId) => ({
      sessionId,
      sourcePath: 'mock',
      sourceFingerprint: 'mock',
      chrom: 'mock',
      openReady: false,
      coordinateReady: false,
      validationState: 'metadata_match',
      tracks: [],
      openedAt: Date.now(),
    }),
    cancelRequest: async (sessionId, requestId) => ({
      sessionId,
      requestId,
      cancelled: false,
    }),
    getFeatureDetails: async (_sessionId, request) => ({
      chrom: request.chrom,
      ...(request.featureId ? { featureId: request.featureId } : {}),
      feature: null,
      relatedFeatures: [],
      sourceRecordCount: 0,
      window: { start: request.start, end: request.end },
      truncated: false,
    }),
    getFeatureDetailsByManifest: async (_manifest, request) => ({
      chrom: request.chrom,
      ...(request.featureId ? { featureId: request.featureId } : {}),
      feature: null,
      relatedFeatures: [],
      sourceRecordCount: 0,
      window: { start: request.start, end: request.end },
      truncated: false,
    }),
    getSequenceWindow: async (sessionId, request, requestId = 'mock-sequence-window') => ({
      sessionId,
      requestId,
      chrom: request.chrom,
      start: request.start,
      end: request.end,
      generation: request.generation,
      validationState: 'metadata_match',
      byteCount: 0,
      bases: '',
    }),
    getSequence: async () => '',
    getFeatures: async () => [],
    searchSequence: async (_manifest, _chrom, _motif, _opts, control) => {
      control.signal?.throwIfAborted();
      return [];
    },
    searchAssemblySequence: async (_request, options) => {
      options?.signal?.throwIfAborted();
      return { hits: [], truncated: false };
    },
    cancelSequenceSearch: async () => false,
  },
  window: {
    showMenu: async () => {},
    setTitleBarTheme: async () => {},
    minimize: async () => {},
    maximize: async () => {},
    unmaximize: async () => {},
    close: async () => {},
    isMaximized: async () => false,
    setSize: async () => {},
    setPosition: async () => {},
    getSize: async () => ({ width: 1200, height: 800 }),
    getPosition: async () => ({ x: 0, y: 0 }),
    setZoomLevel: async () => ({ status: 'unavailable' }),
  },
  on: () => () => {},
  agentTools: {
    onCall: () => () => {},
    onCancel: () => () => {},
    respond: () => {},
  },
  agentConfirm: {
    onRequest: () => () => {},
    onCancel: () => () => {},
    respond: () => {},
    onUserInputRequest: () => () => {},
    onUserInputCancel: () => () => {},
    respondUserInput: () => {},
  },
  largeFileImportDialog: {
    onRequest: () => () => {},
    onCancel: () => () => {},
    respond: () => {},
  },
  startup: {
    getState: async () => ({ loadId: 'browser', pageLoaded: true, shellReady: false }),
    isErrorReportingEnabled: async () => false,
    acknowledge: async () => true,
  },
  app: {
    reportDirtyState: () => {},
    saveAllDone: () => {},
  },
  update: {
    install: async () => ({
      status: 'failed',
      message: 'Automatic update installation is available only in the desktop app.',
    }),
    retry: async () => {},
    checkManual: async () => {},
    simulate: async () => {},
  },
  keyring: {
    hasPassword: hasBrowserMockPassword,
    getPassword: getBrowserMockPassword,
    setPassword: setBrowserMockPassword,
    deletePassword: deleteBrowserMockPassword,
  },
  genomeCredentials: {
    save: async () => {
      throw new Error('Private genomic source credentials are only available in the desktop app.');
    },
    status: async (authRef: string) => ({ authRef, connected: false }),
    prepare: async () => {
      throw new Error('Private genomic source credentials are only available in the desktop app.');
    },
    remove: async (authRef: string) => ({ authRef, removed: false }),
  },
  workspaceMutations: { onLifecycle: () => () => {} },
  compute: {
    recoverLegacyResult: async () => {
      throw new Error('Compute recovery is only available in the desktop app.');
    },
    listProviders: async () => [],
    installManifest: async () => ({
      ok: false,
      kind: 'sidecar_unavailable',
      message: 'Custom compute endpoints are only available in the desktop app.',
    }),
    removeCustomProvider: async () => ({
      ok: false,
      kind: 'not_found',
      message: 'Custom compute endpoints are only available in the desktop app.',
    }),
    connect: async () => ({
      ok: false,
      kind: 'sidecar_unavailable',
      message: 'Compute providers are only available in the desktop app.',
    }),
    test: async () => ({
      ok: false,
      kind: 'sidecar_unavailable',
      message: 'Compute providers are only available in the desktop app.',
    }),
    disconnect: async (providerId: string) => ({ ok: true, providerId, removed: false }),
    recordJobIntent: async () => {
      throw new Error('Compute jobs are only available in the desktop app.');
    },
    markJobSubmitted: async () => null,
    markJobSubmissionUnknown: async () => null,
    markJobFailed: async () => null,
    markJobCanceled: async () => null,
    markJobImported: async () => null,
    listJobs: async () => [],
    listJobsSnapshot: async () => {
      throw new Error('Compute jobs are only available in the desktop app.');
    },
    findJob: async () => null,
  },
  cloudSync: {
    backupWorkspace: async () => {
      throw new Error('Cloud sync is only available in the desktop app.');
    },
    shareWorkspace: async () => {
      throw new Error('Cloud sync is only available in the desktop app.');
    },
    listSnapshots: async () => [],
    restoreSnapshot: async () => {
      throw new Error('Cloud restore is only available in the desktop app.');
    },
    getStatus: async (workspaceUuid) => browserMockSyncStatus(parseWorkspaceUuid(workspaceUuid)),
    subscribeStatus: (workspaceUuid, callback) => {
      const parsedWorkspaceUuid = parseWorkspaceUuid(workspaceUuid);
      const statusEvent: WorkspaceSyncStatusEvent = {
        workspaceUuid: parsedWorkspaceUuid,
        status: browserMockSyncStatus(parsedWorkspaceUuid),
        reason: 'subscribe',
        sequence: ++browserMockSyncSequence,
        emittedAt: Date.now(),
      };
      callback(statusEvent);
      return () => {};
    },
    onOrganizationRegistryChanged: () => () => {},
    onReplicaLifecycle: () => () => {},
    setEnabled: async (workspaceUuid, enabled) => {
      parseWorkspaceUuid(workspaceUuid);
      parseWorkspaceSyncEnabled(enabled);
      return workspaceSyncNotImplemented('setEnabled');
    },
    listOrganizations: async () => workspaceSyncNotImplemented('listOrganizations'),
    createOrganization: async () => workspaceSyncNotImplemented('createOrganization'),
    updateOrganization: async () => workspaceSyncNotImplemented('updateOrganization'),
    deleteOrganization: async () => workspaceSyncNotImplemented('deleteOrganization'),
    listOrganizationDirectory: async () => workspaceSyncNotImplemented('listOrganizationDirectory'),
    getOrganizationProvisioningStatus: async () =>
      workspaceSyncNotImplemented('getOrganizationProvisioningStatus'),
    openOrganizationProvisioningPortal: async () =>
      workspaceSyncNotImplemented('openOrganizationProvisioningPortal'),
    setOrganizationProvisioningGroupRole: async () =>
      workspaceSyncNotImplemented('setOrganizationProvisioningGroupRole'),
    listOrganizationAudit: async () => workspaceSyncNotImplemented('listOrganizationAudit'),
    inviteOrganizationMember: async () => workspaceSyncNotImplemented('inviteOrganizationMember'),
    resendOrganizationInvite: async () => workspaceSyncNotImplemented('resendOrganizationInvite'),
    revokeOrganizationInvite: async () => workspaceSyncNotImplemented('revokeOrganizationInvite'),
    changeOrganizationMemberRole: async () =>
      workspaceSyncNotImplemented('changeOrganizationMemberRole'),
    removeOrganizationMember: async () => workspaceSyncNotImplemented('removeOrganizationMember'),
    transferOrganizationOwnership: async () =>
      workspaceSyncNotImplemented('transferOrganizationOwnership'),
    prepareOrganizationRegistryClaim: async () =>
      workspaceSyncNotImplemented('prepareOrganizationRegistryClaim'),
    claimOrganizationRegistryEntity: async () =>
      workspaceSyncNotImplemented('claimOrganizationRegistryEntity'),
    listCachedOrganizationRegistries: async () =>
      workspaceSyncNotImplemented('listCachedOrganizationRegistries'),
    getOrganizationRegistry: async () => workspaceSyncNotImplemented('getOrganizationRegistry'),
    getOrganizationRegistryRecordSyncStatus: async () =>
      workspaceSyncNotImplemented('getOrganizationRegistryRecordSyncStatus'),
    getOrganizationRegistrySavedRecordReview: async () =>
      workspaceSyncNotImplemented('getOrganizationRegistrySavedRecordReview'),
    resolveOrganizationRegistrySavedRecord: async () =>
      workspaceSyncNotImplemented('resolveOrganizationRegistrySavedRecord'),
    getOrganizationRegistryRecordDetails: async () =>
      workspaceSyncNotImplemented('getOrganizationRegistryRecordDetails'),
    syncOrganizationRegistry: async () => workspaceSyncNotImplemented('syncOrganizationRegistry'),
    mutateOrganizationRegistry: async () =>
      workspaceSyncNotImplemented('mutateOrganizationRegistry'),
    configureOrganizationRegistry: async () =>
      workspaceSyncNotImplemented('configureOrganizationRegistry'),
    getOrganizationRegistrySyncHealth: async () =>
      workspaceSyncNotImplemented('getOrganizationRegistrySyncHealth'),
    getOrganizationDeletionImpact: async () =>
      workspaceSyncNotImplemented('getOrganizationDeletionImpact'),
    resolveOrganizationRegistryConflict: async () =>
      workspaceSyncNotImplemented('resolveOrganizationRegistryConflict'),
    listAccess: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('listAccess');
    },
    setAccess: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('setAccess');
    },
    inviteCollaborator: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('inviteCollaborator');
    },
    revokeInvite: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('revokeInvite');
    },
    resendInvite: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('resendInvite');
    },
    reconcile: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('reconcile');
    },
    getMergeConflict: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('getMergeConflict');
    },
    resolveMergeConflict: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('resolveMergeConflict');
    },
    forceSync: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('forceSync');
    },
    copyShareLink: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('copyShareLink');
    },
    listSyncedProjects: async () => [],
    openSyncedProject: async (remoteWorkspaceId) => {
      parseRemoteWorkspaceId(remoteWorkspaceId);
      return workspaceSyncNotImplemented('openSyncedProject');
    },
    recoverScientificDrafts: async (workspaceUuid, candidateId) => {
      parseWorkspaceUuid(workspaceUuid);
      parseRemoteWorkspaceId(candidateId, 'candidateId');
      return workspaceSyncNotImplemented('recoverScientificDrafts');
    },
    resolveConflict: async (workspaceUuid, resolution) => {
      parseWorkspaceUuid(workspaceUuid);
      parseWorkspaceSyncConflictResolution(resolution);
      return workspaceSyncNotImplemented('resolveConflict');
    },
    deleteCloudCopy: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('deleteCloudCopy');
    },
    updateSelection: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('updateSelection');
    },
    previewUpload: async (workspaceUuid) => {
      parseWorkspaceUuid(workspaceUuid);
      return workspaceSyncNotImplemented('previewUpload');
    },
    preflightDeepShare: async (request) => {
      parseWorkspaceUuid(request.workspaceUuid);
      return {
        ok: false as const,
        code: 'WORKSPACE_NOT_READY' as const,
        message: 'Deep Share is only available in the desktop app.',
      };
    },
    publishDeepShare: async (request) => {
      parseWorkspaceUuid(request.workspaceUuid);
      return {
        ok: false as const,
        code: 'PUBLISH_FAILED' as const,
        message: 'Deep Share is only available in the desktop app.',
      };
    },
    cancelDeepShare: async () => ({ ok: true }),
  },
  agentSdk: {
    detect: async (_pathOverrides) => ({
      claudeCode: {
        cli: 'missing' as const,
        path: null,
        auth: 'unauthenticated' as const,
        defaultModel: null,
        keychainEntryPresent: null,
        credentialsFilePresent: null,
      },
      codex: {
        cli: 'missing' as const,
        path: null,
        auth: 'unauthenticated' as const,
        defaultModel: null,
        authMode: null,
        authFilePresent: false,
      },
      grok: {
        cli: 'missing' as const,
        path: null,
        auth: 'unauthenticated' as const,
        defaultModel: null,
      },
    }),
    getHelperLifecycleSnapshot: async () => ({
      active: 0,
      started: 0,
      settled: 0,
      peakActive: 0,
    }),
    getExternalMcpRegistration: async () => ({
      state: 'development-build' as const,
      launcher: null,
      clients: [],
    }),
    refreshExternalMcpRegistration: async () => ({
      state: 'development-build' as const,
      launcher: null,
      clients: [],
    }),
    getMcpHttpStatus: async () => ({
      enabled: false,
      port: DEFAULT_MCP_HTTP_PORT,
      allowedHosts: [],
      state: 'unavailable' as const,
      url: null,
    }),
    setMcpHttp: async (settings) => ({
      ...settings,
      state: 'unavailable' as const,
      url: null,
    }),
    probeMatrix: async () => [
      {
        transport: 'codex-sdk' as const,
        cliInstalled: false,
        authenticated: false,
        sdkVersion: null,
        cliVersion: null,
        toolAccess: 'none' as const,
        permission: {
          mode: 'unsupported' as const,
          promptSurface: 'not_supported' as const,
          nonInteractiveDenial: 'not_supported' as const,
        },
        releaseMode: 'unsupported' as const,
        stop: {
          modelStream: 'not_supported' as const,
          providerTool: 'not_supported' as const,
          childProcessReaping: 'not_supported' as const,
          mechanisms: [],
          userVisibleStopState: 'unsupported' as const,
        },
        warnings: ['Agent SDK probes are not available in the browser mock.'],
      },
      {
        transport: 'claude-agent-sdk' as const,
        cliInstalled: false,
        authenticated: false,
        sdkVersion: null,
        cliVersion: null,
        toolAccess: 'none' as const,
        permission: {
          mode: 'unsupported' as const,
          promptSurface: 'not_supported' as const,
          nonInteractiveDenial: 'not_supported' as const,
        },
        releaseMode: 'unsupported' as const,
        stop: {
          modelStream: 'not_supported' as const,
          providerTool: 'not_supported' as const,
          childProcessReaping: 'not_supported' as const,
          mechanisms: [],
          userVisibleStopState: 'unsupported' as const,
        },
        warnings: ['Agent SDK probes are not available in the browser mock.'],
      },
      {
        transport: 'grok-acp' as const,
        cliInstalled: false,
        authenticated: false,
        sdkVersion: null,
        cliVersion: null,
        toolAccess: 'none' as const,
        permission: {
          mode: 'unsupported' as const,
          promptSurface: 'not_supported' as const,
          nonInteractiveDenial: 'not_supported' as const,
        },
        releaseMode: 'unsupported' as const,
        stop: {
          modelStream: 'not_supported' as const,
          providerTool: 'not_supported' as const,
          childProcessReaping: 'not_supported' as const,
          mechanisms: [],
          userVisibleStopState: 'unsupported' as const,
        },
        warnings: ['Agent SDK probes are not available in the browser mock.'],
      },
    ],
    onTraceEvent: () => () => {},
    onAuthEvent: () => () => {},
    cancelQuery: async () => ({ ok: true, cancelled: false }),
    authenticate: async (transport, options) => ({
      authId: options?.authId ?? 'browser-mock-auth',
      transport,
      ok: false,
      status: 'not_installed' as const,
      command: [],
      output: '',
      error: 'Agent CLI sign-in is not available in the browser mock.',
      durationMs: 0,
    }),
    query: async (transport) => ({
      transport,
      ok: false,
      text: '',
      error: 'Agent SDK probes are not available in the browser mock.',
      durationMs: 0,
    }),
  },
  agentCapabilities: {
    discover: async (request) => ({
      schemaVersion: 1,
      snapshotId: `browser-mock-${request.provider}`,
      provider: request.provider,
      providerVersion: null,
      accountFingerprint: null,
      workspaceFingerprint: null,
      capturedAt: 0,
      controls: [],
    }),
    resolve: async () => ({ ok: false, reason: 'stale-snapshot' as const }),
    inspectSkill: async () => ({
      ok: false,
      error: 'Skill inspection is not available in the browser mock.',
    }),
    forkConversation: async () => ({
      ok: false,
      error: 'Conversation forking is not available in the browser mock.',
    }),
    listManaged: async () => ({ commands: [], skills: [], memory: [] }),
    saveCommand: async () => ({
      ok: false,
      error: 'Custom commands are not available in the browser mock.',
    }),
    saveSkill: async () => ({
      ok: false,
      error: 'Managed skills are not available in the browser mock.',
    }),
    importSkill: async () => ({
      ok: false,
      error: 'Managed skills are not available in the browser mock.',
    }),
    setSkillEnabled: async () => ({
      ok: false,
      error: 'Managed skills are not available in the browser mock.',
    }),
    setProviderSkillEnabled: async () => ({
      ok: false,
      error: 'CLI skill policies are not available in the browser mock.',
    }),
    listSkillPacks: async () => [],
    browseSkillPack: async () => ({
      ok: false,
      error: 'The skill catalog is not available in the browser mock.',
    }),
    reviewCatalogSkill: async () => ({
      ok: false,
      error: 'The skill catalog is not available in the browser mock.',
    }),
    installCatalogSkill: async () => ({
      ok: false,
      error: 'The skill catalog is not available in the browser mock.',
    }),
    removeSkill: async () => ({
      ok: false,
      error: 'Managed skills are not available in the browser mock.',
    }),
    removeCommand: async () => ({
      ok: false,
      error: 'Custom commands are not available in the browser mock.',
    }),
    saveMemory: async () => ({
      ok: false,
      error: 'Agent memory is not available in the browser mock.',
    }),
    removeMemory: async () => ({
      ok: false,
      error: 'Agent memory is not available in the browser mock.',
    }),
    resetProviderMemory: async () => ({
      ok: false,
      error: 'Provider memory is not available in the browser mock.',
    }),
    inspectProviderPlugin: async () => ({
      ok: false,
      error: 'Provider plugins are not available in the browser mock.',
    }),
    installProviderPlugin: async () => ({
      ok: false,
      error: 'Provider plugins are not available in the browser mock.',
    }),
    removeProviderPlugin: async () => ({
      ok: false,
      error: 'Provider plugins are not available in the browser mock.',
    }),
  },
  agentAttachments: {
    capture: async () => ({
      ok: false,
      error: 'AI attachments are not available in the browser mock.',
    }),
    read: async () => ({
      ok: false,
      error: 'AI attachments are not available in the browser mock.',
    }),
  },
  agentSession: {
    onEvent: () => () => {},
    start: async (request) => ({
      sessionId: request.sessionId ?? 'browser-mock-session',
      provider: request.provider,
      authorityProfileId: request.authorityProfileId,
      ok: false,
      text: '',
      error: 'Agent sessions are not available in the browser mock.',
      durationMs: 0,
      stopState: 'failed' as const,
      workspaceProvenance: {
        policy: request.workspaceGrounding,
        grounded: false,
        completedWorkspaceTools: [],
        completedWorkspaceResources: [],
      },
    }),
    cancel: async () => ({ ok: true, cancelled: false, state: 'not_found' as const }),
    get: async () => null,
    listSchedules: async () => [],
    cancelSchedule: async () => ({ ok: false, schedule: null }),
    listAlwaysAllowRules: async () => [],
    setAlwaysAllowRuleEnabled: async () => [],
    removeAlwaysAllowRule: async () => [],
    permissionCatalog: async () => BUILT_IN_AGENT_PERMISSION_CATALOG,
  },
  conversationLedger: {
    appendEvent: async () => ({ ok: false, event: null }),
    unlinkConversation: async () => ({ ok: true }),
  },
  config: {
    getApiUrl: async () => getBrowserMockApiUrl(),
    getSidecarStatus: async () => 'ready',
    restartSidecar: async () => 'ready',
  },
  feedback: {
    report: async () => ({
      ok: false,
      code: 'FEEDBACK_UNAVAILABLE',
      error: 'Agent reporting requires the DNAForge desktop app.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    }),
    send: async (payload) => ({ success: true, submission_id: payload.submission_id }),
    cancel: async (id) => ({ success: false, submission_id: id, error: 'cancelled' }),
  },
  internalFixtures: {
    recoverTrack: async () => {
      throw new Error('Recovering track fixtures requires Electron.');
    },
    retainTrack: async () => {
      throw new Error('Retaining track fixtures requires Electron.');
    },
    materialize: async () => {
      throw new Error('Internal assembly fixture loaders require Electron.');
    },
    status: async () => {
      throw new Error('Internal assembly fixture loaders require Electron.');
    },
    registerScenarioFiles: async () => {
      throw new Error('Registering scenario files requires Electron.');
    },
  },
  analytics: {
    getRuntimeConfig: async () => null,
    writeTableNotebookReceipt: async () => false,
    getOptIn: async () => false,
    persistConsent: async () => {},
    syncContext: async () => ({
      accepted: false,
      authority: {
        actorKind: 'unknown',
        executionMode: 'interactive',
        impersonated: false,
      },
    }),
    setConsent: async () => {},
  },
  convertFileSrc: async (path) => `https://placehold.co/800x600?text=${encodeURIComponent(path)}`,
};

async function mockQueryRegistrySummaries(
  input: LimsQueryRegistrySummariesInput = {}
): Promise<LimsRegistrySummaryPage> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const offset = Math.max(input.offset ?? 0, 0);
  const search = input.search?.trim().toLowerCase();
  const nameLike = input.nameLike?.trim().toLowerCase();
  const sequenceLike = input.sequenceLike?.trim().toLowerCase();
  const registryIdLike = input.registryIdLike?.trim().toLowerCase();
  const kinds = input.kinds && input.kinds.length > 0 ? new Set(input.kinds) : null;
  const statuses =
    input.registrationStatuses && input.registrationStatuses.length > 0
      ? new Set<string>(input.registrationStatuses)
      : null;
  const idFilter = input.ids ? new Set(input.ids) : null;
  const projectFilter = input.workspaceIds ? new Set(input.workspaceIds) : null;
  const candidates = mockLimsEntities.filter(
    (entity) => input.includeArchived || !entity.tombstone
  );
  const summaries = candidates

    .map((entity) => ({ entity, summary: mockRegistrySummary(entity) }))
    .filter(({ entity, summary }) => {
      if (
        projectFilter &&
        (entity.workspaceId === null || !projectFilter.has(entity.workspaceId))
      ) {
        return false;
      }
      if (idFilter && !idFilter.has(summary.id)) return false;
      if (input.kind && summary.kind !== input.kind) return false;
      if (kinds && !kinds.has(summary.kind)) return false;
      if (input.registrationStatus && summary.registrationStatus !== input.registrationStatus) {
        return false;
      }
      if (statuses && !statuses.has(summary.registrationStatus)) return false;
      if (input.domainStatus !== undefined && summary.domainStatus !== input.domainStatus) {
        return false;
      }
      if (input.representationKind && summary.representation.kind !== input.representationKind) {
        return false;
      }
      if (search && !summary.searchableText.toLowerCase().includes(search)) return false;
      if (nameLike && !summary.name.toLowerCase().includes(nameLike)) return false;
      if (sequenceLike && !entitySequenceSearchText(entity).toLowerCase().includes(sequenceLike)) {
        return false;
      }
      if (registryIdLike && !(summary.registryId ?? '').toLowerCase().includes(registryIdLike)) {
        return false;
      }
      if (input.updatedOn !== undefined) {
        const s = startOfDayMs(input.updatedOn);
        if (summary.updatedAt < s || summary.updatedAt >= endOfDayMs(input.updatedOn)) return false;
      }
      if (input.updatedAfter !== undefined && summary.updatedAt < endOfDayMs(input.updatedAfter)) {
        return false;
      }
      if (
        input.updatedBefore !== undefined &&
        summary.updatedAt >= startOfDayMs(input.updatedBefore)
      ) {
        return false;
      }
      return true;
    })
    .map(({ summary }) => summary)
    .sort((a, b) => compareRegistrySummaries(a, b, input.sort ?? 'updated_desc'));
  const db = await getMockDb();
  const projects = await db.select<Array<{ id: number; name: string }>>(
    'SELECT id, name FROM workspaces'
  );
  const projectCounts = new Map<number, number>();
  for (const entity of candidates) {
    if (entity.workspaceId !== null) {
      projectCounts.set(entity.workspaceId, (projectCounts.get(entity.workspaceId) ?? 0) + 1);
    }
  }
  return {
    summaries: summaries.slice(offset, offset + limit),
    totalCount: summaries.length,
    limit,
    offset,
    availableProjects: projects
      .filter((project) => projectCounts.has(project.id))
      .map((project) => ({
        workspaceId: project.id,
        name: project.name,
        count: projectCounts.get(project.id) ?? 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.workspaceId - b.workspaceId),
  };
}

function mockGetRegistryPreview(input: LimsRegistryPreviewInput): LimsRegistryPreview {
  const entity = requireMockLimsEntity(input.entityId);
  const outgoingLinks = mockLimsLinks
    .filter((link) => link.fromEntityId === entity.id && !link.tombstone)
    .map((link) => mockLinkedRegistryEntitySummary(link, link.toEntityId));
  const incomingLinks = mockLimsLinks
    .filter((link) => link.toEntityId === entity.id && !link.tombstone)
    .map((link) => mockLinkedRegistryEntitySummary(link, link.fromEntityId));
  return {
    entity,
    summary: mockRegistrySummary(entity),
    schemaSnapshot: mockSchemaSnapshot(entity),
    outgoingLinks,
    incomingLinks,
    strainGenomeSummary: entity.kind === 'strain' ? mockStrainGenomeSummary(entity.id) : undefined,
  };
}

function mockGetStrainGenomeSummaries(
  input: LimsStrainGenomeSummariesInput
): LimsStrainGenomeSummariesResult {
  const summaries: Record<string, LimsStrainGenomeSummary> = {};
  for (const strainEntityId of input.strainEntityIds) {
    summaries[strainEntityId] = mockStrainGenomeSummary(strainEntityId);
  }
  return { summaries };
}

function mockRegistrySummary(entity: LimsEntity): LimsRegistrySummary {
  const sequence = entity.fields.sequence as DnaSequenceRef | undefined;
  const links = mockLinksForEntity(entity.id);
  const strainGenomeSummary = entity.kind === 'strain' ? mockStrainGenomeSummary(entity.id) : null;
  const evidenceSummary = strainGenomeSummary
    ? {
        confidenceLabel: registryConfidenceLabel(strainGenomeSummary),
        gapStatus: strainGenomeSummary.gap.status,
        gapMessage: strainGenomeSummary.gap.message,
        parentGenomeName: strainGenomeSummary.parentGenome?.name,
        hypothesisGenomeName: strainGenomeSummary.hypothesisGenome?.name,
        verifiedGenomeName: strainGenomeSummary.verifiedGenome?.name,
      }
    : undefined;
  const representation = mockRegistryRepresentation(entity, sequence);
  const schemaSnapshot = mockSchemaSnapshot(entity);
  return {
    id: entity.id,
    kind: entity.kind,
    schemaSnapshot,
    fieldValues: resolveEntityRecordFieldValues(schemaSnapshot, entity.fields, {
      length:
        sequence?.mode === 'file' || sequence?.mode === 'inline' ? sequence.length : undefined,
      topology:
        sequence?.mode === 'file' || sequence?.mode === 'inline' ? sequence.topology : undefined,
    }),
    schemaDisplayName: schemaSnapshot.displayName,
    name: entity.name,
    registryId: entity.registryId ?? null,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
    representation,
    summary:
      entity.kind === 'strain'
        ? `${String(entity.fields.genotypeCanonical ?? 'No genotype recorded')}; ${
            evidenceSummary?.gapMessage ?? ''
          }`
        : sequence?.mode === 'file'
          ? `${sequence.topology} ${entity.kind} sequence, ${sequence.length} bp`
          : sequence?.mode === 'inline'
            ? entity.kind === 'oligo'
              ? 'Oligo sequence'
              : 'Stored sequence'
            : entity.kind === 'organism'
              ? String(entity.fields.scientificName ?? entity.name)
              : `${entity.kind} record`,
    evidenceSummary,
    sequenceSummary:
      sequence?.mode === 'file'
        ? {
            topology: sequence.topology,
            length: sequence.length,
            sourceFormat: sequence.sourceFormat,
            contentHash: sequence.contentHash,
            fileContentHash: sequence.fileContentHash,
            normalizedSequenceHash: sequence.normalizedSequenceHash,
          }
        : sequence?.mode === 'inline'
          ? {
              topology: sequence.topology,
              length: sequence.length,
              inlineBases: sequence.bases,
              contentHash: sequence.contentHash,
            }
          : undefined,
    linkSummary: mockLinkSummary(links),
    searchableText: mockSearchableText(entity),
    updatedAt: entity.updatedAt,
    archived: Boolean(entity.tombstone),
  };
}

function mockSchemaSnapshot(entity: LimsEntity): ProjectableEntitySchemaRevisionSnapshot {
  const builtin = LIMS_BUILTIN_ENTITY_SCHEMAS.find((schema) => schema.name === entity.kind);
  return {
    schemaId: entity.schemaId ?? `schema-entity-${entity.kind}`,
    schemaRevisionId: entity.schemaRevisionId,
    name: entity.kind,
    displayName: builtin?.displayName ?? entity.kind,
    description: builtin?.description,
    baseKind: builtin?.baseKind ?? entity.kind,
    version: 1,
    fields: (
      builtin?.fields ??
      Object.keys(entity.fields).map((key) => ({ key, label: key, type: 'text' as const }))
    ).map((field) => ({ ...field })),
  };
}

function mockRegistryRepresentation(
  entity: LimsEntity,
  sequence: DnaSequenceRef | undefined
): LimsRegistrySummary['representation'] {
  if (entity.kind === 'protein') {
    const proteinSequence = entity.fields.sequence as ProteinSequenceRef | undefined;
    if (proteinSequence?.mode === 'inline') {
      return {
        kind: 'protein_sequence',
        label: 'Protein sequence',
        canOpen: true,
        openTarget: {
          kind: 'protein_sequence',
          entityId: entity.id,
          entityKind: entity.kind,
          label: entity.name,
          registrationStatus: entity.registrationStatus,
        },
      };
    }
  }
  if (sequence?.mode === 'file') {
    return {
      kind: 'file_sequence',
      label: sequence.topology === 'circular' ? 'Circular DNA sequence' : 'Linear DNA sequence',
      canOpen: true,
      openTarget: {
        kind: 'sequence_file',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
        documentId: sequence.documentId,
        registrationStatus: entity.registrationStatus,
        sequence: {
          topology: sequence.topology,
          length: sequence.length,
          contentHash: sequence.contentHash,
          fileContentHash: sequence.fileContentHash,
          normalizedSequenceHash: sequence.normalizedSequenceHash,
          sourceFormat: sequence.sourceFormat,
          sequenceId: sequence.sequenceId,
          sizeBytes: sequence.sizeBytes,
          modifiedAt: sequence.modifiedAt,
        },
        source: typeof entity.fields.source === 'string' ? entity.fields.source : undefined,
      },
    };
  }
  if (sequence?.mode === 'inline') {
    return {
      kind: 'inline_sequence',
      label: entity.kind === 'oligo' ? 'Oligo sequence' : 'Stored sequence',
      canOpen: false,
      openTarget: {
        kind: 'record_detail',
        entityId: entity.id,
        entityKind: entity.kind,
        label: entity.name,
        reason: 'inline_sequence',
        inlineSequence: {
          length: sequence.length,
          topology: sequence.topology,
          contentHash: sequence.contentHash,
        },
      },
    };
  }
  if (sequence?.mode === 'unresolved') {
    return {
      kind: 'unresolved',
      label: 'Unresolved sequence',
      canOpen: false,
      openTarget: mockRecordDetailOpenTarget(entity, 'unresolved_sequence'),
    };
  }
  if (entity.kind === 'strain') {
    return {
      kind: 'strain_evidence',
      label: 'Strain evidence',
      canOpen: false,
      openTarget: mockRecordDetailOpenTarget(entity, 'strain_evidence'),
    };
  }
  if (entity.kind === 'organism') {
    return {
      kind: 'organism_record',
      label: 'Organism record',
      canOpen: false,
      openTarget: mockRecordDetailOpenTarget(entity, 'organism_record'),
    };
  }
  return {
    kind: 'none',
    label: 'Record metadata',
    canOpen: false,
    openTarget: mockRecordDetailOpenTarget(entity, 'no_primary_representation'),
  };
}

function mockRecordDetailOpenTarget(
  entity: LimsEntity,
  reason: Extract<LimsRegistryOpenTarget, { kind: 'record_detail' }>['reason']
): LimsRegistryOpenTarget {
  return {
    kind: 'record_detail',
    entityId: entity.id,
    entityKind: entity.kind,
    label: entity.name,
    reason,
  };
}

function mockLinksForEntity(entityId: string): { outgoing: LimsLink[]; incoming: LimsLink[] } {
  return {
    outgoing: mockLimsLinks.filter((link) => link.fromEntityId === entityId && !link.tombstone),
    incoming: mockLimsLinks.filter((link) => link.toEntityId === entityId && !link.tombstone),
  };
}

function mockLinkSummary(links: {
  outgoing: LimsLink[];
  incoming: LimsLink[];
}): LimsRegistrySummary['linkSummary'] {
  const notable = [
    ...links.incoming.map((link) => ({
      type: link.type,
      label: requireMockLimsEntity(link.fromEntityId).name,
      entityId: link.fromEntityId,
    })),
    ...links.outgoing.map((link) => ({
      type: link.type,
      label: requireMockLimsEntity(link.toEntityId).name,
      entityId: link.toEntityId,
    })),
  ]
    .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label))
    .slice(0, 8);
  return {
    outgoingCount: links.outgoing.length,
    incomingCount: links.incoming.length,
    notable,
  };
}

function mockLinkedEntitySummary(entity: LimsEntity): LimsRegistryLinkedEntitySummary['entity'] {
  return {
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    registrationStatus: entity.registrationStatus,
    domainStatus: entity.domainStatus,
  };
}

function mockLinkedRegistryEntitySummary(
  link: LimsLink,
  entityId: string
): LimsRegistryLinkedEntitySummary {
  const entity = requireMockLimsEntity(entityId);
  return {
    link,
    entity: mockLinkedEntitySummary(entity),
    summary: mockRegistrySummary(entity),
  };
}

function mockSearchableText(entity: LimsEntity): string {
  const parts = [entity.id, entity.kind, entity.name, entity.registrationStatus];
  for (const value of Object.values(entity.fields)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
    } else if (Array.isArray(value)) {
      parts.push(value.filter((item) => typeof item === 'string').join(' '));
    } else if (value && typeof value === 'object') {
      const sequence = value as Partial<DnaSequenceRef>;
      if (sequence.mode === 'file') parts.push(String(sequence.relPath ?? ''));
      if (sequence.mode) parts.push(String(sequence.mode));
    }
  }
  return parts.filter(Boolean).join(' ');
}

function mockLimsDefinedSchema(input: LimsDefineSchemaInput): LimsSchemaRow {
  const now = Date.now();
  return {
    id: input.id ?? crypto.randomUUID(),
    kind: input.kind,
    name: input.name,
    display_name: input.displayName,
    description: input.description ?? null,
    fields: JSON.stringify(input.fields),
    current_revision_id: null,
    version: 1,
    builtin: 0,
    workspace_id: null,
    actor: 'local-user',
    event_seq: null,
    tombstone: 0,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
}

function mockLimsRefinedSchema(input: LimsRefineSchemaInput): LimsSchemaRow {
  const now = Date.now();
  return {
    id: input.schemaId,
    kind: 'entity',
    name: input.schemaId,
    display_name: input.schemaId,
    description: input.description ?? null,
    fields: JSON.stringify(input.fields),
    current_revision_id: null,
    version: 2,
    builtin: 0,
    workspace_id: input.workspaceId ?? null,
    actor: input.actor ?? 'local-user',
    event_seq: null,
    tombstone: 0,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
}

function mockLimsTelemetryRow(input: LimsTelemetryInput): LimsAuditRow {
  return {
    id: crypto.randomUUID(),
    event_seq: 0,
    schema_version: null,
    idempotency_key: null,
    operation_id: null,
    event_type: input.eventType,
    subject_table: input.subjectTable ?? null,
    subject_id: input.subjectId ?? null,
    batch_id: null,
    actor: input.actor ?? 'local-user',
    actor_client_id: null,
    actor_user_id: null,
    workspace_id: input.workspaceId ?? null,
    before: null,
    after: null,
    payload: input.payload ? JSON.stringify(input.payload) : null,
    prev_hash: null,
    hash: null,
    tombstone: 0,
    created_at: Date.now(),
  };
}

function mockLimsEntity(input: LimsRegisterEntityInput): LimsEntity {
  const now = Date.now();
  return {
    id: input.id ?? crypto.randomUUID(),
    kind: input.kind,
    schemaId: null,
    schemaRevisionId: input.schemaRevisionId ?? `schema-entity-${input.kind}-v1`,
    name: input.name,
    registryId: null,
    fields: input.fields,
    registrationStatus: input.registrationStatus ?? 'registered',
    domainStatus: input.domainStatus ?? null,
    workspaceId: input.workspaceId ?? null,
    actor: input.actor ?? 'local-user',
    eventSeq: mockLimsEntities.length + 1,
    tombstone: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function mockLimsLink(input: {
  id?: string;
  fromEntityId: string;
  toEntityId: string;
  type: string;
  payload?: Record<string, unknown>;
  workspaceId?: number | null;
  actor?: string | null;
}): LimsLink {
  const now = Date.now();
  return {
    id: input.id ?? crypto.randomUUID(),
    fromEntityId: input.fromEntityId,
    toEntityId: input.toEntityId,
    type: input.type,
    payload: input.payload ?? {},
    workspaceId: input.workspaceId ?? null,
    actor: input.actor ?? 'local-user',
    eventSeq: mockLimsLinks.length + 1,
    tombstone: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function requireMockLimsEntity(entityId: string): LimsEntity {
  const entity = mockLimsEntities.find((row) => row.id === entityId && !row.tombstone);
  if (!entity) throw new Error(`LIMS entity not found: ${entityId}`);
  return entity;
}

function mockStrainGenomeSummary(strainEntityId: string): LimsStrainGenomeSummary {
  const strain = requireMockLimsEntity(strainEntityId);
  const links = mockLimsLinks
    .filter((link) => link.fromEntityId === strainEntityId && link.type === 'has_genome')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const parentLink =
    mockLimsLinks.find(
      (link) =>
        link.fromEntityId === strainEntityId &&
        link.type === 'references' &&
        link.payload.role === 'parent_genome'
    ) ?? null;
  const hypothesisLink =
    links.find((link) => link.payload.confidence === 'hypothesis_supplied') ??
    links.find((link) => link.payload.confidence === 'hypothesis_from_genotype_projection') ??
    null;
  const verifiedLink = links.find((link) => link.payload.confidence === 'WGS_verified') ?? null;
  const parentGenome = parentLink ? requireMockLimsEntity(parentLink.toEntityId) : null;
  const hypothesisGenome = hypothesisLink ? requireMockLimsEntity(hypothesisLink.toEntityId) : null;
  const verifiedGenome = verifiedLink ? requireMockLimsEntity(verifiedLink.toEntityId) : null;
  const gap: LimsGenomeGapSummary = !hypothesisGenome
    ? {
        status: 'no_hypothesis',
        message: 'No genome hypothesis is linked for this strain yet.',
      }
    : !verifiedGenome
      ? {
          status: 'no_verified',
          hypothesisGenomeId: hypothesisGenome.id,
          message: 'Genome hypothesis exists; no WGS-verified genome is linked yet.',
        }
      : {
          status: 'mismatch',
          hypothesisGenomeId: hypothesisGenome.id,
          verifiedGenomeId: verifiedGenome.id,
          hypothesisLength: 77335,
          verifiedLength: 77335,
          lengthDelta: 0,
          mismatchCount: 1,
          firstDifferences: [{ position: 10, hypothesisBase: 'A', verifiedBase: 'C' }],
          message: 'Genome hypothesis disagrees with WGS: 1 base differences, length delta 0.',
        };
  return {
    strain,
    parentGenome,
    hypothesisGenome,
    verifiedGenome,
    parentLink,
    hypothesisLink,
    verifiedLink,
    gap,
  };
}

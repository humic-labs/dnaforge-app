import type { WorkspaceSessionSnapshot } from '@waypoint/domain-services';
import { userEntityLabel } from '@waypoint/user-messages';
import { hostedWorkspaceRoot, parseHostedFsPath } from './paths';
import {
  normalizeWorkspaceTimestamp,
  type WorkspaceAccess,
  type WorkspaceOwnerDiscovery,
} from '../shared/workspace-access';
import { pathIsAtOrUnder, pathRelativeToBoundary, rebasePath } from '../shared/path-boundary';
import {
  findCatalogRelocationConflict,
  planCatalogFileRelocation,
} from '../shared/catalog-relocation';
import {
  catalogJsonObject,
  requireCatalogText,
  type CatalogEntityLinkInput,
  type CatalogEntityLinkRow,
  type CatalogEventInput,
  type CatalogEventRow,
  type CatalogEntityPresentationInput,
} from '../shared/catalog-associations';
import {
  parseCatalogEntityPresentation,
  planCatalogEntityPresentation,
} from '../shared/catalog-presentation';
import { FASTA_KIND_DECLARATION_EVENT } from '../shared/fasta-kind';
import {
  planCatalogEntityRegistration,
  type CatalogEntityRegistrationRequest,
  type CatalogEntityRow,
  type CatalogWorkspaceFileRegistrationRequest,
  type CatalogFileRebindRequest,
} from '../shared/catalog-registration';
import { parseCatalogFileBindingRequest } from '../shared/catalog-binding';
import type { ChatEntityReferenceIpcRow } from '../shared/chat-turn-ipc';
import {
  assertEntityReferenceMolecularTarget,
  isFrozenMolecularReference,
  sameEntityReferenceContent,
  updatedEntityReferenceRow,
  validatePreparedEntityReferenceRow,
  type EntityReferenceUpdates,
  type EntityReferenceRevisionInput,
  type EntityReferenceRevisionRow,
} from '../shared/entity-reference-ipc';
import { HostedCapabilityError } from './errors';
import {
  planCatalogMemoryFileBinding,
  type CatalogFileBindingRequest,
  type CatalogFileBindingRow,
} from '../shared/catalog-binding';
import { isAgentAttachmentManifest } from '../shared/agent-attachments';
import {
  validateTerminalReferenceProposals,
  type CommitChatTurnTerminalStateRequest,
  type CreateChatTurnWithUserMessageRequest,
  type CommitChatTurnTerminalStateResult,
} from '../shared/chat-turn-ipc';
import type { PrimerLegacyProjectionInput } from '../shared/primer-projection-ipc';
import {
  searchProjectedCatalogRows,
  type MountedCatalogSearchReader,
} from '../shared/workspace-search-catalog';

type SqlValue = string | number | boolean | null | Uint8Array;
type SqlRow = Record<string, SqlValue>;

export interface HostedMemoryDbSnapshot {
  tables: Array<[string, SqlRow[]]>;
  autoincrement: Array<[string, number]>;
}

const IDENT = String.raw`(?:[A-Za-z_][\w.]*|"[^"]+")`;
const NUMBER_LITERAL_RE = /^-?\d+(?:\.\d+)?$/u;
const INSERT_RE = new RegExp(
  String.raw`^INSERT(?:\s+OR\s+(REPLACE|IGNORE))?\s+INTO\s+(${IDENT})\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(?:\s+ON\s+CONFLICT\s*\(([^)]+)\)\s+DO\s+(NOTHING|UPDATE\s+SET\s+(.+)))?\s*;?\s*$`,
  'iu'
);
const DELETE_RE = new RegExp(
  String.raw`^DELETE\s+FROM\s+(${IDENT})(?:\s+WHERE\s+(.+?))?\s*;?\s*$`,
  'iu'
);
const UPDATE_RE = new RegExp(
  String.raw`^UPDATE\s+(${IDENT})\s+SET\s+(.+?)\s+WHERE\s+(.+?)\s*;?\s*$`,
  'iu'
);
const SELECT_RE = new RegExp(
  String.raw`^SELECT\s+(.+?)\s+FROM\s+(${IDENT})(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+(\d+|\?)(?:\s+OFFSET\s+(\d+|\?))?)?\s*;?\s*$`,
  'iu'
);
const ORDER_RE = new RegExp(String.raw`^(${IDENT})(?:\s+(ASC|DESC))?$`, 'iu');
const PRIMER_CATALOG_RESERVATION_PREFIX = 'primer_catalog_reservation:';
const CONVERSATION_HISTORY_RE =
  /^SELECT c\.\* FROM conversations c WHERE EXISTS \( SELECT 1 FROM messages m WHERE m\.conversation_id = c\.id \) ORDER BY c\.pinned DESC, c\.updated_at DESC\s*;?$/iu;
const CATALOG_FILE_WORKSPACE_RE =
  /^SELECT workspaces\.path AS path FROM catalog_entity_files JOIN workspaces ON workspaces\.id = catalog_entity_files\.workspace_id WHERE catalog_entity_files\.path = \? LIMIT 1\s*;?$/iu;

export interface HostedMemoryCatalogSource {
  snapshot: WorkspaceSessionSnapshot;
  displayName?: string;
}

export function createHostedMemoryDb(
  initial?: HostedMemoryDbSnapshot,
  options: { getCatalogSource?: () => HostedMemoryCatalogSource | null } = {}
) {
  const tables = new Map<string, SqlRow[]>(
    initial?.tables.map(([name, rows]) => [name, rows.map((row) => ({ ...row }))])
  );
  const autoincrement = new Map<string, number>(initial?.autoincrement);

  async function withTransaction<T>(work: () => Promise<T>): Promise<T> {
    const tableSnapshot = new Map(
      [...tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))] as const)
    );
    const autoincrementSnapshot = new Map(autoincrement);
    try {
      return await work();
    } catch (error) {
      tables.clear();
      for (const [name, rows] of tableSnapshot) tables.set(name, rows);
      autoincrement.clear();
      for (const [name, value] of autoincrementSnapshot) autoincrement.set(name, value);
      throw error;
    }
  }

  function tableKey(name: string): string {
    return name.replace(/["'`]/g, '').replace(/.*\./u, '').toLowerCase();
  }

  function table(name: string): SqlRow[] {
    const key = tableKey(name);
    const existing = tables.get(key);
    if (existing) return existing;
    const created: SqlRow[] = [];
    tables.set(key, created);
    return created;
  }

  function nextRowid(name: string): number {
    const key = tableKey(name);
    const next = (autoincrement.get(key) ?? 0) + 1;
    autoincrement.set(key, next);
    return next;
  }

  function rowValue(row: SqlRow, column: string): SqlValue | undefined {
    if (column in row) return row[column];
    const match = Object.keys(row).find((key) => key.toLowerCase() === column.toLowerCase());
    return match === undefined ? undefined : row[match];
  }

  function setRowValue(row: SqlRow, column: string, value: SqlValue): void {
    const match = Object.keys(row).find((key) => key.toLowerCase() === column.toLowerCase());
    row[match ?? column] = value;
  }

  function assertUniqueWorkspacePaths(rows: readonly SqlRow[]): void {
    const paths = new Set<SqlValue>();
    for (const row of rows) {
      const path = rowValue(row, 'path');
      if (path == null) continue;
      if (paths.has(path)) throw new Error('UNIQUE constraint failed: workspaces.path');
      paths.add(path);
    }
  }

  function matchesWhere(row: SqlRow, where: string | undefined, params: SqlValue[]): boolean {
    if (!where) return true;
    const cursor = { index: 0 };
    let matched = true;
    for (const part of splitWhere(where)) {
      const group = /^\((.+)\)$/u.exec(part);
      const alternatives = group ? group[1].split(/\s+OR\s+/iu) : [part];
      let any = false;
      for (const alternative of alternatives) {
        if (matchesPredicate(row, alternative.trim(), params, cursor)) any = true;
      }
      if (!any) matched = false;
    }
    return matched;
  }

  function matchesPredicate(
    row: SqlRow,
    part: string,
    params: SqlValue[],
    cursor: { index: number }
  ): boolean {
    const isNull = new RegExp(String.raw`^(${IDENT})\s+IS\s+NULL$`, 'iu').exec(part);
    if (isNull) {
      const value = rowValue(row, columnName(isNull[1]));
      return value === null || value === undefined;
    }
    const notNull = new RegExp(String.raw`^(${IDENT})\s+IS\s+NOT\s+NULL$`, 'iu').exec(part);
    if (notNull) {
      const value = rowValue(row, columnName(notNull[1]));
      return value !== null && value !== undefined;
    }
    const equals = new RegExp(String.raw`^(${IDENT})\s*=\s*(\?|-?\d+(?:\.\d+)?)$`, 'iu').exec(part);
    if (equals) {
      const expected = equals[2] === '?' ? params[cursor.index++] : Number(equals[2]);
      return rowValue(row, columnName(equals[1])) === expected;
    }
    const like = new RegExp(String.raw`^(${IDENT})\s+LIKE\s+\?$`, 'iu').exec(part);
    if (like) {
      const pattern = params[cursor.index++];
      const value = rowValue(row, columnName(like[1]));
      if (typeof pattern !== 'string' || value === null || value === undefined) return false;
      return likePattern(pattern).test(String(value));
    }
    const inList = new RegExp(String.raw`^(${IDENT})\s+IN\s*\(([^)]+)\)$`, 'iu').exec(part);
    if (inList) {
      const values = splitList(inList[2]).map(() => params[cursor.index++]);
      return values.includes(rowValue(row, columnName(inList[1])) ?? null);
    }
    cursor.index += (part.match(/\?/gu) ?? []).length;
    return false;
  }

  function findConflict(
    rows: SqlRow[],
    columns: string[],
    row: SqlRow,
    conflictColumns: string[]
  ): SqlRow | undefined {
    return rows.find((existing) =>
      conflictColumns.every((column) => {
        const name = columnName(column);
        const index = columns.findIndex((item) => item.toLowerCase() === name.toLowerCase());
        const value = index >= 0 ? row[columns[index]] : rowValue(row, name);
        return rowValue(existing, name) === value;
      })
    );
  }

  function catalogSource(root: string): {
    workspaceId: string;
    source: HostedMemoryCatalogSource | null;
  } {
    const parsed = typeof root === 'string' ? parseHostedFsPath(root) : null;
    if (
      !parsed?.workspaceId ||
      parsed.relativePath !== '' ||
      hostedWorkspaceRoot(parsed.workspaceId) !== root
    )
      throw new Error('Hosted catalog discovery requires a canonical hosted workspace root.');
    const source = options.getCatalogSource?.() ?? null;
    if (options.getCatalogSource && source?.snapshot.workspaceId !== parsed.workspaceId)
      throw new Error('Hosted catalog discovery must use the active hydrated workspace source.');
    return { workspaceId: parsed.workspaceId, source };
  }

  function requireHostedCatalogPath(root: string, path: string, rootFolder = false): void {
    if (rootFolder && path === root) {
      catalogSource(root);
      return;
    }
    const relativePath = pathRelativeToBoundary(path, root);
    if (
      !relativePath ||
      path !== `${root}/${relativePath}` ||
      relativePath.split('/').some((part) => part === '.' || part === '..')
    )
      throw new Error('Hosted catalog file must remain inside its exact workspace owner.');
    const { source } = catalogSource(root);
    if (
      source &&
      !source.snapshot.files.some(
        (file) => file.path === relativePath || file.path.startsWith(`${relativePath}/`)
      )
    )
      throw new Error('Hosted catalog file is absent from its hydrated workspace source.');
  }

  function ensureHostedWorkspaceOwner(
    root: string,
    access?: WorkspaceAccess,
    discovery?: WorkspaceOwnerDiscovery
  ): number {
    const { workspaceId, source } = catalogSource(root);
    if (access !== undefined && access !== 'writable' && access !== 'reference')
      throw new Error('Hosted workspace access classification is invalid.');
    if (
      discovery !== undefined &&
      (!discovery ||
        typeof discovery !== 'object' ||
        Array.isArray(discovery) ||
        Object.keys(discovery).some((key) => !['name', 'recordOpen'].includes(key)) ||
        (discovery.name !== undefined &&
          (typeof discovery.name !== 'string' ||
            !discovery.name.trim() ||
            discovery.name.includes('\0'))) ||
        (discovery.recordOpen !== undefined && typeof discovery.recordOpen !== 'boolean'))
    )
      throw new Error('Hosted workspace discovery metadata is invalid.');
    const rows = table('workspaces');
    const matches = rows.filter((row) => row.path === root);
    if (matches.length > 1) throw new Error('Hosted workspace owner identity is ambiguous.');
    const existing = matches[0];
    if (existing) {
      if (existing.repo_uuid != null && existing.repo_uuid !== workspaceId)
        throw new Error('Hosted workspace root belongs to another source identity.');
      if (discovery?.recordOpen && (existing.archived_at != null || existing.trashed_at != null))
        throw new Error('Restore the owning hosted project before opening it.');
      if (access === 'writable' && existing.access_mode === 'reference')
        throw new Error('A reference workspace cannot acquire write authority through discovery.');
      for (const field of ['created_at', 'last_opened_at', 'archived_at', 'trashed_at']) {
        const value = existing[field];
        if (typeof value === 'number') existing[field] = normalizeWorkspaceTimestamp(value);
      }
      existing.repo_uuid = workspaceId;
      if (source?.displayName?.trim())
        existing.name = userEntityLabel(source.displayName, 'project.untitled');
      existing.access_mode =
        access === 'reference' ? 'reference' : (existing.access_mode ?? 'writable');
      if (discovery?.recordOpen) existing.last_opened_at = Date.now();
      return Number(existing.id);
    }
    const now = Date.now();
    const id = nextRowid('workspaces');
    rows.push({
      id,
      name: source?.displayName ?? discovery?.name?.trim() ?? 'Hosted project',
      path: root,
      repo_uuid: workspaceId,
      access_mode: access ?? 'writable',
      created_at: now,
      last_opened_at: discovery?.recordOpen ? now : null,
      archived_at: null,
      trashed_at: null,
    });
    return id;
  }

  function planHostedCatalogEntity(input: CatalogEntityRegistrationRequest): CatalogEntityRow {
    if (!input.workspaceRoot)
      throw new Error('Hosted catalog identity requires its hydrated workspace owner.');
    const workspaceId = ensureHostedWorkspaceOwner(input.workspaceRoot);
    const { workspaceId: scope } = catalogSource(input.workspaceRoot);
    const rows = table('catalog_entities') as unknown as CatalogEntityRow[];
    return planCatalogEntityRegistration(
      input,
      workspaceId,
      rows.filter((row) => row.id === input.id || row.locator === input.locator),
      Date.now(),
      () => crypto.randomUUID(),
      scope
    );
  }

  function publishCatalogEntity(row: CatalogEntityRow): void {
    const rows = table('catalog_entities');
    const existing = rows.find((entity) => entity.id === row.id);
    if (existing) Object.assign(existing, row);
    else rows.push({ ...row });
  }

  function requireActiveCatalogEntity(id: string): SqlRow {
    requireCatalogText(id, 'entity identity');
    const entity = table('catalog_entities').find((row) => row.id === id);
    if (!entity) throw new Error('Hosted catalog entity does not exist.');
    if (entity.status !== 'active') throw new Error('Hosted catalog entity is inactive.');
    const workspace = table('workspaces').find((row) => row.id === entity.workspace_id);
    if (
      !workspace ||
      typeof workspace.path !== 'string' ||
      workspace.archived_at != null ||
      workspace.trashed_at != null
    )
      throw new Error('Hosted catalog entity has no active workspace owner.');
    if (ensureHostedWorkspaceOwner(workspace.path) !== entity.workspace_id)
      throw new Error('Hosted catalog entity has a conflicting workspace owner.');
    return entity;
  }

  const readMountedCatalogSearchRows: MountedCatalogSearchReader = async (request) => {
    const source = options.getCatalogSource?.();
    if (!source) return [];
    const root = hostedWorkspaceRoot(source.snapshot.workspaceId);
    if (!request.workspaceRoots.includes(root)) return [];
    const workspace = table('workspaces').find(
      (row) => row.path === root && row.archived_at == null && row.trashed_at == null
    );
    if (!workspace) return [];
    const currentFiles = new Set(
      table('catalog_entity_files')
        .filter((file) => file.workspace_id === workspace.id && file.status === 'current')
        .map((file) => file.entity_id)
    );
    const pages = new Set(table('pages').map((page) => page.id));
    const rows = table('catalog_entities').flatMap((row) => {
      if (
        row.workspace_id !== workspace.id ||
        row.status !== 'active' ||
        typeof row.id !== 'string' ||
        typeof row.type !== 'string' ||
        typeof row.name !== 'string'
      )
        return [];
      return [
        {
          entity_id: row.id,
          entity_type: row.type,
          name: row.name,
          storage_type: String(row.storage_type ?? ''),
          metadata: typeof row.metadata === 'string' ? row.metadata : null,
          workspace_root: root,
          workspace_name: String(workspace.name ?? ''),
          updated_at: Number(row.updated_at ?? 0),
          locator: String(row.locator ?? ''),
          hasCurrentFile: currentFiles.has(row.id),
          hasNotebookPage: pages.has(row.id),
        },
      ];
    });
    return searchProjectedCatalogRows(rows, request);
  };

  const database = {
    async rebindCatalogFiles(input: CatalogFileRebindRequest) {
      if (
        !input ||
        typeof input.oldPath !== 'string' ||
        !input.oldPath ||
        typeof input.newPath !== 'string' ||
        !input.newPath ||
        !input.workspaceRoot
      )
        throw new Error('Catalog relocation paths are invalid.');
      const root = input.workspaceRoot;
      const { source } = catalogSource(root);
      if (!source)
        throw new Error('Hosted catalog relocation requires its hydrated workspace source.');
      const workspaceId = ensureHostedWorkspaceOwner(root);
      const workspace = table('workspaces').find((row) => row.id === workspaceId);
      if (workspace?.access_mode !== 'writable')
        throw new Error('Catalog relocation workspace is read-only.');
      if (!pathIsAtOrUnder(input.oldPath, root) || !pathIsAtOrUnder(input.newPath, root))
        throw new Error('Catalog relocation must remain inside its workspace owner.');
      if (input.oldPath === input.newPath) return { updated: 0, missingOldPath: false };
      const files = table('catalog_entity_files') as unknown as CatalogFileBindingRow[];
      const entities = table('catalog_entities') as unknown as CatalogEntityRow[];
      const movers = files.filter((file) => pathIsAtOrUnder(file.path, input.oldPath));
      if (
        findCatalogRelocationConflict(
          files,
          (locator) => entities.find((entity) => entity.locator === locator),
          input.oldPath,
          input.newPath
        )
      )
        throw new Error('Catalog relocation destination belongs to another entity.');
      const now = Date.now();
      const planned = movers.map((file) => {
        const entity = requireActiveCatalogEntity(file.entity_id);
        if (entity.workspace_id !== workspaceId || file.workspace_id !== workspaceId)
          throw new Error('Catalog relocation must use the exact entity workspace owner.');
        const path = rebasePath(file.path, input.oldPath, input.newPath);
        requireHostedCatalogPath(root, path);
        const relativePath = pathRelativeToBoundary(path, root);
        const sourceFile = source.snapshot.files.find(
          (candidate) => candidate.path === relativePath
        );
        return {
          file,
          entity,
          plan: planCatalogFileRelocation(
            file,
            entity as unknown as CatalogEntityRow,
            {
              ...input,
              workspaceRoot: root,
              now,
            },
            { sizeBytes: sourceFile?.sizeBytes ?? null, modifiedAt: null }
          ),
        };
      });
      for (const { file, entity, plan } of planned) {
        Object.assign(file, plan.file);
        if (input.targetFileKind && file.path === input.newPath)
          file.file_kind = input.targetFileKind;
        if (plan.entity) Object.assign(entity, plan.entity, { updated_at: now });
        table('catalog_entity_events').push({
          id: crypto.randomUUID(),
          entity_id: String(entity.id),
          event_type: 'path_moved',
          actor: input.actor ?? 'user',
          summary: 'Catalog file binding moved',
          payload: plan.eventPayload,
          created_at: now,
        });
      }
      return { updated: planned.length, missingOldPath: movers.length === 0 };
    },
    async updateCatalogEntityPresentation(
      input: CatalogEntityPresentationInput
    ): Promise<CatalogEntityRow | null> {
      const request = parseCatalogEntityPresentation(input);
      if (!table('catalog_entities').some((row) => row.id === request.entityId)) return null;
      const entity = requireActiveCatalogEntity(request.entityId);
      const planned = planCatalogEntityPresentation(
        entity as unknown as CatalogEntityRow,
        request,
        {
          sourceMetadata: null,
          readSourceNames: () => {
            const files = table('catalog_entity_files').filter(
              (file) => file.entity_id === entity.id && file.status === 'current'
            );
            if (files.length === 0) return null;
            const workspace = table('workspaces').find((row) => row.id === entity.workspace_id);
            const file = files[0];
            if (
              files.length !== 1 ||
              file.workspace_id !== entity.workspace_id ||
              typeof file.path !== 'string' ||
              typeof workspace?.path !== 'string'
            )
              throw new Error('Catalog presentation has no unique file owner.');
            requireHostedCatalogPath(workspace.path, file.path);
            const name = file.path.slice(file.path.lastIndexOf('/') + 1);
            const extension = name.lastIndexOf('.');
            return new Set([name, extension > 0 ? name.slice(0, extension) : name]);
          },
          assertMutable: () => {
            const workspace = table('workspaces').find((row) => row.id === entity.workspace_id);
            if (workspace?.access_mode !== 'writable') {
              throw new Error('Catalog presentation workspace is read-only.');
            }
          },
          now: Date.now(),
        }
      );
      publishCatalogEntity(planned);
      return { ...planned };
    },
    async ensureWorkspaceOwner(
      root: string,
      access?: WorkspaceAccess,
      discovery?: WorkspaceOwnerDiscovery
    ): Promise<number> {
      return ensureHostedWorkspaceOwner(root, access, discovery);
    },
    async registerCatalogEntity(
      input: CatalogEntityRegistrationRequest
    ): Promise<CatalogEntityRow> {
      const row = planHostedCatalogEntity(input);
      publishCatalogEntity(row);
      return { ...row };
    },
    async registerWorkspaceFile(
      input: CatalogWorkspaceFileRegistrationRequest
    ): Promise<CatalogEntityRow> {
      if (!input.workspaceRoot)
        throw new Error('Hosted catalog file requires its hydrated workspace owner.');
      parseCatalogFileBindingRequest({ ...input, entityId: 'discovery' });
      requireHostedCatalogPath(
        input.workspaceRoot,
        input.path,
        input.fileKind === 'folder' && (input.entityType ?? 'folder') === 'folder'
      );
      const workspaceId = ensureHostedWorkspaceOwner(input.workspaceRoot);
      const current = table('catalog_entity_files').find((file) => file.path === input.path);
      const existing = current
        ? (table('catalog_entities').find(
            (entity) => entity.id === current.entity_id
          ) as unknown as CatalogEntityRow | undefined)
        : undefined;
      if (
        current &&
        (!existing || current.workspace_id !== workspaceId || existing.workspace_id !== workspaceId)
      )
        throw new Error('Hosted catalog file belongs to another workspace identity.');
      const row =
        existing && !existing.locator.startsWith('file://')
          ? existing
          : planHostedCatalogEntity({
              id: existing?.id,
              type: input.entityType ?? (input.fileKind === 'folder' ? 'folder' : 'file'),
              name: input.name ?? input.path.split('/').pop()!,
              locator: `file://${input.path}`,
              storageType: 'file',
              workspaceRoot: input.workspaceRoot,
              preserveExistingName: true,
              metadata: {
                ...input.metadata,
                path: input.path,
                relativePath: pathRelativeToBoundary(input.path, input.workspaceRoot),
                fileKind: input.fileKind ?? 'file',
              },
            });
      const plan = planCatalogMemoryFileBinding(
        { ...input, entityId: row.id },
        workspaceId,
        table('catalog_entity_files') as unknown as CatalogFileBindingRow[],
        Date.now(),
        () => crypto.randomUUID()
      );
      publishCatalogEntity(row);
      tables.set(
        'catalog_entity_files',
        plan.files.map((file) => ({ ...file }))
      );
      tables.set('catalog_entity_events', [...table('catalog_entity_events'), ...plan.events]);
      return { ...row };
    },

    async createEntityReference(
      row: ChatEntityReferenceIpcRow
    ): Promise<ChatEntityReferenceIpcRow> {
      validatePreparedEntityReferenceRow(row);
      if (row.entity_type === 'primer')
        throw new HostedCapabilityError('db.createEntityReference.canonical-primer');
      const rows = table('entity_references');
      assertEntityReferenceMolecularTarget(
        row,
        (id) => (rows.find((row) => row.id === id) as unknown as ChatEntityReferenceIpcRow) ?? null
      );
      const existing = rows.find((item) => item.id === row.id) as unknown as
        | ChatEntityReferenceIpcRow
        | undefined;
      if (existing) {
        if (!sameEntityReferenceContent(existing, row))
          throw new Error(
            'The entity reference ID already belongs to another immutable target or content.'
          );
        return { ...existing };
      }
      rows.push({ ...row });
      return { ...row };
    },
    async updateEntityReference(id: string, updates: EntityReferenceUpdates): Promise<void> {
      const rows = table('entity_references');
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return;
      const existing = rows[index] as unknown as ChatEntityReferenceIpcRow;
      const row = updatedEntityReferenceRow(existing, updates);
      if (row.locator !== existing.locator)
        throw new HostedCapabilityError('db.updateEntityReference.native-identity');
      assertEntityReferenceMolecularTarget(
        row,
        (id) => (rows.find((row) => row.id === id) as unknown as ChatEntityReferenceIpcRow) ?? null
      );
      rows[index] = { ...row };
    },
    async deleteEntityReference(id: string): Promise<void> {
      const rows = table('entity_references');
      const row = rows.find((row) => row.id === id) as unknown as
        | ChatEntityReferenceIpcRow
        | undefined;
      if (!row) return;
      if (
        isFrozenMolecularReference(row) ||
        table('message_references').some((row) => row.reference_id === id)
      )
        throw new Error(
          'Saved molecular snapshots and referenced targets are immutable and cannot be deleted here.'
        );
      tables.set(
        'entity_references',
        rows.filter((row) => row.id !== id)
      );
    },
    async setEntityReferenceWorkspaceRootPathIfMissing(
      id: string,
      root: string
    ): Promise<string | null> {
      const row = table('entity_references').find((row) => row.id === id);
      if (!row) return null;
      if (typeof row.workspace_root_path === 'string') return row.workspace_root_path;
      const candidates =
        typeof row.workspace_scope === 'string' && row.workspace_scope.startsWith('folders:')
          ? JSON.parse(row.workspace_scope.slice('folders:'.length))
          : [];
      if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0] !== root)
        throw new HostedCapabilityError('db.reference-root-recovery.native-evidence');
      row.workspace_root_path = root;
      row.updated_at = Date.now();
      return root;
    },
    async recordEntityReferenceRevision(
      input: EntityReferenceRevisionInput
    ): Promise<EntityReferenceRevisionRow> {
      if (!table('entity_references').some((row) => row.id === input.referenceId))
        throw new Error('The reference revision target is unavailable.');
      const rows = table('entity_reference_revisions');
      const row = {
        id: crypto.randomUUID(),
        reference_id: input.referenceId,
        revision_number:
          Math.max(
            0,
            ...rows
              .filter((row) => row.reference_id === input.referenceId)
              .map((row) => Number(row.revision_number))
          ) + 1,
        changed_by: input.changedBy,
        change_type: input.changeType,
        previous_state: input.previousState ? JSON.stringify(input.previousState) : null,
        new_state: input.newState ? JSON.stringify(input.newState) : null,
        created_at: Date.now(),
      };
      rows.push(row);
      return { ...row };
    },

    async bindCatalogEntityFile(input: CatalogFileBindingRequest): Promise<CatalogFileBindingRow> {
      if (!table('catalog_entities').some((entity) => entity.id === input.entityId)) {
        throw new Error('Catalog file binding entity does not exist.');
      }
      const workspace = input.workspaceRoot
        ? table('workspaces').find(
            (row) =>
              row.path === input.workspaceRoot && row.archived_at == null && row.trashed_at == null
          )
        : undefined;
      if (input.workspaceRoot && !workspace)
        throw new Error('Catalog file binding workspace is not registered.');
      const workspaceId = typeof workspace?.id === 'number' ? workspace.id : null;
      const entity = table('catalog_entities').find((row) => row.id === input.entityId);
      if (entity?.workspace_id !== workspaceId)
        throw new Error('Hosted catalog binding must use its exact entity workspace owner.');
      if (input.workspaceRoot)
        requireHostedCatalogPath(
          input.workspaceRoot,
          input.path,
          input.fileKind === 'folder' && entity?.type === 'folder'
        );
      const plan = planCatalogMemoryFileBinding(
        input,
        workspaceId,
        table('catalog_entity_files') as unknown as CatalogFileBindingRow[],
        Date.now(),
        () => crypto.randomUUID()
      );
      const events = [...table('catalog_entity_events'), ...plan.events];
      tables.set(
        'catalog_entity_files',
        plan.files.map((row) => ({ ...row }))
      );
      tables.set('catalog_entity_events', events);
      return plan.binding;
    },
    async linkCatalogEntities(input: CatalogEntityLinkInput): Promise<CatalogEntityLinkRow> {
      if (!input || typeof input !== 'object') throw new Error('Catalog relationship is invalid.');
      const relation = requireCatalogText(input.relation, 'relationship relation');
      const confidence = input.confidence ?? 'suggested';
      if (!['suggested', 'confirmed', 'rejected'].includes(confidence))
        throw new Error('Catalog relationship confidence is invalid.');
      const from = requireActiveCatalogEntity(input.sourceEntityId);
      const to = requireActiveCatalogEntity(input.targetEntityId);
      if (from.workspace_id !== to.workspace_id)
        throw new Error('Hosted catalog relationship endpoints have different workspace owners.');
      const evidence =
        input.evidence == null
          ? null
          : JSON.stringify(catalogJsonObject(input.evidence, 'relationship evidence'));
      const rows = table('catalog_entity_links');
      const existing = rows.find(
        (row) =>
          row.source_entity_id === from.id &&
          row.target_entity_id === to.id &&
          row.relation === relation
      );
      const now = Date.now();
      const row: CatalogEntityLinkRow = {
        id: typeof existing?.id === 'string' ? existing.id : crypto.randomUUID(),
        source_entity_id: input.sourceEntityId,
        target_entity_id: input.targetEntityId,
        relation,
        confidence,
        evidence,
        created_at: typeof existing?.created_at === 'number' ? existing.created_at : now,
        updated_at: now,
      };
      if (existing) Object.assign(existing, row);
      else rows.push({ ...row });
      return { ...row };
    },
    async recordCatalogEvent(input: CatalogEventInput): Promise<CatalogEventRow> {
      if (!input || typeof input !== 'object') throw new Error('Catalog event is invalid.');
      if (input.eventType === FASTA_KIND_DECLARATION_EVENT)
        throw new Error(
          'FASTA_KIND_HISTORY_PROTECTED: Native kind history requires the classification owner.'
        );
      const row: CatalogEventRow = {
        id:
          input.id === undefined
            ? crypto.randomUUID()
            : requireCatalogText(input.id, 'event identity'),
        entity_id: requireCatalogText(input.entityId, 'entity identity'),
        event_type: requireCatalogText(input.eventType, 'event type'),
        actor: input.actor === undefined ? 'user' : requireCatalogText(input.actor, 'event actor'),
        summary: input.summary == null ? null : requireCatalogText(input.summary, 'event summary'),
        payload:
          input.payload == null
            ? null
            : JSON.stringify(catalogJsonObject(input.payload, 'event payload')),
        created_at: input.createdAt ?? Date.now(),
      };
      if (!Number.isSafeInteger(row.created_at) || row.created_at < 0)
        throw new Error('Catalog event creation time is invalid.');
      requireActiveCatalogEntity(row.entity_id);
      const rows = table('catalog_entity_events');
      const existing = rows.find((event) => event.id === row.id);
      if (existing) {
        if (!Object.entries(row).every(([key, value]) => existing[key] === value))
          throw new Error('Catalog event identity already belongs to a different event.');
      } else rows.push({ ...row });
      return { ...row };
    },
    async execute(
      sql: string,
      params: SqlValue[] = []
    ): Promise<{ changes: number; lastInsertRowid: number }> {
      const normalized = normalizeSql(sql);
      const authorityTable = tableKey(
        INSERT_RE.exec(normalized)?.[2] ??
          UPDATE_RE.exec(normalized)?.[1] ??
          DELETE_RE.exec(normalized)?.[1] ??
          ''
      );
      if (authorityTable === 'entity_references' || authorityTable === 'entity_reference_revisions')
        throw new HostedCapabilityError('db.reference-authority.native-command');
      const insert = INSERT_RE.exec(normalized);
      if (insert) {
        const orMode = insert[1]?.toUpperCase() ?? null;
        const tableName = insert[2];
        const columns = splitList(insert[3]);
        const rows = table(tableName);
        const row: SqlRow = {};
        const expressions = splitSqlExpressions(insert[4]);
        if (expressions.length !== columns.length) {
          throw new HostedCapabilityError('db.insert-value-count');
        }
        const parameter = { index: 0 };
        columns.forEach((column, index) => {
          row[column] = sqlExpressionValue(expressions[index], params, parameter);
        });
        const updates: Array<
          { column: string; source: string } | { column: string; value: SqlValue }
        > = insert[7]
          ? splitSqlExpressions(insert[7]).map((assignment) => {
              const separator = assignment.indexOf('=');
              const rawColumn = assignment.slice(0, separator).trim();
              const rawValue = assignment.slice(separator + 1).trim();
              if (separator < 1) throw new HostedCapabilityError('db.upsert-assignment');
              const column = columnName(rawColumn);
              if (/^excluded\./iu.test(rawValue)) {
                return { column, source: columnName(rawValue.replace(/^excluded\./iu, '')) };
              }
              return { column, value: sqlExpressionValue(rawValue, params, parameter) };
            })
          : [];
        if (
          tableKey(tableName) === 'conversations' &&
          rowValue(row, 'title_locked') === undefined
        ) {
          row.title_locked = 0;
        }
        const conflictColumns = insert[5]
          ? splitList(insert[5])
          : orMode
            ? tableKey(tableName) === 'workspaces'
              ? ['path']
              : [columns[0]]
            : [];
        const targetConflict = conflictColumns.length
          ? findConflict(rows, columns, row, conflictColumns)
          : undefined;
        const pathConflict =
          tableKey(tableName) === 'workspaces' && rowValue(row, 'path') != null
            ? rows.find((existing) => rowValue(existing, 'path') === rowValue(row, 'path'))
            : undefined;
        if (
          pathConflict &&
          pathConflict !== targetConflict &&
          !orMode &&
          !conflictColumns.some((column) => columnName(column).toLowerCase() === 'path')
        ) {
          throw new Error('UNIQUE constraint failed: workspaces.path');
        }
        const existing = targetConflict ?? pathConflict;
        if (rowValue(row, 'id') == null) {
          row.id = nextRowid(tableName);
        } else {
          const insertedId = rowValue(row, 'id');
          if (typeof insertedId === 'number' && Number.isFinite(insertedId)) {
            autoincrement.set(
              tableKey(tableName),
              Math.max(autoincrement.get(tableKey(tableName)) ?? 0, insertedId)
            );
          }
        }
        const conflictAction = insert[6]?.toUpperCase().startsWith('UPDATE')
          ? 'UPDATE'
          : insert[6]?.toUpperCase() === 'NOTHING'
            ? 'NOTHING'
            : orMode === 'IGNORE'
              ? 'NOTHING'
              : orMode === 'REPLACE'
                ? 'REPLACE'
                : null;
        if (existing && conflictAction === 'NOTHING') {
          return { changes: 0, lastInsertRowid: Number(rowValue(existing, 'id') ?? 0) };
        }
        if (existing && (conflictAction === 'REPLACE' || conflictAction === 'UPDATE')) {
          const replacement = { ...existing };
          if (conflictAction === 'UPDATE' && insert[7]) {
            for (const update of updates) {
              const value =
                'source' in update ? (rowValue(row, update.source) ?? null) : update.value;
              setRowValue(replacement, update.column, value);
            }
          } else {
            for (const column of columns) setRowValue(replacement, column, row[column] ?? null);
          }
          if (tableKey(tableName) === 'workspaces') {
            assertUniqueWorkspacePaths(
              rows.map((item) => (item === existing ? replacement : item))
            );
          }
          Object.assign(existing, replacement);
          return { changes: 1, lastInsertRowid: Number(rowValue(existing, 'id') ?? 0) };
        }
        rows.push(row);
        return { changes: 1, lastInsertRowid: Number(rowValue(row, 'id') ?? rows.length) };
      }
      const del = DELETE_RE.exec(normalized);
      if (del) {
        const rows = table(del[1]);
        const next = rows.filter((row) => !matchesWhere(row, del[2], params));
        const changes = rows.length - next.length;
        tables.set(tableKey(del[1]), next);
        return { changes, lastInsertRowid: 0 };
      }
      const update = UPDATE_RE.exec(normalized);
      if (update) {
        let paramIndex = 0;
        const assignments = splitList(update[2]).map((part) => {
          const [rawColumn, rawValue] = part.split('=').map((value) => value.trim());
          const column = columnName(rawColumn);
          if (rawValue === '?') return { column, value: params[paramIndex++] ?? null };
          if (NUMBER_LITERAL_RE.test(rawValue) && Number.isFinite(Number(rawValue))) {
            return { column, value: Number(rawValue) };
          }
          if (rawValue?.toUpperCase() === 'NULL') return { column, value: null };
          throw new HostedCapabilityError(`db.update-expression:${rawValue}`);
        });
        const whereParams = params.slice(paramIndex);
        const rows = table(update[1]);
        const targets = new Set(rows.filter((row) => matchesWhere(row, update[3], whereParams)));
        if (tableKey(update[1]) === 'workspaces') {
          const proposed = rows.map((row) => {
            if (!targets.has(row)) return row;
            const next = { ...row };
            assignments.forEach(({ column, value }) => setRowValue(next, column, value));
            return next;
          });
          assertUniqueWorkspacePaths(proposed);
        }
        for (const row of targets) {
          assignments.forEach(({ column, value }) => {
            setRowValue(row, column, value);
          });
        }
        return { changes: targets.size, lastInsertRowid: 0 };
      }
      if (/^CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)/iu.test(normalized)) {
        return { changes: 0, lastInsertRowid: 0 };
      }
      throw new HostedCapabilityError(`db.execute:${sql.slice(0, 80)}`);
    },

    async select<T = SqlRow[]>(sql: string, params: SqlValue[] = []): Promise<T> {
      const normalized = normalizeSql(sql);
      if (CATALOG_FILE_WORKSPACE_RE.test(normalized)) {
        const file = table('catalog_entity_files').find(
          (row) => rowValue(row, 'path') === params[0]
        );
        const workspace =
          file &&
          table('workspaces').find((row) => rowValue(row, 'id') === rowValue(file, 'workspace_id'));
        return (workspace ? [{ path: rowValue(workspace, 'path') ?? null }] : []) as T;
      }
      if (CONVERSATION_HISTORY_RE.test(normalized)) {
        const populated = new Set(table('messages').map((row) => row.conversation_id));
        return table('conversations')
          .filter((row) => populated.has(row.id))
          .sort(
            (a, b) =>
              Number(b.pinned ?? 0) - Number(a.pinned ?? 0) ||
              Number(b.updated_at) - Number(a.updated_at)
          )
          .map((row) => ({ ...row })) as T;
      }
      const select = SELECT_RE.exec(normalized);
      if (!select) {
        return [] as T;
      }
      const columns = select[1].trim();
      let rows = table(select[2]).filter((row) => matchesWhere(row, select[3], params));
      if (select[4]) {
        const orders = splitList(select[4]).map((part) => ORDER_RE.exec(part));
        if (orders.some((order) => !order)) return [] as T;
        rows = [...rows].sort((a, b) => {
          for (const order of orders) {
            if (!order) continue;
            const left = rowValue(a, columnName(order[1]));
            const right = rowValue(b, columnName(order[1]));
            const descending = (order[2] ?? 'ASC').toUpperCase() === 'DESC';
            if (left === right) continue;
            if (left == null) return 1;
            if (right == null) return -1;
            return left < right ? (descending ? 1 : -1) : descending ? -1 : 1;
          }
          return 0;
        });
      }
      if (select[5]) {
        let boundIndex = (select[3]?.match(/\?/gu) ?? []).length;
        const bound = (token: string | undefined): number =>
          token === undefined ? 0 : Number(token === '?' ? params[boundIndex++] : token);
        const limit = bound(select[5]);
        const offset = bound(select[6]);
        rows = rows.slice(offset, offset + limit);
      }
      if (columns === '*') return rows.map((row) => ({ ...row })) as T;
      const wanted = splitList(columns).map(selectColumn);
      return rows.map((row) => {
        const next: SqlRow = {};
        for (const column of wanted) next[column.output] = rowValue(row, column.source) ?? null;
        return next;
      }) as T;
    },
  };

  async function settingValue(key: string): Promise<string | undefined> {
    const rows = await database.select<Array<{ value: string }>>(
      `SELECT value FROM settings WHERE key = ?`,
      [key]
    );
    return rows[0]?.value;
  }

  return {
    ...database,
    readMountedCatalogSearchRows,
    allocatePrimerCatalogNumber: (workspaceId = 0): Promise<string> =>
      withTransaction(async () => {
        const now = Date.now();
        const prefix = (await settingValue(`primer_prefix_${workspaceId}`))?.trim() || 'P';
        const counterKey = `primer_counter_global_${prefix}`;
        const stored = Number.parseInt((await settingValue(counterKey)) ?? '0', 10);
        const pattern = new RegExp(`^${escapeRegExp(prefix)}(\\d+)$`, 'u');
        const existingMax = table('primers').reduce((max, row) => {
          const match = pattern.exec(String(rowValue(row, 'catalog_number') ?? ''));
          return match ? Math.max(max, Number.parseInt(match[1], 10)) : max;
        }, 0);
        let next = Math.max(Number.isFinite(stored) ? stored : 0, existingMax) + 1;
        const format = (value: number) => `${prefix}${String(value).padStart(3, '0')}`;
        while (
          table('primers').some((row) => rowValue(row, 'catalog_number') === format(next)) ||
          (await settingValue(`${PRIMER_CATALOG_RESERVATION_PREFIX}${format(next)}`)) !== undefined
        ) {
          next++;
        }
        await database.execute(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [counterKey, String(next), now]
        );
        await database.execute(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`, [
          `${PRIMER_CATALOG_RESERVATION_PREFIX}${format(next)}`,
          prefix,
          now,
        ]);
        return format(next);
      }),
    replacePrimerProjection: (input: PrimerLegacyProjectionInput): Promise<void> =>
      withTransaction(async () => {
        await database.execute(
          `INSERT INTO primers (
            id, catalog_number, name, sequence, length, tm, gc_percent, origin, origin_details,
            status, vendor, modifications, application, notes, workspace_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET catalog_number = excluded.catalog_number,
            name = excluded.name, sequence = excluded.sequence, length = excluded.length,
            tm = excluded.tm, gc_percent = excluded.gc_percent, origin = excluded.origin,
            origin_details = excluded.origin_details, status = excluded.status,
            vendor = excluded.vendor, modifications = excluded.modifications,
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
            input.vendor,
            input.modifications,
            input.application,
            input.notes,
            input.workspaceId,
            input.createdAt,
            input.updatedAt,
          ]
        );
        await database.execute(`DELETE FROM primer_bindings WHERE primer_id = ?`, [input.id]);
        for (const binding of input.bindings) {
          await database.execute(
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
      }),
    snapshot: (): HostedMemoryDbSnapshot => ({
      tables: [...tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
      autoincrement: [...autoincrement],
    }),
    createChatTurnWithUserMessage: async (input: CreateChatTurnWithUserMessageRequest) => {
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

      await withTransaction(async () => {
        await database.execute(
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
        await database.execute(
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
          await database.execute(
            `INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)`,
            [input.message.id, input.reference_ids?.[position] ?? null, position]
          );
        }
        for (let position = 0; position < attachments.length; position++) {
          const attachment = attachments[position];
          if (!attachment) continue;
          await database.execute(
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
        await database.execute(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [
          Date.now(),
          input.message.conversation_id,
        ]);
      });
    },
    commitChatTurnTerminalState: async (
      input: CommitChatTurnTerminalStateRequest
    ): Promise<CommitChatTurnTerminalStateResult> => {
      for (const entry of input.messages) {
        if (
          entry.message.conversation_id !== input.conversation_id ||
          entry.message.turn_id !== input.turn_id
        ) {
          throw new Error('Every terminal message must belong to the committed turn.');
        }
      }
      validateTerminalReferenceProposals(input);

      return withTransaction(async () => {
        const rows = await database.select<Array<{ status: string; conversation_id: string }>>(
          `SELECT status, conversation_id FROM chat_turns WHERE id = ?`,
          [input.turn_id]
        );
        if (rows[0]?.conversation_id !== input.conversation_id) {
          throw new Error('Chat turn does not belong to the requested conversation.');
        }
        if (rows[0]?.status !== 'running') return { committed: false };

        for (const row of input.proposed_entity_references ?? [])
          await database.createEntityReference(row);

        for (const entry of input.messages) {
          await database.execute(
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
            await database.execute(
              `INSERT INTO message_references (message_id, reference_id, position) VALUES (?, ?, ?)`,
              [entry.message.id, entry.reference_ids[position] ?? null, position]
            );
          }
        }
        await database.execute(
          `UPDATE chat_turns
           SET status = ?, terminal_reason = ?, error = ?, completed_at = ?
           WHERE id = ?`,
          [input.status, input.terminal_reason, input.error, input.completed_at, input.turn_id]
        );
        await database.execute(`UPDATE conversations SET updated_at = ? WHERE id = ?`, [
          Date.now(),
          input.conversation_id,
        ]);
        return { committed: true };
      });
    },
  };
}

function normalizeSql(sql: string): string {
  return sql.trim().replace(/\s+/gu, ' ');
}

function splitSqlExpressions(value: string): string[] {
  const expressions: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "'") {
      if (quoted && value[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (value[index] === ',' && !quoted) {
      expressions.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quoted) throw new HostedCapabilityError('db.unterminated-string');
  expressions.push(value.slice(start).trim());
  return expressions;
}

function sqlExpressionValue(
  expression: string,
  params: readonly SqlValue[],
  parameter: { index: number }
): SqlValue {
  if (expression === '?') return params[parameter.index++] ?? null;
  if (/^NULL$/iu.test(expression)) return null;
  if (/^(?:TRUE|FALSE)$/iu.test(expression)) return expression.toUpperCase() === 'TRUE' ? 1 : 0;
  if (NUMBER_LITERAL_RE.test(expression) && Number.isFinite(Number(expression))) {
    return Number(expression);
  }
  if (/^'(?:[^']|'')*'$/u.test(expression)) {
    return expression.slice(1, -1).replace(/''/gu, "'");
  }
  throw new HostedCapabilityError(`db.value-expression:${expression}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function likePattern(pattern: string): RegExp {
  const source = [...pattern]
    .map((character) =>
      character === '%' ? '.*' : character === '_' ? '.' : escapeRegExp(character)
    )
    .join('');
  return new RegExp(`^${source}$`, 'isu');
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().replace(/["'`]/g, ''))
    .filter(Boolean);
}

function splitWhere(value: string): string[] {
  return value
    .split(/\s+AND\s+/iu)
    .map((part) => part.trim())
    .filter(Boolean);
}

function columnName(value: string): string {
  return value.replace(/.*\./u, '').replace(/["'`]/g, '').trim();
}

function selectColumn(value: string): { source: string; output: string } {
  const aliased = /^(.+?)\s+AS\s+([A-Za-z_]\w*)$/iu.exec(value.trim());
  if (aliased) {
    return { source: columnName(aliased[1]), output: aliased[2] };
  }
  const name = columnName(value);
  return { source: name, output: name };
}

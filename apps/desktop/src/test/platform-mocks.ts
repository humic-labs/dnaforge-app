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
import {
  normalizeCatalogPlacement,
  type CatalogEntityLinkInput,
  type CatalogEntityLinkRow,
  type CatalogEventInput,
  type CatalogEventRow,
  type CatalogEntityPresentationInput,
  type CatalogWorkspacePlacementInput,
  type CatalogWorkspacePlacementRow,
  type RestoreCatalogProviderBindingInput,
  type ArchiveSupersededNotebookCatalogInput,
} from '../shared/catalog-associations';

import { workspaceScopeKey } from '../shared/workspace-scoped-identity';
import {
  normalizeWorkspaceTimestamp,
  type WorkspaceOwnerDiscovery,
} from '../shared/workspace-access';
import { pathIsAtOrUnder, pathRelativeToBoundary, rebasePath } from '../shared/path-boundary';
import { inferCatalogFileKind } from '../shared/catalog-file-kind';
import { isSequencePackageFileKind } from '../db/sequence-package';
import {
  planCatalogEntityRegistration,
  CATALOG_ROLLBACK_RETAINED_MESSAGE,
  CATALOG_RESET_RETAINED_MESSAGE,
  type CatalogFileFingerprint,
  type CatalogWorkspaceFileRegistrationRequest,
  type CatalogFileRebindRequest,
  type CatalogEntityRollbackRequest,
  type CatalogProjectionClearResult,
  type CatalogEntityRegistrationRequest,
  type CatalogEntityRow,
} from '../shared/catalog-registration';

import {
  planCatalogMemoryFileBinding,
  type CatalogFileBindingRequest,
  type CatalogFileBindingRow,
} from '../shared/catalog-binding';

const mockStorage: Map<string, unknown[]> = new Map();

mockStorage.set('settings', []);
mockStorage.set('conversations', []);
mockStorage.set('messages', []);
mockStorage.set('chat_turns', []);
mockStorage.set('pages', []);
mockStorage.set('sequences', []);
mockStorage.set('features', []);
mockStorage.set('workspaces', []);
mockStorage.set('indexed_files', []);
mockStorage.set('entity_references', []);
mockStorage.set('message_references', []);
mockStorage.set('message_attachments', []);
mockStorage.set('agent_structured_outputs', []);
mockStorage.set('entity_reference_revisions', []);
mockStorage.set('catalog_entities', []);
mockStorage.set('catalog_entity_files', []);
mockStorage.set('catalog_entity_links', []);
mockStorage.set('catalog_entity_events', []);
mockStorage.set('catalog_provider_bindings', []);
mockStorage.set('catalog_workspace_placements', []);
mockStorage.set('lims_schema', []);
mockStorage.set('lims_schema_revision', []);
mockStorage.set('lims_entity', []);
mockStorage.set('lims_link', []);
mockStorage.set('lims_audit', []);

const MOCK_SUPPORTED_PREDICATE = /^(=|is|like)$/i;

export function assertMockCanHonourPredicates(sql: string): void {
  const whereIndex = sql.toLowerCase().indexOf('where');
  if (whereIndex === -1) return;
  const clause = sql.slice(whereIndex).split(/\border\s+by\b|\bgroup\s+by\b|\blimit\b/i)[0];

  const unsupported = [
    ...clause.matchAll(/(?:where|and|or)\s+(?:\w+\.)?(\w+)\s*(<=|>=|<>|!=|<|>)\s*/gi),
  ].map((match) => `${match[1]} ${match[2]}`);

  for (const keyword of ['between', 'glob', 'regexp']) {
    if (new RegExp(`\\b${keyword}\\b`, 'i').test(clause)) unsupported.push(keyword.toUpperCase());
  }

  const comparisons = [...clause.matchAll(/(?:where|and|or)\s+(?:\w+\.)?(\w+)\s*(=|is|like)\s/gi)];
  for (const match of comparisons) {
    if (!MOCK_SUPPORTED_PREDICATE.test(match[2])) unsupported.push(`${match[1]} ${match[2]}`);
  }

  if (unsupported.length > 0) {
    throw new Error(
      `[MockDB] refusing a query whose WHERE clause it cannot honour: ${unsupported.join(', ')}.\n` +
        `SQL: ${sql.replace(/\s+/g, ' ').trim().slice(0, 300)}\n\n` +
        'The mock only implements `= ?`, `is [not] null`, `IN (...)` and `LIKE ?`. An ' +
        'unimplemented predicate used to be DROPPED, which does not narrow the result — it ' +
        'widens it, handing the caller rows it believes it filtered out (). Either ' +
        'implement the operator here, or move the test to L3 where real SQLite runs.'
    );
  }
}

export function matchesSqlLike(value: string, pattern: string): boolean {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      const next = pattern[index + 1];
      if (next !== undefined) {
        expression += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        index += 1;
        continue;
      }
      expression += '\\\\';
      continue;
    }
    if (character === '%') {
      expression += '[\\s\\S]*';
      continue;
    }
    if (character === '_') {
      expression += '[\\s\\S]';
      continue;
    }
    expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${expression}$`).test(value);
}

function isCurrentSequenceFileSelector(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
  return (
    normalized.startsWith(
      'select f.* from catalog_entity_files f join catalog_entities e on e.id = f.entity_id'
    ) &&
    normalized.includes("where f.status = 'current' and e.status = 'active'") &&
    normalized.includes('select entity_id from catalog_entity_files where object_uuid = ?') &&
    normalized.endsWith('limit 2')
  );
}

function selectCurrentSequenceFiles(params: unknown[] | undefined): Array<Record<string, unknown>> {
  if (!params || params.length < 2) return [];
  const documentId = params[params.length - 2];
  const historicalObjectUuid = params[params.length - 1];
  const sequencePackageKinds = new Set(params.slice(0, -2));
  const entities = (mockStorage.get('catalog_entities') ?? []) as Array<Record<string, unknown>>;
  const files = (mockStorage.get('catalog_entity_files') ?? []) as Array<Record<string, unknown>>;
  const entityIdsForHistoricalObject = new Set(
    files.filter((file) => file.object_uuid === historicalObjectUuid).map((file) => file.entity_id)
  );

  return files
    .filter((file) => {
      if (file.status !== 'current') return false;
      const entity = entities.find((candidate) => candidate.id === file.entity_id);
      if (!entity || entity.status !== 'active') return false;
      if (
        entity.type !== 'sequence' &&
        entity.type !== 'trace' &&
        !sequencePackageKinds.has(file.file_kind)
      )
        return false;
      return file.entity_id === documentId || entityIdsForHistoricalObject.has(file.entity_id);
    })
    .slice(0, 2);
}

class MockDatabase {
  async createEntityReference(row: ChatEntityReferenceIpcRow): Promise<ChatEntityReferenceIpcRow> {
    validatePreparedEntityReferenceRow(row);
    const rows = mockStorage.get('entity_references') as ChatEntityReferenceIpcRow[];
    assertEntityReferenceMolecularTarget(row, (id) => rows.find((row) => row.id === id) ?? null);
    const existing = rows.find((item) => item.id === row.id);
    if (existing) {
      if (!sameEntityReferenceContent(existing, row))
        throw new Error(
          'The entity reference ID already belongs to another immutable target or content.'
        );
      return { ...existing };
    }
    rows.push({ ...row });
    return { ...row };
  }
  async updateEntityReference(id: string, updates: EntityReferenceUpdates): Promise<void> {
    const rows = mockStorage.get('entity_references') as ChatEntityReferenceIpcRow[];
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    const row = updatedEntityReferenceRow(rows[index], updates);
    assertEntityReferenceMolecularTarget(row, (id) => rows.find((row) => row.id === id) ?? null);
    rows[index] = { ...row };
  }
  async deleteEntityReference(id: string): Promise<void> {
    const rows = mockStorage.get('entity_references') as ChatEntityReferenceIpcRow[];
    const row = rows.find((row) => row.id === id);
    if (!row) return;
    if (isFrozenMolecularReference(row))
      throw new Error(
        'Saved molecular snapshots and their targets are immutable and cannot be deleted here.'
      );
    mockStorage.set(
      'entity_references',
      rows.filter((row) => row.id !== id)
    );
  }
  async setEntityReferenceWorkspaceRootPathIfMissing(
    id: string,
    root: string
  ): Promise<string | null> {
    const rows = mockStorage.get('entity_references') as ChatEntityReferenceIpcRow[];
    const row = rows.find((row) => row.id === id);
    if (!row) return null;
    if (row.workspace_root_path) return row.workspace_root_path;
    const candidates = row.workspace_scope?.startsWith('folders:')
      ? JSON.parse(row.workspace_scope.slice('folders:'.length))
      : [];
    if (!Array.isArray(candidates) || !candidates.includes(root))
      throw new Error('The reference root is not established by its saved ownership evidence.');
    row.workspace_root_path = root;
    row.updated_at = Date.now();
    return root;
  }
  async recordEntityReferenceRevision(
    input: EntityReferenceRevisionInput
  ): Promise<EntityReferenceRevisionRow> {
    if (
      !(mockStorage.get('entity_references') as ChatEntityReferenceIpcRow[]).some(
        (row) => row.id === input.referenceId
      )
    )
      throw new Error('The reference revision target is unavailable.');
    const rows = mockStorage.get('entity_reference_revisions') as EntityReferenceRevisionRow[];
    const row = {
      id: crypto.randomUUID(),
      reference_id: input.referenceId,
      revision_number:
        Math.max(
          0,
          ...rows
            .filter((row) => row.reference_id === input.referenceId)
            .map((row) => row.revision_number)
        ) + 1,
      changed_by: input.changedBy,
      change_type: input.changeType,
      previous_state: input.previousState ? JSON.stringify(input.previousState) : null,
      new_state: input.newState ? JSON.stringify(input.newState) : null,
      created_at: Date.now(),
    };
    rows.push(row);
    return { ...row };
  }

  async linkCatalogEntities(input: CatalogEntityLinkInput): Promise<CatalogEntityLinkRow> {
    const entities = mockStorage.get('catalog_entities') as CatalogEntityRow[];
    if (
      ![input.sourceEntityId, input.targetEntityId].every((id) =>
        entities.some((entity) => entity.id === id)
      )
    )
      throw new Error('Catalog link endpoint does not exist.');
    const links = mockStorage.get('catalog_entity_links') as CatalogEntityLinkRow[];
    const existing = links.find(
      (row) =>
        row.source_entity_id === input.sourceEntityId &&
        row.target_entity_id === input.targetEntityId &&
        row.relation === input.relation
    );
    const now = Date.now();
    const row = {
      id: existing?.id ?? crypto.randomUUID(),
      source_entity_id: input.sourceEntityId,
      target_entity_id: input.targetEntityId,
      relation: input.relation,
      confidence: input.confidence ?? 'suggested',
      evidence: input.evidence == null ? null : JSON.stringify(input.evidence),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing) Object.assign(existing, row);
    else links.push(row);
    return row;
  }

  async recordCatalogEvent(input: CatalogEventInput): Promise<CatalogEventRow> {
    const row = {
      id: input.id ?? crypto.randomUUID(),
      entity_id: input.entityId,
      event_type: input.eventType,
      actor: input.actor ?? 'user',
      summary: input.summary ?? null,
      payload: input.payload == null ? null : JSON.stringify(input.payload),
      created_at: input.createdAt ?? Date.now(),
    };
    const rows = mockStorage.get('catalog_entity_events') as CatalogEventRow[];
    const existing = rows.find((event) => event.id === row.id);
    if (existing) return existing;
    rows.push(row);
    return row;
  }

  async updateCatalogEntityPresentation(
    input: CatalogEntityPresentationInput
  ): Promise<CatalogEntityRow | null> {
    const entity = (mockStorage.get('catalog_entities') as CatalogEntityRow[]).find(
      (row) => row.id === input.entityId
    );
    if (!entity) return null;
    if (input.name !== undefined) entity.name = input.name;
    if (input.metadataPatch)
      entity.metadata = JSON.stringify({
        ...JSON.parse(entity.metadata ?? '{}'),
        ...input.metadataPatch,
      });
    entity.updated_at = Date.now();
    return entity;
  }

  async writeCatalogWorkspacePlacement(
    input: CatalogWorkspacePlacementInput
  ): Promise<CatalogWorkspacePlacementRow> {
    const normalized = normalizeCatalogPlacement(input);
    const entity = (mockStorage.get('catalog_entities') as CatalogEntityRow[]).find(
      (row) => row.id === input.entityId
    );
    if (!entity || entity.workspace_id !== input.workspaceId)
      throw new Error('Catalog workspace placement must use its entity workspace.');
    const rows = mockStorage.get('catalog_workspace_placements') as CatalogWorkspacePlacementRow[];
    if (
      normalized.status === 'active' &&
      rows.some(
        (row) =>
          row.entity_id !== input.entityId &&
          row.workspace_id === input.workspaceId &&
          row.parent_relative_path === normalized.parentRelativePath &&
          row.normalized_sibling_name === normalized.normalizedSiblingName &&
          row.status === 'active'
      )
    )
      throw new Error('Catalog placement sibling already exists.');
    const existing = rows.find((row) => row.entity_id === input.entityId);
    const now = Date.now();
    const row = {
      entity_id: input.entityId,
      workspace_id: input.workspaceId,
      parent_relative_path: normalized.parentRelativePath,
      display_name: normalized.displayName,
      normalized_sibling_name: normalized.normalizedSiblingName,
      presentation_kind: normalized.presentationKind,
      status: normalized.status,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing) Object.assign(existing, row);
    else rows.push(row);
    return row;
  }

  async removeCatalogWorkspacePlacement(
    entityId: string,
    mode: 'hide' | 'delete'
  ): Promise<boolean> {
    const rows = mockStorage.get('catalog_workspace_placements') as CatalogWorkspacePlacementRow[];
    const index = rows.findIndex((row) => row.entity_id === entityId);
    if (index < 0 || (mode === 'hide' && rows[index].status === 'hidden')) return false;
    if (mode === 'delete') rows.splice(index, 1);
    else Object.assign(rows[index], { status: 'hidden', updated_at: Date.now() });
    return true;
  }

  async restoreCatalogProviderBinding(input: RestoreCatalogProviderBindingInput): Promise<void> {
    const rows = mockStorage.get('catalog_provider_bindings') as Array<Record<string, unknown>>;
    const id = `pb:${input.provider}:${input.objectClass}:${input.stableObjectId}:${input.entityId}`;
    const existing = rows.find((row) => row.id === id);
    const row = {
      id,
      provider: input.provider,
      stable_object_id: input.stableObjectId,
      object_class: input.objectClass,
      entity_id: input.entityId,
      binding_kind: input.bindingKind,
      provider_account_hint: input.providerAccountHint ?? null,
      canonical_url: input.canonicalUrl ?? null,
      evidence_json: JSON.stringify(input.evidence),
      created_at: existing?.created_at ?? Date.now(),
      updated_at: Date.now(),
    };
    if (existing) Object.assign(existing, row);
    else rows.push(row);
  }

  async archiveSupersededNotebookCatalog(
    input: ArchiveSupersededNotebookCatalogInput
  ): Promise<void> {
    const rows = mockStorage.get('catalog_entities') as CatalogEntityRow[];
    const source = rows.find((row) => row.id === input.sourceEntityId);
    const successor = rows.find((row) => row.id === input.successorEntityId);
    const bindings = mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[];
    if (
      !source ||
      !successor ||
      source.workspace_id !== input.workspaceId ||
      successor.workspace_id !== input.workspaceId ||
      !bindings.some(
        (binding) =>
          binding.entity_id === successor.id &&
          binding.workspace_id === input.workspaceId &&
          binding.status === 'current'
      ) ||
      bindings.some((binding) => binding.entity_id === source.id && binding.status === 'current')
    )
      throw new Error('Legacy notebook projection could not be retired after scoped recovery');
    source.status = 'archived';
    source.updated_at = Date.now();
  }

  async ensureSequenceIndex(
    input: import('../shared/sequence-index-command').SequenceIndexRequest
  ): Promise<number> {
    const workspaces = mockStorage.get('workspaces') as Array<{ id: number; path: string }>;
    const owner = input.workspaceRoot
      ? workspaces.find((row) => row.path === input.workspaceRoot)
      : workspaces
          .filter((row) => pathIsAtOrUnder(input.filePath, row.path))
          .sort((a, b) => b.path.length - a.path.length)[0];
    if (!owner) throw new Error('Sequence mock owner is unavailable.');
    const files = mockStorage.get('indexed_files') as Array<Record<string, unknown>>;
    let file = files.find((row) => row.path === input.filePath);
    if (!file) {
      file = {
        id: Math.max(0, ...files.map((row) => Number(row.id))) + 1,
        workspace_id: owner.id,
        path: input.filePath,
        name: input.filePath.split('/').pop(),
        extension: input.filePath.split('.').pop(),
        indexed_at: Date.now(),
      };
      files.push(file);
    }
    const rows = mockStorage.get('sequences') as Array<Record<string, unknown>>;
    const existing = rows.find((row) => row.document_id === input.documentId);
    if (existing) return Number(existing.id);
    const sequence = {
      id: Math.max(0, ...rows.map((row) => Number(row.id))) + 1,
      file_id: file.id,
      document_id: input.documentId,
      name: file.name,
      length: 0,
      circular: 0,
    };
    rows.push(sequence);
    return Number(sequence.id);
  }

  async ensureWorkspaceOwner(
    root: string,
    access?: 'writable' | 'reference',
    discovery?: WorkspaceOwnerDiscovery
  ): Promise<number> {
    const rows = mockStorage.get('workspaces') as Array<Record<string, unknown>>;
    const existing = rows.find((row) => row.path === root);
    if (existing) {
      if (discovery?.recordOpen && (existing.archived_at != null || existing.trashed_at != null))
        throw new Error('Restore the owning project before opening it.');
      for (const column of ['created_at', 'last_opened_at', 'archived_at', 'trashed_at']) {
        if (typeof existing[column] === 'number')
          existing[column] = normalizeWorkspaceTimestamp(existing[column]);
      }
      if (access === 'writable' && existing.access_mode === 'reference')
        throw new Error(
          'A reference workspace cannot acquire write authority through discovery. Import an editable copy.'
        );
      if (access === 'reference') existing.access_mode = access;
      if (discovery?.recordOpen) existing.last_opened_at = Date.now();
      existing.repo_uuid ??= null;
      existing.archived_at ??= null;
      existing.trashed_at ??= null;
      return existing.id as number;
    }
    const id = Math.max(0, ...rows.map((row) => row.id as number)) + 1;
    const now = Date.now();
    rows.push({
      id,
      path: root,
      name:
        discovery?.name ??
        (root
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() ||
          'Project'),
      created_at: now,
      last_opened_at: now,
      access_mode: access ?? 'writable',
      repo_uuid: null,
      archived_at: null,
      trashed_at: null,
    });
    return id;
  }

  async setCatalogFileState(
    path: string,
    state: 'missing' | 'historical',
    reason: string
  ): Promise<CatalogFileBindingRow | null> {
    if (!['missing', 'historical'].includes(state))
      throw new Error('Catalog file state request is invalid.');
    const file = (mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[]).find(
      (file) => file.path === path
    );
    if (!file || (state === 'missing' && file.status !== 'current' && file.status !== 'missing'))
      return file ?? null;
    const eventType = state === 'missing' ? 'file_missing' : 'file_historical';
    const events = mockStorage.get('catalog_entity_events') as CatalogEventRow[];
    if (file.status === state) {
      const last = events
        .filter(
          (event) =>
            event.entity_id === file.entity_id &&
            event.event_type === eventType &&
            JSON.parse(String(event.payload)).path === path
        )
        .at(-1);
      if (!last || JSON.parse(String(last.payload)).reason === reason) return file;
    }
    const now = Date.now();
    if (file.status !== state) {
      file.status = state;
      if (state === 'missing') file.missing_since = now;
      file.updated_at = now;
    }
    events.push({
      id: crypto.randomUUID(),
      entity_id: file.entity_id,
      event_type: eventType,
      actor: 'user',
      summary:
        state === 'missing'
          ? 'Catalog file binding is missing on disk'
          : 'Catalog file binding is historical',
      payload: JSON.stringify({ path, reason, fileKind: file.file_kind }),
      created_at: now,
    });
    return file;
  }

  async refreshCatalogFileFingerprints(files: readonly CatalogFileFingerprint[]): Promise<void> {
    const current = mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[];
    for (const file of files) {
      const row = current.find((row) => row.id === file.id);
      if (
        !row ||
        row.status !== 'current' ||
        !row.object_uuid ||
        ['entity_id', 'workspace_id', 'path', 'object_uuid', 'file_kind'].some(
          (key) =>
            row[key as keyof CatalogFileBindingRow] !== file[key as keyof CatalogFileFingerprint]
        )
      )
        throw new Error(
          'Native sequence binding changed during Git discovery. Retry workspace reconciliation.'
        );
    }
    for (const file of files) {
      const row = current.find((row) => row.id === file.id)!;
      Object.assign(row, {
        content_hash: file.content_hash,
        size_bytes: file.size_bytes,
        modified_at: file.modified_at ?? row.modified_at,
        last_seen_at: Date.now(),
        updated_at: Date.now(),
      });
    }
  }

  async releaseMissingCatalogFilePath(
    file: CatalogFileBindingRow,
    replacementEntityId: string
  ): Promise<void> {
    const files = mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[];
    const row = files.find((row) => row.id === file.id);
    if (
      !row ||
      row.status !== 'missing' ||
      row.entity_id === replacementEntityId ||
      ['entity_id', 'path', 'object_uuid', 'content_hash'].some(
        (key) =>
          row[key as keyof CatalogFileBindingRow] !== file[key as keyof CatalogFileBindingRow]
      )
    )
      throw new Error('Catalog file ownership changed before its missing path could be released.');
    mockStorage.set(
      'catalog_entity_files',
      files.filter((row) => row.id !== file.id)
    );
    mockStorage.get('catalog_entity_events')!.push({
      id: crypto.randomUUID(),
      entity_id: file.entity_id,
      event_type: 'file_path_reuse',
      actor: 'user',
      summary: 'Preserved missing file identity before filename reuse',
      payload: JSON.stringify({ previousFile: file, replacementEntityId }),
      created_at: Date.now(),
    });
  }

  async registerWorkspaceFile(
    input: CatalogWorkspaceFileRegistrationRequest
  ): Promise<CatalogEntityRow> {
    const snapshot = new Map(
      [...mockStorage].map(([table, rows]) => [table, rows.map((row) => ({ ...(row as object) }))])
    );
    try {
      const files = mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[];
      const workspace = (
        mockStorage.get('workspaces') as Array<{
          id: number;
          path: string;
          repo_uuid?: string | null;
        }>
      ).find((row) => row.path === input.workspaceRoot);
      const current = files.find((file) => file.path === input.path);
      if (current) {
        const owner = (mockStorage.get('catalog_entities') as CatalogEntityRow[]).find(
          (entity) => entity.id === current.entity_id
        );
        if (
          !owner ||
          owner.workspace_id !== (workspace?.id ?? null) ||
          current.workspace_id !== owner.workspace_id
        )
          throw new Error('Discovered file must use its existing entity workspace owner.');
        if (!owner.locator.startsWith('file://')) {
          await this.bindCatalogEntityFile({
            ...input,
            entityId: owner.id,
            fileKind: current.file_kind,
          });
          return owner;
        }
      }
      if (!current && input.contentHash?.startsWith('sha256:')) {
        const candidates = files.filter(
          (file) =>
            file.status === 'missing' &&
            file.object_uuid &&
            file.content_hash === input.contentHash &&
            file.workspace_id === (workspace?.id ?? null)
        );
        if (candidates.length === 1) {
          const candidate = candidates[0];
          const entity = (mockStorage.get('catalog_entities') as CatalogEntityRow[]).find(
            (entity) => entity.id === candidate.entity_id
          );
          if (
            entity?.locator === `file://${candidate.path}` &&
            entity.workspace_id === (workspace?.id ?? null)
          )
            await this.rebindCatalogFiles({
              oldPath: candidate.path,
              newPath: input.path,
              workspaceRoot: input.workspaceRoot,
              actor: 'file-discovery',
            });
        }
      }
      const row = await this.registerCatalogEntity({
        type: input.entityType ?? (input.fileKind === 'folder' ? 'folder' : 'file'),
        name: input.name ?? input.path.split('/').pop()!,
        locator: `file://${input.path}`,
        storageType: 'file',
        workspaceRoot: input.workspaceRoot,
        preserveExistingName: true,
        metadata: {
          ...input.metadata,
          path: input.path,
          relativePath: input.workspaceRoot
            ? pathRelativeToBoundary(input.path, input.workspaceRoot)
            : null,
          fileKind: input.fileKind ?? 'file',
        },
      });
      await this.bindCatalogEntityFile({ ...input, entityId: row.id });
      return row;
    } catch (error) {
      mockStorage.clear();
      for (const [table, rows] of snapshot) mockStorage.set(table, rows);
      throw error;
    }
  }

  async rebindCatalogFiles(input: CatalogFileRebindRequest) {
    if (input.oldPath === input.newPath) return { updated: 0, missingOldPath: false };
    const files = mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[];
    const entities = mockStorage.get('catalog_entities') as CatalogEntityRow[];
    const workspace = (
      mockStorage.get('workspaces') as Array<{
        id: number;
        path: string;
        repo_uuid?: string | null;
      }>
    ).find((row) => row.path === input.workspaceRoot);
    const matches = files.filter((file) => pathIsAtOrUnder(file.path, input.oldPath));
    if (
      input.workspaceRoot &&
      (!workspace ||
        !pathIsAtOrUnder(input.oldPath, input.workspaceRoot) ||
        !pathIsAtOrUnder(input.newPath, input.workspaceRoot))
    )
      throw new Error('Catalog relocation must remain inside its workspace owner.');
    for (const file of matches) {
      const entity = entities.find((entity) => entity.id === file.entity_id);
      if (
        !entity ||
        entity.workspace_id !== (workspace?.id ?? null) ||
        file.workspace_id !== entity.workspace_id
      )
        throw new Error('Catalog relocation must use the exact entity workspace owner.');
      const destination = rebasePath(file.path, input.oldPath, input.newPath);
      if (files.some((other) => other.path === destination && !matches.includes(other)))
        throw new Error('Catalog relocation destination belongs to another entity.');
      if (
        entities.some(
          (other) =>
            other.locator === `file://${destination}` &&
            !matches.some((match) => match.entity_id === other.id)
        )
      )
        throw new Error('Catalog relocation destination belongs to another entity.');
    }
    const now = Date.now();
    const events: unknown[] = [];
    const nextEntities = [...entities];
    const nextFiles = files.map((file) => {
      if (!matches.includes(file)) return file;
      const path = rebasePath(file.path, input.oldPath, input.newPath);
      const relativePath = input.workspaceRoot
        ? pathRelativeToBoundary(path, input.workspaceRoot)
        : null;
      const index = nextEntities.findIndex((entity) => entity.id === file.entity_id);
      const entity = nextEntities[index];
      if (entity?.locator === `file://${file.path}`) {
        const metadata = JSON.parse(entity.metadata ?? '{}') as Record<string, unknown>;
        const placement = metadata.placement as Record<string, unknown> | undefined;
        const oldName = file.path.split('/').pop();
        nextEntities[index] = {
          ...entity,
          locator: `file://${path}`,
          updated_at: now,
          name: entity.name === oldName ? path.split('/').pop()! : entity.name,
          metadata: JSON.stringify({
            ...metadata,
            ...(placement?.kind === 'file' && placement.relativePath === file.relative_path
              ? { placement: { ...placement, relativePath } }
              : {}),
            path,
            previousPath: file.path,
          }),
        };
      }
      events.push({
        id: crypto.randomUUID(),
        entity_id: file.entity_id,
        event_type: 'path_moved',
        actor: input.actor ?? 'user',
        summary: 'Catalog file binding moved',
        payload: JSON.stringify({ oldPath: file.path, newPath: path }),
        created_at: now,
      });
      return {
        ...file,
        path,
        relative_path: relativePath,
        file_kind:
          file.path === input.oldPath && input.targetFileKind
            ? input.targetFileKind
            : ['folder', 'waypoint-notebook', 'waypoint-design'].includes(file.file_kind) ||
                isSequencePackageFileKind(file.file_kind)
              ? file.file_kind
              : inferCatalogFileKind(path),
        last_seen_at: now,
        updated_at: now,
      };
    });
    mockStorage.set('catalog_entity_files', nextFiles);
    mockStorage.set('catalog_entities', nextEntities);
    mockStorage.set('catalog_entity_events', [
      ...(mockStorage.get('catalog_entity_events') ?? []),
      ...events,
    ]);
    return { updated: matches.length, missingOldPath: matches.length === 0 };
  }

  async clearCatalogProjection(workspaceRoot: string): Promise<CatalogProjectionClearResult> {
    const workspace = (mockStorage.get('workspaces') as Array<{ id: number; path: string }>).find(
      (row) => row.path === workspaceRoot
    );
    const workspaceId = workspace?.id ?? null;
    if (
      workspaceId !== null &&
      ['catalog_entities', 'catalog_entity_files'].some((table) =>
        (mockStorage.get(table) as Array<{ workspace_id: number | null }>).some(
          (row) => row.workspace_id === workspaceId
        )
      )
    )
      throw new Error(CATALOG_RESET_RETAINED_MESSAGE);
    return { workspaceId, entities: 0, files: 0, links: 0, events: 0 };
  }

  async deleteCatalogEntityIfUnbound(entityId: string): Promise<boolean> {
    if (
      (mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[]).some(
        (file) => file.entity_id === entityId
      )
    )
      return false;
    const entities = mockStorage.get('catalog_entities') as CatalogEntityRow[];
    if (!entities.some((entity) => entity.id === entityId)) return false;
    throw new Error(CATALOG_ROLLBACK_RETAINED_MESSAGE);
  }

  async deleteCatalogEntityWithExactBinding(input: CatalogEntityRollbackRequest): Promise<boolean> {
    const files = mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[];
    const matches = files.filter((file) => file.entity_id === input.entityId);
    const entities = mockStorage.get('catalog_entities') as CatalogEntityRow[];
    const entity = entities.find((entity) => entity.id === input.entityId);
    if (
      matches.length !== 1 ||
      matches[0].path !== input.path ||
      matches[0].file_kind !== input.fileKind ||
      matches[0].workspace_id !== entity?.workspace_id
    )
      return false;
    throw new Error(CATALOG_ROLLBACK_RETAINED_MESSAGE);
  }

  async registerCatalogEntity(input: CatalogEntityRegistrationRequest): Promise<CatalogEntityRow> {
    const workspace = input.workspaceRoot
      ? (
          mockStorage.get('workspaces') as Array<{
            id: number;
            path: string;
            repo_uuid?: string | null;
          }>
        ).find((row) => row.path === input.workspaceRoot)
      : undefined;
    if (input.workspaceRoot && !workspace)
      throw new Error('Catalog registration workspace owner is not registered.');
    const entities = mockStorage.get('catalog_entities') as CatalogEntityRow[];
    const row = planCatalogEntityRegistration(
      input,
      workspace?.id ?? null,
      entities,
      Date.now(),
      () => crypto.randomUUID(),
      workspaceScopeKey(workspace?.repo_uuid, workspace?.id)
    );
    mockStorage.set('catalog_entities', [
      ...entities.filter((entity) => entity.id !== row.id),
      row,
    ]);
    return row;
  }

  async bindCatalogEntityFile(input: CatalogFileBindingRequest): Promise<CatalogFileBindingRow> {
    const entities = mockStorage.get('catalog_entities') as Array<{
      id: string;
      workspace_id?: number | null;
    }>;
    const entity = entities.find((entity) => entity.id === input.entityId);
    if (!entity) {
      throw new Error('Catalog file binding entity does not exist.');
    }
    const workspaces = mockStorage.get('workspaces') as Array<{
      id: number;
      path: string;
      archived_at?: number | null;
      trashed_at?: number | null;
    }>;
    const workspace = input.workspaceRoot
      ? workspaces.find(
          (row) =>
            row.path === input.workspaceRoot && row.archived_at == null && row.trashed_at == null
        )
      : undefined;
    if (input.workspaceRoot && !workspace)
      throw new Error('Catalog file binding workspace is not registered.');
    if ((entity.workspace_id ?? null) !== (workspace?.id ?? null))
      throw new Error('Catalog file binding must use its entity workspace owner.');
    const plan = planCatalogMemoryFileBinding(
      input,
      workspace?.id ?? null,
      mockStorage.get('catalog_entity_files') as CatalogFileBindingRow[],
      Date.now(),
      () => crypto.randomUUID()
    );
    const events = [...(mockStorage.get('catalog_entity_events') ?? []), ...plan.events];
    mockStorage.set('catalog_entity_files', plan.files);
    mockStorage.set('catalog_entity_events', events);
    return plan.binding;
  }

  private name: string;

  constructor(name: string) {
    this.name = name;
    console.log(`[MockDB] Initialized mock database: ${name}`);
  }

  async execute(
    sql: string,
    params?: unknown[]
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    console.log(`[MockDB] Execute: ${sql.slice(0, 100)}...`, params);

    const trimmed = sql.trim();
    if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(trimmed)) {
      throw new Error(
        `[MockDB] refusing transactional SQL. Browser fixtures do not implement SQLite transactions. SQL: ${trimmed.slice(0, 120)}`
      );
    }
    if (/\binsert\s+or\s+ignore\b/i.test(trimmed)) {
      throw new Error(
        `[MockDB] refusing INSERT OR IGNORE. Browser fixtures do not implement SQLite conflict handling.`
      );
    }

    if (sql.trim().toLowerCase().startsWith('create table')) {
      return { changes: 0, lastInsertRowid: 0 };
    }

    if (sql.trim().toLowerCase().startsWith('create index')) {
      return { changes: 0, lastInsertRowid: 0 };
    }

    if (sql.trim().toLowerCase().startsWith('alter table')) {
      return { changes: 0, lastInsertRowid: 0 };
    }

    const insertMatch = sql.match(/insert\s+(?:or\s+(?:replace|ignore)\s+)?into\s+(\w+)/i);
    if (insertMatch) {
      const table = insertMatch[1].toLowerCase();
      const rows = mockStorage.get(table) || [];

      const row: Record<string, unknown> = {};
      if (params) {
        const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
        if (colMatch) {
          const columns = colMatch[1].split(',').map((c) => c.trim().toLowerCase());
          for (let i = 0; i < columns.length && i < params.length; i++) {
            row[columns[i]] = params[i];
          }
        }

        if (
          sql.toLowerCase().includes('or replace') &&
          table === 'settings' &&
          row.key !== undefined
        ) {
          const existing = rows as Array<{ key: string }>;
          const idx = existing.findIndex((r) => r.key === row.key);
          if (idx >= 0) existing.splice(idx, 1);
        }

        if (table === 'workspaces') {
          row.id ??= rows.length + 1;
          row.repo_uuid ??= null;
          row.archived_at ??= null;
          row.trashed_at ??= null;
        }
      }

      rows.push(row);
      mockStorage.set(table, rows);
      const insertedRowid = typeof row.id === 'number' ? row.id : rows.length;
      return { changes: 1, lastInsertRowid: insertedRowid };
    }

    const updateMatch = sql.match(/update\s+(\w+)\s+set/i);
    if (updateMatch) {
      const table = updateMatch[1].toLowerCase();
      const rows = (mockStorage.get(table) || []) as Array<Record<string, unknown>>;
      let changes = 0;

      const setSection = sql.match(/set\s+([\s\S]+?)(?:\s+where\s+|$)/i);
      const whereMatch = sql.match(/where\s+(\w+)\s*=\s*\?/i);
      const isNotNullMatch = sql.match(/\b(\w+)\s+is\s+not\s+null/i);
      const notNullCol = isNotNullMatch ? isNotNullMatch[1].toLowerCase() : null;
      const isNullMatch = sql.match(/\b(\w+)\s+is\s+null\b/i);
      const nullCol = isNullMatch ? isNullMatch[1].toLowerCase() : null;

      if (setSection && whereMatch && params) {
        const setCols = setSection[1]
          .split(',')
          .map((s) => s.trim().match(/^(\w+)\s*=\s*\?/i))
          .filter(Boolean);
        const setColNames = setCols.map((m) => m![1].toLowerCase());
        const whereCol = whereMatch[1].toLowerCase();
        const whereVal = params[setColNames.length];

        for (const row of rows) {
          const matchesWhere = row[whereCol] === whereVal;
          const matchesNotNull = notNullCol ? row[notNullCol] != null : true;
          const matchesNull = nullCol ? row[nullCol] == null : true;
          if (matchesWhere && matchesNotNull && matchesNull) {
            for (let i = 0; i < setColNames.length; i++) {
              row[setColNames[i]] = params[i];
            }
            changes++;
          }
        }
      }

      console.log(`[MockDB] UPDATE ${table} (changes=${changes})`);
      return { changes, lastInsertRowid: 0 };
    }

    const deleteMatch = sql.match(/delete\s+from\s+(\w+)/i);
    if (deleteMatch) {
      const table = deleteMatch[1].toLowerCase();
      const rows = mockStorage.get(table) || [];

      if (params && params.length > 0) {
        const inMatch = sql.match(/where\s+(\w+)\s+in\s*\(/i);
        if (inMatch) {
          const column = inMatch[1].toLowerCase();
          const filtered = (rows as Array<Record<string, unknown>>).filter(
            (r) => !params.includes(r[column])
          );
          mockStorage.set(table, filtered);
          return { changes: rows.length - filtered.length, lastInsertRowid: 0 };
        }

        const whereMatch = sql.match(/where\s+(\w+)\s*=\s*\?/i);
        if (whereMatch) {
          const column = whereMatch[1].toLowerCase();
          const filtered = (rows as Array<Record<string, unknown>>).filter(
            (r) => r[column] !== params[0]
          );
          mockStorage.set(table, filtered);
          return { changes: rows.length - filtered.length, lastInsertRowid: 0 };
        }

        const id = params[0];
        const filtered = (rows as Array<{ id: string }>).filter((r) => r.id !== id);
        mockStorage.set(table, filtered);
        return { changes: rows.length - filtered.length, lastInsertRowid: 0 };
      }
      return { changes: 0, lastInsertRowid: 0 };
    }

    return { changes: 0, lastInsertRowid: 0 };
  }

  async select<T>(sql: string, params?: unknown[]): Promise<T> {
    console.log(`[MockDB] Select: ${sql.slice(0, 100)}...`, params);

    if (sql.trim().toLowerCase().startsWith('pragma')) {
      return [] as T;
    }

    const tableMatch = sql.match(/from\s+(\w+)/i);
    if (!tableMatch) {
      return [] as T;
    }

    const table = tableMatch[1].toLowerCase();
    let rows = mockStorage.get(table) || [];

    if (isCurrentSequenceFileSelector(sql)) {
      return selectCurrentSequenceFiles(params) as T;
    }

    assertMockCanHonourPredicates(sql);

    if (sql.toLowerCase().includes('where') && params && params.length > 0) {
      const parameterPredicates = [
        ...sql.matchAll(/(?:where|and)\s+(?:\w+\.)?(\w+)\s*(=|is|like)\s*\?/gi),
      ];
      if (parameterPredicates.length > 0) {
        rows = (rows as Array<Record<string, unknown>>).filter((row) =>
          parameterPredicates.every((match, index) => {
            const column = match[1].toLowerCase();
            const operator = match[2].toLowerCase();
            const expected = params[index];
            if (operator !== 'like') return row[column] === expected;
            if (typeof expected !== 'string') return false;
            const actual = row[column];
            return typeof actual === 'string' && matchesSqlLike(actual, expected);
          })
        );
      }

      for (const match of sql.matchAll(/(?:where|and)\s+(?:\w+\.)?(\w+)\s*=\s*'([^']*)'/gi)) {
        const column = match[1].toLowerCase();
        const value = match[2];
        rows = (rows as Array<Record<string, unknown>>).filter((row) => row[column] === value);
      }

      for (const match of sql.matchAll(/(?:where|and)\s+(?:\w+\.)?(\w+)\s+is\s+not\s+null/gi)) {
        const column = match[1].toLowerCase();
        rows = (rows as Array<Record<string, unknown>>).filter((row) => row[column] != null);
      }

      for (const match of sql.matchAll(/(?:where|and)\s+(?:\w+\.)?(\w+)\s+is\s+null/gi)) {
        const column = match[1].toLowerCase();
        rows = (rows as Array<Record<string, unknown>>).filter((row) => row[column] == null);
      }

      const inMatch = sql.match(/where\s+(?:\w+\.)?(\w+)\s+in\s*\(/i);
      if (inMatch) {
        const column = inMatch[1].toLowerCase();
        rows = (rows as Array<Record<string, unknown>>).filter((r) => params.includes(r[column]));
      }
    }

    if (sql.toLowerCase().includes('join')) {
      const joinMatch = sql.match(
        /from\s+(\w+)\s+\w+\s+join\s+(\w+)\s+\w+\s+on\s+\w+\.(\w+)\s*=\s*\w+\.(\w+)/i
      );
      if (joinMatch) {
        const table1 = joinMatch[1].toLowerCase();
        const table2 = joinMatch[2].toLowerCase();
        const col1 = joinMatch[3].toLowerCase();
        const col2 = joinMatch[4].toLowerCase();
        const rows1 = (mockStorage.get(table1) || []) as Array<Record<string, unknown>>;
        const rows2 = (mockStorage.get(table2) || []) as Array<Record<string, unknown>>;

        const joined: Record<string, unknown>[] = [];
        for (const r1 of rows1) {
          for (const r2 of rows2) {
            if (r1[col1] === r2[col2]) {
              joined.push({ ...r1, ...r2 });
            }
          }
        }

        if (params && params.length > 0) {
          const whereMatch = sql.match(/where\s+(?:\w+\.)?(\w+)\s*=\s*\?/i);
          if (whereMatch) {
            const column = whereMatch[1].toLowerCase();
            rows = joined.filter((r) => r[column] === params[0]);
          } else {
            rows = joined;
          }
        } else {
          rows = joined;
        }
      }
    }

    const maxMatch = sql.match(/select\s+max\((\w+)\)\s+as\s+(\w+)/i);
    if (maxMatch) {
      const column = maxMatch[1].toLowerCase();
      const alias = maxMatch[2].toLowerCase();
      const typedRows = rows as Array<Record<string, unknown>>;
      const max = typedRows.reduce((acc: number | null, r) => {
        const val = r[column] as number | null;
        if (val === null || val === undefined) return acc;
        return acc === null ? val : Math.max(acc, val);
      }, null);
      return [{ [alias]: max }] as T;
    }

    const limitMatch = sql.match(/limit\s+(\d+)/i);
    if (limitMatch) {
      const limit = parseInt(limitMatch[1], 10);
      rows = rows.slice(0, limit);
    }

    return rows as T;
  }

  async close(): Promise<void> {
    console.log(`[MockDB] Closed mock database: ${this.name}`);
  }
}

export const MockDatabaseModule = {
  load: async (name: string) => new MockDatabase(name),
};

export const MockDialogModule = {
  open: async () => {
    console.log('[MockDialog] open() called - returning null');
    return null;
  },
  save: async () => {
    console.log('[MockDialog] save() called - returning null');
    return null;
  },
  message: async (msg: string) => {
    console.log('[MockDialog] message():', msg);
  },
  ask: async () => {
    console.log('[MockDialog] ask() called - returning true');
    return true;
  },
  confirm: async () => {
    console.log('[MockDialog] confirm() called - returning true');
    return true;
  },
};

const MOCK_FILE_CONTENT: Record<string, string> = {};
const MOCK_BINARY_CONTENT: Record<string, Uint8Array> = {};

interface VirtualEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
  content?: string;
}
const VIRTUAL_FILE_TREE: Record<string, VirtualEntry[]> = {};

export function setMockFileContent(path: string, content: string | Uint8Array): void {
  if (typeof content === 'string') {
    MOCK_FILE_CONTENT[path] = content;
    console.log(`[MockFs] Registered text content for: ${path} (${content.length} chars)`);
  } else {
    MOCK_BINARY_CONTENT[path] = content;
    console.log(`[MockFs] Registered binary content for: ${path} (${content.length} bytes)`);
  }
}

export function getMockFileContent(path: string): string | null {
  return MOCK_FILE_CONTENT[path] ?? null;
}

export async function loadMockFileFromUrl(path: string, url: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (
      response.headers.get('content-type')?.includes('text') ||
      path.endsWith('.gb') ||
      path.endsWith('.fasta') ||
      path.endsWith('.fa')
    ) {
      const text = await response.text();
      setMockFileContent(path, text);
    } else {
      const buffer = await response.arrayBuffer();
      setMockFileContent(path, new Uint8Array(buffer));
    }
  } catch (error) {
    console.error(`[MockFs] Failed to load mock from URL ${url}:`, error);
  }
}

export function setFileTree(
  dirPath: string,
  entries: Array<{ name: string; isDirectory: boolean; content?: string }>
): void {
  const normalized = dirPath.endsWith('/') ? dirPath.slice(0, -1) : dirPath;
  VIRTUAL_FILE_TREE[normalized] = entries.map((e) => ({
    name: e.name,
    isDirectory: e.isDirectory,
    isFile: !e.isDirectory,
  }));
  for (const entry of entries) {
    if (!entry.isDirectory && entry.content !== undefined) {
      const fullPath = `${normalized}/${entry.name}`;
      MOCK_FILE_CONTENT[fullPath] = entry.content;
    }
  }
  console.log(`[MockFs] setFileTree: ${normalized} → ${entries.length} entries`);
}

export function clearFileTree(): void {
  for (const key of Object.keys(VIRTUAL_FILE_TREE)) {
    delete VIRTUAL_FILE_TREE[key];
  }
}

let mockGitStatusPorcelain = '';

export function setMockGitStatusPorcelain(porcelain: string): void {
  mockGitStatusPorcelain = porcelain;
}

export function getMockGitStatusPorcelain(): string {
  return mockGitStatusPorcelain;
}

export const MockFsModule = {
  readTextFile: async (path: string) => {
    console.log('[MockFs] readTextFile():', path);

    if (MOCK_FILE_CONTENT[path]) {
      console.log('[MockFs] Returning mock content for:', path);
      return MOCK_FILE_CONTENT[path];
    }

    const injected =
      typeof window === 'undefined'
        ? undefined
        : (window as Window & { __E2E_INJECTED_FILES?: Record<string, unknown> })
            .__E2E_INJECTED_FILES;
    const injectedContent = injected?.[path];
    if (typeof injectedContent === 'string') {
      console.log('[MockFs] Returning E2E-injected content for:', path);
      return injectedContent;
    }

    if (path.includes('ecoli-mg1655-region.gb') || path.includes('variant1.fasta')) {
      console.log('[MockFs] Returning sample content for test file:', path);
      if (path.endsWith('.gb')) {
        return `LOCUS       Test_Plasmid    82000 bp    DNA     circular SYN 01-JAN-2023
DEFINITION  Test plasmid for E2E testing.
ACCESSION   .
VERSION     .
KEYWORDS    .
SOURCE      synthetic DNA construct
  ORGANISM  synthetic DNA construct
FEATURES             Location/Qualifiers
     CDS             1..1000
                     /label="Test_Gene"
                     /note="Test gene for E2E"
ORIGIN
        1 ${'atcgatcgat'.repeat(8200)}
//`;
      } else if (path.endsWith('.fasta') || path.endsWith('.fa')) {
        return `>Test_Sequence
${'ATCGATCGAT'.repeat(5000)}`;
      }
    }

    console.warn('[MockFs] No mock content for:', path);
    return '';
  },
  readTextFileSlice: async (path: string, maxBytes: number) => {
    const text = await MockFsModule.readTextFile(path);
    return { text: text.slice(0, maxBytes), bytesRead: Math.min(text.length, maxBytes) };
  },
  readFile: async (path: string) => {
    console.log('[MockFs] readFile():', path);

    if (MOCK_BINARY_CONTENT[path]) {
      console.log('[MockFs] Returning mock binary content for:', path);
      return MOCK_BINARY_CONTENT[path];
    }

    if (MOCK_FILE_CONTENT[path]) {
      console.log('[MockFs] Converting text to binary for:', path);
      const encoder = new TextEncoder();
      return encoder.encode(MOCK_FILE_CONTENT[path]);
    }

    console.warn('[MockFs] No mock content for:', path);
    return new Uint8Array();
  },
  readFileBounded: async (path: string, maxBytes: number) => {
    const bytes = await MockFsModule.readFile(path);
    if (bytes.byteLength > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
    return bytes;
  },
  sha256File: async (path: string) => {
    const bytes = await MockFsModule.readFile(path);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `sha256:${hex}`;
  },
  writeTextFile: async (path: string, contents: string) => {
    MOCK_FILE_CONTENT[path] = contents;
    console.log('[MockFs] writeTextFile():', path, `(${contents.length} chars)`);
  },
  writeFile: async (path: string, contents: Uint8Array) => {
    MOCK_BINARY_CONTENT[path] = new Uint8Array(contents);
    console.log('[MockFs] writeFile():', path);
  },
  readDir: async (path: string) => {
    console.log('[MockFs] readDir():', path);

    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    if (VIRTUAL_FILE_TREE[normalized]) {
      console.log('[MockFs] Returning virtual file tree for:', normalized);
      return VIRTUAL_FILE_TREE[normalized].map((e) => ({
        ...e,
        children: [],
      }));
    }

    if (path.includes('plasmid-variants') || path.includes('mock-assets')) {
      return [
        {
          name: 'ecoli-mg1655-region.gb',
          isDirectory: false,
          isFile: true,
          children: [],
        },
        {
          name: 'variant1.fasta',
          isDirectory: false,
          isFile: true,
          children: [],
        },
      ];
    }

    return [];
  },
  exists: async (path: string) => {
    console.log('[MockFs] exists():', path);

    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    if (VIRTUAL_FILE_TREE[normalized]) {
      return true;
    }

    if (path.includes('.welcome-seen') || path.includes('.last-seen-version')) {
      console.log('[MockFs] exists → true (auto-dismiss welcome):', path);
      return true;
    }

    const injected =
      typeof window === 'undefined'
        ? undefined
        : (window as Window & { __E2E_INJECTED_FILES?: Record<string, unknown> })
            .__E2E_INJECTED_FILES;
    const prefix = `${normalized}/`;
    const hasNestedContent =
      Object.keys(MOCK_FILE_CONTENT).some((key) => key === normalized || key.startsWith(prefix)) ||
      Object.keys(MOCK_BINARY_CONTENT).some((key) => key === normalized || key.startsWith(prefix));
    const exists = !!(
      hasNestedContent ||
      injected?.[path] ||
      path.includes('plasmid-variants') ||
      path.includes('ecoli-mg1655-region.gb') ||
      path.includes('variant1.fasta')
    );

    console.log('[MockFs] exists result:', exists);
    return exists;
  },
  mkdir: async (path: string) => {
    console.log('[MockFs] mkdir():', path);
  },
  rename: async (oldPath: string, newPath: string) => {
    console.log('[MockFs] rename():', oldPath, '->', newPath);
    const moveMap = (store: Record<string, unknown>) => {
      const entries = Object.entries(store);
      for (const [path, value] of entries) {
        if (path === oldPath) {
          store[newPath] = value;
          delete store[path];
          continue;
        }
        if (path.startsWith(`${oldPath}/`)) {
          const suffix = path.slice(oldPath.length);
          store[`${newPath}${suffix}`] = value;
          delete store[path];
        }
      }
    };
    moveMap(MOCK_FILE_CONTENT as Record<string, unknown>);
    moveMap(MOCK_BINARY_CONTENT as Record<string, unknown>);
  },
  remove: async (path: string) => {
    console.log('[MockFs] remove():', path);
  },
  stat: async (path: string) => {
    console.log('[MockFs] stat():', path);
    const now = Date.now();

    if (MOCK_FILE_CONTENT[path]) {
      return {
        size: MOCK_FILE_CONTENT[path].length,
        isFile: true,
        isDirectory: false,
        mtime: now,
        ctime: now,
      };
    }

    const normalized = path.endsWith('/') ? path.slice(0, -1) : path;
    if (VIRTUAL_FILE_TREE[normalized]) {
      return {
        size: 0,
        isFile: false,
        isDirectory: true,
        mtime: now,
        ctime: now,
      };
    }

    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash >= 0) {
      const parentDir = normalized.slice(0, lastSlash);
      const fileName = normalized.slice(lastSlash + 1);
      const parentEntries = VIRTUAL_FILE_TREE[parentDir];
      if (parentEntries) {
        const entry = parentEntries.find((e) => e.name === fileName);
        if (entry) {
          const content = MOCK_FILE_CONTENT[normalized];
          return {
            size: content ? content.length : 4096,
            isFile: entry.isFile,
            isDirectory: entry.isDirectory,
            mtime: now,
            ctime: now,
          };
        }
      }
    }

    console.warn('[MockFs] stat: no mock data for path, returning default:', path);
    return {
      size: 0,
      isFile: true,
      isDirectory: false,
      mtime: now,
      ctime: now,
    };
  },
};

export function isBrowserOnly(): boolean {
  return typeof window !== 'undefined' && !('electronAPI' in window);
}

export function clearMockData(): void {
  for (const [key] of mockStorage) {
    mockStorage.set(key, []);
  }
  setMockGitStatusPorcelain('');
  for (const key of Object.keys(MOCK_FILE_CONTENT)) {
    delete MOCK_FILE_CONTENT[key];
  }
  for (const key of Object.keys(MOCK_BINARY_CONTENT)) {
    delete MOCK_BINARY_CONTENT[key];
  }
  clearFileTree();
  console.log('[MockDB] Cleared all mock data');
}

export function seedMockData(table: string, data: unknown[]): void {
  mockStorage.set(table.toLowerCase(), data);
  console.log(`[MockDB] Seeded ${table} with ${data.length} rows`);
}

export function getMockData(table: string): unknown[] {
  return mockStorage.get(table.toLowerCase()) || [];
}

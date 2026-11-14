import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  parseInventoryState,
  type InventoryPrincipal,
  type InventoryState,
} from '@waypoint/domain-services';
import {
  inventoryExecuteRequestSchema,
  inventoryHistoryRequestSchema,
  inventoryMaterialQuerySchema,
  inventoryOperationRequestSchema,
  inventoryReadRequestSchema,
  inventoryReceiptSchema,
  inventoryPrincipalSchema,
  inventoryReceiptContextSchema,
  type InventoryExecuteRequest,
  type NativeInventoryExecution,
  type NativeInventoryHistoryEntry,
  type NativeInventoryReceipt,
} from '../shared/inventory-command';
import type {
  InventoryChanged,
  InventoryAvailabilitySnapshot,
  InventoryMaterial,
  InventoryMaterialPage,
  InventoryProject,
} from '../shared/inventory-client';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import type { RegisteredProject, RegisteredProjectAuthority } from './registered-project-authority';
import { resolveSavedRegistryProject } from './registry-entity-project';
import { registrySourceEligibilitySql } from './registry-source-eligibility';
import { assertAcceptingSharedProjectContentWritable } from './shared-project-write-access';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { NativeDocumentCommandError } from '../shared/native-document-error';

interface InventoryRow {
  inventory_id: string;
  project_id: string;
  revision: number;
  state_json: string;
}

interface JournalRow {
  inventory_id: string;
  operation_id: string;
  revision: number;
  request_json: string;
  receipt_json: string;
}

interface WorkspaceIdentity {
  id: number;
  path: string;
  repo_uuid: string | null;
  access_mode: string;
  archived_at: number | null;
  trashed_at: number | null;
}

function dataError(): never {
  throw new Error('INVENTORY_DATA_INVALID: The saved inventory data could not be verified.');
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return dataError();
  }
}

function requestDigest(request: InventoryExecuteRequest): string {
  return `sha256:${createHash('sha256').update(canonicalNativeMutationRequest(request)).digest('hex')}`;
}

function materialProject(db: Database.Database, id: string, fieldsJson: string): number | null {
  const fields = parsedJson(fieldsJson);
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return dataError();
  try {
    return resolveSavedRegistryProject(db, {
      id,
      workspaceId: null,
      fields: fields as Record<string, unknown>,
    });
  } catch {
    return null;
  }
}

function stateFromRow(row: InventoryRow): InventoryState {
  try {
    const state = parseInventoryState(parsedJson(row.state_json));
    if (state.revision !== row.revision) return dataError();
    return state;
  } catch {
    return dataError();
  }
}

function entryFromRow(row: JournalRow, project: string): NativeInventoryHistoryEntry {
  try {
    const request = inventoryExecuteRequestSchema.parse(parsedJson(row.request_json));
    const receipt = inventoryReceiptSchema.parse(parsedJson(row.receipt_json));
    if (
      request.project !== project ||
      request.inventoryId !== row.inventory_id ||
      request.operationId !== row.operation_id ||
      request.expectedRevision + 1 !== row.revision ||
      receipt.inventoryId !== row.inventory_id ||
      receipt.operationId !== row.operation_id ||
      receipt.revision !== row.revision ||
      receipt.requestDigest !== requestDigest(request)
    )
      return dataError();
    return { request, receipt };
  } catch {
    return dataError();
  }
}

export function createNativeInventoryOwner(options: {
  db(): Database.Database;
  projectAuthority: RegisteredProjectAuthority;
  actor(): string;
  profileKey: string;
  now?: () => number;
}) {
  const authority = inventoryReceiptContextSchema.shape.authority.parse({
    kind: 'local-profile',
    profileKey: options.profileKey,
  });
  const principal = (invocation: NativeInventoryInvocation): InventoryPrincipal =>
    inventoryPrincipalSchema.parse(invocation.principal ?? authority);
  const observationTime = (state: InventoryState): number => {
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new NativeDocumentCommandError(
        'INVENTORY_CLOCK_UNAVAILABLE',
        'The native inventory clock is unavailable.',
        false
      );
    return Math.max(now, state.lastRecordedAt);
  };
  const listeners = new Set<(event: InventoryChanged) => void>();
  const resolveProject = (reference: string, mutating: boolean): RegisteredProject => {
    assertCommittedDatabaseReadAllowed(options.db());
    const project = options.projectAuthority.resolve(reference);
    if (!project || (mutating && project.pinned))
      throw new NativeDocumentCommandError(
        'PROJECT_ACCESS_DENIED',
        'The inventory project is unavailable.',
        false
      );
    return project;
  };

  const inventory = (db: Database.Database, inventoryId: string, projectId: string) => {
    const row = db
      .prepare('SELECT * FROM inventory_state WHERE inventory_id = ?')
      .get(inventoryId) as InventoryRow | undefined;
    if (row && row.project_id !== projectId)
      throw new NativeDocumentCommandError(
        'PROJECT_ACCESS_DENIED',
        'The inventory belongs to another project.',
        false
      );
    return row;
  };

  const read = (input: unknown) => {
    const request = inventoryReadRequestSchema.parse(input);
    const project = resolveProject(request.project, false);
    const row = inventory(options.db(), request.inventoryId, project.projectId);
    return { project, row, request };
  };

  return {
    projects(): readonly InventoryProject[] {
      assertCommittedDatabaseReadAllowed(options.db());
      return options.projectAuthority.list().map((project) => ({
        projectId: project.projectId,
        name: project.name,
        path: project.path,
        pinned: project.pinned,
        defaultInventoryId: `inventory:${project.projectId}`,
      }));
    },

    materials(input: unknown): InventoryMaterialPage {
      const request = inventoryMaterialQuerySchema.parse(input);
      const project = resolveProject(request.project, false);
      const db = options.db();
      const query = request.query.trim().toLowerCase();
      const limit = request.limit ?? 50;
      const rows = db
        .prepare(
          `SELECT id,name,kind,registry_id,fields FROM lims_entity
         WHERE tombstone=0 AND archived_at IS NULL AND id>?
           AND (?='' OR instr(lower(name),?)>0 OR instr(lower(COALESCE(registry_id,'')),?)>0 OR instr(lower(id),?)>0)
           AND (${registrySourceEligibilitySql(db)})
         ORDER BY id ASC`
        )
        .iterate(request.cursor ?? '', query, query, query, query);
      const items: InventoryMaterial[] = [];
      let scanned = 0;
      let cursor: string | null = null;
      for (const value of rows) {
        const row = value as {
          id: string;
          name: string;
          kind: string;
          registry_id: string | null;
          fields: string;
        };
        scanned += 1;
        cursor = row.id;
        if (materialProject(db, row.id, row.fields) === project.id)
          items.push({ id: row.id, name: row.name, kind: row.kind, registryId: row.registry_id });
        if (items.length === limit || scanned === 1000) return { items, nextCursor: cursor };
      }
      return { items, nextCursor: null };
    },

    subscribe(listener: (event: InventoryChanged) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    initialize(): void {
      const db = options.db();
      assertCommittedDatabaseReadAllowed(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS inventory_state (
          inventory_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          state_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inventory_journal (
          inventory_id TEXT NOT NULL REFERENCES inventory_state(inventory_id),
          operation_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision >= 1),
          request_json TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          PRIMARY KEY(inventory_id, operation_id),
          UNIQUE(inventory_id, revision)
        );
      `);
    },

    execute(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      const parsed = inventoryExecuteRequestSchema.parse(input);
      const project = resolveProject(parsed.project, true);
      const assertProject = options.projectAuthority.capture(project.projectId, true);
      const db = options.db();
      const workspace = db
        .prepare(
          'SELECT id,path,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE id = ?'
        )
        .get(project.id) as WorkspaceIdentity | undefined;
      if (!workspace)
        throw new NativeDocumentCommandError(
          'PROJECT_ACCESS_DENIED',
          'The inventory project is unavailable.',
          false
        );
      const request: InventoryExecuteRequest = { ...parsed, project: project.projectId };
      const canonical = canonicalNativeMutationRequest(request);
      assertCurrent();
      assertProject();

      const assertAcceptingProject = () => {
        const acceptingWorkspace = db
          .prepare(
            'SELECT id,path,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE id = ?'
          )
          .get(project.id) as WorkspaceIdentity | undefined;
        if (
          !acceptingWorkspace ||
          canonicalNativeMutationRequest(acceptingWorkspace) !==
            canonicalNativeMutationRequest(workspace) ||
          acceptingWorkspace.access_mode !== 'writable' ||
          acceptingWorkspace.archived_at !== null ||
          acceptingWorkspace.trashed_at !== null
        )
          throw new Error('PROJECT_ACCESS_CHANGED: The inventory project authority changed.');
        assertAcceptingSharedProjectContentWritable(db, project.path);
      };

      let committed = false;
      const execution = db
        .transaction((): NativeInventoryExecution => {
          assertAcceptingProject();
          assertCurrent();
          const row = inventory(db, request.inventoryId, project.projectId);
          const existing = db
            .prepare('SELECT * FROM inventory_journal WHERE inventory_id = ? AND operation_id = ?')
            .get(request.inventoryId, request.operationId) as JournalRow | undefined;
          if (existing) {
            const entry = entryFromRow(existing, project.projectId);
            if (canonicalNativeMutationRequest(entry.request) !== canonical)
              return {
                status: 'rejected',
                inventoryId: request.inventoryId,
                operationId: request.operationId,
                code: 'INVENTORY_OPERATION_CONFLICT',
                message: 'This operation ID was already used with a different inventory request.',
              };
            return entry.receipt;
          }
          const previous = row ? stateFromRow(row) : createInventoryState();
          const recordedAt = observationTime(previous);
          const context = inventoryReceiptContextSchema.parse({
            version: 1,
            principal: principal(invocation),
            authority,
          });
          const lotMaterials = new Map(
            Object.values(previous.lots).map((lot) => [lot.id, lot.materialId])
          );
          for (const input of request.commands) {
            const command = input.kind === 'fulfill-reservations' ? input.withdrawal : input;
            if (command.kind === 'create-lot') lotMaterials.set(command.id, command.materialId);
            if (command.kind === 'pool' || command.kind === 'dilute')
              lotMaterials.set(command.lotId, command.materialId);
            const materialId =
              command.kind === 'receive-stock' ||
              command.kind === 'create-lot' ||
              command.kind === 'pool' ||
              command.kind === 'dilute'
                ? command.materialId
                : command.kind === 'receive-lot-stock' || command.kind === 'associate-stock-lot'
                  ? lotMaterials.get(command.lotId)
                  : undefined;
            const materialIds =
              command.kind === 'record-composition' && command.composition.kind === 'homogeneous'
                ? Object.keys(command.composition.analytes)
                : materialId
                  ? [materialId]
                  : [];
            for (const materialId of materialIds) {
              const entity = db
                .prepare(
                  `SELECT id,fields FROM lims_entity
               WHERE id = ? AND tombstone = 0 AND archived_at IS NULL
               AND (${registrySourceEligibilitySql(db)})`
                )
                .get(materialId) as { id: string; fields: string } | undefined;
              if (!entity || materialProject(db, entity.id, entity.fields) !== project.id)
                return {
                  status: 'rejected',
                  inventoryId: request.inventoryId,
                  operationId: request.operationId,
                  code: 'INVENTORY_MATERIAL_UNAVAILABLE',
                  message: 'Choose an active scientific record in this inventory project.',
                  currentRevision: previous.revision,
                };
            }
          }
          const result = applyInventoryCommandBatch(
            previous,
            {
              expectedRevision: request.expectedRevision,
              commands: request.commands,
            },
            { at: recordedAt, principal: context.principal, authority: context.authority }
          );
          if (!result.ok)
            return {
              status: 'rejected',
              inventoryId: request.inventoryId,
              operationId: request.operationId,
              code: result.code,
              message: result.message,
              currentRevision: previous.revision,
            };
          const receipt: NativeInventoryReceipt = inventoryReceiptSchema.parse({
            status: 'committed',
            inventoryId: request.inventoryId,
            operationId: request.operationId,
            revision: result.state.revision,
            actor: invocation.actor ?? options.actor(),
            recordedAt,
            context,
            requestDigest: requestDigest(request),
          });
          assertCurrent();
          db.prepare(
            `INSERT INTO inventory_state (inventory_id,project_id,revision,state_json) VALUES(?,?,?,?)
           ON CONFLICT(inventory_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json`
          ).run(
            request.inventoryId,
            project.projectId,
            result.state.revision,
            JSON.stringify(result.state)
          );
          db.prepare(
            `INSERT INTO inventory_journal
           (inventory_id,operation_id,revision,request_json,receipt_json) VALUES(?,?,?,?,?)`
          ).run(
            request.inventoryId,
            request.operationId,
            result.state.revision,
            canonical,
            JSON.stringify(receipt)
          );
          assertCurrent();
          assertAcceptingProject();
          committed = true;
          return receipt;
        })
        .immediate();
      if (committed && execution.status === 'committed') {
        const event: InventoryChanged = {
          projectId: project.projectId,
          inventoryId: request.inventoryId,
          revision: execution.revision,
          operationId: execution.operationId,
        };
        for (const listener of listeners) {
          try {
            listener(event);
          } catch {}
        }
      }
      return execution;
    },

    inspect(input: unknown): InventoryState | null {
      const { row } = read(input);
      return row ? stateFromRow(row) : null;
    },

    availability(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryAvailabilitySnapshot | null {
      const { row } = read(input);
      if (!row) return null;
      const state = stateFromRow(row);
      const asOf = observationTime(state);
      const caller = principal(invocation);
      return {
        ...inventoryAvailability(state, caller, asOf),
        revision: state.revision,
        asOf,
        principal: caller,
      };
    },

    operation(input: unknown): NativeInventoryReceipt | null {
      const request = inventoryOperationRequestSchema.parse(input);
      const { project, row } = read({ project: request.project, inventoryId: request.inventoryId });
      if (!row) return null;
      const entry = options
        .db()
        .prepare('SELECT * FROM inventory_journal WHERE inventory_id = ? AND operation_id = ?')
        .get(request.inventoryId, request.operationId) as JournalRow | undefined;
      return entry ? entryFromRow(entry, project.projectId).receipt : null;
    },

    history(input: unknown): readonly NativeInventoryHistoryEntry[] {
      const request = inventoryHistoryRequestSchema.parse(input);
      const { project, row } = read({ project: request.project, inventoryId: request.inventoryId });
      if (!row) return [];
      return (
        options
          .db()
          .prepare(
            `SELECT * FROM inventory_journal WHERE inventory_id = ? AND revision > ?
             ORDER BY revision ASC LIMIT ?`
          )
          .all(
            request.inventoryId,
            request.afterRevision ?? 0,
            request.limit ?? 100
          ) as JournalRow[]
      ).map((entry) => entryFromRow(entry, project.projectId));
    },

    replay(input: unknown): { state: InventoryState; acceptedOperations: number } | null {
      const { project, row, request } = read(input);
      if (!row) return null;
      const journal = options
        .db()
        .prepare('SELECT * FROM inventory_journal WHERE inventory_id = ? ORDER BY revision ASC')
        .all(request.inventoryId) as JournalRow[];
      let state = createInventoryState();
      for (const saved of journal) {
        const entry = entryFromRow(saved, project.projectId);
        const result = applyInventoryCommandBatch(
          state,
          {
            expectedRevision: entry.request.expectedRevision,
            commands: entry.request.commands,
          },
          entry.receipt.context
            ? {
                at: entry.receipt.recordedAt,
                principal: entry.receipt.context.principal,
                authority: entry.receipt.context.authority,
              }
            : undefined
        );
        if (!result.ok) return dataError();
        state = result.state;
      }
      if (
        canonicalNativeMutationRequest(state) !== canonicalNativeMutationRequest(stateFromRow(row))
      )
        return dataError();
      return { state, acceptedOperations: journal.length };
    },
  };
}

export type NativeInventoryOwner = ReturnType<typeof createNativeInventoryOwner>;

export interface NativeInventoryInvocation {
  readonly actor?: string;
  readonly principal?: InventoryPrincipal;
}

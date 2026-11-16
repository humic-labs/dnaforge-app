import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  applyInventoryCommandBatch,
  createInventoryState,
  inventoryAvailability,
  inventoryEquipmentCatalog,
  inventoryEquipmentCatalogUpdatePreview,
  inventoryCurrentLocationPath,
  inventoryItemContains,
  inventoryResolveItemCode,
  inventoryStorageConditionsProjection,
  parseInventoryState,
  type InventoryPrincipal,
  type InventoryEquipmentCatalogEntry,
  type InventoryEquipmentCatalogUpdatePreview,
  type InventoryState,
  type InventoryAvailability,
  type InventoryPhysicalItem,
  type InventoryTransition,
  type InventoryImportBinding,
  type InventoryImportBindingObservation,
  type InventoryImportTarget,
  type InventoryTableChoices,
  type InventoryTableBindingObservation,
} from '@waypoint/domain-services';
import {
  inventoryExecuteRequestSchema,
  inventoryApplyImportRequestSchema,
  inventoryExportSnapshotRequestSchema,
  inventoryPreviewImportRequestSchema,
  inventoryPreviewTableRequestSchema,
  inventoryApplyTableRequestSchema,
  inventoryCatalogQuerySchema,
  inventoryCatalogUpdatePreviewRequestSchema,
  inventoryHistoryRequestSchema,
  inventoryMaterialQuerySchema,
  inventoryOperationRequestSchema,
  inventoryReadRequestSchema,
  inventoryStorageConditionsRequestSchema,
  inventoryResolveItemCodeRequestSchema,
  inventoryPrepareLabelRequestSchema,
  inventoryReceiptSchema,
  inventoryPrincipalSchema,
  inventoryReceiptContextSchema,
  type InventoryAcceptedRequest,
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
  InventoryItemCodeLookupSnapshot,
  InventoryItemCodeTargetSnapshot,
  InventoryLabelArtifact,
  InventoryStorageConditionsSnapshot,
  InventoryExportSnapshot,
  InventoryImportPreviewSnapshot,
  InventoryTablePreviewSnapshot,
} from '../shared/inventory-client';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import type { RegisteredProject, RegisteredProjectAuthority } from './registered-project-authority';
import { resolveSavedRegistryProject } from './registry-entity-project';
import { registrySourceEligibilitySql } from './registry-source-eligibility';
import { assertAcceptingSharedProjectContentWritable } from './shared-project-write-access';
import { assertCommittedDatabaseReadAllowed } from './workspace-sync-database-fence';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import {
  nativeInventoryRequestDigest,
  parseNativeInventoryJournalEntry,
  type NativeInventoryJournalRow,
} from './inventory-journal';
import {
  nativeInventoryArchive,
  nativeInventoryImportPreview,
  nativeInventorySha256,
  applyNativeInventoryAdoption,
  replayNativeInventoryJournal,
} from './inventory-archive';
import { NATIVE_DOCUMENT_MAX_BODY_BYTES } from '../shared/native-document-transport';
import { applyNativeInventoryTable, nativeInventoryTablePreview } from './inventory-table';

interface InventoryRow {
  inventory_id: string;
  project_id: string;
  revision: number;
  state_json: string;
}

type JournalRow = NativeInventoryJournalRow;

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

function itemCodeTargetSnapshot(
  state: InventoryState,
  item: InventoryPhysicalItem,
  availability: InventoryAvailability
): InventoryItemCodeTargetSnapshot {
  const record = item.kind === 'storage' ? state.storage[item.id] : state.vessels[item.id];
  const custody = availability.items[item.id];
  const physical = availability.physical.items[item.id];
  if (!record || !custody || !physical) return dataError();
  return {
    item,
    record,
    custody,
    physical,
    currentLocationPath: inventoryCurrentLocationPath(state, item),
    stocks: Object.values(state.stocks)
      .filter((stock) => inventoryItemContains(state, item, { kind: 'vessel', id: stock.vesselId }))
      .map((stock) => ({ stock, availability: availability.stocks[stock.id] })),
  };
}

function entryFromRow(row: JournalRow, project: string): NativeInventoryHistoryEntry {
  try {
    return parseNativeInventoryJournalEntry(row, project, {
      request: parsedJson(row.request_json),
      receipt: parsedJson(row.receipt_json),
    });
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
  const nativeNow = (): number => {
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new NativeDocumentCommandError(
        'INVENTORY_CLOCK_UNAVAILABLE',
        'The native inventory clock is unavailable.',
        false
      );
    return now;
  };
  const observationTime = (state: InventoryState): number =>
    Math.max(nativeNow(), state.lastRecordedAt);
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

  const importTarget = (
    db: Database.Database,
    project: RegisteredProject,
    inventoryId: string,
    row: InventoryRow | undefined
  ): InventoryImportTarget => ({
    projectId: project.projectId,
    inventoryId,
    present: Boolean(
      row ||
      db.prepare('SELECT 1 FROM inventory_journal WHERE inventory_id=? LIMIT 1').get(inventoryId)
    ),
    revision: row?.revision ?? 0,
  });
  const observeBindings = (
    db: Database.Database,
    project: RegisteredProject,
    bindings: readonly InventoryImportBinding[]
  ): readonly InventoryImportBindingObservation[] =>
    bindings.map((binding) => {
      const row = db
        .prepare(
          `SELECT * FROM lims_entity WHERE id=? AND tombstone=0 AND archived_at IS NULL
       AND (${registrySourceEligibilitySql(db)})`
        )
        .get(binding.destinationMaterialId) as
        | ({ id: string; fields: string } & Record<string, unknown>)
        | undefined;
      if (!row || materialProject(db, row.id, row.fields) !== project.id)
        return {
          ...binding,
          kind: 'unavailable',
          reason: 'Choose an active scientific record in the destination project.',
        };
      const files = db
        .prepare('SELECT * FROM catalog_entity_files WHERE entity_id=? ORDER BY path')
        .all(row.id);
      const catalog = db.prepare('SELECT * FROM catalog_entities WHERE id=?').get(row.id) ?? null;
      return {
        ...binding,
        kind: 'admitted',
        fingerprint: nativeInventorySha256(
          canonicalNativeMutationRequest({ projectId: project.projectId, row, files, catalog })
        ),
      };
    });
  const observeTableBindings = (
    db: Database.Database,
    project: RegisteredProject,
    materials: InventoryTableChoices['materials']
  ): readonly InventoryTableBindingObservation[] =>
    observeBindings(
      db,
      project,
      materials.map((material) => ({
        sourceMaterialId: material.key,
        destinationMaterialId: material.materialId,
      }))
    ).map(
      (binding): InventoryTableBindingObservation => ({
        key: binding.sourceMaterialId,
        materialId: binding.destinationMaterialId,
        ...(binding.kind === 'admitted'
          ? { kind: 'admitted', fingerprint: binding.fingerprint }
          : { kind: 'unavailable', reason: binding.reason }),
      })
    );

  const commit = (
    parsed: InventoryAcceptedRequest,
    assertCurrent: () => void,
    invocation: NativeInventoryInvocation
  ): NativeInventoryExecution => {
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
    const request: InventoryAcceptedRequest = { ...parsed, project: project.projectId };
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
        const reject = (code: string, message: string): NativeInventoryExecution => ({
          status: 'rejected',
          inventoryId: request.inventoryId,
          operationId: request.operationId,
          code,
          message,
          currentRevision: previous.revision,
        });
        let result: InventoryTransition;
        if ('kind' in request && request.kind === 'adopt-archive') {
          if (request.expectedRevision !== previous.revision)
            return reject('REVISION_CONFLICT', 'Inventory changed after the import was previewed.');
          if (Buffer.byteLength(canonical, 'utf8') > NATIVE_DOCUMENT_MAX_BODY_BYTES)
            return reject(
              'INVENTORY_IMPORT_TOO_LARGE',
              'The encoded import request exceeds the inline native transport limit.'
            );
          const preview = nativeInventoryImportPreview(
            request.sourceText,
            importTarget(db, project, request.inventoryId, row),
            request.options,
            observeBindings(db, project, request.options.bindings),
            recordedAt
          );
          if (preview.kind === 'blocked')
            return reject(
              preview.issues[0]?.code ?? 'INVENTORY_IMPORT_BLOCKED',
              preview.issues[0]?.message ?? 'The inventory import is blocked.'
            );
          if (preview.kind !== 'ready')
            return reject(
              'INVENTORY_IMPORT_NO_CHANGES',
              'The archive contains no inventory to adopt.'
            );
          if (
            preview.planDigest !== request.expectedPlanDigest ||
            canonicalNativeMutationRequest(preview.options) !==
              canonicalNativeMutationRequest(request.options)
          )
            return reject(
              'INVENTORY_IMPORT_PLAN_CHANGED',
              'The source, destination or scientific bindings changed. Preview the archive again.'
            );
          result = applyNativeInventoryAdoption(row ? previous : null, request, {
            at: recordedAt,
            principal: context.principal,
            authority: context.authority,
          });
        } else if ('kind' in request && request.kind === 'receive-table') {
          if (request.expectedRevision !== previous.revision)
            return reject('REVISION_CONFLICT', 'Inventory changed after the table was previewed.');
          if (Buffer.byteLength(canonical, 'utf8') > NATIVE_DOCUMENT_MAX_BODY_BYTES)
            return reject(
              'INVENTORY_TABLE_TOO_LARGE',
              'The encoded table request exceeds the inline native transport limit.'
            );
          const executionContext = {
            at: recordedAt,
            principal: context.principal,
            authority: context.authority,
          };
          const preview = nativeInventoryTablePreview(
            row ? previous : null,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            observeTableBindings(db, project, request.options.materials),
            executionContext
          );
          if (preview.kind === 'blocked')
            return reject(
              preview.issues[0]?.code ?? 'INVENTORY_TABLE_BLOCKED',
              preview.issues[0]?.message ?? 'The receive table is blocked.'
            );
          if (preview.kind !== 'ready')
            return reject('INVENTORY_TABLE_NO_CHANGES', 'This table has no new stock to receive.');
          if (
            preview.planDigest !== request.expectedPlanDigest ||
            canonicalNativeMutationRequest(preview.options) !==
              canonicalNativeMutationRequest(request.options)
          )
            return reject(
              'INVENTORY_TABLE_PLAN_CHANGED',
              'The source, destination or scientific bindings changed. Preview the table again.'
            );
          result = applyNativeInventoryTable(row ? previous : null, request, executionContext);
        } else {
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
          result = applyInventoryCommandBatch(
            previous,
            {
              expectedRevision: request.expectedRevision,
              commands: request.commands,
            },
            { at: recordedAt, principal: context.principal, authority: context.authority }
          );
        }
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
          requestDigest: nativeInventoryRequestDigest(request),
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
  };

  return {
    exportSnapshot(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryExportSnapshot {
      const request = inventoryExportSnapshotRequestSchema.parse(input);
      const project = resolveProject(request.project, false);
      const assertProject = options.projectAuthority.capture(project.projectId, false);
      const db = options.db();
      assertProject();
      const snapshot = db
        .transaction(() => {
          const row = inventory(db, request.inventoryId, project.projectId);
          const history = db
            .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision ASC')
            .all(request.inventoryId) as JournalRow[];
          const artifact = nativeInventoryArchive({
            projectId: project.projectId,
            inventoryId: request.inventoryId,
            state: row ? { revision: row.revision, json: row.state_json } : null,
            history: history.map((entry) => ({
              operationId: entry.operation_id,
              revision: entry.revision,
              requestJson: entry.request_json,
              receiptJson: entry.receipt_json,
            })),
          });
          return structuredClone({
            ...artifact,
            asOf: nativeNow(),
            principal: principal(invocation),
          });
        })
        .deferred();
      assertProject();
      return snapshot;
    },

    previewImport(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryImportPreviewSnapshot {
      const request = inventoryPreviewImportRequestSchema.parse(input);
      const project = resolveProject(request.project, false);
      const assertProject = options.projectAuthority.capture(project.projectId, false);
      const db = options.db();
      assertProject();
      const snapshot = db
        .transaction(() => {
          const row = inventory(db, request.inventoryId, project.projectId);
          const asOf = nativeNow();
          const preview = nativeInventoryImportPreview(
            request.sourceText,
            importTarget(db, project, request.inventoryId, row),
            request.options,
            observeBindings(db, project, request.options.bindings),
            asOf
          );
          return structuredClone({ ...preview, asOf, principal: principal(invocation) });
        })
        .deferred();
      assertProject();
      return snapshot;
    },

    previewTable(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryTablePreviewSnapshot {
      const request = inventoryPreviewTableRequestSchema.parse(input);
      const project = resolveProject(request.project, false);
      const assertProject = options.projectAuthority.capture(project.projectId, false);
      const db = options.db();
      assertProject();
      const snapshot = db
        .transaction(() => {
          const row = inventory(db, request.inventoryId, project.projectId);
          const state = row ? stateFromRow(row) : null;
          const asOf = observationTime(state ?? createInventoryState());
          const caller = principal(invocation);
          const preview = nativeInventoryTablePreview(
            state,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            observeTableBindings(db, project, request.options.materials),
            { at: asOf, principal: caller, authority }
          );
          return structuredClone({ ...preview, asOf, principal: caller });
        })
        .deferred();
      assertProject();
      return snapshot;
    },

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

    catalog(input: unknown): readonly InventoryEquipmentCatalogEntry[] {
      const request = inventoryCatalogQuerySchema.parse(input);
      resolveProject(request.project, false);
      return inventoryEquipmentCatalog();
    },

    catalogUpdatePreview(input: unknown): InventoryEquipmentCatalogUpdatePreview {
      const request = inventoryCatalogUpdatePreviewRequestSchema.parse(input);
      const { row } = read({ project: request.project, inventoryId: request.inventoryId });
      const entry = inventoryEquipmentCatalog().find(
        (entry) => entry.id === request.catalogEntryId
      );
      if (!entry)
        throw new NativeDocumentCommandError(
          'INVENTORY_CATALOG_ENTRY_NOT_FOUND',
          'The requested equipment catalog entry is unavailable.',
          false
        );
      return inventoryEquipmentCatalogUpdatePreview(
        row ? stateFromRow(row) : createInventoryState(),
        entry
      );
    },

    storageConditions(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryStorageConditionsSnapshot {
      const request = inventoryStorageConditionsRequestSchema.parse(input);
      const { project, row } = read({ project: request.project, inventoryId: request.inventoryId });
      const state = row ? stateFromRow(row) : createInventoryState();
      return structuredClone({
        ...inventoryStorageConditionsProjection(state, {
          asOf: observationTime(state),
          freshnessMaxAgeMs: request.freshnessMaxAgeMs,
        }),
        projectId: project.projectId,
        inventoryId: request.inventoryId,
        revision: state.revision,
        principal: principal(invocation),
      });
    },

    resolveItemCode(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryItemCodeLookupSnapshot {
      const request = inventoryResolveItemCodeRequestSchema.parse(input);
      const { project, row } = read({ project: request.project, inventoryId: request.inventoryId });
      const state = row ? stateFromRow(row) : createInventoryState();
      const asOf = observationTime(state);
      const caller = principal(invocation);
      const resolution = inventoryResolveItemCode(state, request.query);
      const matches =
        resolution.kind === 'resolved' || resolution.kind === 'retired'
          ? [resolution.match]
          : resolution.kind === 'ambiguous'
            ? resolution.matches
            : [];
      const items = new Map(
        matches.map((match) => [`${match.item.kind}:${match.item.id}`, match.item] as const)
      );
      const availability = items.size ? inventoryAvailability(state, caller, asOf) : null;
      const targets = [...items.values()].map((item) =>
        itemCodeTargetSnapshot(state, item, availability!)
      );
      return structuredClone({
        projectId: project.projectId,
        inventoryId: request.inventoryId,
        revision: state.revision,
        asOf,
        principal: caller,
        resolution,
        targets,
      });
    },

    async prepareLabel(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): Promise<InventoryLabelArtifact> {
      const request = inventoryPrepareLabelRequestSchema.parse(input);
      read({ project: request.project, inventoryId: request.inventoryId });
      const { renderInventoryItemLabel } =
        await import('@waypoint/domain-services/inventory-labels');
      const { project, row } = read({ project: request.project, inventoryId: request.inventoryId });
      const state = row ? stateFromRow(row) : createInventoryState();
      const binding = state.itemCodes[request.codeId];
      if (!binding)
        throw new NativeDocumentCommandError(
          'INVENTORY_ITEM_CODE_NOT_FOUND',
          'The requested item-code binding is unavailable.',
          false
        );
      if (binding.lifecycle.kind !== 'active')
        throw new NativeDocumentCommandError(
          'INVENTORY_ITEM_CODE_RETIRED',
          'This item-code binding is retired. An existing artifact remains a historical snapshot.',
          false
        );
      const record =
        binding.item.kind === 'storage'
          ? state.storage[binding.item.id]
          : state.vessels[binding.item.id];
      if (!record) return dataError();
      if (record.lifecycle !== 'active')
        throw new NativeDocumentCommandError(
          'INVENTORY_LABEL_TARGET_DISPOSED',
          'The label target has been disposed.',
          false
        );
      const asOf = observationTime(state);
      const caller = principal(invocation);
      const target = itemCodeTargetSnapshot(
        state,
        binding.item,
        inventoryAvailability(state, caller, asOf)
      );
      const result = renderInventoryItemLabel({
        scope: { projectId: project.projectId, inventoryId: request.inventoryId },
        sourceRevision: state.revision,
        binding: {
          id: binding.id,
          namespace: binding.namespace,
          value: binding.value,
          item: binding.item,
        },
        mediaProfileId: request.mediaProfileId,
      });
      if (result.kind === 'refused')
        throw new NativeDocumentCommandError(
          `INVENTORY_LABEL_${result.code}`,
          result.message,
          false
        );
      return structuredClone({
        schema: 'dnaforge.inventory-label-artifact.v1',
        projectId: project.projectId,
        inventoryId: request.inventoryId,
        sourceRevision: state.revision,
        asOf,
        principal: caller,
        binding,
        target,
        rendered: result.artifact,
        svgSha256: `sha256:${createHash('sha256').update(result.artifact.svg, 'utf8').digest('hex')}`,
      });
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
      return commit(inventoryExecuteRequestSchema.parse(input), assertCurrent, invocation);
    },

    applyImport(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(inventoryApplyImportRequestSchema.parse(input), assertCurrent, invocation);
    },

    applyTable(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(inventoryApplyTableRequestSchema.parse(input), assertCurrent, invocation);
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
      const state = replayNativeInventoryJournal(
        journal.map((saved) => entryFromRow(saved, project.projectId))
      );
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

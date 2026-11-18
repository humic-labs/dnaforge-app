import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  applyInventoryCommandBatch,
  inventoryPlatePlanObservationExisting,
  inventoryPlatePlanObservationPreview,
  inventoryPlatePlanObservations,
  inventoryPlatePlanVersionExisting,
  inventoryPlatePlanVersionPreview,
  inventoryPlatePlanVersions,
  inventoryPlatePlanBindingPreview,
  renderInventoryPlatePlanDiagram,
  inventoryScientificCitationExisting,
  inventoryScientificCitationWithdrawalExisting,
  inventoryScientificCitationPreview,
  inventoryScientificCitationWithdrawalPreview,
  inventoryScientificCitationsForWork,
  inventoryScientificTransferPreview,
  inventoryScientificWorksForContext,
  inventoryScientificTransferPreviewV2,
  inventoryScientificTransferExistingV2,
  inventoryScientificTransferExisting,
  createInventoryState,
  inventoryAvailability,
  inventoryStockroomProjection,
  inventoryEquipmentCatalog,
  inventoryEquipmentCatalogUpdatePreview,
  inventoryCurrentLocationPath,
  inventoryItemContains,
  inventoryResolveItemCode,
  inventoryStorageConditionsProjection,
  parseInventoryState,
  parseInventoryReceiveTableSource,
  inspectInventoryBenchlingCapture,
  inventoryArrivalMaterialChoices,
  type InventoryArrivalDocumentRead,
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
  type InventoryMappedTableChoices,
  type InventoryMappedTableBindingObservation,
  type InventoryTableBindingObservation,
  type InventoryBenchlingCaptureChoices,
  type InventoryBenchlingCapturePreviewInput,
} from '@waypoint/domain-services';
import {
  inventoryPreviewArrivalRequestSchema,
  inventoryScientificContextsRequestSchema,
  inventoryScientificContextsV2RequestSchema,
  inventoryPreviewScientificTransferV2RequestSchema,
  inventoryApplyScientificTransferV2RequestSchema,
  inventoryPreviewScientificTransferRequestSchema,
  inventoryApplyScientificTransferRequestSchema,
  inventoryScientificSourceRequestSchema,
  inventoryApplyArrivalRequestSchema,
  inventoryArrivalDocumentRequestSchema,
  inventoryExecuteRequestSchema,
  inventoryApplyImportRequestSchema,
  inventoryExportSnapshotRequestSchema,
  inventoryPreviewImportRequestSchema,
  inventoryPreviewTableRequestSchema,
  inventoryApplyTableRequestSchema,
  inventoryPreviewStocktakeRequestSchema,
  inventoryApplyStocktakeRequestSchema,
  inventoryApplyHierarchyRequestSchema,
  inventoryPreviewMappedTableRequestSchema,
  inventoryApplyMappedTableRequestSchema,
  inventoryPreviewHierarchyRequestSchema,
  inventoryPreviewSourceRevisionRequestSchema,
  inventoryAcknowledgeSourceRequestSchema,
  inventoryCatalogQuerySchema,
  inventoryCatalogUpdatePreviewRequestSchema,
  inventoryHistoryRequestSchema,
  inventoryMaterialQuerySchema,
  inventoryOperationRequestSchema,
  inventoryReadRequestSchema,
  inventoryInspectBenchlingCaptureRequestSchema,
  inventoryPreviewBenchlingCaptureRequestSchema,
  inventoryApplyBenchlingCaptureRequestSchema,
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
  InventoryArrivalPreviewSnapshot,
  InventoryScientificContextsSnapshot,
  InventoryScientificContextsV2Snapshot,
  InventoryScientificTransferV2PreviewSnapshot,
  InventoryScientificTransferPreviewSnapshot,
  InventoryScientificSourceRead,
  InventoryChanged,
  InventoryAvailabilitySnapshot,
  InventoryStockroomSnapshot,
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
  InventoryStocktakePreviewSnapshot,
  InventoryHierarchyPreviewSnapshot,
  InventoryMappedTablePreviewSnapshot,
  InventorySourceRevisionPreviewSnapshot,
  InventoryBenchlingCaptureSnapshot,
  InventoryBenchlingCapturePreviewSnapshot,
} from '../shared/inventory-client';
import type {
  NativeNotebookWorkingCopyOwner,
  NotebookSavedSourceCapture,
} from './notebook-document-owner';
import {
  applyNativeInventoryScientificTransfer,
  findNativeInventoryScientificSource,
} from './inventory-scientific';
import {
  inventoryPreviewPlatePlanVersionRequestSchema,
  inventoryApplyPlatePlanVersionRequestSchema,
  inventoryPlatePlanVersionsRequestSchema,
  inventoryPlatePlanVersionRequestSchema,
  inventoryPreviewPlatePlanBindingRequestSchema,
  type InventoryPlatePlanVersionPreviewSnapshot,
  type InventoryPlatePlanVersionsRead,
  type InventoryPlatePlanVersionRead,
  type InventoryPlatePlanBindingPreviewSnapshot,
} from '../shared/inventory-plate-plans';
import {
  inventoryPreviewPlatePlanObservationRequestSchema,
  inventoryApplyPlatePlanObservationRequestSchema,
  inventoryPlatePlanObservationsRequestSchema,
  inventoryPlatePlanObservationRequestSchema,
  inventoryPlatePlanObservationSourceRequestSchema,
  type InventoryPlatePlanObservationPreviewSnapshot,
  type InventoryPlatePlanObservationsRead,
  type InventoryPlatePlanObservationRead,
  type InventoryPlatePlanObservationSourceRead,
} from '../shared/inventory-plate-plan-observations';
import {
  applyNativeInventoryPlatePlanObservation,
  findNativeInventoryPlatePlanObservationSource,
} from './inventory-plate-plan-observations';
import { applyNativeInventoryPlatePlanVersion } from './inventory-plate-plans';
import { canonicalNativeMutationRequest } from './native-mutation-request';
import {
  applyNativeInventoryScientificCitation,
  applyNativeInventoryScientificCitationWithdrawal,
  findNativeInventoryScientificCitationSource,
} from './inventory-scientific-citations';
import {
  inventoryPreviewScientificCitationRequestSchema,
  inventoryApplyScientificCitationRequestSchema,
  inventoryPreviewScientificCitationWithdrawalRequestSchema,
  inventoryApplyScientificCitationWithdrawalRequestSchema,
  inventoryScientificCitationsRequestSchema,
  inventoryScientificCitationSourceRequestSchema,
  type InventoryScientificCitationPreviewSnapshot,
  type InventoryScientificCitationWithdrawalPreviewSnapshot,
  type InventoryScientificCitationsRead,
  type InventoryScientificCitationSourceRead,
} from '../shared/inventory-scientific-citations';
import {
  inventoryScientificWorksForContextRequestSchema,
  type InventoryScientificWorksForContextRead,
} from '../shared/inventory-scientific-read';
import { readWorkspaceSyncAccessBinding } from './workspace-sync-access-record';
import type {
  NativeProtocolPackages,
  ProtocolSavedSourceCapture,
} from './native-protocol-packages';
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
import {
  applyNativeInventoryStocktake,
  nativeInventoryStocktakePreview,
} from './inventory-stocktake';
import {
  applyNativeInventorySourceRevision,
  nativeInventorySourceRevisionPreview,
} from './inventory-source-revision';
import {
  applyNativeInventoryHierarchy,
  nativeInventoryHierarchyPreview,
} from './inventory-hierarchy';
import {
  applyNativeInventoryMappedTable,
  nativeInventoryMappedTablePreview,
} from './inventory-mapped-table';
import { applyNativeInventoryArrival, nativeInventoryArrivalPreview } from './inventory-arrival';
import { findNativeInventoryArrivalDocument } from './inventory-arrival-documents';
import { findNativeInventorySourcePreimages } from './inventory-source-preimages';
import {
  applyNativeInventoryBenchlingCapture,
  nativeInventoryBenchlingCapturePreview,
} from './inventory-benchling-application';

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
  notebookSources?: Pick<NativeNotebookWorkingCopyOwner, 'savedSources' | 'withSavedSource'>;
  protocolSources?: Pick<NativeProtocolPackages, 'listPackages' | 'withSavedRunSource'>;
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
  const sourcePreimages = (
    db: Database.Database,
    project: RegisteredProject,
    inventoryId: string,
    state: InventoryState | null,
    table: InventoryTableChoices,
    sourceText: string
  ) => {
    const rows = db
      .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision ASC')
      .all(inventoryId) as JournalRow[];
    const entries = rows.map((row) => entryFromRow(row, project.projectId));
    if (
      entries.length !== (state?.revision ?? 0) ||
      entries.some(
        (entry, index) =>
          entry.request.expectedRevision !== index || entry.receipt.revision !== index + 1
      )
    )
      return dataError();
    const skipped = new Set(table.skips.map((row) => row.sourceId));
    const source = parseInventoryReceiveTableSource(
      sourceText,
      table.delimiter,
      NATIVE_DOCUMENT_MAX_BODY_BYTES
    );
    const sourceIds = new Set(
      source.rows
        .filter(
          (row) =>
            row.sourceId !== null &&
            row.fields !== null &&
            row.issues.length === 0 &&
            !skipped.has(row.sourceId)
        )
        .map((row) => row.sourceId!)
    );
    return findNativeInventorySourcePreimages(state, entries, table.namespace, sourceIds);
  };
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

  const observeMappedBindings = (
    db: Database.Database,
    project: RegisteredProject,
    materials: InventoryMappedTableChoices['materials']
  ): readonly InventoryMappedTableBindingObservation[] =>
    observeTableBindings(
      db,
      project,
      materials.map((value) => ({ key: value.sourceId, materialId: value.materialId }))
    ).map(({ key, ...value }) => ({ sourceId: key, ...value }));

  const observeBenchlingBindings = (
    db: Database.Database,
    project: RegisteredProject,
    choices: InventoryBenchlingCaptureChoices
  ): InventoryBenchlingCapturePreviewInput['bindings'] =>
    observeMappedBindings(
      db,
      project,
      choices.records.flatMap((decision) =>
        decision.disposition === 'vessel' && decision.contents.kind === 'identify'
          ? [{ sourceId: decision.record.sourceId, materialId: decision.contents.materialId }]
          : []
      )
    );

  const commit = (
    parsed: InventoryAcceptedRequest,
    assertCurrent: () => void,
    invocation: NativeInventoryInvocation,
    scientificCapture?: NotebookSavedSourceCapture | ProtocolSavedSourceCapture
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
          version: 10,
          principal: principal(invocation),
          authority,
          ...('kind' in request &&
          (request.kind === 'record-scientific-transfer' ||
            request.kind === 'record-scientific-transfer-v2' ||
            request.kind === 'record-scientific-citation' ||
            request.kind === 'record-plate-plan-observation') &&
          scientificCapture
            ? { scientificSource: scientificCapture.source }
            : {}),
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
        let assertStockroomMaterials = () => {};
        if ('kind' in request && request.kind === 'record-plate-plan-observation') {
          const existingObservation = inventoryPlatePlanObservationExisting(
            previous,
            request.choices
          );
          if (existingObservation.kind === 'no-change')
            return reject(
              'INVENTORY_PLATE_PLAN_OBSERVATION_NO_CHANGES',
              'This exact completed manual occurrence is already recorded.'
            );
          if (existingObservation.kind === 'blocked')
            return reject(existingObservation.issue.code, existingObservation.issue.message);
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the manual occurrence was previewed.'
            );
          if (!scientificCapture)
            return reject(
              'SCIENTIFIC_CONTEXT_MISMATCH',
              'A checked native saved source is required for a new manual occurrence.'
            );
          scientificCapture.assertCurrent();
          result = applyNativeInventoryPlatePlanObservation(
            previous,
            request,
            { at: recordedAt, principal: context.principal, authority },
            scientificCapture.source
          );
        } else if ('kind' in request && request.kind === 'save-plate-plan-version') {
          const existingVersion = inventoryPlatePlanVersionExisting(previous, request.choices);
          if (existingVersion.kind === 'no-change')
            return reject(
              'INVENTORY_PLATE_PLAN_VERSION_NO_CHANGES',
              'This exact plan version is already saved. Its original reason and recorder remain unchanged.'
            );
          if (existingVersion.kind === 'blocked')
            return reject(existingVersion.issue.code, existingVersion.issue.message);
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the plan version was previewed.'
            );
          result = applyNativeInventoryPlatePlanVersion(previous, request, {
            at: recordedAt,
            principal: context.principal,
            authority,
          });
        } else if (
          'kind' in request &&
          (request.kind === 'record-scientific-citation' ||
            request.kind === 'withdraw-scientific-citation')
        ) {
          const existingCitation =
            request.kind === 'record-scientific-citation'
              ? inventoryScientificCitationExisting(previous, request.choices)
              : inventoryScientificCitationWithdrawalExisting(previous, request.choices);
          if (existingCitation.kind === 'no-change')
            return reject(
              request.kind === 'record-scientific-citation'
                ? 'INVENTORY_SCIENTIFIC_CITATION_NO_CHANGES'
                : 'INVENTORY_SCIENTIFIC_CITATION_WITHDRAWAL_NO_CHANGES',
              'This exact citation history is already recorded. Read its original assertion and correction.'
            );
          if (existingCitation.kind === 'blocked')
            return reject(existingCitation.issue.code, existingCitation.issue.message);
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the citation was previewed.'
            );
          if (request.kind === 'record-scientific-citation') {
            if (!scientificCapture)
              return reject(
                'SCIENTIFIC_CONTEXT_MISMATCH',
                'A checked native saved source is required for a new citation.'
              );
            scientificCapture.assertCurrent();
            result = applyNativeInventoryScientificCitation(
              previous,
              request,
              { at: recordedAt, principal: context.principal, authority },
              scientificCapture.source
            );
          } else {
            result = applyNativeInventoryScientificCitationWithdrawal(previous, request, {
              at: recordedAt,
              principal: context.principal,
              authority,
            });
          }
        } else if (
          'kind' in request &&
          (request.kind === 'record-scientific-transfer' ||
            request.kind === 'record-scientific-transfer-v2')
        ) {
          const existingWork =
            request.kind === 'record-scientific-transfer'
              ? inventoryScientificTransferExisting(previous, request.choices)
              : inventoryScientificTransferExistingV2(previous, request.choices);
          if (existingWork.kind === 'no-change')
            return reject(
              'INVENTORY_SCIENTIFIC_NO_CHANGES',
              'This completed manual work is already recorded.'
            );
          if (existingWork.kind === 'conflict')
            return reject(
              'SCIENTIFIC_WORK_CONFLICT',
              'That physical work identity already records a different observation.'
            );
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after scientific work was previewed.'
            );
          if (!scientificCapture)
            return reject(
              'SCIENTIFIC_CONTEXT_MISMATCH',
              'A current native notebook source observation is required.'
            );
          scientificCapture.assertCurrent();
          result = applyNativeInventoryScientificTransfer(
            previous,
            request,
            { at: recordedAt, principal: context.principal, authority },
            scientificCapture.source
          );
        } else if ('kind' in request && request.kind === 'receive-arrival') {
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the delivery was previewed.'
            );
          if (Buffer.byteLength(canonical, 'utf8') > NATIVE_DOCUMENT_MAX_BODY_BYTES)
            return reject(
              'INVENTORY_ARRIVAL_TOO_LARGE',
              'The encoded delivery request exceeds the inline native transport limit.'
            );
          const executionContext = {
            at: recordedAt,
            principal: context.principal,
            authority: context.authority,
          };
          const preview = nativeInventoryArrivalPreview(
            row ? previous : null,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            observeTableBindings(db, project, inventoryArrivalMaterialChoices(request.options)),
            executionContext
          );
          if (preview.kind === 'blocked')
            return reject(
              preview.issues[0]?.code ?? 'INVENTORY_ARRIVAL_BLOCKED',
              preview.issues[0]?.message ?? 'The delivery is blocked.'
            );
          if (preview.kind !== 'ready')
            return reject(
              'INVENTORY_ARRIVAL_NO_CHANGES',
              'This delivery is already recorded and has no changes to apply.'
            );
          if (
            preview.planDigest !== request.expectedPlanDigest ||
            canonicalNativeMutationRequest(preview.options) !==
              canonicalNativeMutationRequest(request.options)
          )
            return reject(
              'INVENTORY_ARRIVAL_PLAN_CHANGED',
              'The delivery, target or scientific bindings changed. Preview it again.'
            );
          result = applyNativeInventoryArrival(row ? previous : null, request, executionContext);
        } else if ('kind' in request && request.kind === 'import-benchling-capture') {
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the capture was previewed.'
            );
          if (Buffer.byteLength(canonical, 'utf8') > NATIVE_DOCUMENT_MAX_BODY_BYTES)
            return reject(
              'INVENTORY_BENCHLING_CAPTURE_TOO_LARGE',
              'The encoded capture request exceeds the inline native transport limit.'
            );
          const executionContext = {
            at: recordedAt,
            principal: context.principal,
            authority: context.authority,
          };
          const preview = nativeInventoryBenchlingCapturePreview(
            row ? previous : null,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            observeBenchlingBindings(db, project, request.options),
            executionContext
          );
          if (preview.kind === 'blocked')
            return reject(
              preview.issues[0]?.code ?? 'INVENTORY_BENCHLING_CAPTURE_BLOCKED',
              preview.issues[0]?.message ?? 'The capture application is blocked.'
            );
          if (preview.kind !== 'ready')
            return reject(
              'INVENTORY_BENCHLING_CAPTURE_NO_CHANGES',
              'This capture has no inventory changes to apply.'
            );
          if (
            preview.planDigest !== request.expectedPlanDigest ||
            canonicalNativeMutationRequest(preview.options) !==
              canonicalNativeMutationRequest(request.options)
          )
            return reject(
              'INVENTORY_BENCHLING_CAPTURE_PLAN_CHANGED',
              'The capture, target or scientific bindings changed. Preview it again.'
            );
          result = applyNativeInventoryBenchlingCapture(
            row ? previous : null,
            request,
            executionContext
          );
        } else if ('kind' in request && request.kind === 'adopt-archive') {
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
        } else if ('kind' in request && request.kind === 'receive-mapped-table') {
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the mapped table was previewed.'
            );
          if (Buffer.byteLength(canonical, 'utf8') > NATIVE_DOCUMENT_MAX_BODY_BYTES)
            return reject(
              'INVENTORY_MAPPED_TABLE_TOO_LARGE',
              'The encoded table request exceeds the inline native transport limit.'
            );
          const executionContext = {
            at: recordedAt,
            principal: context.principal,
            authority: context.authority,
          };
          const preview = nativeInventoryMappedTablePreview(
            row ? previous : null,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            observeMappedBindings(db, project, request.options.materials),
            executionContext
          );
          if (preview.kind === 'blocked')
            return reject(
              preview.issues[0]?.code ?? 'INVENTORY_MAPPED_TABLE_BLOCKED',
              preview.issues[0]?.message ?? 'The mapped spreadsheet is blocked.'
            );
          if (preview.kind !== 'ready')
            return reject(
              'INVENTORY_MAPPED_TABLE_NO_CHANGES',
              'This table has no new stock to receive.'
            );
          if (
            preview.planDigest !== request.expectedPlanDigest ||
            canonicalNativeMutationRequest(preview.options) !==
              canonicalNativeMutationRequest(request.options)
          )
            return reject(
              'INVENTORY_MAPPED_TABLE_PLAN_CHANGED',
              'The source, destination or scientific bindings changed. Preview the mapped table again.'
            );
          result = applyNativeInventoryMappedTable(
            row ? previous : null,
            request,
            executionContext
          );
        } else if ('kind' in request && request.kind === 'import-hierarchy') {
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the hierarchy was previewed.'
            );
          if (Buffer.byteLength(canonical, 'utf8') > NATIVE_DOCUMENT_MAX_BODY_BYTES)
            return reject(
              'INVENTORY_HIERARCHY_TOO_LARGE',
              'The encoded hierarchy request exceeds the inline native transport limit.'
            );
          const executionContext = {
            at: recordedAt,
            principal: context.principal,
            authority: context.authority,
          };
          const preview = nativeInventoryHierarchyPreview(
            row ? previous : null,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            executionContext
          );
          if (preview.kind === 'blocked')
            return reject(
              preview.issues[0]?.code ?? 'INVENTORY_HIERARCHY_BLOCKED',
              preview.issues[0]?.message ?? 'The hierarchy is blocked.'
            );
          if (preview.kind !== 'ready')
            return reject(
              'INVENTORY_HIERARCHY_NO_CHANGES',
              'This hierarchy has no storage layouts to commit.'
            );
          if (
            preview.planDigest !== request.expectedPlanDigest ||
            canonicalNativeMutationRequest(preview.options) !==
              canonicalNativeMutationRequest(request.options)
          )
            return reject(
              'INVENTORY_HIERARCHY_PLAN_CHANGED',
              'The source, subjects, decisions or target changed. Preview the hierarchy again.'
            );
          result = applyNativeInventoryHierarchy(row ? previous : null, request, executionContext);
        } else if ('kind' in request && request.kind === 'apply-stocktake') {
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the stocktake was previewed.'
            );
          if (Buffer.byteLength(canonical, 'utf8') > NATIVE_DOCUMENT_MAX_BODY_BYTES)
            return reject(
              'INVENTORY_STOCKTAKE_TOO_LARGE',
              'The encoded stocktake request exceeds the inline native transport limit.'
            );
          const executionContext = {
            at: recordedAt,
            principal: context.principal,
            authority: context.authority,
          };
          const preview = nativeInventoryStocktakePreview(
            row ? previous : null,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            executionContext
          );
          if (preview.kind === 'blocked')
            return reject(
              preview.issues[0]?.code ?? 'INVENTORY_STOCKTAKE_BLOCKED',
              preview.issues[0]?.message ?? 'The stocktake is blocked.'
            );
          if (preview.kind !== 'ready')
            return reject(
              'INVENTORY_STOCKTAKE_NO_CHANGES',
              'This stocktake has no observations or corrections to commit.'
            );
          if (
            preview.planDigest !== request.expectedPlanDigest ||
            canonicalNativeMutationRequest(preview.options) !==
              canonicalNativeMutationRequest(request.options)
          )
            return reject(
              'INVENTORY_STOCKTAKE_PLAN_CHANGED',
              'The source, subjects, decisions or target changed. Preview the stocktake again.'
            );
          result = applyNativeInventoryStocktake(row ? previous : null, request, executionContext);
        } else if ('kind' in request && request.kind === 'acknowledge-table-source') {
          if (request.expectedRevision !== previous.revision)
            return reject(
              'REVISION_CONFLICT',
              'Inventory changed after the source revision was previewed.'
            );
          if (Buffer.byteLength(canonical, 'utf8') > NATIVE_DOCUMENT_MAX_BODY_BYTES)
            return reject(
              'INVENTORY_SOURCE_REVISION_TOO_LARGE',
              'The encoded source acknowledgement exceeds the inline native transport limit.'
            );
          const executionContext = {
            at: recordedAt,
            principal: context.principal,
            authority: context.authority,
          };
          const preview = nativeInventorySourceRevisionPreview(
            row ? previous : null,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            sourcePreimages(
              db,
              project,
              request.inventoryId,
              row ? previous : null,
              request.options.table,
              request.sourceText
            ),
            executionContext
          );
          if (preview.kind === 'blocked' || preview.kind === 'needs-acknowledgement')
            return reject(
              preview.issues[0]?.code ?? 'INVENTORY_SOURCE_REVISION_BLOCKED',
              preview.issues[0]?.message ?? 'The source revision requires explicit acknowledgement.'
            );
          if (preview.kind !== 'ready')
            return reject(
              'INVENTORY_SOURCE_REVISION_NO_CHANGES',
              'This source has no revisions to acknowledge.'
            );
          if (
            preview.planDigest !== request.expectedPlanDigest ||
            canonicalNativeMutationRequest(preview.options) !==
              canonicalNativeMutationRequest(request.options)
          )
            return reject(
              'INVENTORY_SOURCE_REVISION_PLAN_CHANGED',
              'The source, previous evidence, decisions or target changed. Preview the source revision again.'
            );
          result = applyNativeInventorySourceRevision(
            row ? previous : null,
            request,
            executionContext
          );
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
              command.kind === 'record-expected-delivery' ||
              command.kind === 'record-reorder-rule' ||
              command.kind === 'receive-stock' ||
              command.kind === 'identify-vessel-stock' ||
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
          const stockroomMaterials = [
            ...new Set(
              request.commands.flatMap((command) =>
                command.kind === 'record-expected-delivery' ||
                command.kind === 'record-reorder-rule'
                  ? [command.materialId]
                  : []
              )
            ),
          ].sort();
          if (stockroomMaterials.length) {
            const bindings = stockroomMaterials.map((materialId) => ({
              sourceMaterialId: materialId,
              destinationMaterialId: materialId,
            }));
            const admitted = observeBindings(db, project, bindings);
            if (admitted.some((binding) => binding.kind !== 'admitted'))
              return reject(
                'INVENTORY_MATERIAL_UNAVAILABLE',
                'Choose an active scientific record in this inventory project.'
              );
            const fingerprint = canonicalNativeMutationRequest(admitted);
            assertStockroomMaterials = () => {
              if (
                canonicalNativeMutationRequest(observeBindings(db, project, bindings)) !==
                fingerprint
              )
                throw new NativeDocumentCommandError(
                  'INVENTORY_MATERIAL_CHANGED',
                  'The scientific material changed before the stockroom operation committed.',
                  false
                );
            };
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
        if (
          'kind' in request &&
          (request.kind === 'record-scientific-transfer' ||
            request.kind === 'record-scientific-transfer-v2' ||
            request.kind === 'record-scientific-citation' ||
            request.kind === 'withdraw-scientific-citation' ||
            request.kind === 'record-plate-plan-observation') &&
          Buffer.byteLength(canonicalNativeMutationRequest({ request, receipt }), 'utf8') >
            NATIVE_DOCUMENT_MAX_BODY_BYTES
        )
          return reject(
            'INVENTORY_SCIENTIFIC_SOURCE_TOO_LARGE',
            'The complete scientific request and retained source exceed the native inline limit.'
          );
        if (
          'kind' in request &&
          request.kind === 'save-plate-plan-version' &&
          Buffer.byteLength(canonicalNativeMutationRequest({ request, receipt }), 'utf8') >
            NATIVE_DOCUMENT_MAX_BODY_BYTES
        )
          return reject(
            'INVENTORY_PLATE_PLAN_TOO_LARGE',
            'The complete plan request and receipt exceed the native inline limit.'
          );
        assertCurrent();
        assertStockroomMaterials();
        scientificCapture?.assertCurrent();
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
        assertStockroomMaterials();
        scientificCapture?.assertCurrent();
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

  const inventorySnapshotRead = <T>(
    scope: { project: string; inventoryId: string },
    mutating: boolean,
    action: (db: Database.Database, project: RegisteredProject, state: InventoryState | null) => T
  ): T => {
    const project = resolveProject(scope.project, mutating),
      assertProject = options.projectAuthority.capture(project.projectId, mutating),
      db = options.db();
    const snapshot = () => {
      const row = db
        .prepare(
          'SELECT id,path,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE id=?'
        )
        .get(project.id) as WorkspaceIdentity | undefined;
      return {
        row,
        access: row?.repo_uuid ? readWorkspaceSyncAccessBinding(db, row.repo_uuid) : null,
      };
    };
    const captured = canonicalNativeMutationRequest(snapshot());
    const assertCaptured = () => {
      if (canonicalNativeMutationRequest(snapshot()) !== captured)
        throw new NativeDocumentCommandError(
          'PROJECT_ACCESS_CHANGED',
          'The inventory project authority changed.',
          false
        );
      if (mutating) assertAcceptingSharedProjectContentWritable(db, project.path);
    };
    const result = db
      .transaction(() => {
        assertCaptured();
        try {
          const row = inventory(db, scope.inventoryId, project.projectId);
          return action(db, project, row ? stateFromRow(row) : null);
        } finally {
          assertCaptured();
        }
      })
      .deferred();
    assertProject();
    return structuredClone(result);
  };
  return {
    async previewPlatePlanObservation(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): Promise<InventoryPlatePlanObservationPreviewSnapshot> {
      const request = inventoryPreviewPlatePlanObservationRequestSchema.parse(input);
      const observe = async (
        capture: NotebookSavedSourceCapture | ProtocolSavedSourceCapture | null
      ): Promise<InventoryPlatePlanObservationPreviewSnapshot> => {
        await invocation.beforeScientificRead?.();
        capture?.assertCurrent();
        const result = inventorySnapshotRead(request, false, (_db, project, saved) => {
          const state = saved ?? createInventoryState(),
            asOf = observationTime(state),
            caller = principal(invocation);
          try {
            return {
              ...inventoryPlatePlanObservationPreview(state, {
                ...request.choices,
                target: {
                  projectId: project.projectId,
                  inventoryId: request.inventoryId,
                  present: saved !== null,
                  revision: request.expectedRevision,
                },
                source: capture?.source ?? null,
                asOf,
                principal: caller,
                authority,
              }),
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              revision: state.revision,
            };
          } finally {
            capture?.assertCurrent();
          }
        });
        if (result.nextBoundaryAt !== null && nativeNow() >= result.nextBoundaryAt)
          return {
            kind: 'unavailable',
            code: 'INVENTORY_PLATE_PLAN_PREVIEW_STALE',
            message:
              'A relevant time boundary passed before this preview could be returned. Preview the occurrence again.',
            retryable: true,
          };
        return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
          NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
          ? result
          : {
              kind: 'unavailable',
              code: 'INVENTORY_QUERY_TOO_LARGE',
              message: 'The manual occurrence preview exceeds the inline read limit.',
              retryable: false,
            };
      };
      const current = read({ project: request.project, inventoryId: request.inventoryId }),
        state = current.row ? stateFromRow(current.row) : createInventoryState();
      if (inventoryPlatePlanObservationExisting(state, request.choices).kind !== 'new')
        return observe(null);
      try {
        if (request.choices.context.kind === 'notebook-page' && options.notebookSources)
          return await options.notebookSources.withSavedSource(
            current.project.projectId,
            request.choices.context.entityId,
            observe
          );
        if (request.choices.context.kind === 'protocol-run' && options.protocolSources)
          return await options.protocolSources.withSavedRunSource(
            current.project.projectId,
            request.choices.context.entityId,
            observe
          );
      } catch (error) {
        if (error instanceof NativeDocumentCommandError) throw error;
      }
      return observe(null);
    },
    async applyPlatePlanObservation(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): Promise<NativeInventoryExecution> {
      const request = inventoryApplyPlatePlanObservationRequestSchema.parse(input),
        project = resolveProject(request.project, true),
        row = inventory(options.db(), request.inventoryId, project.projectId),
        state = row ? stateFromRow(row) : createInventoryState();
      const known = options
        .db()
        .prepare('SELECT 1 FROM inventory_journal WHERE inventory_id=? AND operation_id=?')
        .get(request.inventoryId, request.operationId);
      if (known || inventoryPlatePlanObservationExisting(state, request.choices).kind !== 'new')
        return commit(request, assertCurrent, invocation);
      const accept = async (capture: NotebookSavedSourceCapture | ProtocolSavedSourceCapture) => {
        await invocation.beforeScientificCommit?.();
        return commit(request, assertCurrent, invocation, capture);
      };
      try {
        if (request.choices.context.kind === 'notebook-page' && options.notebookSources)
          return await options.notebookSources.withSavedSource(
            project.projectId,
            request.choices.context.entityId,
            accept
          );
        if (request.choices.context.kind === 'protocol-run' && options.protocolSources)
          return await options.protocolSources.withSavedRunSource(
            project.projectId,
            request.choices.context.entityId,
            accept
          );
        throw Error('The saved manual-occurrence source owner is unavailable.');
      } catch (error) {
        if (error instanceof NativeDocumentCommandError) throw error;
        throw new NativeDocumentCommandError(
          'INVENTORY_SCIENTIFIC_SOURCE_CHANGED',
          error instanceof Error ? error.message : String(error),
          false
        );
      }
    },
    platePlanObservations(input: unknown): InventoryPlatePlanObservationsRead {
      const request = inventoryPlatePlanObservationsRequestSchema.parse(input);
      const result = inventorySnapshotRead(
        request,
        false,
        (_db, project, state): InventoryPlatePlanObservationsRead => {
          const filters = { version: request.version ?? null, context: request.context ?? null };
          if (request.context && !request.context.entityId.startsWith(`${project.projectId}::`))
            return {
              kind: 'unavailable',
              code: 'SCIENTIFIC_CONTEXT_MISMATCH',
              message: 'Choose the exact scientific context in this inventory project.',
              retryable: false,
            };
          if (!state)
            return {
              kind: 'inventory-absent',
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              filters,
            };
          if (request.version) {
            const version = Object.hasOwn(state.platePlanVersions, request.version.versionId)
              ? state.platePlanVersions[request.version.versionId]
              : undefined;
            if (!version)
              return {
                kind: 'unavailable',
                code: 'INVENTORY_PLATE_PLAN_VERSION_NOT_FOUND',
                message: 'The selected saved plan version is unavailable.',
                retryable: false,
              };
            if (version.definitionSha256 !== request.version.definitionSha256)
              return {
                kind: 'unavailable',
                code: 'INVENTORY_PLATE_PLAN_PIN_MISMATCH',
                message: 'The selected plan definition pin changed.',
                retryable: false,
              };
          }
          const observations = inventoryPlatePlanObservations(state, {
              ...(request.version ? { version: request.version } : {}),
              ...(request.context
                ? {
                    context: {
                      ...request.context,
                      projectId: project.projectId,
                      workspaceScope: project.projectId,
                    },
                  }
                : {}),
            }),
            querySha256 = nativeInventorySha256(
              canonicalNativeMutationRequest([
                'dnaforge.inventory-plate-plan-observations-query.v1',
                project.projectId,
                request.inventoryId,
                filters,
              ])
            );
          let start = 0;
          if (request.cursor) {
            if (request.cursor.querySha256 !== querySha256)
              return {
                kind: 'unavailable',
                code: 'INVENTORY_QUERY_CURSOR_INVALID',
                message: 'This cursor belongs to another manual-occurrence query.',
                retryable: false,
              };
            if (request.cursor.revision !== state.revision)
              return {
                kind: 'unavailable',
                code: 'INVENTORY_QUERY_REVISION_CHANGED',
                message: 'Inventory changed. Read the first manual-occurrence page again.',
                retryable: true,
              };
            const index = observations.findIndex(
              (row) =>
                row.id === request.cursor!.after.observationId &&
                row.at === request.cursor!.after.at
            );
            if (index < 0)
              return {
                kind: 'unavailable',
                code: 'INVENTORY_QUERY_CURSOR_INVALID',
                message: 'The cursor does not identify an occurrence in this query.',
                retryable: false,
              };
            start = index + 1;
          }
          const page = observations.slice(start, start + (request.limit ?? 20)),
            last = page.at(-1);
          return {
            kind: 'ready',
            projectId: project.projectId,
            inventoryId: request.inventoryId,
            revision: state.revision,
            filters,
            observations: page,
            nextCursor:
              last && start + page.length < observations.length
                ? {
                    querySha256,
                    revision: state.revision,
                    after: { at: last.at, observationId: last.id },
                  }
                : null,
          };
        }
      );
      return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
        NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
        ? result
        : {
            kind: 'unavailable',
            code: 'INVENTORY_QUERY_TOO_LARGE',
            message:
              'The manual-occurrence page exceeds the inline read limit. Choose a smaller page.',
            retryable: false,
          };
    },
    platePlanObservation(input: unknown): InventoryPlatePlanObservationRead {
      const request = inventoryPlatePlanObservationRequestSchema.parse(input);
      const result = inventorySnapshotRead(
        request,
        false,
        (_db, project, state): InventoryPlatePlanObservationRead => {
          const observation =
            state && Object.hasOwn(state.platePlanObservations, request.observationId)
              ? state.platePlanObservations[request.observationId]
              : undefined;
          if (!state || !observation)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_PLATE_PLAN_OBSERVATION_NOT_FOUND',
              message: 'The exact manual occurrence is unavailable.',
              retryable: false,
            };
          if (observation.intentSha256 !== request.intentSha256)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_PLATE_PLAN_OBSERVATION_PIN_MISMATCH',
              message: 'The manual occurrence does not match its original intent pin.',
              retryable: false,
            };
          return {
            kind: 'available',
            projectId: project.projectId,
            inventoryId: request.inventoryId,
            revision: state.revision,
            observation,
          };
        }
      );
      return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
        NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
        ? result
        : {
            kind: 'unavailable',
            code: 'INVENTORY_QUERY_TOO_LARGE',
            message: 'The manual-occurrence detail exceeds the inline read limit.',
            retryable: false,
          };
    },
    platePlanObservationSource(input: unknown): InventoryPlatePlanObservationSourceRead {
      const request = inventoryPlatePlanObservationSourceRequestSchema.parse(input);
      const result = inventorySnapshotRead(
        request,
        false,
        (db, project, state): InventoryPlatePlanObservationSourceRead => {
          const observation =
            state && Object.hasOwn(state.platePlanObservations, request.observationId)
              ? state.platePlanObservations[request.observationId]
              : undefined;
          if (!state || !observation)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_PLATE_PLAN_OBSERVATION_NOT_FOUND',
              message: 'The exact manual occurrence is unavailable.',
              retryable: false,
            };
          if (observation.intentSha256 !== request.intentSha256)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_PLATE_PLAN_OBSERVATION_PIN_MISMATCH',
              message: 'The manual occurrence does not match its original intent pin.',
              retryable: false,
            };
          const version = state.platePlanVersions[observation.binding.versionId];
          if (!version) return dataError();
          const entries = (
            db
              .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision ASC')
              .all(request.inventoryId) as JournalRow[]
          ).map((row) => entryFromRow(row, project.projectId));
          if (
            canonicalNativeMutationRequest(replayNativeInventoryJournal(entries)) !==
            canonicalNativeMutationRequest(state)
          )
            return dataError();
          return findNativeInventoryPlatePlanObservationSource(
            observation,
            version.definition,
            entries
          );
        }
      );
      return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
        NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
        ? result
        : {
            kind: 'unavailable',
            code: 'INVENTORY_QUERY_TOO_LARGE',
            message: 'The retained manual-occurrence source exceeds the inline read limit.',
            retryable: false,
          };
    },
    previewPlatePlanVersion(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryPlatePlanVersionPreviewSnapshot {
      const request = inventoryPreviewPlatePlanVersionRequestSchema.parse(input);
      return inventorySnapshotRead(request, false, (_db, project, saved) => {
        const state = saved ?? createInventoryState(),
          asOf = observationTime(state),
          caller = principal(invocation);
        return {
          ...inventoryPlatePlanVersionPreview(state, {
            ...request.choices,
            target: {
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              present: saved !== null,
              revision: request.expectedRevision,
            },
            asOf,
            principal: caller,
            authority,
          }),
          projectId: project.projectId,
          inventoryId: request.inventoryId,
          revision: state.revision,
          asOf,
          principal: caller,
        };
      });
    },
    applyPlatePlanVersion(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(
        inventoryApplyPlatePlanVersionRequestSchema.parse(input),
        assertCurrent,
        invocation
      );
    },
    platePlanVersions(input: unknown): InventoryPlatePlanVersionsRead {
      const request = inventoryPlatePlanVersionsRequestSchema.parse(input);
      const result = inventorySnapshotRead(
        request,
        false,
        (_db, project, state): InventoryPlatePlanVersionsRead => {
          const identity = request.identity ?? null;
          if (!state)
            return {
              kind: 'inventory-absent',
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              identity,
            };
          const versions = inventoryPlatePlanVersions(state, request.identity),
            querySha256 = nativeInventorySha256(
              canonicalNativeMutationRequest([
                'dnaforge.inventory-plate-plan-versions-query.v1',
                project.projectId,
                request.inventoryId,
                identity,
              ])
            );
          let start = 0;
          if (request.cursor) {
            if (request.cursor.querySha256 !== querySha256)
              return {
                kind: 'unavailable',
                code: 'INVENTORY_QUERY_CURSOR_INVALID',
                message: 'This cursor belongs to another plan-version query.',
                retryable: false,
              };
            if (request.cursor.revision !== state.revision)
              return {
                kind: 'unavailable',
                code: 'INVENTORY_QUERY_REVISION_CHANGED',
                message: 'Inventory changed. Read the first plan-version page again.',
                retryable: true,
              };
            const index = versions.findIndex(
              (version) =>
                version.id === request.cursor!.after.versionId &&
                version.at === request.cursor!.after.at
            );
            if (index < 0)
              return {
                kind: 'unavailable',
                code: 'INVENTORY_QUERY_CURSOR_INVALID',
                message: 'The cursor does not identify a version in this query.',
                retryable: false,
              };
            start = index + 1;
          }
          const page = versions.slice(start, start + (request.limit ?? 20)),
            last = page.at(-1);
          return {
            kind: 'ready',
            projectId: project.projectId,
            inventoryId: request.inventoryId,
            revision: state.revision,
            identity,
            versions: page,
            nextCursor:
              last && start + page.length < versions.length
                ? {
                    querySha256,
                    revision: state.revision,
                    after: { at: last.at, versionId: last.id },
                  }
                : null,
          };
        }
      );
      return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
        NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
        ? result
        : {
            kind: 'unavailable',
            code: 'INVENTORY_QUERY_TOO_LARGE',
            message: 'The plan-version page exceeds the inline read limit. Choose a smaller page.',
            retryable: false,
          };
    },
    platePlanVersion(input: unknown): InventoryPlatePlanVersionRead {
      const request = inventoryPlatePlanVersionRequestSchema.parse(input);
      return inventorySnapshotRead(
        request,
        false,
        (_db, project, state): InventoryPlatePlanVersionRead => {
          const version =
            state && Object.hasOwn(state.platePlanVersions, request.versionId)
              ? state.platePlanVersions[request.versionId]
              : undefined;
          if (!state || !version)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_PLATE_PLAN_VERSION_NOT_FOUND',
              message: 'The exact saved plan version is unavailable.',
              retryable: false,
            };
          if (version.definitionSha256 !== request.definitionSha256)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_PLATE_PLAN_PIN_MISMATCH',
              message: 'The saved plan version does not match the selected definition pin.',
              retryable: false,
            };
          let result: InventoryPlatePlanVersionRead = {
            kind: 'available',
            projectId: project.projectId,
            inventoryId: request.inventoryId,
            revision: state.revision,
            version,
            diagram: renderInventoryPlatePlanDiagram(version),
          };
          if (
            Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') >
            NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
          )
            result = {
              ...result,
              diagram: {
                kind: 'refused',
                code: 'INVENTORY_PLATE_PLAN_DIAGRAM_TOO_LARGE',
                message:
                  'The diagram exceeds the inline read limit. The exact plan definition remains available.',
              },
            };
          return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
            NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
            ? result
            : {
                kind: 'unavailable',
                code: 'INVENTORY_QUERY_TOO_LARGE',
                message: 'The saved plan definition exceeds the inline read limit.',
                retryable: false,
              };
        }
      );
    },
    previewPlatePlanBinding(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryPlatePlanBindingPreviewSnapshot {
      const request = inventoryPreviewPlatePlanBindingRequestSchema.parse(input);
      const result = inventorySnapshotRead(
        request,
        false,
        (_db, project, state): InventoryPlatePlanBindingPreviewSnapshot => {
          const version =
            state && Object.hasOwn(state.platePlanVersions, request.binding.versionId)
              ? state.platePlanVersions[request.binding.versionId]
              : undefined;
          if (!state || !version)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_PLATE_PLAN_VERSION_NOT_FOUND',
              message: 'The exact saved plan version is unavailable.',
              retryable: false,
            };
          if (version.definitionSha256 !== request.binding.definitionSha256)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_PLATE_PLAN_PIN_MISMATCH',
              message: 'The selected plan definition pin changed.',
              retryable: false,
            };
          const asOf = observationTime(state),
            caller = principal(invocation);
          return {
            ...inventoryPlatePlanBindingPreview(state, {
              target: {
                projectId: project.projectId,
                inventoryId: request.inventoryId,
                present: true,
                revision: request.expectedRevision,
              },
              binding: request.binding,
              asOf,
              principal: caller,
              authority,
            }),
            projectId: project.projectId,
            inventoryId: request.inventoryId,
            revision: state.revision,
          };
        }
      );
      if (
        result.kind !== 'unavailable' &&
        result.nextBoundaryAt !== null &&
        nativeNow() >= result.nextBoundaryAt
      )
        return {
          kind: 'unavailable',
          code: 'INVENTORY_PLATE_PLAN_PREVIEW_STALE',
          message:
            'A relevant time boundary passed before this preview could be returned. Check the binding again.',
          retryable: true,
        };
      return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
        NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
        ? result
        : {
            kind: 'unavailable',
            code: 'INVENTORY_QUERY_TOO_LARGE',
            message: 'The binding preview exceeds the inline read limit.',
            retryable: false,
          };
    },
    async previewScientificCitation(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): Promise<InventoryScientificCitationPreviewSnapshot> {
      const request = inventoryPreviewScientificCitationRequestSchema.parse(input);
      const observe = (capture: NotebookSavedSourceCapture | ProtocolSavedSourceCapture | null) => {
        capture?.assertCurrent();
        const result = inventorySnapshotRead(request, true, (_db, project, saved) => {
          const state = saved ?? createInventoryState(),
            asOf = observationTime(state),
            caller = principal(invocation);
          try {
            return {
              ...inventoryScientificCitationPreview(state, {
                ...request.choices,
                target: {
                  projectId: project.projectId,
                  inventoryId: request.inventoryId,
                  present: Boolean(saved),
                  revision: request.expectedRevision,
                },
                source: capture?.source ?? null,
                asOf,
                principal: caller,
                authority,
              }),
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              revision: state.revision,
              asOf,
              principal: caller,
            };
          } finally {
            capture?.assertCurrent();
          }
        });
        return result;
      };
      const current = read({ project: request.project, inventoryId: request.inventoryId }),
        state = current.row ? stateFromRow(current.row) : createInventoryState();
      if (inventoryScientificCitationExisting(state, request.choices).kind !== 'new')
        return observe(null);
      try {
        if (request.choices.context.kind === 'notebook-page' && options.notebookSources)
          return await options.notebookSources.withSavedSource(
            current.project.projectId,
            request.choices.context.entityId,
            observe
          );
        if (request.choices.context.kind === 'protocol-run' && options.protocolSources)
          return await options.protocolSources.withSavedRunSource(
            current.project.projectId,
            request.choices.context.entityId,
            observe
          );
      } catch (error) {
        if (error instanceof NativeDocumentCommandError) throw error;
      }
      return observe(null);
    },
    async applyScientificCitation(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): Promise<NativeInventoryExecution> {
      const request = inventoryApplyScientificCitationRequestSchema.parse(input),
        project = resolveProject(request.project, true),
        row = inventory(options.db(), request.inventoryId, project.projectId),
        state = row ? stateFromRow(row) : createInventoryState();
      const known = options
        .db()
        .prepare('SELECT 1 FROM inventory_journal WHERE inventory_id=? AND operation_id=?')
        .get(request.inventoryId, request.operationId);
      if (known || inventoryScientificCitationExisting(state, request.choices).kind !== 'new')
        return commit(request, assertCurrent, invocation);
      const accept = async (capture: NotebookSavedSourceCapture | ProtocolSavedSourceCapture) => {
        await invocation.beforeScientificCommit?.();
        return commit(request, assertCurrent, invocation, capture);
      };
      try {
        if (request.choices.context.kind === 'notebook-page' && options.notebookSources)
          return await options.notebookSources.withSavedSource(
            project.projectId,
            request.choices.context.entityId,
            accept
          );
        if (request.choices.context.kind === 'protocol-run' && options.protocolSources)
          return await options.protocolSources.withSavedRunSource(
            project.projectId,
            request.choices.context.entityId,
            accept
          );
        throw Error('The saved citation source owner is unavailable.');
      } catch (error) {
        if (error instanceof NativeDocumentCommandError) throw error;
        throw new NativeDocumentCommandError(
          'INVENTORY_SCIENTIFIC_SOURCE_CHANGED',
          error instanceof Error ? error.message : String(error),
          false
        );
      }
    },
    previewScientificCitationWithdrawal(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryScientificCitationWithdrawalPreviewSnapshot {
      const request = inventoryPreviewScientificCitationWithdrawalRequestSchema.parse(input);
      return inventorySnapshotRead(request, true, (_db, project, saved) => {
        const state = saved ?? createInventoryState(),
          asOf = observationTime(state),
          caller = principal(invocation);
        return {
          ...inventoryScientificCitationWithdrawalPreview(state, {
            ...request.choices,
            target: {
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              present: Boolean(saved),
              revision: request.expectedRevision,
            },
            asOf,
            principal: caller,
            authority,
          }),
          projectId: project.projectId,
          inventoryId: request.inventoryId,
          revision: state.revision,
          asOf,
          principal: caller,
        };
      });
    },
    async applyScientificCitationWithdrawal(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): Promise<NativeInventoryExecution> {
      const request = inventoryApplyScientificCitationWithdrawalRequestSchema.parse(input),
        project = resolveProject(request.project, true),
        row = inventory(options.db(), request.inventoryId, project.projectId),
        state = row ? stateFromRow(row) : createInventoryState();
      const known = options
        .db()
        .prepare('SELECT 1 FROM inventory_journal WHERE inventory_id=? AND operation_id=?')
        .get(request.inventoryId, request.operationId);
      if (
        !known &&
        inventoryScientificCitationWithdrawalExisting(state, request.choices).kind === 'new'
      )
        await invocation.beforeScientificCommit?.();
      return commit(request, assertCurrent, invocation);
    },
    scientificCitations(input: unknown): InventoryScientificCitationsRead {
      const request = inventoryScientificCitationsRequestSchema.parse(input);
      const result = inventorySnapshotRead(
        request,
        false,
        (_db, project, state): InventoryScientificCitationsRead => {
          const work = state?.scientificWorks[request.workId];
          const unavailable = (
            code: string,
            message: string,
            retryable = false
          ): InventoryScientificCitationsRead => ({
            kind: 'unavailable',
            code,
            message,
            retryable,
          });
          if (!state || !work || work.intentSha256 !== request.workIntentSha256)
            return unavailable(
              'INVENTORY_SCIENTIFIC_WORK_NOT_FOUND',
              'The exact physical-work observation is unavailable.'
            );
          const entries = inventoryScientificCitationsForWork(state, work.id),
            querySha256 = nativeInventorySha256(
              canonicalNativeMutationRequest([
                'dnaforge.inventory-scientific-citations-query.v1',
                project.projectId,
                request.inventoryId,
                work.id,
                work.intentSha256,
              ])
            );
          let start = 0;
          if (request.cursor) {
            if (request.cursor.querySha256 !== querySha256)
              return unavailable(
                'INVENTORY_QUERY_CURSOR_INVALID',
                'This cursor belongs to another citation query.'
              );
            if (request.cursor.revision !== state.revision)
              return unavailable(
                'INVENTORY_QUERY_REVISION_CHANGED',
                'Inventory changed. Read the first citation page again.',
                true
              );
            const index = entries.findIndex(
              (row) =>
                row.citation.id === request.cursor!.after.citationId &&
                row.citation.at === request.cursor!.after.at
            );
            if (index < 0)
              return unavailable(
                'INVENTORY_QUERY_CURSOR_INVALID',
                'The cursor does not identify a citation in this query.'
              );
            start = index + 1;
          }
          const page = entries.slice(start, start + (request.limit ?? 20)),
            last = page.at(-1)?.citation;
          return {
            kind: 'ready',
            projectId: project.projectId,
            inventoryId: request.inventoryId,
            revision: state.revision,
            workId: work.id,
            workIntentSha256: work.intentSha256,
            entries: page,
            nextCursor:
              last && start + page.length < entries.length
                ? {
                    querySha256,
                    revision: state.revision,
                    after: { at: last.at, citationId: last.id },
                  }
                : null,
          };
        }
      );
      return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
        NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
        ? result
        : {
            kind: 'unavailable',
            code: 'INVENTORY_QUERY_TOO_LARGE',
            message: 'The citation page exceeds the inline read limit. Choose a smaller page.',
            retryable: false,
          };
    },
    scientificCitationSource(input: unknown): InventoryScientificCitationSourceRead {
      const request = inventoryScientificCitationSourceRequestSchema.parse(input);
      const result = inventorySnapshotRead(
        request,
        false,
        (db, project, state): InventoryScientificCitationSourceRead => {
          const citation = state?.scientificCitations[request.citationId];
          if (!state || !citation)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_SCIENTIFIC_CITATION_SOURCE_UNAVAILABLE',
              message: 'The saved citation is unavailable.',
            };
          const entries = (
            db
              .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision ASC')
              .all(request.inventoryId) as JournalRow[]
          ).map((row) => entryFromRow(row, project.projectId));
          if (
            canonicalNativeMutationRequest(replayNativeInventoryJournal(entries)) !==
            canonicalNativeMutationRequest(state)
          )
            return dataError();
          return findNativeInventoryScientificCitationSource(citation, entries);
        }
      );
      return Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
        NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
        ? result
        : {
            kind: 'unavailable',
            code: 'INVENTORY_QUERY_TOO_LARGE',
            message: 'The retained citation source exceeds the inline read limit.',
          };
    },
    scientificWorksForContext(input: unknown): InventoryScientificWorksForContextRead {
      const request = inventoryScientificWorksForContextRequestSchema.parse(input),
        project = resolveProject(request.project, false),
        assertProject = options.projectAuthority.capture(project.projectId, false),
        db = options.db();
      if (
        !request.context.entityId.startsWith(`${project.projectId}::`) ||
        request.context.entityId === `${project.projectId}::`
      )
        throw new NativeDocumentCommandError(
          'INVENTORY_QUERY_CONTEXT_INVALID',
          'Choose the exact scientific record in this project.',
          false
        );
      const projectSnapshot = () => {
        const row = db
          .prepare(
            'SELECT id,path,repo_uuid,access_mode,archived_at,trashed_at FROM workspaces WHERE id=?'
          )
          .get(project.id) as WorkspaceIdentity | undefined;
        return {
          row,
          access: row?.repo_uuid ? readWorkspaceSyncAccessBinding(db, row.repo_uuid) : null,
        };
      };
      const capturedProject = canonicalNativeMutationRequest(projectSnapshot());
      const assertCaptured = () => {
        if (canonicalNativeMutationRequest(projectSnapshot()) !== capturedProject)
          throw new NativeDocumentCommandError(
            'PROJECT_ACCESS_CHANGED',
            'The inventory project authority changed.',
            false
          );
      };
      const unavailable = (
        code: string,
        message: string,
        retryable: boolean
      ): InventoryScientificWorksForContextRead => ({
        kind: 'unavailable',
        code,
        message,
        retryable,
      });
      const result = db
        .transaction((): InventoryScientificWorksForContextRead => {
          assertCaptured();
          try {
            const row = inventory(db, request.inventoryId, project.projectId);
            const facts = {
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              context: request.context,
            };
            if (!row) return { kind: 'inventory-absent', ...facts };
            const state = stateFromRow(row),
              works = inventoryScientificWorksForContext(state, {
                projectId: project.projectId,
                workspaceScope: project.projectId,
                ...request.context,
              }),
              querySha256 = nativeInventorySha256(
                canonicalNativeMutationRequest([
                  project.projectId,
                  request.inventoryId,
                  request.context.kind,
                  request.context.entityId,
                ])
              );
            let start = 0;
            if (request.cursor) {
              const cursor = request.cursor;
              if (cursor.querySha256 !== querySha256)
                return unavailable(
                  'INVENTORY_QUERY_CURSOR_INVALID',
                  'This cursor belongs to another scientific-work query.',
                  false
                );
              if (cursor.revision !== state.revision)
                return unavailable(
                  'INVENTORY_QUERY_REVISION_CHANGED',
                  'The inventory changed. Read the first page again.',
                  true
                );
              const after = works.findIndex(
                (work) => work.id === cursor.after.workId && work.at === cursor.after.at
              );
              if (after < 0)
                return unavailable(
                  'INVENTORY_QUERY_CURSOR_INVALID',
                  'The scientific-work cursor does not identify a row in this query.',
                  false
                );
              start = after + 1;
            }
            const page = works.slice(start, start + (request.limit ?? 20)),
              last = page.at(-1);
            return {
              kind: 'ready',
              ...facts,
              revision: state.revision,
              works: page,
              nextCursor:
                last && start + page.length < works.length
                  ? {
                      querySha256,
                      revision: state.revision,
                      after: { at: last.at, workId: last.id },
                    }
                  : null,
            };
          } finally {
            assertCaptured();
          }
        })
        .deferred();
      const bounded =
        Buffer.byteLength(canonicalNativeMutationRequest(result), 'utf8') <=
        NATIVE_DOCUMENT_MAX_BODY_BYTES - 2048
          ? result
          : unavailable(
              'INVENTORY_QUERY_TOO_LARGE',
              'This scientific-work page exceeds the inline read limit. Choose a smaller page.',
              false
            );
      assertProject();
      return structuredClone(bounded);
    },
    async scientificContextsV2(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): Promise<InventoryScientificContextsV2Snapshot> {
      const request = inventoryScientificContextsV2RequestSchema.parse(input),
        project = resolveProject(request.project, false),
        assertProject = options.projectAuthority.capture(project.projectId, false);
      const contexts: InventoryScientificContextsV2Snapshot['contexts'] =
        request.kind === 'notebook-page'
          ? (
              (await options.notebookSources?.savedSources(
                project.projectId,
                request.query ?? '',
                request.limit ?? 20
              )) ?? []
            ).map((page) => ({
              kind: 'notebook-page' as const,
              projectId: project.projectId,
              entityId: page.pageId,
              title: page.title,
              sourceSha256: page.sourceSha256,
              sourceKind: 'native-observed-saved-source' as const,
            }))
          : (
              (await options.protocolSources?.listPackages({
                project: project.projectId,
                kind: 'protocol-run',
                query: request.query,
                limit: request.limit,
              })) ?? []
            ).map((run) => ({
              kind: 'protocol-run' as const,
              projectId: project.projectId,
              entityId: run.entityId,
              title: run.title,
              sourceSha256: run.sourceSha256,
              sourceKind: 'native-observed-saved-source' as const,
            }));
      assertProject();
      const row = inventory(options.db(), request.inventoryId, project.projectId),
        state = row ? stateFromRow(row) : createInventoryState();
      return {
        projectId: project.projectId,
        inventoryId: request.inventoryId,
        revision: state.revision,
        asOf: observationTime(state),
        principal: principal(invocation),
        contexts,
      };
    },
    async previewScientificTransferV2(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): Promise<InventoryScientificTransferV2PreviewSnapshot> {
      const request = inventoryPreviewScientificTransferV2RequestSchema.parse(input),
        project = resolveProject(request.project, false),
        assertProject = options.projectAuthority.capture(project.projectId, false);
      const observe = (capture: NotebookSavedSourceCapture | ProtocolSavedSourceCapture | null) => {
        assertProject();
        capture?.assertCurrent();
        return options
          .db()
          .transaction(() => {
            const row = inventory(options.db(), request.inventoryId, project.projectId),
              state = row ? stateFromRow(row) : createInventoryState(),
              asOf = observationTime(state),
              caller = principal(invocation);
            const preview = inventoryScientificTransferPreviewV2(state, {
              ...request.choices,
              target: {
                ...importTarget(options.db(), project, request.inventoryId, row),
                revision: request.expectedRevision,
              },
              source: capture?.source ?? null,
              asOf,
              principal: caller,
              authority,
            });
            return structuredClone({
              ...preview,
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              revision: state.revision,
              asOf,
              principal: caller,
            });
          })
          .deferred();
      };
      const initial = read({ project: project.projectId, inventoryId: request.inventoryId }),
        current = initial.row ? stateFromRow(initial.row) : createInventoryState();
      if (inventoryScientificTransferExistingV2(current, request.choices).kind !== 'new')
        return observe(null);
      try {
        if (request.choices.context.kind === 'notebook-page')
          return options.notebookSources
            ? await options.notebookSources.withSavedSource(
                project.projectId,
                request.choices.context.entityId,
                (capture) => observe(capture)
              )
            : observe(null);
        return options.protocolSources
          ? await options.protocolSources.withSavedRunSource(
              project.projectId,
              request.choices.context.entityId,
              (capture) => observe(capture)
            )
          : observe(null);
      } catch {
        return observe(null);
      }
    },
    async applyScientificTransferV2(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): Promise<NativeInventoryExecution> {
      const request = inventoryApplyScientificTransferV2RequestSchema.parse(input),
        project = resolveProject(request.project, true),
        row = inventory(options.db(), request.inventoryId, project.projectId);
      const existing = options
          .db()
          .prepare('SELECT 1 FROM inventory_journal WHERE inventory_id=? AND operation_id=?')
          .get(request.inventoryId, request.operationId),
        current = row ? stateFromRow(row) : createInventoryState();
      if (
        existing ||
        inventoryScientificTransferExistingV2(current, request.choices).kind !== 'new'
      )
        return commit(request, assertCurrent, invocation);
      const accept = async (capture: NotebookSavedSourceCapture | ProtocolSavedSourceCapture) => {
        await invocation.beforeScientificCommit?.();
        return commit(request, assertCurrent, invocation, capture);
      };
      try {
        if (request.choices.context.kind === 'notebook-page' && options.notebookSources)
          return await options.notebookSources.withSavedSource(
            project.projectId,
            request.choices.context.entityId,
            accept
          );
        if (request.choices.context.kind === 'protocol-run' && options.protocolSources)
          return await options.protocolSources.withSavedRunSource(
            project.projectId,
            request.choices.context.entityId,
            accept
          );
        throw new Error('Scientific source owner unavailable.');
      } catch (error) {
        if (error instanceof NativeDocumentCommandError) throw error;
        throw new NativeDocumentCommandError(
          'INVENTORY_SCIENTIFIC_SOURCE_CHANGED',
          error instanceof Error ? error.message : String(error),
          false
        );
      }
    },
    async scientificContexts(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): Promise<InventoryScientificContextsSnapshot> {
      const request = inventoryScientificContextsRequestSchema.parse(input);
      const project = resolveProject(request.project, false);
      const assertProject = options.projectAuthority.capture(project.projectId, false);
      if (!options.notebookSources)
        throw new NativeDocumentCommandError(
          'INVENTORY_SCIENTIFIC_SOURCE_UNAVAILABLE',
          'Notebook source observations are unavailable.',
          false
        );
      const pages = await options.notebookSources.savedSources(
        project.projectId,
        request.query ?? '',
        request.limit ?? 20
      );
      assertProject();
      const row = inventory(options.db(), request.inventoryId, project.projectId);
      const state = row ? stateFromRow(row) : createInventoryState();
      return {
        projectId: project.projectId,
        inventoryId: request.inventoryId,
        revision: state.revision,
        asOf: observationTime(state),
        principal: principal(invocation),
        pages: pages.map((page) => ({
          ...page,
          kind: 'notebook-page',
          projectId: project.projectId,
          sourceKind: 'native-observed-saved-source',
        })),
      };
    },
    async previewScientificTransfer(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): Promise<InventoryScientificTransferPreviewSnapshot> {
      const request = inventoryPreviewScientificTransferRequestSchema.parse(input);
      const project = resolveProject(request.project, false);
      const assertProject = options.projectAuthority.capture(project.projectId, false);
      const observe = (capture: NotebookSavedSourceCapture | null) => {
        assertProject();
        capture?.assertCurrent();
        return options
          .db()
          .transaction(() => {
            const row = inventory(options.db(), request.inventoryId, project.projectId);
            const state = row ? stateFromRow(row) : createInventoryState();
            const asOf = observationTime(state),
              caller = principal(invocation);
            const target = importTarget(options.db(), project, request.inventoryId, row);
            const preview = inventoryScientificTransferPreview(state, {
              ...request.choices,
              target: { ...target, revision: request.expectedRevision },
              source: capture?.source ?? null,
              asOf,
              principal: caller,
              authority,
            });
            return structuredClone({
              ...preview,
              projectId: project.projectId,
              inventoryId: request.inventoryId,
              revision: state.revision,
              asOf,
              principal: caller,
            });
          })
          .deferred();
      };
      const initial = read({ project: project.projectId, inventoryId: request.inventoryId });
      const current = initial.row ? stateFromRow(initial.row) : createInventoryState();
      if (inventoryScientificTransferExisting(current, request.choices).kind !== 'new')
        return observe(null);
      if (!options.notebookSources) return observe(null);
      try {
        return await options.notebookSources.withSavedSource(
          project.projectId,
          request.choices.pageId,
          (capture) => observe(capture)
        );
      } catch {
        return observe(null);
      }
    },
    async applyScientificTransfer(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): Promise<NativeInventoryExecution> {
      const request = inventoryApplyScientificTransferRequestSchema.parse(input);
      const project = resolveProject(request.project, true);
      const row = inventory(options.db(), request.inventoryId, project.projectId);
      const existing = options
        .db()
        .prepare('SELECT 1 FROM inventory_journal WHERE inventory_id=? AND operation_id=?')
        .get(request.inventoryId, request.operationId);
      const current = row ? stateFromRow(row) : createInventoryState();
      if (existing || inventoryScientificTransferExisting(current, request.choices).kind !== 'new')
        return commit(request, assertCurrent, invocation);
      if (!options.notebookSources)
        throw new NativeDocumentCommandError(
          'INVENTORY_SCIENTIFIC_SOURCE_UNAVAILABLE',
          'Notebook source observations are unavailable.',
          false
        );
      try {
        return await options.notebookSources.withSavedSource(
          project.projectId,
          request.choices.pageId,
          async (capture) => {
            await invocation.beforeScientificCommit?.();
            return commit(request, assertCurrent, invocation, capture);
          }
        );
      } catch (error) {
        if (error instanceof NativeDocumentCommandError) throw error;
        throw new NativeDocumentCommandError(
          'INVENTORY_SCIENTIFIC_SOURCE_CHANGED',
          error instanceof Error
            ? error.message
            : 'The notebook source changed before recording scientific work.',
          false
        );
      }
    },
    scientificSource(input: unknown): InventoryScientificSourceRead {
      const request = inventoryScientificSourceRequestSchema.parse(input);
      const project = resolveProject(request.project, false);
      const assertProject = options.projectAuthority.capture(project.projectId, false);
      const db = options.db();
      const result = db
        .transaction((): InventoryScientificSourceRead => {
          const row = inventory(db, request.inventoryId, project.projectId);
          const state = row ? stateFromRow(row) : null;
          const work = state?.scientificWorks[request.workId];
          if (!work)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_SCIENTIFIC_WORK_NOT_FOUND',
              message: 'The scientific work observation is unavailable.',
            };
          const entries = (
            db
              .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision ASC')
              .all(request.inventoryId) as JournalRow[]
          ).map((saved) => entryFromRow(saved, project.projectId));
          if (
            canonicalNativeMutationRequest(replayNativeInventoryJournal(entries)) !==
            canonicalNativeMutationRequest(state)
          )
            return dataError();
          return findNativeInventoryScientificSource(work, entries);
        })
        .deferred();
      assertProject();
      return structuredClone(result);
    },
    stockroom(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryStockroomSnapshot | null {
      const request = inventoryReadRequestSchema.parse(input);
      const project = resolveProject(request.project, false);
      const assertProject = options.projectAuthority.capture(project.projectId, false);
      const db = options.db();
      assertProject();
      const snapshot = db
        .transaction(() => {
          const row = inventory(db, request.inventoryId, project.projectId);
          if (!row) return null;
          const state = stateFromRow(row);
          const asOf = observationTime(state);
          const caller = principal(invocation);
          return structuredClone({
            ...inventoryStockroomProjection(state, caller, asOf),
            projectId: project.projectId,
            inventoryId: request.inventoryId,
            revision: state.revision,
            asOf,
            principal: caller,
          });
        })
        .deferred();
      assertProject();
      return snapshot;
    },
    previewArrival(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryArrivalPreviewSnapshot {
      const request = inventoryPreviewArrivalRequestSchema.parse(input);
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
          const preview = nativeInventoryArrivalPreview(
            state,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            observeTableBindings(db, project, inventoryArrivalMaterialChoices(request.options)),
            { at: asOf, principal: caller, authority }
          );
          return structuredClone({ ...preview, asOf, principal: caller });
        })
        .deferred();
      assertProject();
      return snapshot;
    },
    arrivalDocument(input: unknown): InventoryArrivalDocumentRead {
      const request = inventoryArrivalDocumentRequestSchema.parse(input);
      const project = resolveProject(request.project, false);
      const assertProject = options.projectAuthority.capture(project.projectId, false);
      const db = options.db();
      assertProject();
      const result = db
        .transaction((): InventoryArrivalDocumentRead => {
          const row = inventory(db, request.inventoryId, project.projectId);
          const state = row ? stateFromRow(row) : null;
          const arrival = state?.arrivals[request.arrivalId];
          if (!arrival)
            return {
              kind: 'unavailable',
              code: 'INVENTORY_ARRIVAL_NOT_FOUND',
              message: 'The recorded delivery is unavailable.',
            };
          const entries = (
            db
              .prepare('SELECT * FROM inventory_journal WHERE inventory_id=? ORDER BY revision ASC')
              .all(request.inventoryId) as JournalRow[]
          ).map((saved) => entryFromRow(saved, project.projectId));
          if (
            entries.length !== state!.revision ||
            canonicalNativeMutationRequest(replayNativeInventoryJournal(entries)) !==
              canonicalNativeMutationRequest(state)
          )
            return dataError();
          return findNativeInventoryArrivalDocument(arrival, entries, request);
        })
        .deferred();
      assertProject();
      return structuredClone(result);
    },
    previewBenchlingCapture(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryBenchlingCapturePreviewSnapshot {
      const request = inventoryPreviewBenchlingCaptureRequestSchema.parse(input);
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
          const preview = nativeInventoryBenchlingCapturePreview(
            state,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            observeBenchlingBindings(db, project, request.options),
            { at: asOf, principal: caller, authority }
          );
          return structuredClone({ ...preview, asOf, principal: caller });
        })
        .deferred();
      assertProject();
      return snapshot;
    },
    inspectBenchlingCapture(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryBenchlingCaptureSnapshot {
      const request = inventoryInspectBenchlingCaptureRequestSchema.parse(input);
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
          const inspection = inspectInventoryBenchlingCapture(
            request.sourceText,
            NATIVE_DOCUMENT_MAX_BODY_BYTES
          );
          return structuredClone({
            ...inspection,
            target: importTarget(db, project, request.inventoryId, row),
            asOf,
            principal: caller,
          });
        })
        .deferred();
      assertProject();
      return snapshot;
    },

    previewMappedTable(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryMappedTablePreviewSnapshot {
      const request = inventoryPreviewMappedTableRequestSchema.parse(input);
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
          const preview = nativeInventoryMappedTablePreview(
            state,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            observeMappedBindings(db, project, request.options.materials),
            { at: asOf, principal: caller, authority }
          );
          return structuredClone({ ...preview, asOf, principal: caller });
        })
        .deferred();
      assertProject();
      return snapshot;
    },

    previewSourceRevision(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventorySourceRevisionPreviewSnapshot {
      const request = inventoryPreviewSourceRevisionRequestSchema.parse(input);
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
          const preview = nativeInventorySourceRevisionPreview(
            state,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            sourcePreimages(
              db,
              project,
              request.inventoryId,
              state,
              request.options.table,
              request.sourceText
            ),
            { at: asOf, principal: caller, authority }
          );
          return structuredClone({ ...preview, asOf, principal: caller });
        })
        .deferred();
      assertProject();
      return snapshot;
    },

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

    previewHierarchy(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryHierarchyPreviewSnapshot {
      const request = inventoryPreviewHierarchyRequestSchema.parse(input);
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
          const preview = nativeInventoryHierarchyPreview(
            state,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
            { at: asOf, principal: caller, authority }
          );
          return structuredClone({ ...preview, asOf, principal: caller });
        })
        .deferred();
      assertProject();
      return snapshot;
    },

    previewStocktake(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryStocktakePreviewSnapshot {
      const request = inventoryPreviewStocktakeRequestSchema.parse(input);
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
          const preview = nativeInventoryStocktakePreview(
            state,
            importTarget(db, project, request.inventoryId, row),
            request.sourceText,
            request.options,
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

    applyArrival(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(inventoryApplyArrivalRequestSchema.parse(input), assertCurrent, invocation);
    },

    applyBenchlingCapture(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(
        inventoryApplyBenchlingCaptureRequestSchema.parse(input),
        assertCurrent,
        invocation
      );
    },

    applyMappedTable(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(inventoryApplyMappedTableRequestSchema.parse(input), assertCurrent, invocation);
    },

    applyHierarchy(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(inventoryApplyHierarchyRequestSchema.parse(input), assertCurrent, invocation);
    },

    applyStocktake(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(inventoryApplyStocktakeRequestSchema.parse(input), assertCurrent, invocation);
    },

    acknowledgeSource(
      input: unknown,
      assertCurrent: () => void = () => {},
      invocation: NativeInventoryInvocation = {}
    ): NativeInventoryExecution {
      return commit(
        inventoryAcknowledgeSourceRequestSchema.parse(input),
        assertCurrent,
        invocation
      );
    },

    inspect(input: unknown): InventoryState | null {
      const { row } = read(input);
      return row ? stateFromRow(row) : null;
    },

    availability(
      input: unknown,
      invocation: NativeInventoryInvocation = {}
    ): InventoryAvailabilitySnapshot | null {
      const { row, project, request } = read(input);
      if (!row) return null;
      const state = stateFromRow(row);
      const asOf = observationTime(state);
      const caller = principal(invocation);
      return {
        ...inventoryAvailability(state, caller, asOf),
        projectId: project.projectId,
        inventoryId: request.inventoryId,
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
  beforeScientificRead?(): Promise<void>;
  beforeScientificCommit?(): Promise<void>;
  readonly actor?: string;
  readonly principal?: InventoryPrincipal;
}

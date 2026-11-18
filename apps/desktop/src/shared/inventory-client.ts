import type {
  InventoryRunValueCandidatesRequest,
  InventoryRunValueCandidatesRead,
  InventoryPreviewRunValueAttributionRequest,
  InventoryRunValueAttributionPreviewSnapshot,
  InventoryApplyRunValueAttributionRequest,
  InventoryPreviewRunValueAttributionWithdrawalRequest,
  InventoryRunValueAttributionWithdrawalPreviewSnapshot,
  InventoryApplyRunValueAttributionWithdrawalRequest,
  InventoryRunValueAttributionsRequest,
  InventoryRunValueAttributionsRead,
  InventoryRunValueAttributionRequest,
  InventoryRunValueAttributionRead,
  InventoryRunValueAttributionSourceRequest,
  InventoryRunValueAttributionSourceRead,
} from './inventory-run-value-attributions';
export type {
  InventoryRunValueCandidatesRequest,
  InventoryRunValueCandidatesRead,
  InventoryPreviewRunValueAttributionRequest,
  InventoryRunValueAttributionPreviewSnapshot,
  InventoryApplyRunValueAttributionRequest,
  InventoryPreviewRunValueAttributionWithdrawalRequest,
  InventoryRunValueAttributionWithdrawalPreviewSnapshot,
  InventoryApplyRunValueAttributionWithdrawalRequest,
  InventoryRunValueAttributionsRequest,
  InventoryRunValueAttributionsRead,
  InventoryRunValueAttributionRequest,
  InventoryRunValueAttributionRead,
  InventoryRunValueAttributionSourceRequest,
  InventoryRunValueAttributionSourceRead,
} from './inventory-run-value-attributions';
import type {
  InventoryAvailability,
  InventoryScientificTransferPreview,
  InventoryScientificTransferPreviewV2,
  InventoryStockroomProjection,
  InventoryArrivalPreview,
  InventoryArrivalDocumentRead,
  InventoryEquipmentCatalogEntry,
  InventoryEquipmentCatalogUpdatePreview,
  InventoryItemCodeResolution,
  InventoryItemCode,
  InventoryItemCustody,
  InventoryLocationPathEntry,
  InventoryPhysicalItem,
  InventoryPhysicalItemProjection,
  InventoryPrincipal,
  InventoryState,
  InventoryStorageConditionsProjection,
  InventoryStock,
  InventoryStockAvailability,
  InventoryStorage,
  InventoryVessel,
  InventoryArchiveArtifact,
  InventoryImportPreview,
  InventoryTablePreview,
  InventoryStocktakePreview,
  InventoryHierarchyPreview,
  InventoryMappedTablePreview,
  InventorySourceRevisionPreview,
  InventoryBenchlingCaptureInspection,
  InventoryBenchlingCapturePreview,
  InventoryImportTarget,
} from '@waypoint/domain-services';
import type { InventoryRenderedLabel } from '@waypoint/domain-services/inventory-label-types';
import type {
  InventoryPreviewArrivalRequest,
  InventoryScientificContextsRequest,
  InventoryScientificContextsV2Request,
  InventoryPreviewScientificTransferV2Request,
  InventoryApplyScientificTransferV2Request,
  InventoryPreviewScientificTransferRequest,
  InventoryApplyScientificTransferRequest,
  InventoryScientificSourceRequest,
  InventoryApplyArrivalRequest,
  InventoryArrivalDocumentRequest,
  InventoryCatalogUpdatePreviewRequest,
  InventoryExportSnapshotRequest,
  InventoryPreviewImportRequest,
  InventoryApplyImportRequest,
  InventoryPreviewTableRequest,
  InventoryApplyTableRequest,
  InventoryPreviewStocktakeRequest,
  InventoryPreviewHierarchyRequest,
  InventoryPreviewMappedTableRequest,
  InventoryApplyMappedTableRequest,
  InventoryApplyHierarchyRequest,
  InventoryApplyStocktakeRequest,
  InventoryPreviewSourceRevisionRequest,
  InventoryAcknowledgeSourceRequest,
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryOperationRequest,
  InventoryPrepareLabelRequest,
  InventoryReadRequest,
  InventoryInspectBenchlingCaptureRequest,
  InventoryPreviewBenchlingCaptureRequest,
  InventoryApplyBenchlingCaptureRequest,
  InventoryResolveItemCodeRequest,
  InventoryStorageConditionsRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from './inventory-command';
import type { NotebookSavedSource } from './notebook-saved-source';
import type { ProtocolRunSavedSource } from './protocol-packages';
import type {
  InventoryScientificWorksForContextRequest,
  InventoryScientificWorksForContextRead,
} from './inventory-scientific-read';
export type {
  InventoryScientificWorkCursor,
  InventoryScientificWorksForContextRequest,
  InventoryScientificWorksForContextRead,
} from './inventory-scientific-read';

import type {
  InventoryPreviewScientificCitationRequest,
  InventoryApplyScientificCitationRequest,
  InventoryPreviewScientificCitationWithdrawalRequest,
  InventoryApplyScientificCitationWithdrawalRequest,
  InventoryScientificCitationsRequest,
  InventoryScientificCitationSourceRequest,
  InventoryScientificCitationPreviewSnapshot,
  InventoryScientificCitationWithdrawalPreviewSnapshot,
  InventoryScientificCitationsRead,
  InventoryScientificCitationSourceRead,
} from './inventory-scientific-citations';
export type {
  InventoryPreviewScientificCitationRequest,
  InventoryApplyScientificCitationRequest,
  InventoryPreviewScientificCitationWithdrawalRequest,
  InventoryApplyScientificCitationWithdrawalRequest,
  InventoryScientificCitationsRequest,
  InventoryScientificCitationSourceRequest,
  InventoryScientificCitationPreviewSnapshot,
  InventoryScientificCitationWithdrawalPreviewSnapshot,
  InventoryScientificCitationsRead,
  InventoryScientificCitationSourceRead,
} from './inventory-scientific-citations';

export interface InventoryScientificContextsSnapshot {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly pages: readonly {
    readonly kind: 'notebook-page';
    readonly projectId: string;
    readonly pageId: string;
    readonly title: string;
    readonly sourceSha256: `sha256:${string}`;
    readonly sourceKind: 'native-observed-saved-source';
  }[];
}
export type InventoryScientificTransferPreviewSnapshot = InventoryScientificTransferPreview & {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};
export type InventoryScientificSourceRead =
  | {
      readonly kind: 'available';
      readonly workId: string;
      readonly sourceSha256: `sha256:${string}`;
      readonly source: NotebookSavedSource | ProtocolRunSavedSource;
    }
  | { readonly kind: 'unavailable'; readonly code: string; readonly message: string };

export interface InventoryScientificContextsV2Snapshot {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly contexts: readonly {
    readonly kind: 'notebook-page' | 'protocol-run';
    readonly projectId: string;
    readonly entityId: string;
    readonly title: string;
    readonly sourceSha256: `sha256:${string}`;
    readonly sourceKind: 'native-observed-saved-source';
  }[];
}
export type InventoryScientificTransferV2PreviewSnapshot = InventoryScientificTransferPreviewV2 & {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};
export interface InventoryProject {
  readonly projectId: string;
  readonly name: string;
  readonly path: string;
  readonly pinned: boolean;
  readonly defaultInventoryId: string;
}

export interface InventoryMaterial {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly registryId: string | null;
}

export interface InventoryMaterialQuery {
  readonly project: string;
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface InventoryCatalogQuery {
  readonly project: string;
}

export interface InventoryMaterialPage {
  readonly items: readonly InventoryMaterial[];
  readonly nextCursor: string | null;
}

export interface InventoryChanged {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly operationId: string;
}

export interface InventoryStockroomSnapshot extends InventoryStockroomProjection {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
}

export interface InventoryAvailabilitySnapshot extends InventoryAvailability {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
}

export interface InventoryStorageConditionsSnapshot extends InventoryStorageConditionsProjection {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly principal: InventoryPrincipal;
}

export interface InventoryItemCodeTargetSnapshot {
  readonly item: InventoryPhysicalItem;
  readonly record: InventoryStorage | InventoryVessel;
  readonly custody: InventoryItemCustody;
  readonly physical: InventoryPhysicalItemProjection;
  readonly currentLocationPath: readonly InventoryLocationPathEntry[] | null;
  readonly stocks: readonly {
    readonly stock: InventoryStock;
    readonly availability: InventoryStockAvailability;
  }[];
}

export interface InventoryItemCodeLookupSnapshot {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly resolution: InventoryItemCodeResolution;
  readonly targets: readonly InventoryItemCodeTargetSnapshot[];
}

export interface InventoryLabelArtifact {
  readonly schema: 'dnaforge.inventory-label-artifact.v1';
  readonly projectId: string;
  readonly inventoryId: string;
  readonly sourceRevision: number;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
  readonly binding: InventoryItemCode;
  readonly target: InventoryItemCodeTargetSnapshot;
  readonly rendered: InventoryRenderedLabel;
  readonly svgSha256: string;
}

export interface InventoryExportSnapshot extends InventoryArchiveArtifact {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
}
export type InventoryImportPreviewSnapshot = InventoryImportPreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};
export type InventoryTablePreviewSnapshot = InventoryTablePreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryStocktakePreviewSnapshot = InventoryStocktakePreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventorySourceRevisionPreviewSnapshot = InventorySourceRevisionPreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryHierarchyPreviewSnapshot = InventoryHierarchyPreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryMappedTablePreviewSnapshot = InventoryMappedTablePreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryBenchlingCaptureSnapshot = InventoryBenchlingCaptureInspection & {
  readonly target: InventoryImportTarget;
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};
export type InventoryBenchlingCapturePreviewSnapshot = InventoryBenchlingCapturePreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};

export type InventoryArrivalPreviewSnapshot = InventoryArrivalPreview & {
  readonly asOf: number;
  readonly principal: InventoryPrincipal;
};
export type { InventoryArrivalDocumentRead };

import type {
  InventoryPreviewPlatePlanVersionRequest,
  InventoryApplyPlatePlanVersionRequest,
  InventoryPlatePlanVersionsRequest,
  InventoryPlatePlanVersionRequest,
  InventoryPreviewPlatePlanBindingRequest,
  InventoryPlatePlanVersionPreviewSnapshot,
  InventoryPlatePlanVersionsRead,
  InventoryPlatePlanVersionRead,
  InventoryPlatePlanBindingPreviewSnapshot,
} from './inventory-plate-plans';
export type {
  InventoryPreviewPlatePlanVersionRequest,
  InventoryApplyPlatePlanVersionRequest,
  InventoryPlatePlanVersionsRequest,
  InventoryPlatePlanVersionRequest,
  InventoryPreviewPlatePlanBindingRequest,
  InventoryPlatePlanVersionPreviewSnapshot,
  InventoryPlatePlanVersionsRead,
  InventoryPlatePlanVersionRead,
  InventoryPlatePlanBindingPreviewSnapshot,
} from './inventory-plate-plans';

import type {
  InventoryPreviewPlatePlanObservationRequest,
  InventoryApplyPlatePlanObservationRequest,
  InventoryPlatePlanObservationsRequest,
  InventoryPlatePlanObservationRequest,
  InventoryPlatePlanObservationSourceRequest,
  InventoryPlatePlanObservationPreviewSnapshot,
  InventoryPlatePlanObservationsRead,
  InventoryPlatePlanObservationRead,
  InventoryPlatePlanObservationSourceRead,
} from './inventory-plate-plan-observations';
export type {
  InventoryPreviewPlatePlanObservationRequest,
  InventoryApplyPlatePlanObservationRequest,
  InventoryPlatePlanObservationsRequest,
  InventoryPlatePlanObservationRequest,
  InventoryPlatePlanObservationSourceRequest,
  InventoryPlatePlanObservationPreviewSnapshot,
  InventoryPlatePlanObservationsRead,
  InventoryPlatePlanObservationRead,
  InventoryPlatePlanObservationSourceRead,
} from './inventory-plate-plan-observations';
export interface InventoryClient {
  runValueCandidates(
    input: InventoryRunValueCandidatesRequest
  ): Promise<InventoryRunValueCandidatesRead>;
  previewRunValueAttribution(
    input: InventoryPreviewRunValueAttributionRequest
  ): Promise<InventoryRunValueAttributionPreviewSnapshot>;
  applyRunValueAttribution(
    input: InventoryApplyRunValueAttributionRequest
  ): Promise<NativeInventoryExecution>;
  previewRunValueAttributionWithdrawal(
    input: InventoryPreviewRunValueAttributionWithdrawalRequest
  ): Promise<InventoryRunValueAttributionWithdrawalPreviewSnapshot>;
  applyRunValueAttributionWithdrawal(
    input: InventoryApplyRunValueAttributionWithdrawalRequest
  ): Promise<NativeInventoryExecution>;
  runValueAttributions(
    input: InventoryRunValueAttributionsRequest
  ): Promise<InventoryRunValueAttributionsRead>;
  runValueAttribution(
    input: InventoryRunValueAttributionRequest
  ): Promise<InventoryRunValueAttributionRead>;
  runValueAttributionSource(
    input: InventoryRunValueAttributionSourceRequest
  ): Promise<InventoryRunValueAttributionSourceRead>;

  previewPlatePlanObservation(
    input: InventoryPreviewPlatePlanObservationRequest
  ): Promise<InventoryPlatePlanObservationPreviewSnapshot>;
  applyPlatePlanObservation(
    input: InventoryApplyPlatePlanObservationRequest
  ): Promise<NativeInventoryExecution>;
  platePlanObservations(
    input: InventoryPlatePlanObservationsRequest
  ): Promise<InventoryPlatePlanObservationsRead>;
  platePlanObservation(
    input: InventoryPlatePlanObservationRequest
  ): Promise<InventoryPlatePlanObservationRead>;
  platePlanObservationSource(
    input: InventoryPlatePlanObservationSourceRequest
  ): Promise<InventoryPlatePlanObservationSourceRead>;

  previewPlatePlanVersion(
    input: InventoryPreviewPlatePlanVersionRequest
  ): Promise<InventoryPlatePlanVersionPreviewSnapshot>;
  applyPlatePlanVersion(
    input: InventoryApplyPlatePlanVersionRequest
  ): Promise<NativeInventoryExecution>;
  platePlanVersions(
    input: InventoryPlatePlanVersionsRequest
  ): Promise<InventoryPlatePlanVersionsRead>;
  platePlanVersion(input: InventoryPlatePlanVersionRequest): Promise<InventoryPlatePlanVersionRead>;
  previewPlatePlanBinding(
    input: InventoryPreviewPlatePlanBindingRequest
  ): Promise<InventoryPlatePlanBindingPreviewSnapshot>;

  previewScientificCitation(
    input: InventoryPreviewScientificCitationRequest
  ): Promise<InventoryScientificCitationPreviewSnapshot>;
  applyScientificCitation(
    input: InventoryApplyScientificCitationRequest
  ): Promise<NativeInventoryExecution>;
  previewScientificCitationWithdrawal(
    input: InventoryPreviewScientificCitationWithdrawalRequest
  ): Promise<InventoryScientificCitationWithdrawalPreviewSnapshot>;
  applyScientificCitationWithdrawal(
    input: InventoryApplyScientificCitationWithdrawalRequest
  ): Promise<NativeInventoryExecution>;
  scientificCitations(
    input: InventoryScientificCitationsRequest
  ): Promise<InventoryScientificCitationsRead>;
  scientificCitationSource(
    input: InventoryScientificCitationSourceRequest
  ): Promise<InventoryScientificCitationSourceRead>;
  scientificWorksForContext(
    input: InventoryScientificWorksForContextRequest
  ): Promise<InventoryScientificWorksForContextRead>;
  scientificContextsV2(
    input: InventoryScientificContextsV2Request
  ): Promise<InventoryScientificContextsV2Snapshot>;
  previewScientificTransferV2(
    input: InventoryPreviewScientificTransferV2Request
  ): Promise<InventoryScientificTransferV2PreviewSnapshot>;
  applyScientificTransferV2(
    input: InventoryApplyScientificTransferV2Request
  ): Promise<NativeInventoryExecution>;
  scientificContexts(
    input: InventoryScientificContextsRequest
  ): Promise<InventoryScientificContextsSnapshot>;
  previewScientificTransfer(
    input: InventoryPreviewScientificTransferRequest
  ): Promise<InventoryScientificTransferPreviewSnapshot>;
  applyScientificTransfer(
    input: InventoryApplyScientificTransferRequest
  ): Promise<NativeInventoryExecution>;
  scientificSource(input: InventoryScientificSourceRequest): Promise<InventoryScientificSourceRead>;
  stockroom(input: InventoryReadRequest): Promise<InventoryStockroomSnapshot | null>;
  previewArrival(input: InventoryPreviewArrivalRequest): Promise<InventoryArrivalPreviewSnapshot>;
  applyArrival(input: InventoryApplyArrivalRequest): Promise<NativeInventoryExecution>;
  arrivalDocument(input: InventoryArrivalDocumentRequest): Promise<InventoryArrivalDocumentRead>;
  previewBenchlingCapture(
    input: InventoryPreviewBenchlingCaptureRequest
  ): Promise<InventoryBenchlingCapturePreviewSnapshot>;
  applyBenchlingCapture(
    input: InventoryApplyBenchlingCaptureRequest
  ): Promise<NativeInventoryExecution>;
  inspectBenchlingCapture(
    input: InventoryInspectBenchlingCaptureRequest
  ): Promise<InventoryBenchlingCaptureSnapshot>;
  previewMappedTable(
    input: InventoryPreviewMappedTableRequest
  ): Promise<InventoryMappedTablePreviewSnapshot>;
  applyMappedTable(input: InventoryApplyMappedTableRequest): Promise<NativeInventoryExecution>;
  previewHierarchy(
    input: InventoryPreviewHierarchyRequest
  ): Promise<InventoryHierarchyPreviewSnapshot>;
  applyHierarchy(input: InventoryApplyHierarchyRequest): Promise<NativeInventoryExecution>;
  previewSourceRevision(
    input: InventoryPreviewSourceRevisionRequest
  ): Promise<InventorySourceRevisionPreviewSnapshot>;
  acknowledgeSource(input: InventoryAcknowledgeSourceRequest): Promise<NativeInventoryExecution>;
  previewStocktake(
    input: InventoryPreviewStocktakeRequest
  ): Promise<InventoryStocktakePreviewSnapshot>;
  applyStocktake(input: InventoryApplyStocktakeRequest): Promise<NativeInventoryExecution>;
  exportSnapshot(input: InventoryExportSnapshotRequest): Promise<InventoryExportSnapshot>;
  previewImport(input: InventoryPreviewImportRequest): Promise<InventoryImportPreviewSnapshot>;
  applyImport(input: InventoryApplyImportRequest): Promise<NativeInventoryExecution>;
  previewTable(input: InventoryPreviewTableRequest): Promise<InventoryTablePreviewSnapshot>;
  applyTable(input: InventoryApplyTableRequest): Promise<NativeInventoryExecution>;
  projects(): Promise<readonly InventoryProject[]>;
  catalog(input: InventoryCatalogQuery): Promise<readonly InventoryEquipmentCatalogEntry[]>;
  catalogUpdatePreview(
    input: InventoryCatalogUpdatePreviewRequest
  ): Promise<InventoryEquipmentCatalogUpdatePreview>;
  resolveItemCode(input: InventoryResolveItemCodeRequest): Promise<InventoryItemCodeLookupSnapshot>;
  prepareLabel(input: InventoryPrepareLabelRequest): Promise<InventoryLabelArtifact>;
  storageConditions(
    input: InventoryStorageConditionsRequest
  ): Promise<InventoryStorageConditionsSnapshot>;
  materials(input: InventoryMaterialQuery): Promise<InventoryMaterialPage>;
  inspect(input: InventoryReadRequest): Promise<InventoryState | null>;
  availability(input: InventoryReadRequest): Promise<InventoryAvailabilitySnapshot | null>;
  execute(input: InventoryExecuteRequest): Promise<NativeInventoryExecution>;
  operation(input: InventoryOperationRequest): Promise<NativeInventoryReceipt | null>;
  history(input: InventoryHistoryRequest): Promise<readonly NativeInventoryHistoryEntry[]>;
  onChanged(listener: (event: InventoryChanged) => void): () => void;
}

export function unavailableInventoryClient(): InventoryClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('INVENTORY_OWNER_UNAVAILABLE: Inventory requires the connected desktop owner.');
  };
  const unavailableMutation = async (
    request: Pick<InventoryExecuteRequest, 'inventoryId' | 'operationId'>
  ): Promise<NativeInventoryExecution> => ({
    status: 'rejected',
    inventoryId: request.inventoryId,
    operationId: request.operationId,
    code: 'INVENTORY_OWNER_UNAVAILABLE',
    message: 'Inventory requires the connected desktop owner.',
  });
  return {
    runValueCandidates: unavailable,
    previewRunValueAttribution: unavailable,
    applyRunValueAttribution: unavailableMutation,
    previewRunValueAttributionWithdrawal: unavailable,
    applyRunValueAttributionWithdrawal: unavailableMutation,
    runValueAttributions: unavailable,
    runValueAttribution: unavailable,
    runValueAttributionSource: unavailable,
    previewPlatePlanObservation: unavailable,
    applyPlatePlanObservation: unavailableMutation,
    platePlanObservations: unavailable,
    platePlanObservation: unavailable,
    platePlanObservationSource: unavailable,
    previewPlatePlanVersion: unavailable,
    applyPlatePlanVersion: unavailableMutation,
    platePlanVersions: unavailable,
    platePlanVersion: unavailable,
    previewPlatePlanBinding: unavailable,
    previewScientificCitation: unavailable,
    applyScientificCitation: unavailableMutation,
    previewScientificCitationWithdrawal: unavailable,
    applyScientificCitationWithdrawal: unavailableMutation,
    scientificCitations: unavailable,
    scientificCitationSource: unavailable,
    scientificWorksForContext: unavailable,
    scientificContextsV2: unavailable,
    previewScientificTransferV2: unavailable,
    applyScientificTransferV2: unavailableMutation,
    scientificContexts: unavailable,
    previewScientificTransfer: unavailable,
    applyScientificTransfer: unavailableMutation,
    scientificSource: unavailable,
    stockroom: unavailable,
    previewArrival: unavailable,
    applyArrival: unavailableMutation,
    arrivalDocument: unavailable,
    previewBenchlingCapture: unavailable,
    applyBenchlingCapture: unavailableMutation,
    inspectBenchlingCapture: unavailable,
    exportSnapshot: unavailable,
    previewImport: unavailable,
    applyImport: unavailableMutation,
    previewTable: unavailable,
    previewSourceRevision: unavailable,
    acknowledgeSource: unavailableMutation,
    previewStocktake: unavailable,
    previewHierarchy: unavailable,
    previewMappedTable: unavailable,
    applyMappedTable: unavailableMutation,
    applyHierarchy: unavailableMutation,
    applyStocktake: unavailableMutation,
    applyTable: unavailableMutation,
    projects: unavailable,
    catalog: unavailable,
    catalogUpdatePreview: unavailable,
    resolveItemCode: unavailable,
    prepareLabel: unavailable,
    storageConditions: unavailable,
    materials: unavailable,
    inspect: unavailable,
    availability: unavailable,
    execute: unavailableMutation,
    operation: unavailable,
    history: unavailable,
    onChanged: () => () => {},
  };
}

export type {
  InventoryPreviewBenchlingCaptureRequest,
  InventoryApplyBenchlingCaptureRequest,
  InventoryExportSnapshotRequest,
  InventoryPreviewImportRequest,
  InventoryApplyImportRequest,
  InventoryPreviewTableRequest,
  InventoryApplyTableRequest,
  InventoryPreviewStocktakeRequest,
  InventoryPreviewHierarchyRequest,
  InventoryPreviewMappedTableRequest,
  InventoryApplyMappedTableRequest,
  InventoryApplyHierarchyRequest,
  InventoryApplyStocktakeRequest,
  InventoryPreviewSourceRevisionRequest,
  InventoryAcknowledgeSourceRequest,
  InventoryAcceptedRequest,
  InventoryScientificContextsRequest,
  InventoryScientificContextsV2Request,
  InventoryPreviewScientificTransferV2Request,
  InventoryApplyScientificTransferV2Request,
  InventoryPreviewScientificTransferRequest,
  InventoryApplyScientificTransferRequest,
  InventoryScientificSourceRequest,
  InventoryPreviewArrivalRequest,
  InventoryApplyArrivalRequest,
  InventoryArrivalDocumentRequest,
  InventoryCatalogUpdatePreviewRequest,
  InventoryExecuteRequest,
  InventoryHistoryRequest,
  InventoryOperationRequest,
  InventoryPrepareLabelRequest,
  InventoryReadRequest,
  InventoryInspectBenchlingCaptureRequest,
  InventoryResolveItemCodeRequest,
  InventoryStorageConditionsRequest,
  NativeInventoryExecution,
  NativeInventoryHistoryEntry,
  NativeInventoryReceipt,
} from './inventory-command';

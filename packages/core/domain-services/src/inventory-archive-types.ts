import type { InventoryPhysicalItem, InventoryState } from './inventory-types';
import type { InventoryScientificReference } from './inventory-adoption';
export type { InventoryScientificReference } from './inventory-adoption';

export type InventoryArchiveSha256 = `sha256:${string}`;

export interface InventoryArchiveSource {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly revision: number;
  readonly storedSchema: string | null;
}

export type InventoryArchiveSnapshot =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'present';
      readonly json: string;
      readonly sha256: InventoryArchiveSha256;
    };

export interface InventoryArchiveJournalEntry {
  readonly operationId: string;
  readonly revision: number;
  readonly requestJson: string;
  readonly requestSha256: InventoryArchiveSha256;
  readonly receiptJson: string;
  readonly receiptSha256: InventoryArchiveSha256;
}

export interface InventoryArchiveContent {
  readonly source: InventoryArchiveSource;
  readonly state: InventoryArchiveSnapshot;
  readonly history: readonly InventoryArchiveJournalEntry[];
  readonly scientificReferences: readonly InventoryScientificReference[];
}

export interface InventoryArchiveDocument {
  readonly schema: 'dnaforge.inventory-export.v1';
  readonly content: InventoryArchiveContent;
  readonly contentSha256: InventoryArchiveSha256;
}

export interface InventoryArchiveArtifact {
  readonly schema: 'dnaforge.inventory-export-artifact.v1';
  readonly source: InventoryArchiveSource;
  readonly sourceText: string;
  readonly sourceSha256: InventoryArchiveSha256;
  readonly contentSha256: InventoryArchiveSha256;
}

export interface InventoryArchiveCapture {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly state: { readonly revision: number; readonly json: string } | null;
  readonly history: readonly {
    readonly operationId: string;
    readonly revision: number;
    readonly requestJson: string;
    readonly receiptJson: string;
  }[];
}

export interface InventoryArchiveParsedJournalEntry extends InventoryArchiveJournalEntry {
  readonly request: unknown;
  readonly receipt: unknown;
}

export interface InventoryArchiveRuntime {
  readonly maxBytes: number;
  sha256(text: string): InventoryArchiveSha256;
  replayJournal(input: {
    readonly source: InventoryArchiveSource;
    readonly rows: readonly InventoryArchiveParsedJournalEntry[];
    readonly depth: number;
  }): InventoryState;
}

export interface InventoryValidatedArchive {
  readonly document: InventoryArchiveDocument;
  readonly sourceText: string;
  readonly sourceSha256: InventoryArchiveSha256;
  readonly state: InventoryState | null;
}

export interface InventoryImportBinding {
  readonly sourceMaterialId: string;
  readonly destinationMaterialId: string;
}

export interface InventoryResolvedImportBinding extends InventoryImportBinding {
  readonly fingerprint: InventoryArchiveSha256;
}

export interface InventoryImportOptions {
  readonly bindings: readonly InventoryImportBinding[];
}

export interface InventoryResolvedImportOptions {
  readonly bindings: readonly InventoryResolvedImportBinding[];
}

export type InventoryImportBindingObservation = InventoryImportBinding &
  (
    | { readonly kind: 'admitted'; readonly fingerprint: InventoryArchiveSha256 }
    | { readonly kind: 'unavailable'; readonly reason: string }
  );

export interface InventoryImportTarget {
  readonly projectId: string;
  readonly inventoryId: string;
  readonly present: boolean;
  readonly revision: number;
}

export interface InventoryPortabilityIssue {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
}

export interface InventoryImportRecordGroup {
  readonly kind:
    | 'storage'
    | 'vessels'
    | 'stocks'
    | 'lots'
    | 'reservations'
    | 'typeVersions'
    | 'recipeVersions'
    | 'fitEvidence'
    | 'itemCodes'
    | 'temperatureClaims'
    | 'equipmentSetpoints'
    | 'storageRequirements'
    | 'thermalContexts'
    | 'tableBindings'
    | 'observations'
    | 'hierarchyBindings'
    | 'vesselBindings';
  readonly ids: readonly string[];
}

interface InventoryImportPreviewFacts {
  readonly schema: 'dnaforge.inventory-import-preview.v1';
  readonly sourceSha256: InventoryArchiveSha256;
  readonly target: InventoryImportTarget;
  readonly source: InventoryArchiveSource | null;
  readonly sourceRecordedAt: number | null;
  readonly sourceHistoryEntries: number;
  readonly scientificReferences: readonly InventoryScientificReference[];
  readonly bindings: readonly InventoryImportBindingObservation[];
  readonly records: readonly InventoryImportRecordGroup[];
  readonly responsibilities: {
    readonly activeReservationIds: readonly string[];
    readonly unavailableItems: readonly InventoryPhysicalItem[];
  };
}

export type InventoryImportPreview = InventoryImportPreviewFacts &
  (
    | {
        readonly kind: 'blocked';
        readonly issues: readonly InventoryPortabilityIssue[];
        readonly planDigest: null;
        readonly options: null;
      }
    | {
        readonly kind: 'no-change';
        readonly source: InventoryArchiveSource;
        readonly issues: readonly [];
        readonly planDigest: null;
        readonly options: null;
      }
    | {
        readonly kind: 'ready';
        readonly source: InventoryArchiveSource;
        readonly issues: readonly [];
        readonly planDigest: InventoryArchiveSha256;
        readonly options: InventoryResolvedImportOptions;
      }
  );

export interface InventoryImportPreviewInput {
  readonly target: InventoryImportTarget;
  readonly options: InventoryImportOptions;
  readonly bindings: readonly InventoryImportBindingObservation[];
  readonly asOf: number;
}

import type { InventoryTableSha256 } from './inventory-table-types';

export const INVENTORY_BENCHLING_CAPTURE_FORMAT = 'dnaforge.benchling-physical-capture.v1';

export type InventoryBenchlingRecordKind =
  | 'location'
  | 'box'
  | 'plate'
  | 'container'
  | 'box-schema'
  | 'plate-schema';

export interface InventoryBenchlingSourceReference {
  readonly responseId: string;
  readonly pointer: string;
}

export type InventoryBenchlingObservedField = InventoryBenchlingSourceReference &
  (
    | { readonly kind: 'omitted' }
    | { readonly kind: 'null' }
    | { readonly kind: 'present'; readonly jsonText: string }
  );

export type InventoryBenchlingField = {
  readonly observations: readonly InventoryBenchlingObservedField[];
} & (
  | { readonly kind: 'omitted' }
  | { readonly kind: 'null' }
  | { readonly kind: 'present'; readonly jsonText: string }
  | {
      readonly kind: 'conflict';
      readonly alternatives: readonly (
        | { readonly kind: 'null' }
        | { readonly kind: 'present'; readonly jsonText: string }
      )[];
    }
);

export interface InventoryBenchlingRecord {
  readonly kind: InventoryBenchlingRecordKind;
  readonly sourceId: string;
  readonly observations: readonly InventoryBenchlingSourceReference[];
  readonly fields: Readonly<Record<string, InventoryBenchlingField>>;
}

export type InventoryBenchlingPlacementObservation = InventoryBenchlingSourceReference &
  (
    | {
        readonly kind: 'box-position';
        readonly containerId: string;
        readonly boxId: string;
        readonly gridPosition: InventoryBenchlingObservedField;
        readonly gridNumber: InventoryBenchlingObservedField;
      }
    | {
        readonly kind: 'plate-well';
        readonly containerId: string;
        readonly plateId: string;
        readonly position: string;
      }
  );

export interface InventoryBenchlingCaptureRequest {
  readonly method: 'GET';
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface InventoryBenchlingCapturedResponse {
  readonly id: string;
  readonly request: InventoryBenchlingCaptureRequest;
  readonly bodyText: string;
  readonly bodySha256: InventoryTableSha256;
  readonly numberLexemes: readonly { readonly pointer: string; readonly lexeme: string }[];
}

export interface InventoryBenchlingCapture {
  readonly format: typeof INVENTORY_BENCHLING_CAPTURE_FORMAT;
  readonly apiVersion: 'v2';
  readonly namespace: string;
  readonly capturedAt: string;
  readonly scope: { readonly kind: 'selected-records'; readonly description: string };
  readonly responses: readonly InventoryBenchlingCapturedResponse[];
  readonly sourceText: string;
}

export interface InventoryBenchlingCaptureIssue {
  readonly severity: 'invalid' | 'needs-resolution';
  readonly code: string;
  readonly pointer: string;
  readonly responseId: string | null;
  readonly bodyPointer: string | null;
  readonly message: string;
}

export interface InventoryBenchlingPaginationPage {
  readonly responseId: string;
  readonly requestToken:
    | { readonly kind: 'initial' }
    | { readonly kind: 'cursor'; readonly value: string };
  readonly nextToken: InventoryBenchlingObservedField;
  readonly containers: InventoryBenchlingObservedField;
}

export interface InventoryBenchlingPagination {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly kind: 'linked' | 'incomplete' | 'conflict';
  readonly pages: readonly InventoryBenchlingPaginationPage[];
  readonly linkedResponseIds: readonly string[];
  readonly issues: readonly InventoryBenchlingCaptureIssue[];
}

export interface InventoryBenchlingCaptureInspection {
  readonly schema: 'dnaforge.inventory-benchling-capture-inspection.v1';
  readonly kind: 'blocked' | 'inspected';
  readonly sourceSha256: InventoryTableSha256 | null;
  readonly capture: InventoryBenchlingCapture | null;
  readonly records: readonly InventoryBenchlingRecord[];
  readonly placements: readonly InventoryBenchlingPlacementObservation[];
  readonly pagination: readonly InventoryBenchlingPagination[];
  readonly issues: readonly InventoryBenchlingCaptureIssue[];
}

import type {
  ScientificDocumentIdentity,
  ScientificDocumentReadResult,
  WorkspaceIdentity,
} from '@waypoint/domain-services';

export const SCIENTIFIC_DOCUMENT_READ_CHANNEL = 'scientificDocuments:read' as const;
export const SCIENTIFIC_DOCUMENT_CANCEL_READ_CHANNEL = 'scientificDocuments:cancelRead' as const;

export interface DesktopScientificDocumentReadRequest {
  readonly operationId: string;
  readonly workspaceRoot: string;
  readonly workspace: WorkspaceIdentity;
  readonly document: ScientificDocumentIdentity;

  readonly acceptedHead?: string;
}

export interface DesktopScientificDocumentCancelRequest {
  readonly operationId: string;
}

export type DesktopScientificDocumentReadResult = ScientificDocumentReadResult;

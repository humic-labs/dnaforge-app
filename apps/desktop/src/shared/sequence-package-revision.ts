import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { SchemaBoundSequenceEntityMetadata } from './sequence-entity-schema';
import type { ManagedSequenceDocumentRef } from './managed-sequence-document';
import type { SequencePackageDocument } from '../db/sequence-package';
import type { UserAttachmentMutation } from '../db/sequence-package-user-attachment-mutation';

export interface SequenceUserAttachmentMutationRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  expectedMarkerSha256: string;
  expectedProductSha256: string;
  operationId: string;
  mutation: UserAttachmentMutation;
  mutationToken?: string;
}

export interface SequenceUserAttachmentMutationResult {
  revisionId: string;
  alreadyPublished: boolean;
  snapshotPaths: string[];
  assetPaths: string[];
  publicationPaths?: string[];
}

export interface SequenceMetadataRevisionRequest {
  document: ManagedSequenceDocumentRef;

  expectedMarkerSha256: string;
  operationId: string;
  proposed: {
    name: string;
    topology?: 'circular' | 'linear';
    entity: SchemaBoundSequenceEntityMetadata;

    geneticCode?: GeneticCodeSpec | null;
  };
}

export interface SequenceMetadataRevisionResult {
  updatedMarkerContent: string;
  revisionId: string | null;
  productChanged: boolean;
  snapshotPaths: string[];

  alreadyPublished?: boolean;
}

export interface AcceptedAssemblyRevisionPublicationRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  nextDocument: SequencePackageDocument;
  nextProductContent: string;
  acceptedVersionId: string;
  expectedMarkerSha256: string;
  expectedProductSha256: string;
  primerAssets: ReadonlyArray<{ path: string; sha256: string; content: string }>;
  mutationToken?: string;
}

export interface AcceptedAssemblyRevisionPublicationResult {
  revisionId: string;
  markerContent: string;
  snapshotPaths: string[];
  assetPaths: string[];
}

export interface SequenceRestoreSelection {
  itemId: string;
  revisionId: string;
}

export interface SequenceRestorePreviewRequest {
  workspaceRoot: string;
  packageRoot: string;
  packageId: string;
  selections: SequenceRestoreSelection[];
}

export interface SequenceRestorePreviewResult {
  previewFingerprint: string;
  currentHeadId: string;
  currentMarkerSha256: string;
  currentProductSha256: string;
  selectedSources: Record<string, { revisionId: string; valueSha256: string }>;
  changedItems: string[];
  blockers: string[];
  warnings: string[];
}

export interface SequenceRestoreApplyRequest extends SequenceRestorePreviewRequest {
  operationId: string;
  previewFingerprint: string;
  mutationToken?: string;
}

export interface SequenceRestoreApplyResult {
  revisionId: string;
  alreadyPublished: boolean;
  markerContent: string;
  snapshotPaths: string[];
  publicationPaths?: string[];
}

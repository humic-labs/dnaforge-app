import type { WorkspaceIdentity } from '@waypoint/domain-services';
import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { SequencePackageDocument } from '../../db/sequence-package';
import type { ManagedSequenceDocumentRef } from '../../shared/managed-sequence-document';

export interface ResolvedManagedSequenceDocument {
  ref: ManagedSequenceDocumentRef;
  document: SequencePackageDocument;

  productPath: string;
  accepted?: {
    workspaceRoot: string;
    workspace: WorkspaceIdentity;
    head: string;
    productRevisionId: string;
    packageRevisionId: string;
  };
}

export interface AcceptedSequenceMetadataOwner {
  load(packageRoot: string): Promise<ResolvedManagedSequenceDocument | null>;
  save(
    current: ResolvedManagedSequenceDocument,
    next: SequencePackageDocument,
    options: UpdateManagedSequenceMetadataOptions
  ): Promise<SequencePackageDocument>;
}

export interface ManagedSequenceResolutionOptions {
  readonly mutationToken?: string;
}

export interface ManagedSequenceRepository {
  findByMemberPath(
    path: string,
    options?: ManagedSequenceResolutionOptions
  ): Promise<ResolvedManagedSequenceDocument | null>;
  findById(
    packageId: string,
    workspaceRoots: readonly string[],
    options?: ManagedSequenceResolutionOptions
  ): Promise<ResolvedManagedSequenceDocument | null>;
  openPackage(
    packageRoot: string,
    options?: ManagedSequenceResolutionOptions
  ): Promise<ResolvedManagedSequenceDocument>;
  resolve(
    ref: ManagedSequenceDocumentRef,
    options?: ManagedSequenceResolutionOptions
  ): Promise<ResolvedManagedSequenceDocument>;
  updateMetadata(
    ref: ManagedSequenceDocumentRef,
    update: (current: SequencePackageDocument) => SequencePackageDocument,
    options?: UpdateManagedSequenceMetadataOptions
  ): Promise<SequencePackageDocument>;
}

export interface UpdateManagedSequenceMetadataOptions {
  readonly geneticCode?: GeneticCodeSpec | null;
}

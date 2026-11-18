import type {
  ScientificAssemblyDraft,
  ScientificDocument,
  ScientificFileContent,
  ScientificSnapshot,
} from '@waypoint/scientific-objects';
import type { Conflict, MutationError } from '@waypoint/workspace-revisions';
import type { GeneticCodeSpec } from '@waypoint/sequence-utils';
import type { ScientificAcceptedDocumentRevision, WorkspaceIdentity } from './scientific-documents';

export type ScientificSubmittedFile = {
  readonly resourceId: string;

  readonly path: string;
} & ScientificFileContent;

export interface ScientificWorkspaceSubmission {
  readonly operationId: string;
  readonly expectedHead: string | null;
  readonly source:
    | { readonly kind: 'initialize-empty-namespace' }
    | {
        readonly kind: 'documents';
        readonly entries: readonly ScientificSubmittedFile[];
      }
    | {
        readonly kind: 'accepted-assembly';
        readonly entries: readonly ScientificSubmittedFile[];
        readonly assembly: ScientificAssemblyDraft;

        readonly nativePackage?: {
          readonly metadataText: string;
          readonly primerCsvText: string;
          readonly primerFastaText: string;
          readonly snapshotFiles?: readonly {
            readonly path: string;
            readonly content: string;
            readonly sha256: string;
          }[];
        };
      }
    | {
        readonly kind: 'native-artifact';

        readonly expectedRevisionId: string | null;
        readonly entry: {
          readonly resourceId: string;
          readonly path: string;
          readonly representation: {
            readonly format: 'primer-v2' | 'strain-entity-v1' | 'genbank-v1';
            readonly text: string;
          };

          readonly sequencePackageText?: string;
        };
      }
    | {
        readonly kind: 'sequence-metadata';
        readonly resourceId: string;
        readonly expectedRevisionId: string;
        readonly expectedPackageRevisionId: string;
        readonly metadataText: string;

        readonly expectedWorkingMetadataSha256?: string;
        readonly geneticCode?: GeneticCodeSpec | null;
      }
    | {
        readonly kind: 'relocate';
        readonly sourcePath: string;
        readonly destinationPath: string;
      }
    | {
        readonly kind: 'restore-workspace';
        readonly version: string;
      }
    | { readonly kind: 'delete'; readonly sourcePath: string }
    | { readonly kind: 'restore-record'; readonly resourceId: string }
    | { readonly kind: 'revert-record'; readonly resourceId: string }
    | {
        readonly kind: 'copy';
        readonly resourceId: string;
        readonly destinationPath: string;
        readonly copiedAt: string;

        readonly catalogNumber?: string;
      }
    | { readonly kind: 'working-files' }
    | { readonly kind: 'git-commit'; readonly commit: string };
}

export interface ScientificWorkspaceRequest {
  readonly workspace: WorkspaceIdentity;
}
export interface ScientificObjectReadRequest extends ScientificWorkspaceRequest {
  readonly resourceId: string;

  readonly revisionId?: string;
}
export interface ScientificWorkspaceSubmitRequest
  extends ScientificWorkspaceSubmission, ScientificWorkspaceRequest {}

export interface ScientificAcceptedWorkspace {
  readonly workspace: WorkspaceIdentity;
  readonly head: string | null;
  readonly entries: readonly {
    readonly resourceId: string;
    readonly revisionId: string;
    readonly path: string;
    readonly document: ScientificDocument;
  }[];
}

export interface ScientificWorkspaceCatalog extends ScientificWorkspaceRequest {
  readonly head: string | null;
  readonly entries: readonly {
    readonly resourceId: string;
    readonly revisionId: string;
    readonly path: string | null;
    readonly lastPath: string | null;
    readonly tombstone: boolean;
  }[];
}
export type ScientificSubmissionReceipt =
  | { readonly outcome: 'changed'; readonly version: string }
  | { readonly outcome: 'no-op'; readonly head: string | null }
  | { readonly outcome: 'conflict'; readonly conflicts: readonly Conflict[] }
  | { readonly outcome: 'rejected'; readonly error: MutationError };
export interface ScientificWorkspaceSubmitResult {
  readonly operationId: string;
  readonly replayed: boolean;
  readonly currentHead: string | null;
  readonly receipt: ScientificSubmissionReceipt;

  readonly accepted?: ScientificAcceptedDocumentRevision;

  readonly nativeProjectionComplete?: boolean;
  readonly createdResourceId?: string;
  readonly delivery:
    | null
    | { readonly kind: 'complete' }
    | { readonly kind: 'blocked'; readonly versionId: string; readonly error: string };
}

export interface ScientificWorkspaceProjectionResult {
  readonly head: string | null;

  readonly projectedPaths: readonly string[];

  readonly acceptedResourceIds?: readonly string[];
  readonly relationships: number;
}

export interface ScientificObjectsService {
  catalog(request: ScientificWorkspaceRequest): Promise<ScientificWorkspaceCatalog>;
  list(request: ScientificWorkspaceRequest): Promise<ScientificAcceptedWorkspace>;
  read(request: ScientificObjectReadRequest): Promise<ScientificSnapshot | null>;
  submit(request: ScientificWorkspaceSubmitRequest): Promise<ScientificWorkspaceSubmitResult>;
  reconcileProjections(
    request: ScientificWorkspaceRequest
  ): Promise<ScientificWorkspaceProjectionResult>;
}

import type { FileAssociationFamilyId, HandlerFamilyId } from './file-associations';

export interface FileActivationDelivery {
  readonly deliveryId: string;
  readonly path: string;
  readonly familyId: HandlerFamilyId;
}

export type FileAssociationHandlerState =
  | 'default'
  | 'other'
  | 'none'
  | 'unavailable'
  | 'unsupported';

export type FileAssociationDefaultAction = 'native' | 'system-settings' | 'instructions' | 'none';

export interface FileAssociationHandlerStatus {
  readonly familyId: HandlerFamilyId;
  readonly state: FileAssociationHandlerState;
  readonly handlerName: string | null;
  readonly handlerPath: string | null;
  readonly mixedHandlers?: readonly {
    readonly extension: string;
    readonly handlerName: string | null;
  }[];
  readonly defaultAction: FileAssociationDefaultAction;
  readonly detail: string | null;
}

export interface FileAssociationDefaultRequestResult {
  readonly familyId: HandlerFamilyId;
  readonly outcome: 'requested' | 'opened-settings' | 'instructions' | 'unavailable';
  readonly detail: string | null;
}

export interface MaterializeQuickLookPackageRequest {
  readonly sourcePath: string;
  readonly familyId: FileAssociationFamilyId;
}

export interface PrepareQuickLookPackageRequest {
  readonly packageRoot: string;
}

export interface QuickLookRecordReceipt {
  readonly recordId: string;
  readonly ordinal: number;
  readonly displayName: string;
  readonly sequenceLength: number;
  readonly circular: boolean;
  readonly productPath: string;
}

export interface QuickLookPackageReceipt {
  readonly sourcePath: string;
  readonly productPath: string;
  readonly packageRoot: string;
  readonly contentHash: string;
  readonly familyId: FileAssociationFamilyId;
  readonly sourceFileName: string;
  readonly records: readonly [QuickLookRecordReceipt, ...QuickLookRecordReceipt[]];
}

export interface PromoteQuickLookPackageRequest {
  readonly receipt: QuickLookPackageReceipt;
  readonly destination:
    | { readonly kind: 'existing-workspace'; readonly rootPath: string }
    | { readonly kind: 'new-workspace'; readonly name: string };
}

export interface PromoteQuickLookPackageResult {
  readonly destPath: string;
  readonly relPath: string;
  readonly committed: boolean;
  readonly workspaceRoot: string;
  readonly createdNewWorkspace: boolean;
  readonly createdWorkspaceName: string | null;
  readonly records: readonly {
    readonly recordId: string;
    readonly destPath: string;
    readonly relPath: string;
  }[];
}

export interface ExternalPreviewReceipt {
  readonly version: 1;
  readonly packageId: string;
  readonly familyId: HandlerFamilyId;
  readonly sourcePath: string;
  readonly sourceFileName: string;
  readonly contentHash: string;
  readonly sequence?: QuickLookPackageReceipt;
  readonly acquisitionId?: string;
}

export interface ProjectPreviewPackage {
  readonly packageId: string;
  readonly packageInstanceId: string;
  readonly familyId: Exclude<HandlerFamilyId, FileAssociationFamilyId>;
  readonly sourceFileName: string;
  readonly contentHash: string;
  readonly entryPath: string;
  readonly productPaths: readonly string[];
  readonly presentation: import('./source-document-package').SourceDocumentPresentation;
  readonly bytes: Uint8Array;
}

export interface PreviewTabSnapshot {
  readonly ownerId: string;
  readonly receipts: readonly (ExternalPreviewReceipt | QuickLookPackageReceipt)[];
}

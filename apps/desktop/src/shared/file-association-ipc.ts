import type { FileAssociationFamilyId } from './file-associations';

export interface FileActivationDelivery {
  readonly deliveryId: string;
  readonly path: string;
  readonly familyId: FileAssociationFamilyId;
}

export type FileAssociationHandlerState =
  | 'default'
  | 'other'
  | 'none'
  | 'unavailable'
  | 'unsupported';

export type FileAssociationDefaultAction = 'native' | 'system-settings' | 'instructions' | 'none';

export interface FileAssociationHandlerStatus {
  readonly familyId: FileAssociationFamilyId;
  readonly state: FileAssociationHandlerState;
  readonly handlerName: string | null;
  readonly handlerPath: string | null;
  readonly defaultAction: FileAssociationDefaultAction;
  readonly detail: string | null;
}

export interface FileAssociationDefaultRequestResult {
  readonly familyId: FileAssociationFamilyId;
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

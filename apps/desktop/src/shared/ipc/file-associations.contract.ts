import type {
  ExternalPreviewReceipt,
  ProjectPreviewPackage,
  PreviewTabSnapshot,
  FileActivationDelivery,
  FileAssociationDefaultRequestResult,
  FileAssociationHandlerStatus,
  MaterializeQuickLookPackageRequest,
  PrepareQuickLookPackageRequest,
  PromoteQuickLookPackageRequest,
  PromoteQuickLookPackageResult,
  QuickLookPackageReceipt,
} from '../file-association-ipc';
import type { HandlerFamilyId } from '../file-associations';
import { defineGroup, invoke, event } from './contract';

export const fileAssociationsContract = defineGroup('fileAssociations', {
  openPreview: invoke<
    [request: { sourcePath: string; familyId: HandlerFamilyId }],
    ExternalPreviewReceipt
  >(),
  adoptPreview: invoke<
    [request: { receipt: ExternalPreviewReceipt | QuickLookPackageReceipt }],
    ExternalPreviewReceipt
  >(),
  releasePreview: invoke<[request: { receipt: ExternalPreviewReceipt }], void>(),
  savePreview: invoke<
    [
      request: {
        receipt: ExternalPreviewReceipt;
        destination: PromoteQuickLookPackageRequest['destination'];
      },
    ],
    PromoteQuickLookPackageResult
  >(),
  readPreviewPackage: invoke<[request: { receipt: ExternalPreviewReceipt }], Uint8Array>(),
  resolvePreviewImportSource: invoke<[request: { receipt: ExternalPreviewReceipt }], string>(),
  syncPreviewTabs: invoke<[request: PreviewTabSnapshot], void>(),
  readPreviewPresentation: invoke<
    [request: { receipt: ExternalPreviewReceipt }],
    import('../source-document-package').SourceDocumentPresentationData
  >(),
  describeProjectPreviewPackage: invoke<
    [request: { workspaceRoot: string; path: string }],
    Omit<ProjectPreviewPackage, 'bytes'>
  >(),
  readProjectPreviewPresentation: invoke<
    [
      request: {
        workspaceRoot: string;
        path: string;
        expectedPackageId?: string;
        expectedSourceSha256?: string;
      },
    ],
    import('../source-document-package').SourceDocumentPresentationData
  >(),
  readProjectPreviewPackage: invoke<
    [request: { workspaceRoot: string; path: string }],
    ProjectPreviewPackage
  >(),
  readPreviewBytes: invoke<[path: string, maxBytes: number], Uint8Array>(),
  takePendingActivations: invoke<[], FileActivationDelivery[]>(),
  materializeQuickLookPackage: invoke<
    [request: MaterializeQuickLookPackageRequest],
    QuickLookPackageReceipt
  >(),
  prepareQuickLookPackage: invoke<[request: PrepareQuickLookPackageRequest], boolean>(),
  promoteQuickLookPackage: invoke<
    [request: PromoteQuickLookPackageRequest],
    PromoteQuickLookPackageResult
  >(),
  queryHandlers: invoke<[], FileAssociationHandlerStatus[]>(),
  requestDefault: invoke<[familyId: HandlerFamilyId], FileAssociationDefaultRequestResult>(),
  onOpenFiles: event<[deliveries: FileActivationDelivery[]]>().channel(
    'file-association:open-files'
  ),
});

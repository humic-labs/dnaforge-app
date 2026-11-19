import type {
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

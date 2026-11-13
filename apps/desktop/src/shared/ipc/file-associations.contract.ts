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
import type { FileAssociationFamilyId } from '../file-associations';
import { defineGroup, invoke, event } from './contract';

export const fileAssociationsContract = defineGroup('fileAssociations', {
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
  requestDefault: invoke<
    [familyId: FileAssociationFamilyId],
    FileAssociationDefaultRequestResult
  >(),
  onOpenFiles: event<[deliveries: FileActivationDelivery[]]>().channel(
    'file-association:open-files'
  ),
});

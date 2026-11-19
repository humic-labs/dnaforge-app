import type {
  NativeCatalogRecordReconcileRequest,
  WorkspaceListChildrenRequest,
  WorkspaceListChildrenResult,
} from '../workspace-browser-types';
import { defineGroup, invoke } from './contract';
import type { DocumentAvailability, DocumentAvailabilityRequest } from '../document-availability';

export const workspaceBrowserContract = defineGroup('workspace', {
  listChildren: invoke<[request: WorkspaceListChildrenRequest], WorkspaceListChildrenResult>(),
  checkDocument: invoke<[request: DocumentAvailabilityRequest], DocumentAvailability>(),
  reconcileNativeRecords: invoke<[request: NativeCatalogRecordReconcileRequest], number>(),
});

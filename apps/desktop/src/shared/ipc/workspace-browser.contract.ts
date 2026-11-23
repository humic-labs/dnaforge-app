import type {
  NativeCatalogRecordReconcileRequest,
  WorkspaceListChildrenRequest,
  WorkspaceListChildrenResult,
} from '../workspace-browser-types';
import { defineGroup, invoke } from './contract';
import type { DocumentAvailabilityProbe, DocumentAvailabilityRequest } from '../document-availability';

export const workspaceBrowserContract = defineGroup('workspace', {
  listChildren: invoke<[request: WorkspaceListChildrenRequest], WorkspaceListChildrenResult>(),
  checkDocument: invoke<[request: DocumentAvailabilityRequest], DocumentAvailabilityProbe>(),
  reconcileNativeRecords: invoke<[request: NativeCatalogRecordReconcileRequest], number>(),
});

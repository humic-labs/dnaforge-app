import type {
  NativeCatalogRecordReconcileRequest,
  WorkspaceListChildrenRequest,
  WorkspaceListChildrenResult,
} from '../workspace-browser-types';
import { defineGroup, invoke } from './contract';

export const workspaceBrowserContract = defineGroup('workspace', {
  listChildren: invoke<[request: WorkspaceListChildrenRequest], WorkspaceListChildrenResult>(),
  reconcileNativeRecords: invoke<[request: NativeCatalogRecordReconcileRequest], number>(),
});

import type { NativeDocumentWorkspaceRootsRequest } from '../native-document-workspaces';
import { defineGroup, invoke } from './contract';

export const workspaceNativeDocumentsContract = defineGroup('workspace', {
  setDocumentCommandRoots: invoke<[request: NativeDocumentWorkspaceRootsRequest], boolean>(),
});

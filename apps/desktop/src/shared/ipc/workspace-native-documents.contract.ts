import type { NativeDocumentWorkspaceRootsRequest } from '../native-document-workspaces';
import type { AuthorizedProjectFolder } from '../agent-project-scope';
import { defineGroup, invoke } from './contract';

export const workspaceNativeDocumentsContract = defineGroup('workspace', {
  listRegisteredProjects: invoke<[], AuthorizedProjectFolder[]>(),
  resolveRegisteredProject: invoke<[reference: string], AuthorizedProjectFolder | null>(),
  setDocumentCommandRoots: invoke<[request: NativeDocumentWorkspaceRootsRequest], boolean>(),
});

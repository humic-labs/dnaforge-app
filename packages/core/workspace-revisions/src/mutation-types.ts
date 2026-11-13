import type { OperationId, RefName, WorkspaceVersionId } from './identity';
import type { RevisionGraph, WorkspaceMutation } from './types';

export interface ApplyMutationInput {
  readonly graph: RevisionGraph;
  readonly refName: RefName;
  readonly expectedHead: WorkspaceVersionId | null;
  readonly operationId: OperationId;
  readonly mutation: WorkspaceMutation;
}

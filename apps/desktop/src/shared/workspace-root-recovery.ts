export interface WorkspaceRootStatus {
  repoPath: string;
  state: 'available' | 'missing' | 'unavailable';
}

export interface RelinkWorkspaceRootRequest {
  repoPath: string;
  selectedPath: string;
}

export type RelinkWorkspaceRootResult =
  | { status: 'relinked'; workspaceId: number; repoPath: string }
  | {
      status: 'rejected';
      reason:
        | 'identity-unavailable'
        | 'source-present'
        | 'invalid-target'
        | 'identity-mismatch'
        | 'path-conflict'
        | 'compute-dependency'
        | 'pending-sync-delivery'
        | 'unbound-file-document'
        | 'scientific-document'
        | 'unsaved-document';
    };

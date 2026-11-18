export type WorkspaceSyncSelectionExcludedReason =
  | 'project-ignore'
  | 'unsupported'
  | 'private-raw-data'
  | 'reference-pointer'
  | 'file-too-large'
  | 'bundle-too-large'
  | 'selection-review';

export interface WorkspaceSyncExcludedFile {
  relativePath: string;
  sizeBytes: number;
  reason: WorkspaceSyncSelectionExcludedReason;
}

export interface WorkspaceSyncSelection {
  version: 1;
  revision: string;
  state: 'review-required' | 'active';
  ruleFiles: { relativePath: string; content: string }[];
  newlyIncludedPaths: string[];
  protectedFiles?: {
    relativePath: string;
    reason: 'already-backed-up' | 'required-scientific' | 'project-rules';
  }[];
}

export type WorkspaceSyncSelectionUpdate =
  | { kind: 'save-rules'; expectedRevision: string; rootGitignore: string }
  | { kind: 'approve'; expectedRevision: string };

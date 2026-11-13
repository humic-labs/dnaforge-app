import type { SafeWorkspaceSource } from '@waypoint/analytics-policy';

export type WorkspaceSource =
  | { kind: 'local-folder'; path: string; name?: string; pinned?: boolean }
  | { kind: 'workspace-file'; path: string }
  | { kind: 'sample-template'; templateId: string; mode?: 'reuse' | 'fresh' }
  | { kind: 'git-clone'; remoteUrl: string; ref?: string }
  | { kind: 'community-workspace'; id: string; version?: string }
  | { kind: 'empty'; name?: string };

export interface OpenWorkspaceOptions {
  openAsset?: string;
  revealAsset?: string;
  openAssetLabel?: string;
  allowOpenAssetFailure?: boolean;
  addToRecents?: boolean;
  replaceCurrent?: boolean;
  makeCurrent?: boolean;
  inPlace?: boolean;
  importId?: string;
  telemetrySource?: SafeWorkspaceSource;
}

export interface WorkspaceInstance {
  id: string;
  displayName: string;
  rootFolders: Array<{ path: string; name: string; pinned?: boolean }>;
  workspaceFilePath?: string;
  source: WorkspaceSource;
  writable: boolean;
  createdAt: number;
}

import type { ManagedFileMigrationIssue } from '../shared/workspace-git-types';

export interface WorkspaceReconcileResult {
  scanned: number;

  visibleFileCount?: number;
  healedFileCount?: number;
  migrationIssues?: ManagedFileMigrationIssue[];
  registered: number;
  repaired: number;
  missing: number;

  externalMovesRelinked: number;

  externalMovesAmbiguous: number;
  primerArtifactsDiscovered: number;
  primerArtifactsReconciled: number;
  primerArtifactErrors: Array<{ path: string; message: string; primerName?: string }>;

  primerArtifactCandidatePaths?: string[];

  entityArtifactCandidatePaths?: string[];

  entityArtifactDiscoveryComplete?: boolean;

  nativeManifestEntities?: number;
  nativeManifestLinks?: number;
  nativeManifestLimsEntities?: number;
  nativeManifestEvents?: number;

  nativeManifestProviderBindings?: number;
  errors: Array<{ path: string; message: string }>;
}

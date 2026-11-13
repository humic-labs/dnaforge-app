import type { ArtifactDatabase, ArtifactFiles } from '../artifact-io';
import type { CatalogNumberAllocator, WorkspaceMutationRunner } from '../artifact-operation-ports';
import type { createDnaSequenceOwner } from '../registry-artifacts/dna-sequence-owner';
import type { LimsRegistryPreview, LimsRegistryPreviewInput } from '../lims';
import type { OriginalDefaultProjectResolution } from '../first-project';
import type { PrimerRegistryRelationship } from '../primer-registry-relationships';
export interface PrimerRecoveryDependencies {
  io(): {
    db: Pick<ArtifactDatabase, 'select'>;
    fs: Pick<
      ArtifactFiles,
      'exists' | 'readTextFile' | 'validateWorkspacePath' | 'writeWorkspaceTextFileAtomic'
    >;
    workspace: { getOriginalDefaultProject(): Promise<OriginalDefaultProjectResolution> };
  };
  setSetting(key: string, value: string): Promise<void>;
  withRendererWorkspaceMutation: WorkspaceMutationRunner;
  getLimsRegistryPreview(input?: LimsRegistryPreviewInput): Promise<LimsRegistryPreview>;
  buildFileDnaSequenceRef: ReturnType<typeof createDnaSequenceOwner>['buildFileDnaSequenceRef'];
  generateCatalogNumber: CatalogNumberAllocator;
  findTrashedPrimerDocument(
    entityId: string,
    expectedPath?: string
  ): Promise<{
    path: string;
    workspace_id: number | null;
    status: string;
    file_kind: string;
  } | null>;
  readPrimerRegistryRelationships(entityId: string): Promise<PrimerRegistryRelationship[]>;
}

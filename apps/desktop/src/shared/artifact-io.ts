import type {
  PrimerArtifactRevisionStateRequest,
  PrimerArtifactRevisionState,
  PrimerArtifactRevisionCommand,
  PrimerArtifactRevisionResult,
  PrimerArtifactPublicationResumeRequest,
} from './primer-artifact-revision';
import type { CatalogFileBindingRequest, CatalogFileBindingRow } from './catalog-binding';
import type { SqliteIpcValue } from './sqlite-ipc';
import type { PrimerLegacyProjectionInput } from './primer-projection-ipc';
import type {
  LimsRegisterEntityInput,
  LimsEntity,
  LimsUpdateEntityInput,
  LimsEntityActionInput,
  LimsQueryEntitiesInput,
  LimsSchemaDefinitionView,
} from './lims';
import type {
  WorkspaceBinaryFileAtomicWriteInput,
  WorkspaceTextFileAtomicWriteResult,
  WorkspaceTextFileAtomicWriteInput,
  WorkspacePathValidationInput,
} from './workspace-file-atomic';
import type { FilesystemStat } from './filesystem-stat';
export interface ArtifactDatabase {
  bindCatalogEntityFile(
    input: CatalogFileBindingRequest,
    mutationToken?: string
  ): Promise<CatalogFileBindingRow>;
  execute(
    sql: string,
    params?: SqliteIpcValue[]
  ): Promise<{ changes: number; lastInsertRowid: number }>;
  select<T>(sql: string, params?: SqliteIpcValue[]): Promise<T>;
  replacePrimerProjection(
    input: PrimerLegacyProjectionInput,
    workspaceRoot?: string,
    mutationToken?: string
  ): Promise<void>;
}

export interface ArtifactRegistryIO {
  readPrimerArtifactRevisionState(
    input: PrimerArtifactRevisionStateRequest
  ): Promise<PrimerArtifactRevisionState>;
  revisePrimerArtifact(input: PrimerArtifactRevisionCommand): Promise<PrimerArtifactRevisionResult>;
  resumePrimerArtifactPublication(
    input: PrimerArtifactPublicationResumeRequest
  ): Promise<PrimerArtifactRevisionResult>;
  registerEntity(input: LimsRegisterEntityInput, mutationToken?: string): Promise<LimsEntity>;
  repairEntityProjectionFromAudit(entityId: string, mutationToken?: string): Promise<boolean>;
  updateEntity(input: LimsUpdateEntityInput, mutationToken?: string): Promise<LimsEntity>;
  restoreEntity(input: LimsEntityActionInput, mutationToken?: string): Promise<LimsEntity>;
  queryEntities(input?: LimsQueryEntitiesInput): Promise<LimsEntity[]>;
  listSchemas(): Promise<LimsSchemaDefinitionView[]>;
}

export interface ArtifactFiles {
  readTextFile(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  sha256File(path: string): Promise<string>;
  writeWorkspaceBinaryFileAtomic(
    input: WorkspaceBinaryFileAtomicWriteInput
  ): Promise<WorkspaceTextFileAtomicWriteResult>;
  writeWorkspaceTextFileAtomic(
    input: WorkspaceTextFileAtomicWriteInput
  ): Promise<WorkspaceTextFileAtomicWriteResult>;
  validateWorkspacePath(input: WorkspacePathValidationInput): Promise<boolean>;
  readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean }>>;
  stat(path: string): Promise<FilesystemStat>;
  exists(path: string): Promise<boolean>;
}
export interface ArtifactIO {
  fs: ArtifactFiles;
  db: ArtifactDatabase;
  lims: ArtifactRegistryIO;
}

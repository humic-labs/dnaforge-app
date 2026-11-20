import type {
  RelinkWorkspaceRootRequest,
  RelinkWorkspaceRootResult,
  WorkspaceRootStatus,
} from '../workspace-root-recovery';
import type {
  CreateEmptyWorkspaceRequest,
  CreateEmptyWorkspaceResult,
  ImportContentRequest,
  ImportFileRequest,
  ImportFileAsWorkspaceRequest,
  ImportFileResult,
  ImportManagedWorkspaceRequest,
  ImportManagedWorkspaceResult,
  ImportSequenceContentRequest,
  ImportSequenceContentResult,
  ManagedCatalogHeadIndex,
  ManagedCatalogHeadIndexRequest,
  WorkspaceEntityMigrationResult,
  ManagedHeadIndex,
  ManagedWorkspaceLifecycleRequest,
  ManagedWorkspaceLifecycleResult,
  ManagedWorkspaceRenameRequest,
  ManagedWorkspaceRenameResult,
  PurgeTrashedWorkspaceResult,
  RegisterImportedSequenceFromContentRequest,
  RegisterImportedSequenceRequest,
  RegisterImportedSequenceResult,
  SequenceImportPreviewRequest,
  SequenceImportPreviewResult,
  WorkspaceArtifactDiscoveryRequest,
  WorkspaceArtifactDiscoveryResult,
  ImportProgressEvent,
  ResolveProjectRootRequest,
  ResolvedProjectRoot,
} from '../workspace-git-types';
import type { DedupPreviewItem } from '../import-dedup';
import { defineGroup, invoke, event } from './contract';

export const workspaceContract = defineGroup('workspace', {
  onMigrationCandidatesChanged: event<[event: { workspaceRoot: string }]>().channel(
    'workspace:migrationCandidatesChanged'
  ),
  resolveProjectRoot: invoke<[request: ResolveProjectRootRequest], ResolvedProjectRoot>(),
  rootStatus: invoke<[], WorkspaceRootStatus[]>(),
  relinkRoot: invoke<[request: RelinkWorkspaceRootRequest], RelinkWorkspaceRootResult>(),
  importManaged: invoke<[request: ImportManagedWorkspaceRequest], ImportManagedWorkspaceResult>(),
  recoverLegacyPrimerLibrary: invoke<
    [],
    import('../legacy-primer-library-recovery').LegacyPrimerLibraryRecoveryResult
  >(),
  createEmptyWorkspace: invoke<
    [request: CreateEmptyWorkspaceRequest],
    CreateEmptyWorkspaceResult
  >(),
  importFile: invoke<[request: ImportFileRequest], ImportFileResult>(),
  importFileFromContent: invoke<[request: ImportContentRequest], ImportFileResult>(),
  importSequenceFromContent: invoke<
    [request: ImportSequenceContentRequest],
    ImportSequenceContentResult
  >(),
  importFolder: invoke<
    [
      request: {
        targetRoot: string;
        sourcePath: string;
      },
    ],
    ImportFileResult
  >(),
  previewImportDedup: invoke<
    [
      request: {
        sourcePaths: string[];
        targetRoot: string;
      },
    ],
    DedupPreviewItem[]
  >(),
  previewSequenceImport: invoke<
    [request: SequenceImportPreviewRequest],
    SequenceImportPreviewResult
  >(),
  importFileAsNewWorkspace: invoke<
    [request: ImportFileAsWorkspaceRequest],
    ImportManagedWorkspaceResult
  >(),
  registerImportedSequence: invoke<
    [request: RegisterImportedSequenceRequest],
    RegisterImportedSequenceResult
  >(),
  registerImportedSequenceFromContent: invoke<
    [request: RegisterImportedSequenceFromContentRequest],
    RegisterImportedSequenceResult
  >(),
  purgeTrashed: invoke<[request: { repoUuid: string }], PurgeTrashedWorkspaceResult>(),
  transitionLifecycle: invoke<
    [request: ManagedWorkspaceLifecycleRequest],
    ManagedWorkspaceLifecycleResult
  >(),
  rename: invoke<[request: ManagedWorkspaceRenameRequest], ManagedWorkspaceRenameResult>(),
  indexManagedHead: invoke<[request: { repoPath: string }], ManagedHeadIndex>(),
  indexManagedCatalogHead: invoke<
    [request: ManagedCatalogHeadIndexRequest],
    ManagedCatalogHeadIndex
  >(),
  discoverArtifacts: invoke<
    [request: WorkspaceArtifactDiscoveryRequest],
    WorkspaceArtifactDiscoveryResult
  >(),
  migrateLegacyProjectFiles: invoke<
    [request: { repoPath: string; mutationToken?: string }],
    WorkspaceEntityMigrationResult
  >(),
  onImportProgress: event<[event: ImportProgressEvent]>().channel('workspace:import-progress'),
});

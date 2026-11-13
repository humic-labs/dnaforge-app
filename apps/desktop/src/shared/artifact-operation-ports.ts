import type { WorkflowActionInput } from './workflow-operation';
import type {
  LimsEntity,
  LimsQueryEntitiesInput,
  LimsRegisterEntityInput,
  LimsUpdateEntityInput,
  LimsEntityActionInput,
} from './lims';
export type GitFileStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed';
export interface ArtifactHistoryPort {
  isGitRepo(dirPath: string, mutationToken?: string): Promise<boolean>;
  gitStatus(dirPath: string, mutationToken?: string): Promise<Map<string, GitFileStatus>>;
  gitCommitPaths(
    dirPath: string,
    message: string,
    files: string[],
    mutationToken?: string
  ): Promise<void>;
}
export interface WorkspaceMutationOptions {
  waitForAvailability?: boolean;
}
export type WorkspaceMutationRunner = <T>(
  workspaceRoot: string | null | undefined,
  operation: (mutationToken?: string) => Promise<T>,
  parentToken?: string,
  options?: WorkspaceMutationOptions
) => Promise<T>;
export interface CooperationOptions {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}
export type CooperativeYield = (iteration: number, options?: CooperationOptions) => Promise<void>;
export type CatalogNumberAllocator = (
  workspaceId: number,
  workspaceRoot?: string,
  mutationToken?: string
) => Promise<string>;

export type RegistryMutationOptions = Pick<
  WorkflowActionInput,
  'initiator' | 'workflowOrigin' | 'parentActionId'
> & { mutationToken?: string };
export interface ArtifactRegistryOperations {
  queryLimsEntities(input?: LimsQueryEntitiesInput): Promise<LimsEntity[]>;
  registerLimsEntity(
    input: LimsRegisterEntityInput,
    options?: RegistryMutationOptions
  ): Promise<LimsEntity>;
  updateLimsEntity(
    input: LimsUpdateEntityInput,
    options?: RegistryMutationOptions
  ): Promise<LimsEntity>;
  restoreLimsEntity(
    input: LimsEntityActionInput,
    options?: RegistryMutationOptions
  ): Promise<LimsEntity>;
}

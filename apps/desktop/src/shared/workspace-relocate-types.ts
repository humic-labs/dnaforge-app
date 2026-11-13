export interface RelocateEntityFileInput {
  workspaceRoot: string | null;

  oldPath: string;

  newPath: string;

  actor?: string;

  mutationToken?: string;
}

export interface RelocateEntityFileCounts {
  catalog: { updated: number };
  indexed: {
    indexedFilesMoved: number;
    staleIndexedFilesMerged: number;
    primerBindingsRepointed: number;
  };
  lims: { rebasedEntityIds: string[]; workspaceIds: Array<number | null> };
}

export interface RelocateEntityFileResult {
  newPath: string;
  counts: RelocateEntityFileCounts;
  warnings?: string[];
}

export const WORKSPACE_FILE_RELOCATED_EVENT = 'waypoint:workspace-file-relocated';

export interface WorkspaceFileRelocatedDetail {
  oldPath: string;
  newPath: string;
}

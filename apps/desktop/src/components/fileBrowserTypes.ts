export interface WorkspaceCreationContext {
  targetPath?: string | null;
  targetKind?: 'file' | 'folder' | null;
  parentPath?: string | null;
  workspaceRoot?: string | null;
  artifactFileName?: string | null;
  artifactTitle?: string | null;
}

export type WorkspaceCreateHandler = (context?: WorkspaceCreationContext) => void | Promise<void>;

export type PendingArtifactKind = 'notebook' | 'assembly' | 'dna-sequence' | 'text-file' | 'folder';

export interface PendingArtifactCreate {
  id: string;
  kind: PendingArtifactKind;
  parentPath: string;
  path: string;
  fileName: string;
  workspaceRoot: string | null;
  context: WorkspaceCreationContext;
  sequenceCreation?: import('../features/sequence/create-empty-dna-sequence').CapturedSequenceCreation;
}

export interface FileSelectionIntent {
  extend?: boolean;
  toggle?: boolean;
}

export interface FileSelectionContext {
  activeTargetKind?: 'file' | 'folder' | 'catalog' | null;
  activeFilesystemPath?: string | null;
}

export type SelectionChangeHandler = (
  selectedEntryIds: Set<string>,
  activeEntryId: string,
  anchorEntryId: string,
  context?: FileSelectionContext
) => void;
import type { FileEntry } from '../hooks/useFileBrowser';
import type { WorkspaceBrowserCatalogEntry } from '../shared/workspace-browser-types';

export type FileBrowserTreeEntry = FileEntry | WorkspaceBrowserCatalogEntry;

import type { CatalogRecordPresentationKind } from '../shared/catalog-entity';
import type { DocumentPackageKind } from '../shared/document-package';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';
export interface WorkspaceCreationContext {
  targetPath?: string | null;
  targetKind?: 'file' | 'folder' | null;
  parentPath?: string | null;
  workspaceRoot?: string | null;
  artifactFileName?: string | null;
  artifactTitle?: string | null;
}

export type WorkspaceCreateHandler = (context?: WorkspaceCreationContext) => void | Promise<void>;

export type PendingArtifactKind =
  | 'notebook'
  | 'assembly'
  | 'table'
  | 'dna-sequence'
  | 'text-file'
  | 'folder';

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

export interface FilesystemContextMenuState {
  kind: 'filesystem';
  x: number;
  y: number;
  entryId: string;
  path: string;
  relativePath: string | null;
  displayName: string;
  isDirectory: boolean;
  isNotebookPackage?: boolean;
  packageKind?: DocumentPackageKind;
  sequenceDocument?: ManagedSequenceDocumentRef;
  isRootFolder: boolean;
  pinned: boolean;
}

export interface CatalogContextMenuState {
  kind: 'catalog';
  x: number;
  y: number;
  entryId: string;
  workspaceId: number;
  entityId: string;
  sourceRecordId: string | null;
  displayName: string;
  presentationKind: CatalogRecordPresentationKind;
  workspaceRoot: string;
}

export type ContextMenuState = FilesystemContextMenuState | CatalogContextMenuState;

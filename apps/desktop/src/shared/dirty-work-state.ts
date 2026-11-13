export interface DirtyWorkItem {
  kind: string;
  id: string;
  nativeDocumentId?: string;
  filePath?: string;
}

export interface DirtyWorkState {
  hasDirtyWork: boolean;
  details: string;
  dirtyPageIds?: readonly string[];
  dirtySequenceDocumentIds?: readonly string[];
  dirtyTabIds?: readonly string[];
  dirtyFilePaths?: readonly string[];
  dirtyItems?: readonly DirtyWorkItem[];
}

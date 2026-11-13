export interface NotebookConflictComparison {
  documentId: string;
  title: string;
  token: string;
  fileText: string;
  applicationText: string;
  previewsTruncated: boolean;
  fileFingerprint: string;
  applicationFingerprint: string;
  baseFingerprint: string | null;
}
export interface NotebookConflictResolution {
  resolved: true;
  retainedPath: string;
  documentId: string;
  choice: 'file' | 'application';
}
export interface ResolveNotebookConflictRequest {
  documentId: string;
  token: string;
  choice: 'file' | 'application';
}

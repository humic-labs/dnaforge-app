import type {
  ManagedWorkspaceLargeFile,
  ManagedWorkspaceLargeFilePolicy,
} from './workspace-git-types';

export const LARGE_FILE_IMPORT_DIALOG_CANCEL_CHANNEL = 'workspace:large-file-import-cancel';

export interface LargeFileImportDialogRequest {
  requestId: string;
  files: ManagedWorkspaceLargeFile[];
  thresholdBytes: number;
}

export interface LargeFileImportDialogCancel {
  requestId: string;
}

export interface LargeFileImportDialogResponse {
  requestId: string;
  policy: ManagedWorkspaceLargeFilePolicy | 'cancel';
}

export type LargeFileImportDialogResponseChannel = `workspace:large-file-import-response:${string}`;

export function largeFileImportDialogResponseChannel(
  requestId: string
): LargeFileImportDialogResponseChannel {
  return `workspace:large-file-import-response:${requestId}`;
}

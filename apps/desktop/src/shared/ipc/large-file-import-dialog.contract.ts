import type {
  LargeFileImportDialogCancel,
  LargeFileImportDialogRequest,
} from '../large-file-import-dialog';
import { defineGroup, event } from './contract';

export const largeFileImportDialogContract = defineGroup('largeFileImportDialog', {
  onRequest: event<[payload: LargeFileImportDialogRequest]>().channel(
    'workspace:large-file-import-request'
  ),
  onCancel: event<[payload: LargeFileImportDialogCancel]>()
    .projected((payload) => payload.requestId)
    .channel('workspace:large-file-import-cancel'),
});

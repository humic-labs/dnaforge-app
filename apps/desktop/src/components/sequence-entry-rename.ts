import { userMessage } from '@waypoint/user-messages';
import type { FileEntry } from '../hooks/useFileBrowser';
import { openDocument } from '../features/document-opening/open-document';
import { requestManagedSequenceRename } from '../features/sequence/public/managed-sequence-rename';
import { useToastStore } from '../stores/toast-store';

export function beginSequenceEntryRename(
  entry: Pick<FileEntry, 'name' | 'packageKind' | 'sequenceDocument'>
): boolean {
  const document = entry.sequenceDocument;
  if (!document && entry.packageKind !== 'sequence') return false;
  const failed = (error?: unknown) => {
    if (error) console.error('[FileBrowser] Could not rename managed sequence:', error);
    useToastStore
      .getState()
      .addToast(userMessage('notice.could-not-open-this-sequence-for-renaming'), {
        definition: 'file-browser-could-not-open-sequence-for-renaming',
      });
  };
  if (!document) {
    failed();
    return true;
  }
  void openDocument({
    target: { kind: 'sequence-document', document },
    label: entry.name,
  })
    .then((result) => {
      if (result.status === 'presented') requestManagedSequenceRename(document.packageId);
      else if (result.status === 'failed') failed(result.message);
    })
    .catch(failed);
  return true;
}

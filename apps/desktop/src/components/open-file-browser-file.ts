import { toUserMessage } from '@waypoint/user-messages';
import type { DocumentPackageKind } from '../shared/document-package';
import type { TabType } from '../features/canvas/types';
import { useCanvasStore } from '../features/canvas/public/store';
import type { ManagedSequenceDocumentRef } from '../shared/managed-sequence-document';
import { resolveSequencePackageProductPath } from '../features/sequence/sequence-package-product';
import { scientificPackageMetaPath } from '../shared/scientific-package';
import { useToastStore } from '../stores/toast-store';
import { getTabTypeForFile } from '../utils/fileTypes';
import { tablePackagePaths } from '../shared/table-package';

export async function openFileBrowserFile(
  entry: {
    path: string;
    packageKind?: DocumentPackageKind;
    isNotebookPackage?: boolean;
    sequenceDocument?: ManagedSequenceDocumentRef;
  },
  present: (path: string, tabType: TabType) => void
): Promise<void> {
  try {
    const ref = entry.sequenceDocument;
    if (
      entry.packageKind === 'sequence' &&
      ref?.kind === 'managed-sequence' &&
      ref.packageRoot === entry.path
    ) {
      const canvas = useCanvasStore.getState();
      for (const panel of Object.values(canvas.panels)) {
        const existing = panel.tabs.find(
          (tab) =>
            tab.type === 'sequence' &&
            tab.entityId === ref.packageId &&
            tab.sequenceDocument?.kind === 'managed-sequence' &&
            tab.sequenceDocument.packageId === ref.packageId &&
            tab.sequenceDocument.packageRoot === ref.packageRoot
        );
        if (existing) {
          canvas.setActiveTab(panel.id, existing.id);
          break;
        }
      }
    }
    if (entry.packageKind === 'notebook' || entry.isNotebookPackage) {
      present(entry.path, 'page');
      return;
    }
    const path =
      entry.packageKind === 'sequence'
        ? await resolveSequencePackageProductPath(entry.path)
        : entry.packageKind === 'table'
          ? tablePackagePaths(entry.path).headPath
          : entry.packageKind === 'protocol' || entry.packageKind === 'protocol-run'
            ? scientificPackageMetaPath(entry.path, entry.packageKind)
            : entry.path;
    present(path, getTabTypeForFile(path));
  } catch (error) {
    useToastStore.getState().addToast(toUserMessage(error, 'operation.failed'), {
      definition: 'root-folder-couldn-t-open-the-plasmid-in-example-file',
    });
  }
}

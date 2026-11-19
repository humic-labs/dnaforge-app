import { isSourceDocumentMarkerPath } from '../../shared/source-document-package';
import type {
  ExternalPreviewReceipt,
  PromoteQuickLookPackageResult,
} from '../../shared/file-association-ipc';
import { sourceViewerTabId } from '../../lib/open-external-preview';
import { platform } from '../../platform';
import { useCanvasStore } from '../canvas/public/store';
import type { Tab } from '../canvas/public/types';
import { managedSequenceRepository } from '../sequence/public/managed-sequence-repository';
import { isPathInsideBoundary } from '../../shared/path-boundary';

export async function promotePreviewTab(
  receipt: ExternalPreviewReceipt,
  result: PromoteQuickLookPackageResult,
  tabId: string
): Promise<void> {
  const panel = Object.values(useCanvasStore.getState().panels).find((p) =>
    p.tabs.some((t) => t.id === tabId)
  );
  const tab = panel?.tabs.find((t) => t.id === tabId);
  if (!panel || !tab) return;
  if (
    tab.sourceFileView?.receipt?.packageId !== receipt.packageId &&
    !(
      receipt.sequence &&
      tab.quickLookSource?.contentHash === receipt.contentHash &&
      tab.quickLookSource.sourcePath === receipt.sourcePath
    )
  )
    return;

  async function target(tab: Tab) {
    const ref = tab.sequenceDocument;
    const ordinal =
      ref?.kind === 'managed-sequence' && tab.quickLookSource
        ? tab.quickLookSource.records.findIndex((record) =>
            isPathInsideBoundary(record.productPath, ref.packageRoot)
          )
        : (tab.sourceFileView?.selectedRecord ?? 0);
    const path =
      (result.records[Math.max(0, ordinal)] ?? result.records[0])?.destPath ?? result.destPath;
    if (isSourceDocumentMarkerPath(path)) {
      const doc = await platform().fileAssociations.describeProjectPreviewPackage({
        workspaceRoot: result.workspaceRoot,
        path,
      });
      if (doc.familyId !== 'fasta' && doc.familyId !== 'chromatogram')
        throw new Error('Unrecognized saved source package.');
      const sourceFileView = {
        location: 'project' as const,
        path: doc.entryPath,
        sourceFileName: doc.sourceFileName,
        format: doc.familyId,
        workspaceRoot: result.workspaceRoot,
        projectPackageId: doc.packageId,
        selectedRecord: ordinal,
      };
      return {
        identity: { type: 'file' as const, entityId: sourceViewerTabId(sourceFileView) },
        updates: { sourceFileView, label: doc.sourceFileName, readOnly: true },
      };
    }
    if (receipt.familyId === 'structure') {
      return {
        identity: { type: 'file' as const, entityId: `source-view:project:${path}` },
        updates: {
          label: receipt.sourceFileName,
          readOnly: true,
          sourceFileView: {
            path,
            format: 'structure' as const,
            location: 'project' as const,
            workspaceRoot: result.workspaceRoot,
          },
        },
      };
    }
    const promoted = await managedSequenceRepository.findByMemberPath(path);
    if (!promoted)
      throw new Error('The saved sequence package could not be resolved. Reopen it from Files.');
    return {
      identity: { type: 'sequence' as const, sequenceDocument: promoted.ref },
      updates: {
        readOnly: false,
        isDirty: false,
        label: promoted.document.name,
        sourceFileView: undefined,
        quickLookSource: undefined,
        sourceFileName: undefined,
        previewReceipt: undefined,
        loadStatus: 'loaded' as const,
      },
    };
  }
  const { identity, updates } = await target(tab);
  const current = useCanvasStore.getState();
  const active = Object.values(current.panels).find((p) =>
    p.tabs.some((t) => t.id === tabId && t.entityId === tab.entityId)
  );
  if (active) current.retargetTab(active.id, tabId, identity, updates);
}

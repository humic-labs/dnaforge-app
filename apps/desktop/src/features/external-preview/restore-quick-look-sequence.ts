import { releasePresentedPreview, syncPreviewTabs } from '../../lib/preview-tab-packages';
import { platform } from '../../platform';
import { isPathInsideBoundary } from '../../shared/path-boundary';
import { useCanvasStore } from '../canvas/public/store';
import type { Tab } from '../canvas/public/types';
import { managedSequenceRepository } from '../sequence/public/managed-sequence-repository';

export async function restoreQuickLookSequence(tab: Tab) {
  const previous = tab.quickLookSource;
  const ref = tab.sequenceDocument;
  if (!previous || ref?.kind !== 'managed-sequence')
    throw new Error('This preview has no recoverable sequence package.');
  const selected = previous.records.find((record) =>
    isPathInsideBoundary(record.productPath, ref.packageRoot)
  );
  if (!selected) throw new Error('This record is missing from the saved preview.');
  await syncPreviewTabs();
  const adopted = await platform().fileAssociations.adoptPreview({
    receipt: tab.previewReceipt ?? previous,
  });
  try {
    const record = adopted.sequence?.records[selected.ordinal];
    if (!record || !adopted.sequence)
      throw new Error('The saved preview no longer contains this record.');
    const resolved = await managedSequenceRepository.findByMemberPath(record.productPath);
    if (!resolved)
      throw new Error(
        'This preview package is missing. Reopen its original file from File → Open.'
      );
    if (
      tab.previewReceipt?.packageId !== adopted.packageId ||
      previous.packageRoot !== adopted.sequence.packageRoot ||
      ref.packageRoot !== resolved.ref.packageRoot
    ) {
      const { acquisitionId: _acquisition, ...durable } = adopted;
      const canvas = useCanvasStore.getState();
      const panel = Object.values(canvas.panels).find((p) =>
        p.tabs.some(
          (t) => t.id === tab.id && t.entityId === tab.entityId && t.quickLookSource === previous
        )
      );
      if (panel)
        canvas.retargetTab(
          panel.id,
          tab.id,
          { type: 'sequence', sequenceDocument: resolved.ref },
          {
            quickLookSource: adopted.sequence,
            previewReceipt: durable,
            sourceFileName: adopted.sourceFileName,
            readOnly: true,
          }
        );
    }
    return {
      ref: resolved.ref,
      documentId: resolved.document.id,
      sourcePath: resolved.productPath,
      name: resolved.document.name,
    };
  } finally {
    await releasePresentedPreview(adopted);
  }
}

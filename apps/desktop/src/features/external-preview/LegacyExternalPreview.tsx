import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { sourceViewForReceipt, type SourceViewerTab } from '../../lib/open-external-preview';
import { releasePresentedPreview } from '../../lib/preview-tab-packages';
import { platform } from '../../platform';
import { externalFormatForPath, externalPreviewFilters } from '../../shared/external-preview';
import { useCanvasStore } from '../canvas/public/store';

export function LegacyExternalPreview({ view, tabId }: { view: SourceViewerTab; tabId: string }) {
  const [path, setPath] = useState(view.path);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    async function upgrade() {
      setError('');
      if (externalFormatForPath(path) !== view.format)
        throw new Error('Choose the original file format.');
      const receipt = await platform().fileAssociations.openPreview({
        sourcePath: path,
        familyId: view.format,
      });
      try {
        if (!active) return;
        if (view.expectedSourceSha256 && view.expectedSourceSha256 !== receipt.contentHash)
          throw new Error('This file differs from the retained preview.');
        const state = useCanvasStore.getState();
        const panel = Object.values(state.panels).find((p) =>
          p.tabs.some((t) => t.id === tabId && t.sourceFileView === view)
        );
        if (!panel) return;
        state.retargetTab(
          panel.id,
          tabId,
          { type: 'file', entityId: `source-view:external:${receipt.packageId}` },
          {
            sourceFileView: sourceViewForReceipt(receipt),
            label: receipt.sourceFileName,
            readOnly: true,
          }
        );
      } finally {
        await releasePresentedPreview(receipt);
      }
    }
    void upgrade().catch(() => {
      if (active)
        setError('This older preview needs its original file. Choose it to restore the tab.');
    });
    return () => {
      active = false;
    };
  }, [path, attempt, view, tabId]);
  async function chooseFile() {
    try {
      const picked = await platform().dialog.open({
        multiple: false,
        title: 'Choose the original file',
        filters: externalPreviewFilters(),
      });
      const next = Array.isArray(picked) ? picked[0] : picked;
      if (next) {
        setPath(next);
        setAttempt((value) => value + 1);
      }
    } catch {
      setError('Could not choose the original file. Try again.');
    }
  }
  return (
    <div className="p-4 text-sm">
      <p role={error ? 'alert' : 'status'}>{error || 'Restoring preview…'}</p>
      {error && <Button onClick={() => void chooseFile()}>Choose original file…</Button>}
    </div>
  );
}

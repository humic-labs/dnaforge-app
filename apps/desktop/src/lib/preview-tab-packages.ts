import { useCanvasStore } from '../features/canvas/public/store';
import type { CanvasState } from '../features/canvas/types';
import { platform } from '../platform';
import type {
  ExternalPreviewReceipt,
  QuickLookPackageReceipt,
} from '../shared/file-association-ipc';

type Receipt = ExternalPreviewReceipt | QuickLookPackageReceipt;

export function referencedPreviewPackages(
  state: Pick<CanvasState, 'panels'> & Partial<Pick<CanvasState, 'recentlyClosed'>>
): Receipt[] {
  const receipts = new Map<string, Receipt>();
  const tabs = [
    ...Object.values(state.panels).flatMap((panel) => panel.tabs),
    ...(state.recentlyClosed ?? []).map((closed) => closed.tab),
  ];
  for (const tab of tabs) {
    const receipt = tab.sourceFileView?.receipt ?? tab.previewReceipt ?? tab.quickLookSource;
    if (!receipt) continue;
    const key = 'packageId' in receipt ? receipt.packageId : receipt.packageRoot;
    receipts.set(key, receipt);
  }
  return [...receipts.values()];
}

let pending = Promise.resolve();
let synced = '';

export function syncPreviewTabs(): Promise<void> {
  const run = pending.then(async () => {
    const receipts = referencedPreviewPackages(useCanvasStore.getState());
    const next = JSON.stringify(
      receipts
        .map((receipt) => ('packageId' in receipt ? receipt.packageId : receipt.packageRoot))
        .sort()
    );
    if (next === synced) return;
    await platform().fileAssociations.syncPreviewTabs({ ownerId: 'workspace-canvas', receipts });
    synced = next;
  });
  pending = run.catch(() => {});
  return run;
}

export function watchPreviewTabs(): () => void {
  function sync() {
    void syncPreviewTabs().catch((error: unknown) => console.error('[preview tabs]', error));
  }
  const unsubscribe = useCanvasStore.subscribe((state, previous) => {
    if (
      useCanvasStore.persist.hasHydrated() &&
      (state.panels !== previous.panels || state.recentlyClosed !== previous.recentlyClosed)
    )
      sync();
  });
  const hydrated = useCanvasStore.persist.onFinishHydration(sync);
  if (useCanvasStore.persist.hasHydrated()) sync();
  return () => {
    hydrated();
    unsubscribe();
  };
}

export async function releasePresentedPreview(receipt: ExternalPreviewReceipt): Promise<void> {
  await syncPreviewTabs();
  await platform().fileAssociations.releasePreview({ receipt });
}

export async function readRetainedPreview(receipt: ExternalPreviewReceipt) {
  await syncPreviewTabs();
  const adopted = await platform().fileAssociations.adoptPreview({ receipt });
  try {
    return await platform().fileAssociations.readPreviewPresentation({ receipt: adopted });
  } finally {
    await releasePresentedPreview(adopted);
  }
}

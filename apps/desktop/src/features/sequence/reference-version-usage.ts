import { platform } from '../../platform';
import { useCanvasStore } from '../canvas/public/store';
import type { Tab } from '../canvas/public/types';
import type { OpenReferenceVersionV1 } from '../../shared/reference-assets-ipc';

export function openReferenceVersions(tabs: readonly Tab[]): OpenReferenceVersionV1[] {
  const versions = tabs.flatMap((tab) => {
    const state = tab.indexedGenome;
    if (!state?.assembly) return [];
    const generationId =
      state.assemblyPortableBundleFingerprint ??
      state.sourcePath.match(/[/\\]generations[/\\]([^/\\]+)/)?.[1];
    return generationId ? [{ catalogId: state.assembly.assemblyId, generationId }] : [];
  });
  return [
    ...new Map(
      versions.map((version) => [`${version.catalogId}/${version.generationId}`, version])
    ).values(),
  ];
}

export function installReferenceVersionUsageTracking(): () => void {
  let disposed = false;
  let previous = '';
  let pending = Promise.resolve();
  const report = (): void => {
    if (disposed || !useCanvasStore.persist.hasHydrated()) return;
    const tabs = Object.values(useCanvasStore.getState().panels)
      .flatMap((panel) => panel.tabs)
      .filter((tab) => tab.indexedGenome?.assembly);
    const versions = openReferenceVersions(tabs);
    const serialized = JSON.stringify({ versions, tabIds: tabs.map((tab) => tab.id) });
    if (serialized === previous) return;
    previous = serialized;
    pending = pending
      .then(async () => {
        if (!disposed) await platform().referenceAssets.setOpenVersions?.(versions);
      })
      .catch((error) => {
        previous = '';
        console.warn('[reference-retention] Failed to publish open reference versions:', error);
      });
  };
  const unsubscribe = useCanvasStore.subscribe(report);
  const unsubscribeHydration = useCanvasStore.persist.onFinishHydration(report);
  report();
  return () => {
    disposed = true;
    unsubscribe();
    unsubscribeHydration();
  };
}

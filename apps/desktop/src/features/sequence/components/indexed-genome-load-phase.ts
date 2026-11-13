export type IndexedGenomePrepareStatus = 'preparing' | 'ready' | 'error';
export type IndexedGenomePrepareLoadPhase = 'indexing' | 'opening';
export type IndexedGenomeViewerLoadPhase = 'loading' | 'ready' | 'error';
export type LoadPhase = 'indexing' | 'opening' | 'loading-data' | 'ready' | 'error';

export function computeLoadPhase(input: {
  prepareStatus: IndexedGenomePrepareStatus;
  prepareLoadPhase: IndexedGenomePrepareLoadPhase;
  viewerLoadPhase: IndexedGenomeViewerLoadPhase;
  hasManifest: boolean;
}): LoadPhase {
  if (input.prepareStatus === 'error') return 'error';
  if (input.prepareStatus !== 'ready' || !input.hasManifest) {
    return input.prepareLoadPhase;
  }
  if (input.viewerLoadPhase === 'error') return 'error';
  if (input.viewerLoadPhase === 'loading') return 'loading-data';
  return 'ready';
}

import { create } from 'zustand';
import type { ImportDoorKind } from './components/LimsImportWizard';

interface LimsImportLaunchRequest {
  requestId: number;
  kind: ImportDoorKind | null;
  destinationPath: string | null;
}

interface LimsImportLaunchStore {
  request: LimsImportLaunchRequest | null;
  open: (request: Omit<LimsImportLaunchRequest, 'requestId'>) => void;
  consume: (requestId: number) => void;
}

export const useLimsImportLaunchStore = create<LimsImportLaunchStore>((set) => ({
  request: null,
  open: (request) => set({ request: { ...request, requestId: Date.now() } }),
  consume: (requestId) =>
    set((state) => (state.request?.requestId === requestId ? { request: null } : state)),
}));

export function openLimsImportFromSharedPicker(
  kind: ImportDoorKind | null,
  destinationPath: string | null
): void {
  useLimsImportLaunchStore.getState().open({ kind, destinationPath });
  window.dispatchEvent(new CustomEvent('waypoint:open-lims-registry'));
}

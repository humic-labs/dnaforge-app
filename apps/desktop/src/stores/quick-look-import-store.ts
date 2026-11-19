import { create } from 'zustand';
import type {
  PromoteQuickLookPackageResult,
  QuickLookPackageReceipt,
} from '../shared/file-association-ipc';

interface DurableQuickLookPromotion {
  readonly sourcePath: string;
  readonly contentHash: string;
  readonly result: PromoteQuickLookPackageResult;
}

type PromotionPhase = 'idle' | 'choosing' | 'promoting' | 'recoverable';

interface QuickLookImportState {
  requestId: number;
  tabId?: string;
  phase: PromotionPhase;
  begin: (requestId: number) => boolean;
  fail: (requestId: number) => void;
  request: QuickLookPackageReceipt | null;
  durablePromotion: DurableQuickLookPromotion | null;
  open: (receipt: QuickLookPackageReceipt, tabId?: string) => void;
  close: (requestId?: number) => void;
  rememberPromotion: (
    receipt: QuickLookPackageReceipt,
    result: PromoteQuickLookPackageResult,
    requestId?: number
  ) => void;
  finish: (requestId: number) => void;
}

export const useQuickLookImportStore = create<QuickLookImportState>((set, get) => ({
  requestId: 0,
  phase: 'idle',
  begin: (requestId) => {
    const state = get();
    if (state.requestId !== requestId || !state.request || state.phase === 'promoting')
      return false;
    set({ phase: 'promoting' });
    return true;
  },
  fail: (requestId) => {
    if (get().requestId === requestId) set({ phase: 'recoverable' });
  },
  request: null,
  durablePromotion: null,
  open: (request, tabId) =>
    set((state) => ({
      request,
      tabId,
      requestId: state.requestId + 1,
      phase: 'choosing',
      durablePromotion:
        state.durablePromotion?.sourcePath === request.sourcePath &&
        state.durablePromotion.contentHash === request.contentHash
          ? state.durablePromotion
          : null,
    })),
  close: (requestId) => {
    if (requestId !== undefined && get().requestId !== requestId) return;
    set({ request: null, phase: 'idle' });
  },
  rememberPromotion: (receipt, result, requestId) => {
    const state = get();
    if (state.request !== receipt || (requestId !== undefined && state.requestId !== requestId))
      return;
    set({
      durablePromotion: {
        sourcePath: receipt.sourcePath,
        contentHash: receipt.contentHash,
        result,
      },
    });
  },
  finish: (requestId) => {
    if (get().requestId !== requestId) return;
    set({ request: null, durablePromotion: null, phase: 'idle' });
  },
}));

export function requestQuickLookImport(receipt: QuickLookPackageReceipt, tabId: string): void {
  useQuickLookImportStore.getState().open(receipt, tabId);
}

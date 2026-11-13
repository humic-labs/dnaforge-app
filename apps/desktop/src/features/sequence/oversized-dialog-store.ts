import { create } from 'zustand';

export type OversizedDialogRequest =
  | {
      kind: 'warn';
      filePath: string;
      sizeBytes: number;
      resolve: (proceed: boolean) => void;
    }
  | {
      kind: 'block';
      filePath: string;
      sizeBytes: number;
      resolve: () => void;
    };

interface OversizedDialogStore {
  request: OversizedDialogRequest | null;
  requestWarn: (params: { filePath: string; sizeBytes: number }) => Promise<boolean>;
  requestBlock: (params: { filePath: string; sizeBytes: number }) => Promise<void>;
  resolveCurrent: (proceed: boolean) => void;
}

export const useOversizedDialogStore = create<OversizedDialogStore>((set, get) => ({
  request: null,

  requestWarn: ({ filePath, sizeBytes }) =>
    new Promise<boolean>((resolve) => {
      const prev = get().request;
      if (prev) {
        if (prev.kind === 'warn') prev.resolve(false);
        else prev.resolve();
      }
      set({ request: { kind: 'warn', filePath, sizeBytes, resolve } });
    }),

  requestBlock: ({ filePath, sizeBytes }) =>
    new Promise<void>((resolve) => {
      const prev = get().request;
      if (prev) {
        if (prev.kind === 'warn') prev.resolve(false);
        else prev.resolve();
      }
      set({ request: { kind: 'block', filePath, sizeBytes, resolve } });
    }),

  resolveCurrent: (proceed) => {
    const r = get().request;
    if (!r) return;
    if (r.kind === 'warn') r.resolve(proceed);
    else r.resolve();
    set({ request: null });
  },
}));

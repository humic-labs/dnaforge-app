import { toUserMessage, type UserMessage } from '@waypoint/user-messages';
import { create } from 'zustand';

export interface ConfirmRequest {
  title: UserMessage;
  message: UserMessage;
  confirmLabel?: UserMessage;
  cancelLabel?: UserMessage;
  showCloseButton?: boolean;
  tone?: 'default' | 'danger';
  safeDefault?: boolean;
  signal?: AbortSignal;
  input?: ConfirmInput;
  resolve: (confirmed: boolean, text?: string) => void;
}

export interface ConfirmInput {
  defaultValue: string;
  label?: UserMessage;
  maxLength?: number;
}

export type PromptRequest = Omit<ConfirmRequest, 'resolve' | 'input'> & { input: ConfirmInput };

interface ConfirmDialogStore {
  request: ConfirmRequest | null;
  confirm: (params: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>;
  prompt: (params: PromptRequest) => Promise<string | null>;
  resolveCurrent: (confirmed: boolean, text?: string) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogStore>((set, get) => {
  const open = (
    params: Omit<ConfirmRequest, 'resolve'>,
    settle: (confirmed: boolean, text?: string) => void
  ) => {
    if (params.signal?.aborted) {
      settle(false);
      return;
    }
    const prev = get().request;
    if (prev) prev.resolve(false);
    let settled = false;
    const finish = (confirmed: boolean, text?: string) => {
      if (settled) return;
      settled = true;
      params.signal?.removeEventListener('abort', onAbort);
      settle(confirmed, text);
    };
    const onAbort = () => {
      const current = get().request;
      if (current?.resolve === finish) set({ request: null });
      finish(false);
    };
    params.signal?.addEventListener('abort', onAbort, { once: true });
    set({
      request: {
        ...params,
        title: toUserMessage(params.title, 'dialog.confirmChange'),
        message: toUserMessage(params.message, 'operation.confirm'),
        ...(params.confirmLabel === undefined
          ? {}
          : { confirmLabel: toUserMessage(params.confirmLabel, 'dialog.continue') }),
        ...(params.cancelLabel === undefined
          ? {}
          : { cancelLabel: toUserMessage(params.cancelLabel, 'dialog.cancel') }),
        ...(params.input === undefined
          ? {}
          : {
              input: {
                ...params.input,
                ...(params.input.label === undefined
                  ? {}
                  : { label: toUserMessage(params.input.label, 'dialog.name') }),
              },
            }),
        resolve: finish,
      },
    });
  };

  return {
    request: null,

    confirm: (params) =>
      new Promise<boolean>((resolve) => open(params, (confirmed) => resolve(confirmed))),

    prompt: (params) =>
      new Promise<string | null>((resolve) =>
        open(params, (confirmed, text) => resolve(confirmed && text !== undefined ? text : null))
      ),

    resolveCurrent: (confirmed, text) => {
      const current = get().request;
      if (!current) return;
      set({ request: null });
      current.resolve(confirmed, text);
    },
  };
});

export function confirmDialog(params: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return useConfirmDialogStore.getState().confirm(params);
}

export function promptDialog(params: PromptRequest): Promise<string | null> {
  return useConfirmDialogStore.getState().prompt(params);
}

import { create } from 'zustand';
import { trackRendererEvent } from '../lib/analytics';
import {
  resolveUserMessage,
  userMessage,
  type UserMessage,
  type UserMessageInput,
} from '@waypoint/user-messages';
import {
  resolveToastDefinition,
  TOAST_BEHAVIOR,
  type ToastDefinitionId,
  type ToastSelection,
  type ToastType,
  type ToastDismissMode,
  type ToastTiming,
} from './toast-definitions';
export { TOAST_TYPES } from './toast-definitions';
export type { ToastType, ToastDismissMode } from './toast-definitions';
export type ToastPhase = 'visible' | 'exiting';
export type ToastPauseReason = 'pointer' | 'focus';
export const DEFAULT_TOAST_TYPE: ToastType = 'info';
export const DEFAULT_TOAST_DURATION_MS = TOAST_BEHAVIOR.duration;
export const TOAST_EXIT_DURATION_MS = TOAST_BEHAVIOR.exitDuration;
export const TOAST_LAYOUT_DURATION_MS = TOAST_BEHAVIOR.layoutDuration;
export const TOAST_DISMISS_REMOVE_DELAY_MS = TOAST_EXIT_DURATION_MS + TOAST_LAYOUT_DURATION_MS;

export interface ToastAction {
  label: string;

  onClick: (sourceElement?: HTMLElement) => unknown;
}
export interface Toast {
  id: string;
  message: UserMessage;
  type: ToastType;
  duration?: number;
  timing?: ToastTiming;
  dismissOn?: ToastDismissMode;
  phase?: ToastPhase;
  onDismiss?: () => void | Promise<void>;
  actions?: ToastAction[];
  progress?: { value: number; label: UserMessage };
  definition?: ToastDefinitionId;
  variant?: string;
  group?: string;
  groupExit?: 'remove' | 'dismiss';
  expiresAt?: number;
  remainingMs?: number;
  pauseReasons?: ToastPauseReason[];
  pauseOnInteraction?: boolean;
  closeButton?: boolean;
  actionDismisses?: boolean;
  preview?: boolean;
}
type ToastProgressInput = { value: number; label: UserMessageInput };
type LegacyToastInput = Omit<Toast, 'id' | 'message' | 'progress'> & {
  message: UserMessageInput;
  progress?: ToastProgressInput;
};
export interface CatalogToastInput extends ToastSelection {
  message?: UserMessageInput;
  actions?: ToastAction[];
  progress?: ToastProgressInput;
  onDismiss?: Toast['onDismiss'];
  preview?: boolean;
}
interface ToastStore {
  toasts: Toast[];
  addToast: (
    message: UserMessageInput,
    selection?: ToastSelection | ToastType,
    duration?: number
  ) => string;
  addRichToast: (toast: CatalogToastInput | LegacyToastInput) => string;
  updateToastProgress: (id: string, percent: number) => void;
  dismissToast: (id: string) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
  clearToastGroup: (group: string) => void;
  pauseToast: (id: string, reason: ToastPauseReason) => void;
  resumeToast: (id: string, reason: ToastPauseReason) => void;
  invokeToastAction: (id: string, index: number, sourceElement?: HTMLElement) => void;
}
let nextId = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const shownKeys = new Map<string, { id: string; group?: string; keyScope?: 'session' | 'group' }>();
const invokedActions = new Set<string>();
function cancelTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}
function scheduleTimer(id: string, delay: number, callback: () => void): void {
  cancelTimer(id);
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      callback();
    }, delay)
  );
}
export function toastRemainingMs(toast: Toast, now = Date.now()): number {
  if (toast.phase === 'exiting') return 0;
  if (toast.pauseReasons?.length) return toast.remainingMs ?? 0;
  return toast.expiresAt === undefined ? 0 : Math.max(0, toast.expiresAt - now);
}
function notifyToastDismissed(toast: Toast): void {
  if (!toast.onDismiss) return;
  try {
    void Promise.resolve(toast.onDismiss()).catch((error: unknown) =>
      console.error('[Toast] onDismiss failed:', error)
    );
  } catch (error) {
    console.error('[Toast] onDismiss failed:', error);
  }
}
export const useToastStore = create<ToastStore>((set, get) => {
  const add = (input: CatalogToastInput | LegacyToastInput): string => {
    const policy = input.definition ? resolveToastDefinition(input as CatalogToastInput) : null;
    const key =
      !input.preview && policy?.oncePerKey && 'key' in input && input.key
        ? input.definition + ':' + input.key
        : null;
    const remembered = key ? shownKeys.get(key) : undefined;
    if (remembered) return remembered.id;
    for (const definition of policy?.clearsKeys ?? []) {
      if (!input.preview)
        for (const remembered of shownKeys.keys()) {
          if (remembered.startsWith(definition + ':')) shownKeys.delete(remembered);
        }
    }
    const groupName = (group: string) => (input.preview ? 'review:' + group : group);
    for (const group of policy?.clearsGroups ?? []) get().clearToastGroup(groupName(group));
    if (policy?.group) get().clearToastGroup(groupName(policy.group));
    const id = `toast-${++nextId}`;
    const legacy = input as LegacyToastInput;
    const duration = policy?.duration ?? legacy.duration ?? DEFAULT_TOAST_DURATION_MS;
    const toast: Toast = {
      ...input,
      id,
      message: resolveUserMessage(
        input.message ?? policy?.message ?? userMessage('operation.failed')
      ),
      progress: input.progress
        ? {
            ...input.progress,
            label: resolveUserMessage(input.progress.label, 'operation.attention'),
          }
        : undefined,
      type: policy?.type ?? legacy.type ?? DEFAULT_TOAST_TYPE,
      duration,
      timing: policy?.timing,
      dismissOn: policy?.dismissOn ?? legacy.dismissOn ?? TOAST_BEHAVIOR.dismissOn,
      pauseOnInteraction: policy?.pauseOnInteraction ?? TOAST_BEHAVIOR.pauseOnInteraction,
      closeButton: policy?.closeButton ?? TOAST_BEHAVIOR.closeButton,
      actionDismisses: policy?.actionDismisses ?? TOAST_BEHAVIOR.actionDismisses,
      group: policy?.group ? groupName(policy.group) : undefined,
      groupExit: policy?.groupExit,
      phase: 'visible',
      expiresAt: duration > 0 ? Date.now() + duration : undefined,
      remainingMs: duration > 0 ? duration : undefined,
      pauseReasons: [],
    };
    if (key) shownKeys.set(key, { id, group: toast.group, keyScope: policy?.keyScope });
    set((state) => ({ toasts: [...state.toasts, toast] }));
    if (!input.preview && (toast.type === 'error' || toast.type === 'warning')) {
      try {
        trackRendererEvent('user_notification_observed', {
          feature_area: 'reliability',
          notification_id: crypto.randomUUID(),
          occurred_at_ms: Date.now(),
          notification_definition: toast.definition ?? 'uncatalogued',
          notification_variant: toast.variant ?? 'default',
          notification_severity: toast.type,
        });
      } catch {}
    }
    if (duration > 0) scheduleTimer(id, duration, () => get().dismissToast(id));
    return id;
  };
  return {
    toasts: [],
    addToast: (message, selection = DEFAULT_TOAST_TYPE, duration = DEFAULT_TOAST_DURATION_MS) =>
      typeof selection === 'string'
        ? add({ message, type: selection, duration })
        : add({ ...selection, message }),
    addRichToast: add,
    updateToastProgress: (id, percent) => {
      if (!Number.isFinite(percent)) return;
      const value = Math.round(Math.max(0, Math.min(100, percent)));
      set((state) => ({
        toasts: state.toasts.map((toast) =>
          toast.id === id && toast.phase !== 'exiting' && toast.progress
            ? { ...toast, progress: { ...toast.progress, value } }
            : toast
        ),
      }));
    },
    dismissToast: (id) => {
      const toast = get().toasts.find((t) => t.id === id);
      if (!toast || toast.phase === 'exiting') return;
      cancelTimer(id);
      set((state) => ({
        toasts: state.toasts.map((t) => (t.id === id ? { ...t, phase: 'exiting' } : t)),
      }));
      scheduleTimer(id, TOAST_DISMISS_REMOVE_DELAY_MS, () => get().removeToast(id));
      notifyToastDismissed(toast);
    },
    removeToast: (id) => {
      cancelTimer(id);
      invokedActions.delete(id);
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    },
    clearToasts: () => {
      for (const id of timers.keys()) cancelTimer(id);
      shownKeys.clear();
      invokedActions.clear();
      set({ toasts: [] });
    },
    clearToastGroup: (group) => {
      for (const [key, remembered] of shownKeys) {
        if (remembered.group === group && remembered.keyScope === 'group') shownKeys.delete(key);
      }
      for (const toast of get().toasts)
        if (toast.group === group) {
          if (toast.groupExit === 'dismiss') get().dismissToast(toast.id);
          else get().removeToast(toast.id);
        }
    },
    pauseToast: (id, reason) => {
      const toast = get().toasts.find((t) => t.id === id);
      if (
        !toast ||
        toast.phase === 'exiting' ||
        !toast.duration ||
        !toast.pauseOnInteraction ||
        toast.pauseReasons?.includes(reason)
      )
        return;
      const remainingMs = toastRemainingMs(toast);
      cancelTimer(id);
      set((state) => ({
        toasts: state.toasts.map((t) =>
          t.id === id
            ? {
                ...t,
                remainingMs,
                expiresAt: undefined,
                pauseReasons: [...(t.pauseReasons ?? []), reason],
              }
            : t
        ),
      }));
    },
    resumeToast: (id, reason) => {
      const toast = get().toasts.find((t) => t.id === id);
      if (!toast || toast.phase === 'exiting' || !toast.pauseReasons?.includes(reason)) return;
      const pauseReasons = toast.pauseReasons.filter((r) => r !== reason);
      const remainingMs = toast.remainingMs ?? 0;
      set((state) => ({
        toasts: state.toasts.map((t) =>
          t.id === id
            ? {
                ...t,
                pauseReasons,
                expiresAt: pauseReasons.length ? undefined : Date.now() + remainingMs,
              }
            : t
        ),
      }));
      if (!pauseReasons.length) scheduleTimer(id, remainingMs, () => get().dismissToast(id));
    },
    invokeToastAction: (id, index, sourceElement) => {
      const toast = get().toasts.find((t) => t.id === id);
      const action = toast?.actions?.[index];
      if (!toast || toast.phase === 'exiting' || !action || invokedActions.has(id)) return;
      invokedActions.add(id);
      try {
        void Promise.resolve(
          sourceElement ? action.onClick(sourceElement) : action.onClick()
        ).catch((error) => console.error('[Toast] action failed:', error));
      } catch (error) {
        console.error('[Toast] action failed:', error);
      }
      if (toast.actionDismisses !== false) get().dismissToast(id);
      else invokedActions.delete(id);
    },
  };
});

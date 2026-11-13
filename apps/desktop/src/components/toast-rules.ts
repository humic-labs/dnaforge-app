import type { CSSProperties } from 'react';

import {
  TOAST_EXIT_DURATION_MS,
  TOAST_LAYOUT_DURATION_MS,
  type Toast,
  type ToastType,
} from '../stores/toast-store';

export const TOAST_STACK_GAP_PX = 8;

export const TOAST_CONTAINER_CLASS_NAME =
  'pointer-events-none fixed right-4 bottom-4 z-[9999] flex w-[min(calc(100vw-2rem),24rem)] max-w-sm flex-col';

export const TOAST_STACK_ITEM_CLASS_NAME = 'grid min-h-0 overflow-hidden';

export const TOAST_STACK_ITEM_CONTENT_CLASS_NAME =
  'min-h-0 max-w-full justify-self-end overflow-hidden';

export const TOAST_BASE_CLASS_NAME =
  'pointer-events-auto relative flex flex-col gap-1 overflow-hidden rounded-md border px-3 py-2 text-xs leading-snug animate-slide-in-up';

export const TOAST_EXITING_CLASS_NAME = 'pointer-events-none';

export const TOAST_MESSAGE_ROW_CLASS_NAME = 'flex items-start gap-2';

export const TOAST_ACTION_ROW_CLASS_NAME = 'pointer-events-none flex flex-wrap items-center gap-2';

export const TOAST_DISMISS_HINT_CLASS_NAME =
  'pointer-events-none ml-auto rounded py-0.5 text-[11px] font-medium opacity-70';

export const TOAST_DISMISS_BUTTON_CLASS_NAME =
  'pointer-events-auto -mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-sm leading-none text-current opacity-55 hover:bg-current/10 hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current';

export interface ToastTypeRule {
  className: string;
  actionClassName: string;
  role: 'status' | 'alert';
}

export const TOAST_TYPE_RULES: Record<ToastType, ToastTypeRule> = {
  info: {
    className: 'border-border-hover bg-bg-subtle/95 text-fg',
    actionClassName:
      'pointer-events-auto rounded border border-border-hover px-2 py-1 text-[11px] font-medium text-accent/70 hover:bg-bg-muted hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
    role: 'status',
  },
  success: {
    className:
      'border-green-300 bg-green-50 text-green-900 dark:border-green-700/50 dark:bg-green-950/90 dark:text-green-100',
    actionClassName:
      'pointer-events-auto rounded border border-green-400/60 px-2 py-1 text-[11px] font-medium text-green-800 hover:bg-green-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-500 dark:border-green-500/35 dark:text-green-100 dark:hover:bg-green-500/15 dark:focus-visible:outline-green-300',
    role: 'status',
  },
  warning: {
    className:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/50 dark:bg-[color-mix(in_srgb,theme(colors.amber.300)_25%,hsl(var(--color-bg-subtle)))] dark:text-amber-100',
    actionClassName:
      'pointer-events-auto rounded border border-amber-400/60 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500 dark:border-amber-500/35 dark:text-amber-100 dark:hover:bg-amber-500/15 dark:focus-visible:outline-amber-300',
    role: 'alert',
  },
  error: {
    className:
      'border-red-300 bg-red-50 text-red-900 dark:border-red-700/50 dark:bg-red-950/90 dark:text-red-100',
    actionClassName:
      'pointer-events-auto rounded border border-red-400/60 px-2 py-1 text-[11px] font-medium text-red-800 hover:bg-red-500/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500 dark:border-red-500/35 dark:text-red-100 dark:hover:bg-red-500/15 dark:focus-visible:outline-red-300',
    role: 'alert',
  },
};

export function toastStackItemStyle(toast: Toast, index: number): CSSProperties {
  const isExiting = toast.phase === 'exiting';
  return {
    gridTemplateRows: isExiting ? '0fr' : '1fr',
    marginTop: index === 0 || isExiting ? 0 : TOAST_STACK_GAP_PX,
    transition: `grid-template-rows ${TOAST_LAYOUT_DURATION_MS}ms ease-out ${TOAST_EXIT_DURATION_MS}ms, margin-top ${TOAST_LAYOUT_DURATION_MS}ms ease-out ${TOAST_EXIT_DURATION_MS}ms`,
  };
}

export function toastSurfaceStyle(toast: Toast): CSSProperties {
  return {
    opacity: toast.phase === 'exiting' ? 0 : 1,
    transition: `opacity ${TOAST_EXIT_DURATION_MS}ms ease-out`,
  };
}

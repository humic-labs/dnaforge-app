import { toUserMessage } from '@waypoint/user-messages';
import { useEffect } from 'react';
import { useToastStore } from '../stores/toast-store';
import { ToastCountdown } from './ToastCountdown';
import {
  toastStackItemStyle,
  toastSurfaceStyle,
  TOAST_ACTION_ROW_CLASS_NAME,
  TOAST_BASE_CLASS_NAME,
  TOAST_CONTAINER_CLASS_NAME,
  TOAST_DISMISS_HINT_CLASS_NAME,
  TOAST_DISMISS_BUTTON_CLASS_NAME,
  TOAST_EXITING_CLASS_NAME,
  TOAST_MESSAGE_ROW_CLASS_NAME,
  TOAST_STACK_ITEM_CLASS_NAME,
  TOAST_STACK_ITEM_CONTENT_CLASS_NAME,
  TOAST_TYPE_RULES,
} from './toast-rules';

type ToastStore = ReturnType<typeof useToastStore.getState>;
type ToastTestWindow = Window & {
  __waypoint_addToast?: ToastStore['addToast'];
  __waypoint_addRichToast?: ToastStore['addRichToast'];
  __waypoint_clearToasts?: ToastStore['clearToasts'];
};

function toastTestWindow(): ToastTestWindow {
  return window as ToastTestWindow;
}

function useTestHook() {
  const addToast = useToastStore((s) => s.addToast);
  const addRichToast = useToastStore((s) => s.addRichToast);
  const clearToasts = useToastStore((s) => s.clearToasts);
  useEffect(() => {
    const testWindow = toastTestWindow();
    testWindow.__waypoint_addToast = addToast;
    testWindow.__waypoint_addRichToast = addRichToast;
    testWindow.__waypoint_clearToasts = clearToasts;
    return () => {
      delete testWindow.__waypoint_addToast;
      delete testWindow.__waypoint_addRichToast;
      delete testWindow.__waypoint_clearToasts;
    };
  }, [addToast, addRichToast, clearToasts]);
}

export function ToastContainer() {
  useTestHook();
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);
  const pauseToast = useToastStore((s) => s.pauseToast);
  const resumeToast = useToastStore((s) => s.resumeToast);
  const invokeToastAction = useToastStore((s) => s.invokeToastAction);

  if (toasts.length === 0) return null;

  return (
    <div data-testid="toast-container" className={TOAST_CONTAINER_CLASS_NAME}>
      {toasts.map((toast, index) => {
        const rules = TOAST_TYPE_RULES[toast.type];
        const hasCountdown =
          Boolean(toast.duration && toast.duration > 0) &&
          (toast.expiresAt !== undefined || Boolean(toast.pauseReasons?.length));
        return (
          <div
            key={toast.id}
            data-testid="toast-stack-item"
            data-toast-phase={toast.phase ?? 'visible'}
            className={TOAST_STACK_ITEM_CLASS_NAME}
            style={toastStackItemStyle(toast, index)}
          >
            <div className={TOAST_STACK_ITEM_CONTENT_CLASS_NAME}>
              <div
                data-testid={`toast-${toast.type}`}
                role={rules.role}
                data-toast-dismiss-on={toast.dismissOn ?? 'control'}
                data-toast-phase={toast.phase ?? 'visible'}
                data-toast-definition={toast.definition}
                data-toast-variant={toast.variant ?? 'default'}
                data-toast-duration={toast.duration}
                data-toast-timing={toast.timing}
                onMouseEnter={() => pauseToast(toast.id, 'pointer')}
                onMouseLeave={() => resumeToast(toast.id, 'pointer')}
                onFocusCapture={() => pauseToast(toast.id, 'focus')}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    resumeToast(toast.id, 'focus');
                  }
                }}
                onClick={toast.dismissOn === 'surface' ? () => dismissToast(toast.id) : undefined}
                className={`${TOAST_BASE_CLASS_NAME} ${rules.className} ${
                  toast.dismissOn === 'surface' ? 'cursor-pointer' : ''
                } ${toast.phase === 'exiting' ? TOAST_EXITING_CLASS_NAME : ''}`}
                style={toastSurfaceStyle(toast)}
              >
                <div className={TOAST_MESSAGE_ROW_CLASS_NAME}>
                  <span className="min-w-0 flex-1">
                    {toUserMessage(toast.message, 'operation.failed')}
                  </span>
                  {toast.closeButton !== false && (
                    <button
                      type="button"
                      data-testid="toast-dismiss"
                      aria-label="Dismiss notification"
                      onClick={(event) => {
                        event.stopPropagation();
                        dismissToast(toast.id);
                      }}
                      className={TOAST_DISMISS_BUTTON_CLASS_NAME}
                    >
                      ×
                    </button>
                  )}
                </div>
                {toast.progress && (
                  <div className="flex w-64 max-w-full items-center gap-2 py-1">
                    <div
                      role="progressbar"
                      aria-label={toUserMessage(toast.progress.label, 'update.downloadProgress')}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={toast.progress.value}
                      className="h-1.5 flex-1 overflow-hidden rounded-full bg-fg/10"
                    >
                      <div
                        className="h-full rounded-full bg-accent transition-[width]"
                        style={{ width: `${toast.progress.value}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-fg-muted">{toast.progress.value}%</span>
                  </div>
                )}
                {((toast.actions && toast.actions.length > 0) ||
                  toast.dismissOn === 'surface' ||
                  hasCountdown) && (
                  <div className={TOAST_ACTION_ROW_CLASS_NAME}>
                    {toast.actions?.map((action, actionIndex) => (
                      <button
                        type="button"
                        key={action.label}
                        onClick={(event) => {
                          event.stopPropagation();
                          invokeToastAction(toast.id, actionIndex, event.currentTarget);
                        }}
                        className={rules.actionClassName}
                      >
                        {action.label}
                      </button>
                    ))}
                    {hasCountdown ? (
                      <ToastCountdown toast={toast} />
                    ) : toast.dismissOn === 'surface' ? (
                      <span
                        data-testid="toast-dismiss-hint"
                        className={TOAST_DISMISS_HINT_CLASS_NAME}
                      >
                        Click to dismiss
                      </span>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

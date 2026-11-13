import { useEffect, useState } from 'react';
import { TOAST_BEHAVIOR } from '../stores/toast-definitions';
import { toastRemainingMs, useToastStore, type Toast } from '../stores/toast-store';

export function ToastCountdown({ toast }: { toast: Toast }) {
  const [, setNow] = useState(Date.now);
  const dismissToast = useToastStore((s) => s.dismissToast);
  const paused = Boolean(toast.pauseReasons?.length);
  useEffect(() => {
    if (paused || toast.phase === 'exiting') return;
    const refresh = setInterval(() => setNow(Date.now()), TOAST_BEHAVIOR.countdownLabelRefresh);
    return () => clearInterval(refresh);
  }, [paused, toast.phase]);
  const remaining = toastRemainingMs(toast);
  return (
    <span
      data-testid="toast-countdown"
      data-remaining-ms={remaining}
      data-paused={paused}
      className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] opacity-70"
    >
      <button
        type="button"
        data-testid="toast-dismiss-hint"
        aria-label="Dismiss notification now"
        className="pointer-events-auto rounded py-0.5 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
        onClick={(event) => {
          event.stopPropagation();
          dismissToast(toast.id);
        }}
      >
        Click to dismiss
      </button>
      <span data-testid="toast-countdown-seconds" className="tabular-nums" aria-hidden="true">
        {Math.ceil(remaining / 1000)}s{paused ? ' · Paused' : ''}
      </span>
    </span>
  );
}

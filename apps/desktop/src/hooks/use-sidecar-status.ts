import { useEffect, useRef, useState } from 'react';
import { platform } from '../platform';

const RECONCILE_INTERVAL_MS = 1000;

export function useSidecarStatus(initial = 'starting'): string {
  const [status, setStatus] = useState<string>(initial);
  const statusRef = useRef(status);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    const applyStatus = (next: string) => {
      statusRef.current = next;
      setStatus(next);
    };

    const reconcile = () => {
      if (statusRef.current === 'ready') return;

      try {
        const p = platform();

        p.config
          ?.getSidecarStatus?.()
          .then((s) => {
            if (!cancelled && s) applyStatus(s);
          })
          .catch(() => undefined);
      } catch {
        return;
      }
    };

    reconcile();

    try {
      const p = platform();

      if (p?.on) {
        unsubscribe = p.on('sidecar:status', (...args: unknown[]) => {
          applyStatus(args[0] as string);
        });
      }
    } catch {
      unsubscribe = undefined;
    }

    const interval = window.setInterval(reconcile, RECONCILE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      unsubscribe?.();
    };
  }, []);

  return status;
}

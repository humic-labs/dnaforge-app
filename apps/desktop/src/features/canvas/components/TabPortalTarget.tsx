import { useRef, useLayoutEffect } from 'react';
import { REPLAY_BLOCKED_ATTRIBUTES } from '../../../components/TelemetryBlockedSurface';
import type { Tab } from '../types';
import {
  TAB_PORTAL_HOST_ATTACHED_EVENT,
  TAB_PORTAL_HOST_DETACHING_EVENT,
} from '../../../shared/tab-portal-contract';
import { useTabPortalHost } from './TabContentPortalManager';

export { TAB_PORTAL_HOST_ATTACHED_EVENT } from '../../../shared/tab-portal-contract';

interface TabPortalTargetProps {
  tab: Tab | null;
}

export function TabPortalTarget({ tab }: TabPortalTargetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const host = useTabPortalHost(tab?.id ?? null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const detail = { tabId: tab?.id ?? null };

    if (host) {
      if (host.parentNode && host.parentNode !== container) {
        host.dispatchEvent(new CustomEvent(TAB_PORTAL_HOST_DETACHING_EVENT, { detail }));
      }
      container.appendChild(host);
      host.dispatchEvent(
        new CustomEvent(TAB_PORTAL_HOST_ATTACHED_EVENT, {
          bubbles: true,
          detail,
        })
      );
      window.dispatchEvent(new CustomEvent(TAB_PORTAL_HOST_ATTACHED_EVENT, { detail }));
    }

    return () => {
      if (host?.parentNode === container) {
        host.dispatchEvent(new CustomEvent(TAB_PORTAL_HOST_DETACHING_EVENT, { detail }));
        container.removeChild(host);
      }
    };
  }, [host, tab?.id]);

  return (
    <div
      ref={containerRef}
      data-testid="tab-portal-target"
      {...REPLAY_BLOCKED_ATTRIBUTES}
      className="h-full w-full overflow-hidden"
    />
  );
}

import { toUserMessage, withUserMessage } from '@waypoint/user-messages';
import { useEffect, useRef, useState } from 'react';
import {
  isEntityNavigationUrl,
  parseEntityNavigationUrl,
  type EntityNavigationTarget,
} from '../shared/entity-navigation';
import { openEntityNavigationTarget } from '../services/entity-navigation';
import { useToastStore } from '../stores/toast-store';

export function useEntityNavigation(ready: boolean): void {
  const [started, setStarted] = useState(false);
  const processing = useRef(Promise.resolve());
  useEffect(() => {
    if (ready) setStarted(true);
  }, [ready]);
  useEffect(() => {
    if (!started) return;
    const api = window.electronAPI?.entityNavigation;
    if (!api) return;
    let disposed = false;
    const report = (error: unknown) =>
      useToastStore
        .getState()
        .addToast(toUserMessage(error, 'failure.the-entity-could-not-be-opened'), {
          definition: 'file-open-failed',
        });
    const receive = (targets: EntityNavigationTarget[]) => {
      processing.current = processing.current.then(async () => {
        for (const target of targets) {
          if (disposed) return;
          try {
            await openEntityNavigationTarget(target);
          } catch (error) {
            report(error);
          }
        }
      });
    };
    const followLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const href = anchor?.getAttribute('href');
      if (!href || !isEntityNavigationUrl(href)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = parseEntityNavigationUrl(href);
      if (target) receive([target]);
      else report(withUserMessage(new Error('Invalid DNAForge entity link.'), 'link.invalid'));
    };
    document.addEventListener('click', followLink, true);
    const unsubscribe = api.onOpen(receive);
    void api.takePending().then(receive).catch(report);
    return () => {
      disposed = true;
      document.removeEventListener('click', followLink, true);
      unsubscribe();
    };
  }, [started]);
}

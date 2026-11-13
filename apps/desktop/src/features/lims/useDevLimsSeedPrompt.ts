import { toUserMessage, userMessage } from '@waypoint/user-messages';
import { useEffect } from 'react';

import { platform } from '../../platform';
import { DEV_LIMS_SEED_STORAGE_KEY, DEV_LIMS_SEED_VERSION } from '../../shared/lims-dev-seed';
import { useToastStore } from '../../stores/toast-store';
import { seedLimsMockDemo } from './operations';

let devLimsSeedPromptShown = false;

export function useDevLimsSeedPrompt(): void {
  useEffect(() => {
    if (import.meta.env.DEV !== true) return;
    if (!platform().runtime.getProfile().scenarioMutationAllowed) return;
    if (typeof navigator !== 'undefined' && navigator.webdriver) return;
    if (devLimsSeedPromptShown) return;

    let stored = 0;
    try {
      stored = Number(localStorage.getItem(DEV_LIMS_SEED_STORAGE_KEY) ?? '0') || 0;
    } catch {
      return;
    }
    if (stored === DEV_LIMS_SEED_VERSION) return;

    devLimsSeedPromptShown = true;
    const toast = useToastStore.getState();
    const id = toast.addRichToast({
      definition: 'dev-registry-seed',
      message:
        stored === 0
          ? userMessage('notice.dev-load-the-default-lims-registry-mock-primers')
          : userMessage(
              'notice.dev-the-lims-seed-changed-reseed-demo-data-your-hand-made-rows-are-kep'
            ),
      actions: [
        {
          label: 'Reseed',
          onClick: () => {
            void (async () => {
              try {
                await seedLimsMockDemo({
                  actor: 'local-user',
                  reset: true,
                  resetScope: 'dev-seed',
                });
                try {
                  localStorage.setItem(DEV_LIMS_SEED_STORAGE_KEY, String(DEV_LIMS_SEED_VERSION));
                } catch {}
                toast.removeToast(id);
                toast.addToast(
                  userMessage('notice.dev-lims-registry-reseeded-reopen-the-lims-panel-to-view'),
                  {
                    definition:
                      'use-dev-lims-seed-prompt-dev-lims-registry-reseeded-reopen-the-lims-panel-to-view',
                  }
                );
              } catch (err) {
                toast.addToast(toUserMessage(err, 'operation.failed'), {
                  definition: 'use-dev-lims-seed-prompt-reseed-failed',
                });
              }
            })();
          },
        },
        { label: 'Not now', onClick: () => toast.removeToast(id) },
      ],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

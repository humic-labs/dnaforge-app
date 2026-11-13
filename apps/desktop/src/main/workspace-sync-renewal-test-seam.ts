import { app } from 'electron';

import { performRefresh } from './auth/controller';
import { createDesktopSyncClient } from './desktop-sync-client';
import {
  createWorkspaceSyncClaimClient,
  type WorkspaceSyncActionDeps,
} from './workspace-sync-actions';

export const workspaceSyncRenewalTestSeam = {
  switchToAccountId: null as string | null,
  hits: 0,
  enabled(): boolean {
    return !app.isPackaged && process.env.NODE_ENV === 'test';
  },
  actionDeps(): Pick<WorkspaceSyncActionDeps, 'createClaimClient'> {
    if (!this.enabled()) return {};
    return {
      createClaimClient: (deviceId) =>
        createWorkspaceSyncClaimClient(
          deviceId,
          createDesktopSyncClient({
            performRefresh: async () => {
              const outcome = await performRefresh();
              const target = this.switchToAccountId;
              if (target !== null) {
                this.switchToAccountId = null;
                this.hits += 1;
                const { setActiveAccount } = await import('./auth/session-store');
                await setActiveAccount(target);
              }
              return outcome;
            },
          })
        ),
    };
  },
};

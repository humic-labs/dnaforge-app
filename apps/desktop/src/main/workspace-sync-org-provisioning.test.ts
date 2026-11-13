import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/dnaforge-org-provisioning-test',
    getVersion: () => '0.0.0-test',
    getName: () => 'DNAForge Test',
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));
vi.mock('@sentry/electron/main', () => ({ captureException: vi.fn() }));
vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: vi.fn(),
      once: vi.fn(),
      removeListener: vi.fn(),
      checkForUpdates: vi.fn(),
    },
  },
}));

import {
  getWorkspaceSyncOrganizationProvisioningStatus,
  openWorkspaceSyncOrganizationProvisioningPortal,
  setWorkspaceSyncOrganizationProvisioningGroupRole,
} from './workspace-sync-access';

const ORG_ID = 'cccccccc-cccc-cccc-cccc-ccccccccccc1';
const session = {
  accountId: 'account-1',
  desktopSessionId: 'session-1',
  accessToken: 'secret',
  accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
  refreshToken: 'secret',
  channel: 'stable',
  updatedAt: 1,
};

describe('desktop organization directory provisioning', () => {
  it('reads the server-owned status for the active desktop account', async () => {
    const getOrganizationProvisioningStatus = vi.fn(async () => ({
      orgId: ORG_ID,
      configured: false as const,
      seatCount: 1,
      seatLimit: null,
    }));

    await expect(
      getWorkspaceSyncOrganizationProvisioningStatus(ORG_ID, {
        getActiveSession: async () => session,
        client: { getOrganizationProvisioningStatus } as never,
      })
    ).resolves.toEqual({
      ok: true,
      status: { orgId: ORG_ID, configured: false, seatCount: 1, seatLimit: null },
    });
    expect(getOrganizationProvisioningStatus).toHaveBeenCalledWith('account-1', ORG_ID);
  });

  it('opens a provider-issued WorkOS URL from main, never from renderer input', async () => {
    const openExternal = vi.fn(async () => undefined);
    const createOrganizationProvisioningPortal = vi.fn(async () => ({
      url: 'https://setup.workos.com/s/setup_token',
    }));

    await expect(
      openWorkspaceSyncOrganizationProvisioningPortal(ORG_ID, {
        getActiveSession: async () => session,
        client: { createOrganizationProvisioningPortal } as never,
        openExternal,
      })
    ).resolves.toEqual({ ok: true, status: 'opened' });
    expect(createOrganizationProvisioningPortal).toHaveBeenCalledWith('account-1', ORG_ID);
    expect(openExternal).toHaveBeenCalledWith('https://setup.workos.com/s/setup_token');
  });

  it('refuses a compromised hosted response at the native shell boundary', async () => {
    const openExternal = vi.fn(async () => undefined);

    const result = await openWorkspaceSyncOrganizationProvisioningPortal(ORG_ID, {
      getActiveSession: async () => session,
      client: {
        createOrganizationProvisioningPortal: async () => ({
          url: 'https://attacker.example/steal',
        }),
      } as never,
      openExternal,
    });

    expect(result.ok).toBe(false);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('maps a directory group through the hosted organization authority', async () => {
    const setOrganizationProvisioningGroupRole = vi.fn(async () => ({
      externalGroupId: 'directory_group_1',
      roleId: 'admin' as const,
    }));
    await expect(
      setWorkspaceSyncOrganizationProvisioningGroupRole(
        ORG_ID,
        { externalGroupId: 'directory_group_1', roleId: 'admin' },
        {
          getActiveSession: async () => session,
          client: { setOrganizationProvisioningGroupRole } as never,
        }
      )
    ).resolves.toEqual({
      ok: true,
      externalGroupId: 'directory_group_1',
      roleId: 'admin',
    });
    expect(setOrganizationProvisioningGroupRole).toHaveBeenCalledWith('account-1', ORG_ID, {
      externalGroupId: 'directory_group_1',
      roleId: 'admin',
    });
  });
});

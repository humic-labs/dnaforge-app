import { describe, expect, it, vi } from 'vitest';

import { OrganizationRegistrySyncCoordinator } from '../org-registry-sync-coordinator';

const ORG_A = '10000000-0000-4000-8000-000000000001';
const ORG_B = '20000000-0000-4000-8000-000000000002';

function organizations() {
  return {
    ok: true as const,
    organizations: [
      {
        orgId: ORG_A,
        slug: 'alpha',
        displayName: 'Alpha',
        role: 'owner',
        canCreateManagedProjects: true,
        isAdministrator: true,
      },
      {
        orgId: ORG_B,
        slug: 'beta',
        displayName: 'Beta',
        role: 'member',
        canCreateManagedProjects: true,
        isAdministrator: false,
      },
    ],
  };
}

function synced(status: 'ready' | 'not_configured' | 'access_revoked' = 'ready') {
  return {
    ok: true as const,
    sync: { status, cursor: 0, pendingCount: 0, conflictCount: 0 },
    registry: {} as never,
  };
}

describe('OrganizationRegistrySyncCoordinator', () => {
  it('syncs every visible organization immediately and on the scheduled interval', async () => {
    const scheduled: { callback?: () => void } = {};
    const timer = { cancel: vi.fn(), unref: vi.fn() };
    const listOrganizations = vi.fn().mockResolvedValue(organizations());
    const syncOrganizationRegistry = vi.fn().mockResolvedValue(synced());
    const coordinator = new OrganizationRegistrySyncCoordinator(
      {
        listOrganizations,
        listCachedOrganizationIds: async () => [],
        syncOrganizationRegistry,
      },
      {
        schedule: (callback) => {
          scheduled.callback = callback;
          return timer;
        },
        clearSchedule: vi.fn(),
      }
    );

    await expect(coordinator.start()).resolves.toMatchObject({
      organizationsChecked: 2,
      synchronized: 2,
      failed: 0,
    });
    expect(syncOrganizationRegistry).toHaveBeenNthCalledWith(1, ORG_A);
    expect(syncOrganizationRegistry).toHaveBeenNthCalledWith(2, ORG_B);
    expect(timer.unref).toHaveBeenCalledOnce();

    scheduled.callback?.();
    await vi.waitFor(() => expect(syncOrganizationRegistry).toHaveBeenCalledTimes(4));
  });

  it('isolates one organization failure and continues syncing the others', async () => {
    const warn = vi.fn();
    const syncOrganizationRegistry = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'SYNC_ERROR', message: 'offline' })
      .mockResolvedValueOnce(synced('not_configured'));
    const coordinator = new OrganizationRegistrySyncCoordinator(
      {
        listOrganizations: async () => organizations(),
        listCachedOrganizationIds: async () => [],
        syncOrganizationRegistry,
      },
      { schedule: () => ({ cancel: vi.fn() }), clearSchedule: vi.fn(), warn }
    );

    await expect(coordinator.start()).resolves.toMatchObject({
      organizationsChecked: 2,
      synchronized: 0,
      notConfigured: 1,
      failed: 1,
    });
    expect(syncOrganizationRegistry).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(ORG_A));
  });

  it('coalesces concurrent startup, auth, and focus triggers into one pass', async () => {
    let release!: (value: ReturnType<typeof organizations>) => void;
    const listOrganizations = vi.fn(
      () =>
        new Promise<ReturnType<typeof organizations>>((resolve) => {
          release = resolve;
        })
    );
    const syncOrganizationRegistry = vi.fn().mockResolvedValue(synced());
    const coordinator = new OrganizationRegistrySyncCoordinator(
      {
        listOrganizations,
        listCachedOrganizationIds: async () => [],
        syncOrganizationRegistry,
      },
      { schedule: () => ({ cancel: vi.fn() }), clearSchedule: vi.fn() }
    );

    const startup = coordinator.start();
    const auth = coordinator.trigger('auth');
    const focus = coordinator.trigger('focus');
    expect(listOrganizations).toHaveBeenCalledOnce();
    release(organizations());
    await Promise.all([startup, auth, focus]);

    expect(listOrganizations).toHaveBeenCalledOnce();
    expect(syncOrganizationRegistry).toHaveBeenCalledTimes(2);
  });

  it('runs one later pass for publications that settle after an in-flight pass began', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listOrganizations = vi.fn().mockResolvedValue(organizations());
    const syncOrganizationRegistry = vi
      .fn()
      .mockImplementationOnce(async () => {
        await blocked;
        return synced();
      })
      .mockResolvedValue(synced());
    const coordinator = new OrganizationRegistrySyncCoordinator(
      { listOrganizations, listCachedOrganizationIds: async () => [], syncOrganizationRegistry },
      { schedule: () => ({ cancel: vi.fn() }), clearSchedule: vi.fn() }
    );
    const first = coordinator.start();
    await vi.waitFor(() => expect(syncOrganizationRegistry).toHaveBeenCalledTimes(1));
    const publication = coordinator.trigger('publication');
    const anotherPublication = coordinator.trigger('publication');
    expect(listOrganizations).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, publication, anotherPublication]);
    expect(listOrganizations).toHaveBeenCalledTimes(2);
    expect(syncOrganizationRegistry.mock.calls.map(([id]) => id)).toEqual([
      ORG_A,
      ORG_B,
      ORG_A,
      ORG_B,
    ]);
    coordinator.stop();
  });

  it('does not start a queued publication pass after shutdown', async () => {
    let release!: (value: ReturnType<typeof organizations>) => void;
    const listOrganizations = vi.fn(
      () =>
        new Promise<ReturnType<typeof organizations>>((resolve) => {
          release = resolve;
        })
    );
    const coordinator = new OrganizationRegistrySyncCoordinator(
      {
        listOrganizations,
        listCachedOrganizationIds: async () => [],
        syncOrganizationRegistry: vi.fn().mockResolvedValue(synced()),
      },
      { schedule: () => ({ cancel: vi.fn() }), clearSchedule: vi.fn() }
    );
    const first = coordinator.start();
    void coordinator.trigger('publication');
    coordinator.stop();
    release(organizations());
    await first;
    expect(listOrganizations).toHaveBeenCalledTimes(1);
  });

  it('does no network work while signed out and cancels its timer on stop', async () => {
    const scheduled: { callback?: () => void } = {};
    const clearSchedule = vi.fn();
    const timer = { cancel: vi.fn() };
    const listOrganizations = vi.fn().mockResolvedValue(organizations());
    const coordinator = new OrganizationRegistrySyncCoordinator(
      {
        listOrganizations,
        listCachedOrganizationIds: async () => [],
        syncOrganizationRegistry: vi.fn(),
      },
      {
        shouldRun: () => false,
        schedule: (callback) => {
          scheduled.callback = callback;
          return timer;
        },
        clearSchedule,
      }
    );

    await expect(coordinator.start()).resolves.toMatchObject({ skipped: true });
    expect(listOrganizations).not.toHaveBeenCalled();
    coordinator.stop();
    scheduled.callback?.();
    await Promise.resolve();
    expect(clearSchedule).toHaveBeenCalledWith(timer);
    expect(listOrganizations).not.toHaveBeenCalled();
  });

  it('rechecks cached organizations that disappeared from the membership list and records revocation cleanup', async () => {
    const listCachedOrganizationIds = vi.fn().mockResolvedValue([ORG_A]);
    const syncOrganizationRegistry = vi.fn().mockResolvedValue(synced('access_revoked'));
    const coordinator = new OrganizationRegistrySyncCoordinator(
      {
        listOrganizations: async () => ({ ok: true as const, organizations: [] }),
        listCachedOrganizationIds,
        syncOrganizationRegistry,
      },
      { schedule: () => ({ cancel: vi.fn() }), clearSchedule: vi.fn() }
    );

    await expect(coordinator.start()).resolves.toMatchObject({
      organizationsChecked: 1,
      synchronized: 0,
      accessRevoked: 1,
      failed: 0,
    });
    expect(listCachedOrganizationIds).toHaveBeenCalledOnce();
    expect(syncOrganizationRegistry).toHaveBeenCalledExactlyOnceWith(ORG_A);
  });
});

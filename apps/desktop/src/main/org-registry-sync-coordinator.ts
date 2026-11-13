import type { OrganizationRegistrySyncResult } from '../shared/org-registry-sync';
import type { WorkspaceSyncOrganizationsResult } from '../shared/workspace-sync-ipc';
import { observeOrgRegistrySync } from './workspace-sync-observation';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

interface ScheduleHandle {
  cancel(): void;
  unref?(): void;
}

export interface OrganizationRegistrySyncCoordinatorActions {
  listOrganizations(): Promise<WorkspaceSyncOrganizationsResult>;
  listCachedOrganizationIds(): Promise<string[]>;
  syncOrganizationRegistry(orgId: string): Promise<OrganizationRegistrySyncResult>;
}

export interface OrganizationRegistrySyncCoordinatorOptions {
  intervalMs?: number;
  shouldRun?: () => boolean;
  schedule?: (callback: () => void, intervalMs: number) => ScheduleHandle;
  clearSchedule?: (handle: ScheduleHandle) => void;
  warn?: (message: string) => void;
}

export interface OrganizationRegistrySyncCoordinatorRun {
  skipped: boolean;
  organizationsChecked: number;
  synchronized: number;
  notConfigured: number;
  accessRevoked: number;
  failed: number;
}

const skippedRun = (): OrganizationRegistrySyncCoordinatorRun => ({
  skipped: true,
  organizationsChecked: 0,
  synchronized: 0,
  notConfigured: 0,
  accessRevoked: 0,
  failed: 0,
});

export class OrganizationRegistrySyncCoordinator {
  private active = false;
  private publicationQueued = false;
  private timer: ScheduleHandle | null = null;
  private inFlight: Promise<OrganizationRegistrySyncCoordinatorRun> | null = null;
  private readonly intervalMs: number;
  private readonly shouldRun: () => boolean;
  private readonly schedule: (callback: () => void, intervalMs: number) => ScheduleHandle;
  private readonly clearSchedule: (handle: ScheduleHandle) => void;
  private readonly warn: (message: string) => void;

  constructor(
    private readonly actions: OrganizationRegistrySyncCoordinatorActions,
    options: OrganizationRegistrySyncCoordinatorOptions = {}
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.shouldRun = options.shouldRun ?? (() => true);
    this.schedule = options.schedule ?? scheduleInterval;
    this.clearSchedule = options.clearSchedule ?? ((handle) => handle.cancel());
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  start(): Promise<OrganizationRegistrySyncCoordinatorRun> {
    if (!this.active) {
      this.active = true;
      this.timer = this.schedule(() => {
        void this.trigger('interval');
      }, this.intervalMs);
      this.timer.unref?.();
    }
    return this.trigger('startup');
  }

  trigger(
    reason: 'startup' | 'auth' | 'focus' | 'interval' | 'manual' | 'publication'
  ): Promise<OrganizationRegistrySyncCoordinatorRun> {
    if (!this.active || !this.shouldRun()) return Promise.resolve(skippedRun());
    if (this.inFlight) {
      if (reason === 'publication') this.publicationQueued = true;
      return this.inFlight;
    }
    const running = this.runOnce().finally(() => {
      if (this.inFlight !== running) return;
      this.inFlight = null;
      if (this.publicationQueued) {
        this.publicationQueued = false;
        return this.trigger('publication').then(() => undefined);
      }
    });
    this.inFlight = running;
    return running;
  }

  stop(): void {
    this.active = false;
    this.publicationQueued = false;
    if (this.timer !== null) this.clearSchedule(this.timer);
    this.timer = null;
  }

  private async runOnce(): Promise<OrganizationRegistrySyncCoordinatorRun> {
    const result: OrganizationRegistrySyncCoordinatorRun = {
      skipped: false,
      organizationsChecked: 0,
      synchronized: 0,
      notConfigured: 0,
      accessRevoked: 0,
      failed: 0,
    };
    let listed: WorkspaceSyncOrganizationsResult;
    try {
      listed = await this.actions.listOrganizations();
    } catch (error) {
      result.failed = 1;
      this.warn(`[OrgRegistrySync] Could not list organizations: ${messageFrom(error)}`);
      return result;
    }
    if (!listed.ok) {
      result.failed = 1;
      this.warn(`[OrgRegistrySync] Could not list organizations: ${listed.message}`);
      return result;
    }

    const organizationIds = new Set(listed.organizations.map((organization) => organization.orgId));
    try {
      for (const orgId of await this.actions.listCachedOrganizationIds()) {
        organizationIds.add(orgId);
      }
    } catch (error) {
      result.failed += 1;
      this.warn(`[OrgRegistrySync] Could not list cached organizations: ${messageFrom(error)}`);
    }

    result.organizationsChecked = organizationIds.size;
    for (const orgId of organizationIds) {
      try {
        const synced = await this.actions.syncOrganizationRegistry(orgId);
        observeOrgRegistrySync(orgId, synced);
        if (!synced.ok) {
          result.failed += 1;
          this.warn(`[OrgRegistrySync] ${orgId}: ${synced.message}`);
          continue;
        }
        if (synced.sync.status === 'ready') {
          result.synchronized += 1;
        } else if (synced.sync.status === 'not_configured') {
          result.notConfigured += 1;
        } else if (synced.sync.status === 'access_revoked') {
          result.accessRevoked += 1;
        } else {
          result.failed += 1;
          this.warn(
            `[OrgRegistrySync] ${orgId}: ${synced.sync.errorMessage ?? synced.sync.status}`
          );
        }
      } catch (error) {
        observeOrgRegistrySync(orgId, { thrown: error });
        result.failed += 1;
        this.warn(`[OrgRegistrySync] ${orgId}: ${messageFrom(error)}`);
      }
    }
    return result;
  }
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduleInterval(callback: () => void, intervalMs: number): ScheduleHandle {
  const timer = setInterval(callback, intervalMs);
  return {
    cancel: () => clearInterval(timer),
    unref: () => {
      if (typeof timer !== 'object') return;
      const unref = Reflect.get(timer, 'unref');
      if (typeof unref === 'function') Reflect.apply(unref, timer, []);
    },
  };
}

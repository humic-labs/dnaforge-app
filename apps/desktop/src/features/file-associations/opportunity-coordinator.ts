import type {
  FileAssociationDefaultRequestResult,
  FileAssociationHandlerStatus,
} from '../../shared/file-association-ipc';
import type { FileAssociationFamilyId } from '../../shared/file-associations';
import {
  FILE_ASSOCIATION_OPPORTUNITY_SETTING_KEY,
  createOpportunityState,
  markConfirmedDefault,
  parseOpportunityState,
  recordOpportunityDismissed,
  recordOpportunityPrompted,
  recordOpportunitySnoozed,
  selectOpportunityFamily,
  type FileAssociationOpportunityState,
} from './opportunity-state';

export interface FileAssociationOpportunity {
  readonly familyId: FileAssociationFamilyId;
  readonly status: FileAssociationHandlerStatus;
}

export interface DefaultRequestVerification {
  readonly request: FileAssociationDefaultRequestResult;
  readonly confirmedDefault: boolean;
}

interface FileAssociationOpportunityDependencies {
  readonly getSetting: (key: string) => Promise<string | null>;
  readonly setSetting: (key: string, value: string) => Promise<void>;
  readonly queryHandlers: () => Promise<readonly FileAssociationHandlerStatus[]>;
  readonly requestDefault: (
    familyId: FileAssociationFamilyId
  ) => Promise<FileAssociationDefaultRequestResult>;
  readonly now?: () => number;
}

export class FileAssociationOpportunityCoordinator {
  private state: FileAssociationOpportunityState | null = null;
  private readonly successfulFamilies = new Set<FileAssociationFamilyId>();
  private sessionPrompted = false;
  private serial: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: FileAssociationOpportunityDependencies) {}

  recordSuccessfulUse(
    familyId: FileAssociationFamilyId
  ): Promise<FileAssociationOpportunity | null> {
    return this.enqueue(async () => {
      await this.load();
      this.successfulFamilies.add(familyId);
      let statuses: readonly FileAssociationHandlerStatus[];
      try {
        statuses = await this.dependencies.queryHandlers();
      } catch {
        return null;
      }
      await this.rememberConfirmedDefaults(statuses);
      const selected = selectOpportunityFamily({
        state: this.requireState(),
        handlerStatuses: statuses,
        successfulFamilies: this.successfulFamilies,
        now: this.now(),
        sessionPrompted: this.sessionPrompted,
      });
      if (!selected) return null;
      const selectedStatus = statuses.find((status) => status.familyId === selected);
      if (!selectedStatus) return null;

      this.state = recordOpportunityPrompted(this.requireState(), selected, this.now());
      this.sessionPrompted = true;
      await this.persist();
      return { familyId: selected, status: selectedStatus };
    });
  }

  snooze(familyId: FileAssociationFamilyId): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      this.state = recordOpportunitySnoozed(this.requireState(), familyId, this.now());
      await this.persist();
    });
  }

  dismissPermanently(familyId: FileAssociationFamilyId): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      this.state = recordOpportunityDismissed(this.requireState(), familyId);
      await this.persist();
    });
  }

  requestDefault(familyId: FileAssociationFamilyId): Promise<DefaultRequestVerification> {
    return this.enqueue(async () => {
      await this.load();
      const request = await this.dependencies.requestDefault(familyId);
      if (request.outcome !== 'requested') return { request, confirmedDefault: false };
      let statuses: readonly FileAssociationHandlerStatus[];
      try {
        statuses = await this.dependencies.queryHandlers();
      } catch {
        return { request, confirmedDefault: false };
      }
      const confirmedDefault = statuses.some(
        (status) => status.familyId === familyId && status.state === 'default'
      );
      if (confirmedDefault) await this.rememberConfirmedDefaults(statuses);
      return { request, confirmedDefault };
    });
  }

  refreshConfirmedDefaults(): Promise<readonly FileAssociationHandlerStatus[]> {
    return this.enqueue(async () => {
      await this.load();
      const statuses = await this.dependencies.queryHandlers();
      await this.rememberConfirmedDefaults(statuses);
      return statuses;
    });
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.serial.then(operation);
    this.serial = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async load(): Promise<void> {
    if (this.state) return;
    const stored = await this.dependencies.getSetting(FILE_ASSOCIATION_OPPORTUNITY_SETTING_KEY);
    this.state = stored ? parseOpportunityState(stored) : createOpportunityState();
  }

  private async rememberConfirmedDefaults(
    statuses: readonly FileAssociationHandlerStatus[]
  ): Promise<void> {
    let next = this.requireState();
    let changed = false;
    for (const status of statuses) {
      if (status.state !== 'default') continue;
      const existing = next.families[status.familyId]?.confirmedDefaultAt ?? null;
      if (existing !== null) continue;
      next = markConfirmedDefault(next, status.familyId, this.now());
      changed = true;
    }
    if (!changed) return;
    this.state = next;
    await this.persist();
  }

  private requireState(): FileAssociationOpportunityState {
    if (!this.state) throw new Error('File association opportunity state was not loaded.');
    return this.state;
  }

  private async persist(): Promise<void> {
    await this.dependencies.setSetting(
      FILE_ASSOCIATION_OPPORTUNITY_SETTING_KEY,
      JSON.stringify(this.requireState())
    );
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}

import type { WorkspaceSyncReconcileResult } from '../shared/workspace-sync-ipc';

export interface WorkspaceSyncReconcileSchedulerDeps {
  reconcile: (workspaceUuid: string) => Promise<WorkspaceSyncReconcileResult>;
  onSettled?: (workspaceUuid: string, result: WorkspaceSyncReconcileResult) => void;
  debounceMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 1_500;

export class WorkspaceSyncReconcileScheduler {
  private readonly timers = new Map<string, unknown>();
  private readonly running = new Map<string, Promise<WorkspaceSyncReconcileResult>>();
  private readonly followUp = new Set<string>();
  private stopped = false;

  constructor(private readonly deps: WorkspaceSyncReconcileSchedulerDeps) {}

  schedule(workspaceUuid: string): void {
    if (this.stopped) return;
    const existing = this.timers.get(workspaceUuid);
    if (existing !== undefined) (this.deps.clearTimer ?? clearTimeout)(existing as never);
    const handle = (this.deps.setTimer ?? setTimeout)(() => {
      this.timers.delete(workspaceUuid);
      void this.runNow(workspaceUuid);
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timers.set(workspaceUuid, handle);
  }

  runNow(workspaceUuid: string): Promise<WorkspaceSyncReconcileResult> {
    const inFlight = this.running.get(workspaceUuid);
    if (inFlight) {
      this.followUp.add(workspaceUuid);
      return inFlight;
    }
    const run = (async (): Promise<WorkspaceSyncReconcileResult> => {
      let result: WorkspaceSyncReconcileResult;
      try {
        result = await this.deps.reconcile(workspaceUuid);
      } catch (error) {
        result = {
          ok: false,
          code: 'INVALID_REQUEST',
          message: error instanceof Error ? error.message : 'Reconciliation failed.',
        };
      }
      this.deps.onSettled?.(workspaceUuid, result);
      return result;
    })();
    this.running.set(workspaceUuid, run);
    const finish = (): void => {
      if (this.running.get(workspaceUuid) === run) this.running.delete(workspaceUuid);
      if (this.followUp.delete(workspaceUuid) && !this.stopped) this.schedule(workspaceUuid);
    };
    void run.then(finish, finish);
    return run;
  }

  isRunning(workspaceUuid: string): boolean {
    return this.running.has(workspaceUuid);
  }

  stop(): void {
    this.stopped = true;
    for (const handle of this.timers.values())
      (this.deps.clearTimer ?? clearTimeout)(handle as never);
    this.timers.clear();
    this.followUp.clear();
  }
}

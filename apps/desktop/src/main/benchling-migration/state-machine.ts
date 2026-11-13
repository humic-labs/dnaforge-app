import type {
  ActiveMigrationState,
  InterruptedMigrationState,
  MigrationIssue,
  MigrationRun,
  MigrationState,
} from '../../shared/benchling-migration';

const NEXT_ACTIVE_STATE: Readonly<Record<ActiveMigrationState, MigrationState>> = {
  draft: 'identity_confirmation',
  identity_confirmation: 'scope_planning',
  scope_planning: 'export_pending',
  export_pending: 'downloading',
  downloading: 'parsing',
  parsing: 'offline_resolution',
  offline_resolution: 'targeted_reads',
  targeted_reads: 'projecting',
  projecting: 'validating',
  validating: 'ready_to_unlock',
  ready_to_unlock: 'unlocked',
};

const INTERRUPTIBLE_STATES = new Set<ActiveMigrationState>([
  'identity_confirmation',
  'scope_planning',
  'export_pending',
  'downloading',
  'parsing',
  'offline_resolution',
  'targeted_reads',
  'projecting',
  'validating',
]);

const INTERRUPTED_STATES = new Set<InterruptedMigrationState>([
  'paused',
  'action_required',
  'cancelled_preserved',
]);

const TERMINAL_STATES = new Set<MigrationState>(['unlocked', 'failed', 'discarded']);

export class IllegalMigrationTransitionError extends Error {
  constructor(from: MigrationState, to: MigrationState) {
    super(`Illegal Benchling migration transition: ${from} -> ${to}`);
    this.name = 'IllegalMigrationTransitionError';
  }
}

export function isTerminalMigrationState(state: MigrationState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransitionMigrationRun(
  run: MigrationRun,
  to: MigrationState,
  issue: MigrationIssue | null = null
): boolean {
  if (run.state === to) return true;
  if (isTerminalMigrationState(run.state)) return false;
  if (to === 'discarded' || to === 'failed') return true;
  if (to === 'action_required' && (run.state === 'draft' || run.state === 'ready_to_unlock')) {
    return issue?.code === 'projection_contract_restart_required';
  }

  if (INTERRUPTED_STATES.has(run.state as InterruptedMigrationState)) {
    if (to === 'action_required') return true;
    if (to === 'cancelled_preserved' && run.state !== 'cancelled_preserved') return true;
    return run.resumeState === to;
  }

  if (INTERRUPTIBLE_STATES.has(run.state as ActiveMigrationState)) {
    if (INTERRUPTED_STATES.has(to as InterruptedMigrationState)) return true;
  }

  return NEXT_ACTIVE_STATE[run.state as ActiveMigrationState] === to;
}

export function transitionMigrationRun(
  run: MigrationRun,
  to: MigrationState,
  now: string,
  issue: MigrationIssue | null = null
): MigrationRun {
  if (!canTransitionMigrationRun(run, to, issue)) {
    throw new IllegalMigrationTransitionError(run.state, to);
  }
  if (run.state === to) {
    if (to !== 'action_required' || issue === null) return run;
    return { ...run, updatedAt: now, lastError: issue };
  }

  const enteringInterruptedState = INTERRUPTED_STATES.has(to as InterruptedMigrationState);
  const leavingInterruptedState = INTERRUPTED_STATES.has(run.state as InterruptedMigrationState);

  return {
    ...run,
    state: to,
    resumeState: enteringInterruptedState
      ? INTERRUPTED_STATES.has(run.state as InterruptedMigrationState)
        ? run.resumeState
        : (run.state as ActiveMigrationState)
      : leavingInterruptedState
        ? null
        : run.resumeState,
    updatedAt: now,
    startedAt: run.startedAt ?? (to === 'identity_confirmation' ? now : null),
    unlockedAt: to === 'unlocked' ? now : run.unlockedAt,
    lastError: issue,
  };
}

export function advanceMigrationRun(run: MigrationRun, now: string): MigrationRun {
  if (INTERRUPTED_STATES.has(run.state as InterruptedMigrationState)) {
    if (!run.resumeState) {
      throw new IllegalMigrationTransitionError(run.state, run.state);
    }
    return transitionMigrationRun(run, run.resumeState, now);
  }
  const next = NEXT_ACTIVE_STATE[run.state as ActiveMigrationState];
  if (!next) throw new IllegalMigrationTransitionError(run.state, run.state);
  return transitionMigrationRun(run, next, now);
}

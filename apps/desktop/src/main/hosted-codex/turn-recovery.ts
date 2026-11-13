import {
  AGENT_STATE_CAPSULE_SCHEMA_VERSION,
  agentStateCapsuleDigest,
  type AgentStateCapsuleBody,
  type AgentStateCapsuleStore,
  type StoredAgentStateCapsule,
} from './agent-state-capsule';
import type { RunBudgetSnapshot } from './run-budget';
import type {
  ApprovalDecision,
  EffectResolution,
  TurnCoordinator,
  TurnOutcome,
} from './turn-coordinator';

export type RecoveryRefusal = 'unknown_schema' | 'digest_mismatch';

export interface RecoveredTurn {
  readonly resumable: boolean;
  readonly refusal: RecoveryRefusal | null;
  readonly unknownEffects: readonly string[];
  readonly outcome: TurnOutcome | null;
  readonly spentBudget: Readonly<Record<string, number>>;
}

export function recoverTurn(capsule: StoredAgentStateCapsule | null): RecoveredTurn {
  if (capsule === null) {
    return { resumable: false, refusal: null, unknownEffects: [], outcome: null, spentBudget: {} };
  }

  const unknownEffects = [...capsule.openToolExecutions];
  const outcome: TurnOutcome | null = unknownEffects.length > 0 ? 'outcome_unknown' : null;
  const spentBudget = { ...capsule.budget };

  if (capsule.schemaVersion !== AGENT_STATE_CAPSULE_SCHEMA_VERSION) {
    return { resumable: false, refusal: 'unknown_schema', unknownEffects, outcome, spentBudget };
  }

  const { capsuleDigest, ...body } = capsule;
  if (agentStateCapsuleDigest(body) !== capsuleDigest) {
    return { resumable: false, refusal: 'digest_mismatch', unknownEffects, outcome, spentBudget };
  }

  return { resumable: true, refusal: null, unknownEffects, outcome, spentBudget };
}

interface RecordedCall {
  approval: 'pending' | ApprovalDecision;
  effect: 'none' | 'applying' | EffectResolution;
  observation: 'none' | 'writing' | 'recorded';
}

export type RecordingTurn = TurnCoordinator;

export interface RecordingTurnOptions {
  readonly runId: string;
  readonly store: AgentStateCapsuleStore;
  readonly coordinator: TurnCoordinator;
  readonly generations: Readonly<Record<string, string>>;
}

export function createRecordingTurn(options: RecordingTurnOptions): RecordingTurn {
  const { coordinator, store, runId } = options;
  const calls = new Map<string, RecordedCall>();

  const resumeFrom = store.readActive(runId);
  let sequence = resumeFrom?.sequence ?? 0;
  let predecessorDigest = resumeFrom?.capsuleDigest ?? null;

  function openExecutions(): string[] {
    const open: string[] = [];
    for (const [callId, state] of calls) {
      if (state.effect === 'none') continue;
      if (state.observation !== 'recorded') open.push(callId);
    }
    return open.sort();
  }

  function record(budget: RunBudgetSnapshot): void {
    sequence += 1;
    const body: AgentStateCapsuleBody = {
      schemaVersion: AGENT_STATE_CAPSULE_SCHEMA_VERSION,
      runId,
      sequence,
      predecessorDigest,
      bindings: { runId },
      watermarks: {},
      references: [],
      openToolExecutions: openExecutions(),
      generations: options.generations,
      budget: {
        providerAttempts: budget.providerAttempts,
        tokens: budget.tokens,
        spendMicros: budget.spendMicros,
        toolCalls: budget.toolCalls,
        mutations: budget.mutations,
        compactions: budget.compactions,
        recoveries: budget.recoveries,
      },
      compaction: null,
    };
    const digest = store.writeCandidate(body);
    store.activate(runId, digest);
    predecessorDigest = digest;
  }

  function recorded<T>(act: () => T, mutate: () => void): T {
    const result = act();
    mutate();
    try {
      record(coordinator.budgetSnapshot());
    } catch (cause) {
      coordinator.stop();
      throw cause;
    }
    return result;
  }

  return {
    get phase() {
      return coordinator.phase;
    },
    get outcome() {
      return coordinator.outcome;
    },
    get stopRequested() {
      return coordinator.stopRequested;
    },

    beginProviderStep: () =>
      recorded(
        () => coordinator.beginProviderStep(),
        () => {}
      ),
    finishProviderStep: () =>
      recorded(
        () => coordinator.finishProviderStep(),
        () => {}
      ),
    failProviderStep: (reason) =>
      recorded(
        () => coordinator.failProviderStep(reason),
        () => {}
      ),

    chargeToolCall: () =>
      recorded(
        () => coordinator.chargeToolCall(),
        () => {}
      ),

    chargeUsage: (usage) =>
      recorded(
        () => coordinator.chargeUsage(usage),
        () => {}
      ),

    beginApproval: (callId) =>
      recorded(
        () => coordinator.beginApproval(callId),
        () => calls.set(callId, { approval: 'pending', effect: 'none', observation: 'none' })
      ),

    settleApproval: (callId, decision) =>
      recorded(
        () => coordinator.settleApproval(callId, decision),
        () => {
          const state = calls.get(callId);
          if (state) state.approval = decision;
        }
      ),

    beginEffect: (callId) =>
      recorded(
        () => coordinator.beginEffect(callId),
        () => {
          const state = calls.get(callId);
          if (state) state.effect = 'applying';
        }
      ),

    resolveEffect: (callId, resolution) =>
      recorded(
        () => coordinator.resolveEffect(callId, resolution),
        () => {
          const state = calls.get(callId);
          if (state) state.effect = resolution;
        }
      ),

    beginObservation: (callId) =>
      recorded(
        () => coordinator.beginObservation(callId),
        () => {
          const state = calls.get(callId);
          if (state) state.observation = 'writing';
        }
      ),

    completeObservation: (callId) =>
      recorded(
        () => coordinator.completeObservation(callId),
        () => {
          const state = calls.get(callId);
          if (state) state.observation = 'recorded';
        }
      ),

    stop: () => {
      coordinator.stop();
    },

    finish: (requested) => {
      coordinator.finish(requested);
    },

    budgetSnapshot: () => coordinator.budgetSnapshot(),
  };
}

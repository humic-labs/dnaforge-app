import type { EffectHold, RunBudget, RunBudgetSnapshot } from './run-budget';
import { RunBudgetError } from './run-budget';

export const TURN_PHASES = [
  'admitting',
  'streaming',
  'awaiting_approval',
  'applying_effect',
  'recording_observation',
  'finished',
] as const;

export type TurnPhase = (typeof TURN_PHASES)[number];

export type TurnOutcome = 'completed' | 'stopped' | 'failed' | 'outcome_unknown';

export type EffectResolution = 'applied' | 'no_effect' | 'outcome_unknown';

export type ApprovalDecision = 'approved' | 'declined';

export type TurnCoordinatorCode =
  | 'stopped'
  | 'already_finished'
  | 'illegal_transition'
  | 'unknown_call'
  | 'effect_unresolved'
  | 'observation_unresolved'
  | 'budget_exhausted'
  | 'retry_not_owned';

export class TurnCoordinatorError extends Error {
  constructor(
    readonly code: TurnCoordinatorCode,
    message: string
  ) {
    super(message);
    this.name = 'TurnCoordinatorError';
  }
}

export interface TurnCoordinator {
  readonly phase: TurnPhase;
  readonly outcome: TurnOutcome | null;
  readonly stopRequested: boolean;
  beginProviderStep(): void;
  finishProviderStep(): void;
  failProviderStep(reason: string): void;
  chargeToolCall(): void;
  chargeUsage(usage: { readonly tokens?: number; readonly spendMicros?: number }): void;
  beginApproval(callId: string): void;
  settleApproval(callId: string, decision: ApprovalDecision): void;
  beginEffect(callId: string): void;
  resolveEffect(callId: string, resolution: EffectResolution): void;
  beginObservation(callId: string): void;
  completeObservation(callId: string): void;
  stop(): void;
  finish(outcome: TurnOutcome): void;
  budgetSnapshot(): RunBudgetSnapshot;
}

export interface TurnCoordinatorOptions {
  readonly budget: RunBudget;
}

interface CallState {
  approval: 'pending' | ApprovalDecision;
  effect: 'none' | 'applying' | EffectResolution;
  observation: 'none' | 'writing' | 'recorded';
  hold: { release(): void } | null;
}

export function createTurnCoordinator(options: TurnCoordinatorOptions): TurnCoordinator {
  const calls = new Map<string, CallState>();
  let phase: TurnPhase = 'admitting';
  let outcome: TurnOutcome | null = null;
  let stopRequested = false;
  let providerFailed = false;

  function refuse(code: TurnCoordinatorCode, message: string): never {
    throw new TurnCoordinatorError(code, message);
  }

  function admit(): void {
    notFinished();
    if (stopRequested) refuse('stopped', 'the turn was stopped');
  }

  function notFinished(): void {
    if (phase === 'finished') refuse('already_finished', 'the turn already finished');
  }

  function charge(action: () => void): void {
    try {
      action();
    } catch (cause) {
      if (cause instanceof RunBudgetError) {
        refuse('budget_exhausted', `the run budget refused: ${cause.code}`);
      }
      throw cause;
    }
  }

  function call(callId: string): CallState {
    const state = calls.get(callId);
    if (!state) refuse('unknown_call', `no tool call "${callId}" is in flight`);
    return state;
  }

  function unresolved(): TurnCoordinatorCode | null {
    for (const state of calls.values()) {
      if (state.effect === 'applying') return 'effect_unresolved';
      if (state.observation === 'writing') return 'observation_unresolved';
      if (state.effect !== 'none' && state.observation !== 'recorded') {
        return 'observation_unresolved';
      }
    }
    return null;
  }

  return {
    get phase() {
      return phase;
    },
    get outcome() {
      return outcome;
    },
    get stopRequested() {
      return stopRequested;
    },

    beginProviderStep: () => {
      admit();
      if (providerFailed) {
        refuse(
          'retry_not_owned',
          "a failed provider step is the gateway's to retry, not this turn's"
        );
      }
      charge(() => options.budget.chargeProviderAttempt());
      phase = 'streaming';
    },

    finishProviderStep: () => {
      admit();
      if (phase !== 'streaming') refuse('illegal_transition', 'no provider step is streaming');
      phase = 'admitting';
    },

    failProviderStep: (reason) => {
      if (phase === 'finished') refuse('already_finished', 'the turn already finished');
      if (phase !== 'streaming') refuse('illegal_transition', 'no provider step is streaming');
      providerFailed = true;
      phase = 'admitting';
      void reason;
    },

    chargeUsage: (usage) => {
      admit();
      if (usage.tokens !== undefined && usage.tokens > 0) {
        charge(() => options.budget.chargeTokens(usage.tokens ?? 0));
      }
      if (usage.spendMicros !== undefined && usage.spendMicros > 0) {
        charge(() => options.budget.chargeSpendMicros(usage.spendMicros ?? 0));
      }
    },

    chargeToolCall: () => {
      admit();
      charge(() => options.budget.chargeToolCall());
    },

    beginApproval: (callId) => {
      admit();
      if (calls.has(callId)) {
        refuse('illegal_transition', `tool call "${callId}" is already in flight`);
      }
      calls.set(callId, { approval: 'pending', effect: 'none', observation: 'none', hold: null });
      phase = 'awaiting_approval';
    },

    settleApproval: (callId, decision) => {
      notFinished();
      const state = call(callId);
      if (state.approval !== 'pending') {
        refuse('illegal_transition', `the approval for "${callId}" was already settled`);
      }
      state.approval = decision;
      phase = 'admitting';
    },

    beginEffect: (callId) => {
      admit();
      const state = calls.get(callId);
      if (!state) {
        if (calls.size === 0) {
          refuse('illegal_transition', 'an effect requires an approved tool call');
        }
        refuse('unknown_call', `no tool call "${callId}" is in flight`);
      }
      if (state.approval !== 'approved') {
        refuse(
          'illegal_transition',
          `an effect requires an approved tool call, and "${callId}" is ${state.approval}`
        );
      }
      let hold: EffectHold;
      try {
        hold = options.budget.beginEffect();
      } catch (cause) {
        if (cause instanceof RunBudgetError) {
          refuse('budget_exhausted', `the run budget refused: ${cause.code}`);
        }
        throw cause;
      }
      try {
        charge(() => options.budget.chargeMutation());
      } catch (cause) {
        hold.release();
        throw cause;
      }
      state.hold = hold;
      state.effect = 'applying';
      phase = 'applying_effect';
    },

    resolveEffect: (callId, resolution) => {
      notFinished();
      const state = call(callId);
      if (state.effect !== 'applying') refuse('illegal_transition', 'no effect is applying');
      state.effect = resolution;
      state.hold?.release();
      state.hold = null;
      if (resolution === 'outcome_unknown') {
        outcome = 'outcome_unknown';
      }
      phase = 'admitting';
    },

    beginObservation: (callId) => {
      notFinished();
      const state = call(callId);
      if (state.effect === 'none' || state.effect === 'applying') {
        refuse('illegal_transition', 'an observation requires a resolved effect');
      }
      state.observation = 'writing';
      phase = 'recording_observation';
    },

    completeObservation: (callId) => {
      notFinished();
      const state = call(callId);
      if (state.observation !== 'writing')
        refuse('illegal_transition', 'no observation is being written');
      state.observation = 'recorded';
      phase = 'admitting';
    },

    stop: () => {
      if (stopRequested) return;
      stopRequested = true;
      options.budget.stop('user_stopped');
    },

    finish: (requested) => {
      notFinished();
      const outstanding = unresolved();
      if (outstanding) {
        refuse(
          outstanding,
          outstanding === 'effect_unresolved'
            ? 'an effect is still applying'
            : 'an observation is still being written'
        );
      }
      phase = 'finished';
      outcome = outcome === 'outcome_unknown' ? 'outcome_unknown' : requested;
    },

    budgetSnapshot: () => options.budget.snapshot(),
  };
}

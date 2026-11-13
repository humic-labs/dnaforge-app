import { describe, expect, it } from 'vitest';

import { createRunBudget, type RunBudgetLimits } from './run-budget';
import {
  createTurnCoordinator,
  TurnCoordinatorError,
  TURN_PHASES,
  type TurnCoordinator,
  type TurnPhase,
} from './turn-coordinator';

const LIMITS: RunBudgetLimits = {
  providerAttempts: 5,
  totalTokens: 10_000,
  spendMicros: 100_000,
  toolCalls: 10,
  mutations: 5,
  parallelEffects: 2,
  compactions: 2,
  recoveries: 2,
  deadlineMs: 600_000,
};

let clock = 0;
function coordinator(limits: Partial<RunBudgetLimits> = {}): TurnCoordinator {
  clock = 0;
  return createTurnCoordinator({
    budget: createRunBudget({ limits: { ...LIMITS, ...limits }, now: () => clock }),
  });
}

function refusal(run: () => unknown): TurnCoordinatorError {
  try {
    run();
  } catch (error) {
    if (error instanceof TurnCoordinatorError) return error;
    throw error;
  }
  throw new Error('expected the coordinator to refuse');
}

function driveTo(turn: TurnCoordinator, phase: TurnPhase): void {
  if (phase === 'admitting') return;
  turn.beginProviderStep();
  if (phase === 'streaming') return;
  turn.beginApproval('call-1');
  if (phase === 'awaiting_approval') return;
  turn.settleApproval('call-1', 'approved');
  turn.beginEffect('call-1');
  if (phase === 'applying_effect') return;
  turn.resolveEffect('call-1', 'applied');
  turn.beginObservation('call-1');
}

describe('createTurnCoordinator', () => {
  it('starts admitting and nothing else', () => {
    expect(coordinator().phase).toBe('admitting');
  });

  describe('Stop', () => {
    it.each(TURN_PHASES.filter((phase) => phase !== 'finished'))(
      'is honoured in the %s phase',
      (phase) => {
        const turn = coordinator();
        driveTo(turn, phase);
        expect(turn.phase).toBe(phase);
        turn.stop();
        expect(turn.stopRequested).toBe(true);
      }
    );

    it.each(TURN_PHASES.filter((phase) => phase !== 'finished'))(
      'gives the same answer to every caller in the %s phase',
      (phase) => {
        const turn = coordinator();
        driveTo(turn, phase);
        turn.stop();
        expect(turn.stopRequested).toBe(true);
        expect(turn.stopRequested).toBe(true);
        expect(refusal(() => turn.beginProviderStep()).code).toBe('stopped');
      }
    );

    it('refuses to start anything new once stopped', () => {
      const turn = coordinator();
      turn.stop();
      expect(refusal(() => turn.beginProviderStep()).code).toBe('stopped');
      expect(refusal(() => turn.beginApproval('call-1')).code).toBe('stopped');
      expect(refusal(() => turn.beginEffect('call-1')).code).toBe('stopped');
    });

    it('stays stopped', () => {
      const turn = coordinator();
      turn.stop();
      turn.stop();
      expect(turn.stopRequested).toBe(true);
    });

    it('charges the budget a stop, so a stopped run cannot spend afterwards', () => {
      const turn = coordinator();
      turn.stop();
      expect(turn.budgetSnapshot().stoppedReason).toBe('user_stopped');
    });
  });

  describe('unresolved work', () => {
    it('refuses to finish while an effect is still applying', () => {
      const turn = coordinator();
      driveTo(turn, 'applying_effect');
      expect(refusal(() => turn.finish('completed')).code).toBe('effect_unresolved');
    });

    it('refuses to finish while an observation is still being written', () => {
      const turn = coordinator();
      driveTo(turn, 'recording_observation');
      expect(refusal(() => turn.finish('completed')).code).toBe('observation_unresolved');
    });

    it('refuses to finish as stopped while an effect is outstanding', () => {
      const turn = coordinator();
      driveTo(turn, 'applying_effect');
      turn.stop();
      expect(refusal(() => turn.finish('stopped')).code).toBe('effect_unresolved');
    });

    it('refuses to finish while an applied effect has never been observed', () => {
      const turn = coordinator();
      driveTo(turn, 'applying_effect');
      turn.resolveEffect('call-1', 'applied');
      expect(refusal(() => turn.finish('completed')).code).toBe('observation_unresolved');
    });

    it('lets a stopped turn record what an effect already did', () => {
      const turn = coordinator();
      driveTo(turn, 'applying_effect');
      turn.stop();
      turn.resolveEffect('call-1', 'applied');
      expect(refusal(() => turn.finish('stopped')).code).toBe('observation_unresolved');
      expect(() => turn.beginObservation('call-1')).not.toThrow();
      turn.completeObservation('call-1');
      expect(() => turn.finish('stopped')).not.toThrow();
    });

    it('does not require an observation for an effect that never ran', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      turn.settleApproval('call-1', 'declined');
      expect(() => turn.finish('completed')).not.toThrow();
    });

    it('finishes once the effect and observation are resolved', () => {
      const turn = coordinator();
      driveTo(turn, 'recording_observation');
      turn.completeObservation('call-1');
      expect(turn.phase).toBe('admitting');
      expect(() => turn.finish('completed')).not.toThrow();
      expect(turn.phase).toBe('finished');
    });

    it('lets an effect resolve as outcome-unknown when its fate cannot be established', () => {
      const turn = coordinator();
      driveTo(turn, 'applying_effect');
      turn.resolveEffect('call-1', 'outcome_unknown');
      turn.beginObservation('call-1');
      turn.completeObservation('call-1');
      turn.finish('completed');
      expect(turn.outcome).toBe('outcome_unknown');
    });

    it('does not let an unknown outcome be downgraded to completed', () => {
      const turn = coordinator();
      driveTo(turn, 'applying_effect');
      turn.resolveEffect('call-1', 'outcome_unknown');
      turn.beginObservation('call-1');
      turn.completeObservation('call-1');
      turn.finish('completed');
      expect(turn.outcome).not.toBe('completed');
    });
  });

  describe('phase transitions', () => {
    it('refuses an approval for a call that was never started', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      expect(refusal(() => turn.beginEffect('call-2')).code).toBe('unknown_call');
    });

    it('refuses an effect that was never approved', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      expect(refusal(() => turn.beginEffect('call-1')).code).toBe('illegal_transition');
    });

    it('refuses an effect for a call the user declined', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      turn.settleApproval('call-1', 'declined');
      const error = refusal(() => turn.beginEffect('call-1'));
      expect(error.code).toBe('illegal_transition');
      expect(error.message).toContain('declined');
    });

    it('refuses an effect while the approval is still pending', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      expect(refusal(() => turn.beginEffect('call-1')).message).toContain('pending');
    });

    it('refuses to settle the same approval twice', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      turn.settleApproval('call-1', 'approved');
      expect(refusal(() => turn.settleApproval('call-1', 'declined')).code).toBe(
        'illegal_transition'
      );
    });

    it('does not spend a mutation on an effect it then refuses to start', () => {
      const turn = coordinator({ parallelEffects: 1, mutations: 5 });
      turn.beginProviderStep();
      for (const callId of ['call-1', 'call-2']) {
        turn.beginApproval(callId);
        turn.settleApproval(callId, 'approved');
      }
      turn.beginEffect('call-1');
      expect(refusal(() => turn.beginEffect('call-2')).code).toBe('budget_exhausted');
      expect(turn.budgetSnapshot().mutations).toBe(1);
    });

    it('gives back the effect slot when the mutation limit refuses the change', () => {
      const turn = coordinator({ parallelEffects: 2, mutations: 1 });
      turn.beginProviderStep();
      for (const callId of ['call-1', 'call-2']) {
        turn.beginApproval(callId);
        turn.settleApproval(callId, 'approved');
      }
      turn.beginEffect('call-1');
      expect(turn.budgetSnapshot().effectsInFlight).toBe(1);
      expect(refusal(() => turn.beginEffect('call-2')).code).toBe('budget_exhausted');
      expect(turn.budgetSnapshot().effectsInFlight).toBe(1);
    });

    it('refuses to re-offer a call id already in flight', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      turn.settleApproval('call-1', 'approved');
      turn.beginEffect('call-1');
      expect(refusal(() => turn.beginApproval('call-1')).code).toBe('illegal_transition');
      expect(turn.budgetSnapshot().effectsInFlight).toBe(1);
    });

    it('returns an effect slot to the budget when the effect resolves', () => {
      const turn = coordinator({ parallelEffects: 1, mutations: 5 });
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      turn.settleApproval('call-1', 'approved');
      turn.beginEffect('call-1');
      expect(turn.budgetSnapshot().effectsInFlight).toBe(1);
      turn.resolveEffect('call-1', 'applied');
      expect(turn.budgetSnapshot().effectsInFlight).toBe(0);

      turn.beginApproval('call-2');
      turn.settleApproval('call-2', 'approved');
      expect(() => turn.beginEffect('call-2')).not.toThrow();
    });

    it('refuses an observation for an effect that never resolved', () => {
      const turn = coordinator();
      driveTo(turn, 'applying_effect');
      expect(refusal(() => turn.beginObservation('call-2')).code).toBe('unknown_call');
    });

    it('refuses a late approval decision rather than reanimating a finished turn', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      turn.finish('completed');
      expect(refusal(() => turn.settleApproval('call-1', 'approved')).code).toBe(
        'already_finished'
      );
      expect(turn.phase).toBe('finished');
    });

    it('refuses a late effect resolution on a finished turn', () => {
      const turn = coordinator();
      driveTo(turn, 'applying_effect');
      turn.resolveEffect('call-1', 'applied');
      turn.beginObservation('call-1');
      turn.completeObservation('call-1');
      turn.finish('completed');
      expect(refusal(() => turn.resolveEffect('call-1', 'applied')).code).toBe('already_finished');
      expect(turn.phase).toBe('finished');
    });

    it('refuses a late observation completion on a finished turn', () => {
      const turn = coordinator();
      turn.finish('completed');
      expect(refusal(() => turn.completeObservation('call-1')).code).toBe('already_finished');
    });

    it('refuses to act after finishing', () => {
      const turn = coordinator();
      turn.finish('completed');
      expect(refusal(() => turn.beginProviderStep()).code).toBe('already_finished');
      expect(refusal(() => turn.finish('completed')).code).toBe('already_finished');
    });
  });

  describe('budget', () => {
    it('refuses a provider step the budget will not admit', () => {
      const turn = coordinator({ providerAttempts: 1 });
      turn.beginProviderStep();
      turn.finishProviderStep();
      expect(refusal(() => turn.beginProviderStep()).code).toBe('budget_exhausted');
    });

    it('ends the turn when a terminal budget is exhausted', () => {
      const turn = coordinator({ providerAttempts: 1 });
      turn.beginProviderStep();
      turn.finishProviderStep();
      refusal(() => turn.beginProviderStep());
      expect(turn.budgetSnapshot().stoppedReason).toBe('provider_attempts_exhausted');
    });

    it('leaves the turn able to answer when only a capability budget is spent', () => {
      const turn = coordinator({ mutations: 0 });
      turn.beginProviderStep();
      turn.beginApproval('call-1');
      turn.settleApproval('call-1', 'approved');
      expect(refusal(() => turn.beginEffect('call-1')).code).toBe('budget_exhausted');
      expect(turn.budgetSnapshot().stoppedReason).toBeNull();
      expect(() => turn.finish('completed')).not.toThrow();
    });
  });

  describe('retry ownership', () => {
    it('never retries a provider step itself', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.failProviderStep('provider_unavailable');
      expect(refusal(() => turn.beginProviderStep()).code).toBe('retry_not_owned');
    });

    it('records the failure as the turn outcome', () => {
      const turn = coordinator();
      turn.beginProviderStep();
      turn.failProviderStep('provider_unavailable');
      turn.finish('failed');
      expect(turn.outcome).toBe('failed');
    });
  });
});

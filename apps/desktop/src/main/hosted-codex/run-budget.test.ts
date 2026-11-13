import { describe, expect, it } from 'vitest';

import {
  createRunBudget,
  RunBudgetError,
  type RunBudgetLimits,
  type RunBudget,
} from './run-budget';

const LIMITS: RunBudgetLimits = {
  providerAttempts: 3,
  totalTokens: 1_000,
  spendMicros: 5_000,
  toolCalls: 4,
  mutations: 2,
  parallelEffects: 2,
  compactions: 1,
  recoveries: 1,
  deadlineMs: 60_000,
};

let clock = 0;
function budget(overrides: Partial<RunBudgetLimits> = {}): RunBudget {
  clock = 0;
  return createRunBudget({
    limits: { ...LIMITS, ...overrides },
    now: () => clock,
  });
}

function refusal(run: () => void): RunBudgetError {
  try {
    run();
  } catch (error) {
    if (error instanceof RunBudgetError) return error;
    throw error;
  }
  throw new Error('expected the budget to refuse');
}

describe('createRunBudget', () => {
  describe('provider attempts', () => {
    it('admits attempts up to the limit and refuses the one past it', () => {
      const run = budget({ providerAttempts: 2 });
      run.chargeProviderAttempt();
      run.chargeProviderAttempt();
      expect(refusal(() => run.chargeProviderAttempt()).code).toBe('provider_attempts_exhausted');
    });

    it('stays exhausted once exhausted', () => {
      const run = budget({ providerAttempts: 1 });
      run.chargeProviderAttempt();
      refusal(() => run.chargeProviderAttempt());
      expect(refusal(() => run.chargeProviderAttempt()).code).toBe('provider_attempts_exhausted');
    });
  });

  describe('tokens and spend', () => {
    it('refuses the charge that would cross the token limit rather than after it', () => {
      const run = budget({ totalTokens: 100 });
      run.chargeTokens(60);
      expect(refusal(() => run.chargeTokens(50)).code).toBe('tokens_exhausted');
      expect(run.snapshot().tokens).toBe(60);
    });

    it('admits a charge that lands exactly on the limit', () => {
      const run = budget({ totalTokens: 100 });
      run.chargeTokens(100);
      expect(run.snapshot().tokens).toBe(100);
    });

    it('refuses the charge that would cross the spend limit', () => {
      const run = budget({ spendMicros: 500 });
      run.chargeSpendMicros(400);
      expect(refusal(() => run.chargeSpendMicros(101)).code).toBe('spend_exhausted');
      expect(run.snapshot().spendMicros).toBe(400);
    });

    it.each([
      ['a negative charge', -1],
      ['a fractional charge', 1.5],
      ['not a number', Number.NaN],
      ['infinity', Number.POSITIVE_INFINITY],
    ])('refuses %s rather than guessing what it meant', (_label, amount) => {
      expect(refusal(() => budget().chargeTokens(amount)).code).toBe('uncountable_charge');
      expect(refusal(() => budget().chargeSpendMicros(amount)).code).toBe('uncountable_charge');
    });

    it('stops the run on a charge it cannot account for', () => {
      const run = budget();
      refusal(() => run.chargeTokens(Number.NaN));
      expect(run.snapshot().stoppedReason).toBe('uncountable_charge');
    });

    it('refuses a charge that would overflow a safe integer', () => {
      const run = budget({ totalTokens: Number.MAX_SAFE_INTEGER });
      run.chargeTokens(Number.MAX_SAFE_INTEGER - 1);
      expect(refusal(() => run.chargeTokens(10)).code).toBe('tokens_exhausted');
    });
  });

  describe('tools and mutations', () => {
    it('bounds tool calls', () => {
      const run = budget({ toolCalls: 1 });
      run.chargeToolCall();
      expect(refusal(() => run.chargeToolCall()).code).toBe('tool_calls_exhausted');
    });

    it('bounds mutations separately from tool calls', () => {
      const run = budget({ toolCalls: 10, mutations: 1 });
      run.chargeMutation();
      expect(refusal(() => run.chargeMutation()).code).toBe('mutations_exhausted');
      expect(() => run.chargeToolCall()).not.toThrow();
    });

    it('bounds effects running at once, and releases them when they finish', () => {
      const run = budget({ parallelEffects: 2 });
      const first = run.beginEffect();
      run.beginEffect();
      expect(refusal(() => run.beginEffect()).code).toBe('parallel_effects_exhausted');
      first.release();
      expect(() => run.beginEffect()).not.toThrow();
    });

    it('does not double-release an effect back into the budget', () => {
      const run = budget({ parallelEffects: 1 });
      const effect = run.beginEffect();
      effect.release();
      effect.release();
      run.beginEffect();
      expect(refusal(() => run.beginEffect()).code).toBe('parallel_effects_exhausted');
    });

    it('reports effects still unresolved, so a run cannot end cleanly mid-effect', () => {
      const run = budget({ parallelEffects: 2 });
      const effect = run.beginEffect();
      expect(run.snapshot().effectsInFlight).toBe(1);
      effect.release();
      expect(run.snapshot().effectsInFlight).toBe(0);
    });
  });

  describe('compaction and recovery', () => {
    it('bounds compactions', () => {
      const run = budget({ compactions: 1 });
      run.chargeCompaction();
      expect(refusal(() => run.chargeCompaction()).code).toBe('compactions_exhausted');
    });

    it('bounds recoveries, so a crash loop cannot restart forever', () => {
      const run = budget({ recoveries: 2 });
      run.chargeRecovery();
      run.chargeRecovery();
      expect(refusal(() => run.chargeRecovery()).code).toBe('recoveries_exhausted');
    });
  });

  describe('deadline', () => {
    it('refuses once the deadline has passed', () => {
      const run = budget({ deadlineMs: 1_000 });
      clock = 999;
      expect(() => run.chargeProviderAttempt()).not.toThrow();
      clock = 1_000;
      expect(refusal(() => run.chargeProviderAttempt()).code).toBe('deadline_exceeded');
    });

    it('checks the deadline before every kind of charge', () => {
      const run = budget({ deadlineMs: 10 });
      clock = 11;
      expect(refusal(() => run.chargeTokens(1)).code).toBe('deadline_exceeded');
      expect(refusal(() => run.chargeToolCall()).code).toBe('deadline_exceeded');
      expect(refusal(() => run.chargeMutation()).code).toBe('deadline_exceeded');
      expect(refusal(() => run.chargeCompaction()).code).toBe('deadline_exceeded');
      expect(refusal(() => run.chargeRecovery()).code).toBe('deadline_exceeded');
      expect(refusal(() => run.beginEffect()).code).toBe('deadline_exceeded');
    });

    it('refuses a clock that goes backwards rather than extending the run', () => {
      const run = budget({ deadlineMs: 1_000 });
      clock = 500;
      run.chargeProviderAttempt();
      clock = 100;
      expect(refusal(() => run.chargeProviderAttempt()).code).toBe('clock_went_backwards');
    });
  });

  describe('stopping', () => {
    it('tells a later caller what the run stopped for, not merely that it did', () => {
      const run = budget({ providerAttempts: 1 });
      run.chargeProviderAttempt();
      expect(refusal(() => run.chargeProviderAttempt()).code).toBe('provider_attempts_exhausted');
      expect(refusal(() => run.chargeToolCall()).code).toBe('provider_attempts_exhausted');
    });

    it('refuses everything once stopped', () => {
      const run = budget();
      run.stop('user_stopped');
      expect(refusal(() => run.chargeProviderAttempt()).code).toBe('run_stopped');
      expect(refusal(() => run.chargeTokens(1)).code).toBe('run_stopped');
      expect(refusal(() => run.chargeToolCall()).code).toBe('run_stopped');
      expect(refusal(() => run.beginEffect()).code).toBe('run_stopped');
    });

    it('keeps the first reason it stopped for', () => {
      const run = budget();
      run.stop('user_stopped');
      run.stop('deadline_exceeded');
      expect(run.snapshot().stoppedReason).toBe('user_stopped');
    });

    it('lets an effect already in flight be released after a stop', () => {
      const run = budget();
      const effect = run.beginEffect();
      run.stop('user_stopped');
      expect(() => effect.release()).not.toThrow();
      expect(run.snapshot().effectsInFlight).toBe(0);
    });

    it('records a terminal exhaustion as a stop, so the reason survives', () => {
      const run = budget({ providerAttempts: 0 });
      refusal(() => run.chargeProviderAttempt());
      expect(run.snapshot().stoppedReason).toBe('provider_attempts_exhausted');
    });

    it.each([
      ['tool calls', (run: RunBudget) => run.chargeToolCall(), { toolCalls: 0 }],
      ['mutations', (run: RunBudget) => run.chargeMutation(), { mutations: 0 }],
      ['parallel effects', (run: RunBudget) => run.beginEffect(), { parallelEffects: 0 }],
    ])('exhausting %s refuses the action without ending the run', (_label, act, limit) => {
      const run = budget(limit);
      refusal(() => act(run));
      expect(run.snapshot().stoppedReason).toBeNull();
      expect(() => run.chargeTokens(1)).not.toThrow();
    });
  });

  describe('limits themselves', () => {
    it.each([
      ['negative', -1],
      ['fractional', 2.5],
      ['not a number', Number.NaN],
    ])('refuses a %s limit rather than running unbounded', (_label, value) => {
      expect(() =>
        createRunBudget({ limits: { ...LIMITS, toolCalls: value }, now: () => 0 })
      ).toThrow(RunBudgetError);
    });

    it('admits a zero limit, which forbids the action entirely', () => {
      const run = budget({ mutations: 0 });
      expect(refusal(() => run.chargeMutation()).code).toBe('mutations_exhausted');
    });
  });

  describe('the snapshot', () => {
    it('reports what was consumed without exposing anything to change it', () => {
      const run = budget();
      run.chargeProviderAttempt();
      run.chargeTokens(10);
      run.chargeSpendMicros(20);
      run.chargeToolCall();
      const snapshot = run.snapshot();
      expect(snapshot).toMatchObject({
        providerAttempts: 1,
        tokens: 10,
        spendMicros: 20,
        toolCalls: 1,
        effectsInFlight: 0,
        stoppedReason: null,
      });
      (snapshot as { tokens: number }).tokens = 9_999;
      expect(run.snapshot().tokens).toBe(10);
    });
  });
});

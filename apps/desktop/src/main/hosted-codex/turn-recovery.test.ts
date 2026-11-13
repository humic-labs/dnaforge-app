import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import {
  AgentStateCapsuleStore,
  createAgentStateCapsuleTable,
  type StoredAgentStateCapsule,
} from './agent-state-capsule';
import { createRunBudget, type RunBudgetLimits } from './run-budget';
import { createTurnCoordinator } from './turn-coordinator';
import { createRecordingTurn, recoverTurn, type RecordingTurn } from './turn-recovery';

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

interface Harness {
  readonly turn: RecordingTurn;
  readonly store: AgentStateCapsuleStore;
  readonly db: Database.Database;
  readonly runId: string;
}

function harness(runId = 'run-1'): Harness {
  const db = createTestDb();
  createAgentStateCapsuleTable(db);
  const store = new AgentStateCapsuleStore(db);
  const turn = createRecordingTurn({
    runId,
    store,
    coordinator: createTurnCoordinator({
      budget: createRunBudget({ limits: LIMITS, now: () => 0 }),
    }),
    generations: { catalog: 'cat-1', protocol: 'protocol-v1' },
  });
  return { turn, store, db, runId };
}

function active(h: Harness): StoredAgentStateCapsule {
  const capsule = h.store.readActive(h.runId);
  if (!capsule) throw new Error('no active capsule');
  return capsule;
}

describe('createRecordingTurn', () => {
  it('records nothing before the turn does anything', () => {
    const h = harness();
    expect(h.store.readActive(h.runId)).toBeNull();
  });

  it('records an effect as applying BEFORE it is applied', () => {
    const h = harness();
    h.turn.beginProviderStep();
    h.turn.beginApproval('call-1');
    h.turn.settleApproval('call-1', 'approved');
    h.turn.beginEffect('call-1');

    expect(active(h).openToolExecutions).toContain('call-1');
  });

  it('advances the capsule chain by exactly one per recorded action', () => {
    const h = harness();
    h.turn.beginProviderStep();
    const first = active(h);
    h.turn.beginApproval('call-1');
    const second = active(h);
    expect(second.sequence).toBe(first.sequence + 1);
    expect(second.predecessorDigest).toBe(first.capsuleDigest);
  });

  it('carries the budget into the capsule, so a recovered run cannot start fresh', () => {
    const h = harness();
    h.turn.beginProviderStep();
    expect(active(h).budget.providerAttempts).toBe(1);
  });

  it('clears the open execution once the effect resolves and is observed', () => {
    const h = harness();
    h.turn.beginProviderStep();
    h.turn.beginApproval('call-1');
    h.turn.settleApproval('call-1', 'approved');
    h.turn.beginEffect('call-1');
    h.turn.resolveEffect('call-1', 'applied');
    h.turn.beginObservation('call-1');
    h.turn.completeObservation('call-1');
    expect(active(h).openToolExecutions).toEqual([]);
  });

  it('stops the run when the record cannot be written', () => {
    const h = harness();
    h.turn.beginProviderStep();
    h.db.exec('DROP TABLE agent_state_capsules');
    expect(() => h.turn.beginApproval('call-1')).toThrow();
    expect(h.turn.stopRequested).toBe(true);
  });

  it('does not record a capsule for an action the coordinator refused', () => {
    const h = harness();
    h.turn.beginProviderStep();
    const before = active(h);
    expect(() => h.turn.beginEffect('call-1')).toThrow();
    expect(active(h).capsuleDigest).toBe(before.capsuleDigest);
  });
});

describe('recoverTurn', () => {
  it('has nothing to recover when no capsule was ever written', () => {
    const recovered = recoverTurn(null);
    expect(recovered.resumable).toBe(false);
    expect(recovered.unknownEffects).toEqual([]);
    expect(recovered.outcome).toBeNull();
  });

  it('reports an effect that was applying as outcome-unknown', () => {
    const h = harness();
    h.turn.beginProviderStep();
    h.turn.beginApproval('call-1');
    h.turn.settleApproval('call-1', 'approved');
    h.turn.beginEffect('call-1');

    const recovered = recoverTurn(active(h));
    expect(recovered.unknownEffects).toEqual(['call-1']);
    expect(recovered.outcome).toBe('outcome_unknown');
  });

  it('does not invent an unknown effect for a turn that resolved everything', () => {
    const h = harness();
    h.turn.beginProviderStep();
    h.turn.beginApproval('call-1');
    h.turn.settleApproval('call-1', 'approved');
    h.turn.beginEffect('call-1');
    h.turn.resolveEffect('call-1', 'applied');
    h.turn.beginObservation('call-1');
    h.turn.completeObservation('call-1');

    const recovered = recoverTurn(active(h));
    expect(recovered.unknownEffects).toEqual([]);
    expect(recovered.outcome).toBeNull();
    expect(recovered.resumable).toBe(true);
  });

  it('carries the spent budget forward so a recovered run resumes where it stopped', () => {
    const h = harness();
    h.turn.beginProviderStep();
    h.turn.beginProviderStep();
    const recovered = recoverTurn(active(h));
    expect(recovered.spentBudget.providerAttempts).toBe(2);
  });

  it('carries every counter forward, not just the paid one', () => {
    const h = harness();
    h.turn.beginProviderStep();
    h.turn.beginApproval('call-1');
    h.turn.settleApproval('call-1', 'approved');
    h.turn.beginEffect('call-1');
    h.turn.resolveEffect('call-1', 'applied');
    h.turn.beginObservation('call-1');
    h.turn.completeObservation('call-1');

    const recovered = recoverTurn(active(h));
    expect(recovered.spentBudget).toMatchObject({
      providerAttempts: 1,
      mutations: 1,
    });
    for (const counter of [
      'providerAttempts',
      'tokens',
      'spendMicros',
      'toolCalls',
      'mutations',
      'compactions',
      'recoveries',
    ]) {
      expect(recovered.spentBudget, counter).toHaveProperty(counter);
    }
  });

  it('refuses to resume a capsule written by a schema this build does not know', () => {
    const h = harness();
    h.turn.beginProviderStep();
    const capsule = { ...active(h), schemaVersion: 99 };
    const recovered = recoverTurn(capsule);
    expect(recovered.resumable).toBe(false);
    expect(recovered.refusal).toBe('unknown_schema');
  });

  it('refuses to resume a capsule whose digest does not match its body', () => {
    const h = harness();
    h.turn.beginProviderStep();
    const capsule = { ...active(h), runId: 'someone-elses-run' };
    const recovered = recoverTurn(capsule);
    expect(recovered.resumable).toBe(false);
    expect(recovered.refusal).toBe('digest_mismatch');
  });

  it('still reports an unknown effect from a capsule it refuses to resume', () => {
    const h = harness();
    h.turn.beginProviderStep();
    h.turn.beginApproval('call-1');
    h.turn.settleApproval('call-1', 'approved');
    h.turn.beginEffect('call-1');
    const capsule = { ...active(h), schemaVersion: 99 };
    const recovered = recoverTurn(capsule);
    expect(recovered.resumable).toBe(false);
    expect(recovered.unknownEffects).toEqual(['call-1']);
    expect(recovered.outcome).toBe('outcome_unknown');
  });
});

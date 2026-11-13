import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../__tests__/test-db';
import {
  AGENT_STATE_CAPSULE_SCHEMA_VERSION,
  AgentStateCapsuleError,
  AgentStateCapsuleStore,
  agentStateCapsuleDigest,
  createAgentStateCapsuleTable,
  type AgentStateCapsuleBody,
} from './agent-state-capsule';

const RUN = 'run-1';

function body(overrides: Partial<AgentStateCapsuleBody> = {}): AgentStateCapsuleBody {
  return {
    schemaVersion: AGENT_STATE_CAPSULE_SCHEMA_VERSION,
    runId: RUN,
    sequence: 1,
    predecessorDigest: null,
    bindings: { accountId: 'account-1', turnId: 'turn-1', codexThreadId: 'thread-1' },
    watermarks: { message: 4, toolEvent: 2 },
    references: ['sequence|pUC19'],
    openToolExecutions: [],
    generations: { catalog: 'catalog-v1', protocol: 'protocol-v1', model: 'model-v1' },
    budget: { providerAttempts: 1, inputTokens: 20, outputTokens: 5, toolSteps: 0 },
    compaction: null,
    ...overrides,
  };
}

describe('AgentStateCapsuleStore', () => {
  let db: Database.Database;
  let store: AgentStateCapsuleStore;

  beforeEach(() => {
    db = createTestDb();
    createAgentStateCapsuleTable(db);
    store = new AgentStateCapsuleStore(db, () => 1_760_000_000_000);
  });

  it('keeps a written candidate out of recovery until it is activated', () => {
    const digest = store.writeCandidate(body());
    expect(store.readActive(RUN)).toBeNull();

    store.activate(RUN, digest);
    expect(store.readActive(RUN)).toMatchObject({ capsuleDigest: digest, sequence: 1 });
  });

  it('leaves the active capsule untouched when a later candidate is never activated', () => {
    const first = store.writeCandidate(body());
    store.activate(RUN, first);
    store.writeCandidate(
      body({ sequence: 2, predecessorDigest: first, watermarks: { message: 9, toolEvent: 5 } })
    );

    expect(store.readActive(RUN)).toMatchObject({
      capsuleDigest: first,
      watermarks: { message: 4, toolEvent: 2 },
    });
  });

  it('advances the chain by exactly one sequence from the active capsule', () => {
    const first = store.writeCandidate(body());
    store.activate(RUN, first);

    const skipped = store.writeCandidate(body({ sequence: 3, predecessorDigest: first }));
    expect(() => store.activate(RUN, skipped)).toThrow(/advance by exactly one/u);
    expect(store.readActive(RUN)).toMatchObject({ capsuleDigest: first });

    const next = store.writeCandidate(body({ sequence: 2, predecessorDigest: first }));
    store.activate(RUN, next);
    expect(store.readActive(RUN)).toMatchObject({ capsuleDigest: next, sequence: 2 });
  });

  it('refuses a capsule that does not continue the active capsule', () => {
    const first = store.writeCandidate(body());
    store.activate(RUN, first);
    const forked = store.writeCandidate(body({ sequence: 2, predecessorDigest: 'b'.repeat(64) }));
    expect(() => store.activate(RUN, forked)).toThrow(/does not continue the active capsule/u);
    expect(store.readActive(RUN)).toMatchObject({ capsuleDigest: first });
  });

  it('requires the first capsule of a run to start the chain', () => {
    expect(() =>
      store.writeCandidate(body({ sequence: 1, predecessorDigest: 'c'.repeat(64) }))
    ).toThrow(/first capsule of a run has no predecessor/u);
    expect(() => store.writeCandidate(body({ sequence: 2, predecessorDigest: null }))).toThrow(
      /must name its predecessor/u
    );
  });

  it('never leaves a run with two active capsules', () => {
    const first = store.writeCandidate(body());
    store.activate(RUN, first);
    const second = store.writeCandidate(body({ sequence: 2, predecessorDigest: first }));
    store.activate(RUN, second);

    const active = db
      .prepare(
        `SELECT count(*) AS total FROM agent_state_capsules WHERE run_id = ? AND state = 'active'`
      )
      .get(RUN) as { total: number };
    expect(active.total).toBe(1);
    expect(store.readActive(RUN)).toMatchObject({ capsuleDigest: second });
  });

  it('reports an active capsule edited underneath the app instead of resuming it', () => {
    const first = store.writeCandidate(body());
    store.activate(RUN, first);
    db.prepare(`UPDATE agent_state_capsules SET payload = ? WHERE capsule_digest = ?`).run(
      JSON.stringify({ ...body(), watermarks: { message: 999, toolEvent: 999 } }),
      first
    );
    expect(() => store.readActive(RUN)).toThrow(AgentStateCapsuleError);
    expect(() => store.readActive(RUN)).toThrow(/does not match its digest/u);
  });

  it('refuses to activate a capsule twice', () => {
    const first = store.writeCandidate(body());
    store.activate(RUN, first);
    expect(() => store.activate(RUN, first)).toThrow(/already active/u);
  });

  it('refuses a capsule written by a schema version this build does not understand', () => {
    expect(() => store.writeCandidate(body({ schemaVersion: 99 }))).toThrow(/schema version 99/u);
  });

  it('digests the payload independently of key order', () => {
    const ordered = body();
    const shuffled: AgentStateCapsuleBody = {
      compaction: ordered.compaction,
      budget: ordered.budget,
      generations: ordered.generations,
      openToolExecutions: ordered.openToolExecutions,
      references: ordered.references,
      watermarks: ordered.watermarks,
      bindings: ordered.bindings,
      predecessorDigest: ordered.predecessorDigest,
      sequence: ordered.sequence,
      runId: ordered.runId,
      schemaVersion: ordered.schemaVersion,
    };
    expect(agentStateCapsuleDigest(ordered)).toMatch(/[0-9a-f]{64}/);
    expect(agentStateCapsuleDigest(shuffled)).toBe(agentStateCapsuleDigest(ordered));
  });

  it('keeps runs independent', () => {
    const first = store.writeCandidate(body());
    store.activate(RUN, first);
    const otherRun = 'run-2';
    const otherFirst = store.writeCandidate(body({ runId: otherRun }));
    store.activate(otherRun, otherFirst);

    expect(store.readActive(RUN)).toMatchObject({ capsuleDigest: first });
    expect(store.readActive(otherRun)).toMatchObject({ capsuleDigest: otherFirst });
  });
});

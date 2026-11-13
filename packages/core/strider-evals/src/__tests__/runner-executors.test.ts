import { describe, expect, it } from 'vitest';
import { runEvalDescriptor } from '../runner/execute.ts';
import { buildExampleEnvironment } from '../examples/test-environment.ts';
import type { ActionEvalDescriptor } from '../descriptor/action.ts';
import type { StateCoherenceEvalDescriptor } from '../descriptor/state-coherence.ts';
import type { AuditEvalDescriptor } from '../descriptor/audit.ts';
import type { ProvenanceEvalDescriptor } from '../descriptor/provenance.ts';

describe('runEvalDescriptor — happy paths covered by examples; here we cover failure detection', () => {
  it('reports failure when an action is not registered', async () => {
    const descriptor: ActionEvalDescriptor = {
      id: 'rename-missing-action',
      kind: 'action',
      description: 'should fail because we point assertion at a non-existent action',
      mode: 'mock-llm',
      tags: [],
      actionName: 'sequence.doesNotExist',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      input: {},
      assertions: { success: {} },
    };
    const env = buildExampleEnvironment();
    const result = await runEvalDescriptor(descriptor, env);
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/No action registered/);
  });

  it('reports failure when state-coherence stale-context is not enforced', async () => {
    const descriptor: StateCoherenceEvalDescriptor = {
      id: 'state-fail',
      kind: 'state-coherence',
      description: 'forces a wrong error code expectation to verify detection',
      mode: 'mock-llm',
      tags: [],
      actionName: 'sequence.rename',
      entity: { kind: 'sequence', id: 'plasmid-001' },
      input: { sequenceId: 'plasmid-001', newName: 'pUC19' },
      cases: [
        {
          kind: 'stale-context',
          expectedRevision: 0,
          liveRevision: 5,
          expectedError: { code: 'EXECUTION_FAILED' },
        },
      ],
    };
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(descriptor, env);
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/Expected error EXECUTION_FAILED/);
  });

  it('audit executor passes when entry is fully populated', async () => {
    const descriptor: AuditEvalDescriptor = {
      id: 'audit-happy',
      kind: 'audit',
      description: 'sequence.rename writes a clean audit entry',
      mode: 'mock-llm',
      tags: [],
      actionName: 'sequence.rename',
      input: { sequenceId: 'plasmid-001', newName: 'pUC19-renamed' },
      expectedAudit: {
        actionName: 'sequence.rename',
        status: 'ok',
        scopeIncludes: ['mutating'],
        sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
        affectedEntities: [{ kind: 'sequence', id: 'plasmid-001' }],
        expectStateMutated: true,
      },
    };
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(descriptor, env);
    expect(result.passed).toBe(true);
  });

  it('audit executor passes rename-to-same-name (revision-aware snapshots detect mutation)', async () => {
    const descriptor: AuditEvalDescriptor = {
      id: 'audit-revision-only-mutation',
      kind: 'audit',
      description: 'rename to same name is still a mutation (revision bumps)',
      mode: 'mock-llm',
      tags: [],
      actionName: 'sequence.rename',
      input: { sequenceId: 'plasmid-001', newName: 'pUC19' },
      expectedAudit: {
        actionName: 'sequence.rename',
        status: 'ok',
        scopeIncludes: ['mutating'],
        sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
        affectedEntities: [{ kind: 'sequence', id: 'plasmid-001' }],
        expectStateMutated: true,
      },
    };
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(descriptor, env);
    expect(result.passed).toBe(true);
  });

  it('provenance executor fails when no record is attached', async () => {
    const descriptor: ProvenanceEvalDescriptor = {
      id: 'provenance-missing',
      kind: 'provenance',
      description: 'sequence.rename does not attach provenance — assert detection',
      mode: 'mock-llm',
      tags: [],
      actionName: 'sequence.rename',
      input: { sequenceId: 'plasmid-001', newName: 'pUC19-renamed' },
      expectedProvenance: {
        derivedEntity: { kind: 'sequence', id: 'plasmid-001' },
        derivationKind: 'mutation',
        actionName: 'sequence.rename',
        sources: [
          {
            entity: { kind: 'sequence', id: 'plasmid-001' },
            role: 'parent',
          },
        ],
        attachedAtFieldExists: true,
      },
    };
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(descriptor, env);
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/No ProvenanceRecord/);
  });

  it('action executor: missing action registration is reported', async () => {
    const env = buildExampleEnvironment();
    const result = await runEvalDescriptor(
      {
        id: 'no-such-action',
        kind: 'action',
        description: 'x',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.ghost',
        runtime: 'renderer',
        effects: ['read-only'],
        actionClass: 'read',
        input: {},
        assertions: { success: {} },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/No action registered/);
  });

  it('action executor: failure-expected-but-got-success is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'expects-failure-gets-success',
        kind: 'action',
        description: 'happy-path action with failure assertion fails detection',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        runtime: 'renderer',
        effects: ['mutating'],
        actionClass: 'modify',
        input: { sequenceId: 'plasmid-001', newName: 'pUC19-x' },
        assertions: { failure: { code: 'EXECUTION_FAILED' } },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/Expected failure with code EXECUTION_FAILED/);
  });

  it('action executor: wrong error code mismatches', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'wrong-error-code',
        kind: 'action',
        description: 'invalid input but assertion expects NOT_IMPLEMENTED',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        runtime: 'renderer',
        effects: ['mutating'],
        actionClass: 'modify',
        input: { sequenceId: 'plasmid-001', newName: '' },
        assertions: { failure: { code: 'NOT_IMPLEMENTED' } },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/Expected error code NOT_IMPLEMENTED, got BAD_INPUT/);
  });

  it('action executor: messageContains mismatch is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'wrong-message',
        kind: 'action',
        description: 'real error but messageContains does not match',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        runtime: 'renderer',
        effects: ['mutating'],
        actionClass: 'modify',
        input: { sequenceId: 'plasmid-001', newName: '' },
        assertions: { failure: { code: 'BAD_INPUT', messageContains: 'NEVER_MATCH' } },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/Expected error message to contain/);
  });

  it('action executor: success.resultEquals mismatch is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'wrong-result',
        kind: 'action',
        description: 'asserts a wrong success result to verify executor detection',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        runtime: 'renderer',
        effects: ['mutating'],
        actionClass: 'modify',
        input: { sequenceId: 'plasmid-001', newName: 'pUC19-x' },
        assertions: {
          success: {
            resultEquals: { sequenceId: 'plasmid-001', name: 'WRONG', revision: 1 },
          },
        },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/Result mismatch/);
  });

  it('action executor: failure.retriable mismatch is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'wrong-retriable',
        kind: 'action',
        description: 'asserts wrong retriable to verify executor detection',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        runtime: 'renderer',
        effects: ['mutating'],
        actionClass: 'modify',
        input: { sequenceId: 'plasmid-001', newName: '' },
        assertions: { failure: { code: 'BAD_INPUT', retriable: true } },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/Expected retriable=true, got false/);
  });

  it('action executor: STALE_STATE default retriable=true is asserted', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    env.store.bumpRevision({ kind: 'sequence', id: 'plasmid-001' });
    env.store.bumpRevision({ kind: 'sequence', id: 'plasmid-001' });
    const action = env.resolveAction('sequence.rename');
    if (!action) throw new Error('sequence.rename not registered');
    const result = await action(
      { sequenceId: 'plasmid-001', newName: 'pUC19-x' },
      {
        sessionId: 'session-direct',
        store: env.store,
        audit: env.audit,
        provenance: env.provenance,
        expectedRevisions: { 'sequence/plasmid-001': 0 },
      }
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error.code).toBe('STALE_STATE');
      expect(result.error.retriable).toBe(true);
    }
  });

  it('state-coherence: revision-bump that does not advance is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'wrong-expected-bump',
        kind: 'state-coherence',
        description: 'asserts wrong post-bump revision',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        entity: { kind: 'sequence', id: 'plasmid-001' },
        input: { sequenceId: 'plasmid-001', newName: 'pUC19-x' },
        cases: [
          {
            kind: 'revision-bump',
            initialRevision: 0,
            expectedRevisionAfter: 99,
          },
        ],
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/Expected revision 99 after action, got 1/);
  });

  it('state-coherence: backward seeding works when store exposes seedRevision', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    env.store.bumpRevision({ kind: 'sequence', id: 'plasmid-001' });
    env.store.bumpRevision({ kind: 'sequence', id: 'plasmid-001' });
    env.store.bumpRevision({ kind: 'sequence', id: 'plasmid-001' });
    const result = await runEvalDescriptor(
      {
        id: 'seed-backward-via-seedrevision',
        kind: 'state-coherence',
        description: 'multi-case seeding does not cascade revisions across cases',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        entity: { kind: 'sequence', id: 'plasmid-001' },
        input: { sequenceId: 'plasmid-001', newName: 'pUC19-x' },
        cases: [
          {
            kind: 'revision-bump',
            initialRevision: 1,
            expectedRevisionAfter: 2,
          },
        ],
      },
      env
    );
    expect(result.passed).toBe(true);
  });

  it('audit executor: required scope value missing is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'audit-scope-missing',
        kind: 'audit',
        description: 'requires a scope value the action does not declare',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        input: { sequenceId: 'plasmid-001', newName: 'pUC19-x' },
        expectedAudit: {
          actionName: 'sequence.rename',
          status: 'ok',
          scopeIncludes: ['ui-bound'],
          sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
          affectedEntities: [],
          expectStateMutated: true,
        },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/scope missing/);
  });

  it('audit executor: required affectedEntity missing is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'audit-affected-missing',
        kind: 'audit',
        description: 'requires an affected entity the action did not write',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.rename',
        input: { sequenceId: 'plasmid-001', newName: 'pUC19-x' },
        expectedAudit: {
          actionName: 'sequence.rename',
          status: 'ok',
          scopeIncludes: [],
          sessionIdMatchesPattern: '^session-[a-z0-9-]+$',
          affectedEntities: [{ kind: 'sequence', id: 'NOT_TOUCHED' }],
          expectStateMutated: true,
        },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/affectedEntities missing sequence\/NOT_TOUCHED/);
  });

  it('provenance executor: derivationKind mismatch is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'wrong-derivation-kind',
        kind: 'provenance',
        description: 'PCR action expected to be cloning',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.pcrAmplify',
        input: {
          templateSequenceId: 'plasmid-001',
          forwardPrimerId: 'fwd',
          reversePrimerId: 'rev',
          productId: 'p1',
        },
        expectedProvenance: {
          derivedEntity: { kind: 'sequence', id: 'p1' },
          derivationKind: 'cloning',
          actionName: 'sequence.pcrAmplify',
          sources: [{ entity: { kind: 'sequence', id: 'plasmid-001' }, role: 'template' }],
          attachedAtFieldExists: true,
        },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/derivationKind mismatch/);
  });

  it('provenance executor: missing source entity is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'missing-source',
        kind: 'provenance',
        description: 'expected source not in record',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.pcrAmplify',
        input: {
          templateSequenceId: 'plasmid-001',
          forwardPrimerId: 'fwd',
          reversePrimerId: 'rev',
          productId: 'p1',
        },
        expectedProvenance: {
          derivedEntity: { kind: 'sequence', id: 'p1' },
          derivationKind: 'pcr',
          actionName: 'sequence.pcrAmplify',
          sources: [
            {
              entity: { kind: 'sequence', id: 'ghost-source' },
              role: 'template',
            },
          ],
          attachedAtFieldExists: true,
        },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/Source missing/);
  });

  it('provenance executor: actionName mismatch is reported', async () => {
    const env = buildExampleEnvironment({
      sequences: { 'plasmid-001': { name: 'pUC19' } },
    });
    const result = await runEvalDescriptor(
      {
        id: 'wrong-action-name',
        kind: 'provenance',
        description: 'record actionName does not match expected',
        mode: 'mock-llm',
        tags: [],
        actionName: 'sequence.pcrAmplify',
        input: {
          templateSequenceId: 'plasmid-001',
          forwardPrimerId: 'fwd',
          reversePrimerId: 'rev',
          productId: 'p1',
        },
        expectedProvenance: {
          derivedEntity: { kind: 'sequence', id: 'p1' },
          derivationKind: 'pcr',
          actionName: 'sequence.somethingElse',
          sources: [{ entity: { kind: 'sequence', id: 'plasmid-001' }, role: 'template' }],
          attachedAtFieldExists: true,
        },
      },
      env
    );
    expect(result.passed).toBe(false);
    expect(result.cases[0]?.reason).toMatch(/actionName mismatch/);
  });
});

import { describe, expect, it } from 'vitest';
import {
  ActionErrorCodeSchema,
  ActionEvalDescriptorSchema,
  StateCoherenceEvalDescriptorSchema,
  AuditEvalDescriptorSchema,
  ProvenanceEvalDescriptorSchema,
  EvalDescriptorSchema,
} from '../descriptor/index.ts';
import { loadDescriptor } from '../runner/load-descriptors.ts';

describe('descriptor schemas', () => {
  it('action descriptor enforces domain.verb naming', () => {
    const bad = ActionEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'action',
      description: 'x',
      actionName: 'bad_name_no_dot',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      input: {},
      assertions: { success: {} },
    });
    expect(bad.success).toBe(false);
  });

  it('action descriptor requires exactly one assertion branch', () => {
    const noBranch = ActionEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'action',
      description: 'x',
      actionName: 'sequence.rename',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      input: {},
      assertions: {},
    });
    expect(noBranch.success).toBe(false);

    const twoBranches = ActionEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'action',
      description: 'x',
      actionName: 'sequence.rename',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      input: {},
      assertions: {
        success: {},
        failure: { code: 'EXECUTION_FAILED' },
      },
    });
    expect(twoBranches.success).toBe(false);
  });

  it('state-coherence requires at least one case', () => {
    const bad = StateCoherenceEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'state-coherence',
      description: 'x',
      actionName: 'sequence.rename',
      entity: { kind: 'sequence', id: 's1' },
      input: {},
      cases: [],
    });
    expect(bad.success).toBe(false);
  });

  it('audit descriptor accepts a minimal expected entry', () => {
    const ok = AuditEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'audit',
      description: 'x',
      actionName: 'sequence.rename',
      input: {},
      expectedAudit: {
        actionName: 'sequence.rename',
        status: 'ok',
      },
    });
    expect(ok.success).toBe(true);
  });

  it('provenance descriptor rejects sources=[]', () => {
    const bad = ProvenanceEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'provenance',
      description: 'x',
      actionName: 'sequence.pcrAmplify',
      input: {},
      expectedProvenance: {
        derivedEntity: { kind: 'sequence', id: 's' },
        derivationKind: 'pcr',
        actionName: 'sequence.pcrAmplify',
        sources: [],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('discriminated union routes by kind', () => {
    const result = EvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'audit',
      description: 'y',
      actionName: 'sequence.rename',
      input: {},
      expectedAudit: { actionName: 'sequence.rename', status: 'ok' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe('audit');
  });

  it('loadDescriptor surfaces readable errors on invalid shape', () => {
    expect(() =>
      loadDescriptor({
        id: 'x',
        kind: 'action',
      })
    ).toThrow(/Invalid eval descriptor/);
  });

  it('defaults: mode=mock-llm, tags=[], scopeIncludes=[], affectedEntities=[]', () => {
    const action = ActionEvalDescriptorSchema.safeParse({
      id: 'd-action',
      kind: 'action',
      description: 'x',
      actionName: 'sequence.rename',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      input: {},
      assertions: { success: {} },
    });
    expect(action.success).toBe(true);
    if (action.success) {
      expect(action.data.mode).toBe('mock-llm');
      expect(action.data.tags).toEqual([]);
    }
    const audit = AuditEvalDescriptorSchema.safeParse({
      id: 'd-audit',
      kind: 'audit',
      description: 'x',
      actionName: 'sequence.rename',
      input: {},
      expectedAudit: { actionName: 'sequence.rename', status: 'ok' },
    });
    expect(audit.success).toBe(true);
    if (audit.success) {
      expect(audit.data.expectedAudit.scopeIncludes).toEqual([]);
      expect(audit.data.expectedAudit.affectedEntities).toEqual([]);
      expect(audit.data.expectedAudit.expectStateMutated).toBe(true);
      expect(audit.data.expectedAudit.sessionIdMatchesPattern).toBe('^session-[a-z0-9-]+$');
    }
  });

  it('all three EvalMode values parse correctly', () => {
    for (const mode of ['mock-llm', 'real-llm', 'dev-loop'] as const) {
      const r = AuditEvalDescriptorSchema.safeParse({
        id: 'm',
        kind: 'audit',
        description: 'x',
        mode,
        actionName: 'sequence.rename',
        input: {},
        expectedAudit: { actionName: 'sequence.rename', status: 'ok' },
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.mode).toBe(mode);
    }
  });

  it('EvalDescriptorSchema rejects an unknown kind', () => {
    const bad = EvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'not-a-kind',
      description: 'x',
      actionName: 'sequence.rename',
      input: {},
    });
    expect(bad.success).toBe(false);
  });

  it('action descriptor: actionClass is optional (B1 has no actionClass concept)', () => {
    const noActionClass = ActionEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'action',
      description: 'x',
      actionName: 'sequence.rename',
      runtime: 'renderer',
      effects: ['mutating'],
      input: {},
      assertions: { success: {} },
    });
    expect(noActionClass.success).toBe(true);
  });

  it('ActionErrorCodeSchema matches @waypoint/agent-tools.ALL_ACTION_ERROR_CODES exactly', async () => {
    const { ALL_ACTION_ERROR_CODES } = await import('@waypoint/agent-tools');
    const ours = new Set(ActionErrorCodeSchema.options);
    const theirs = new Set(ALL_ACTION_ERROR_CODES);
    expect(ours).toEqual(theirs);
    expect(ActionErrorCodeSchema.options).toHaveLength(ALL_ACTION_ERROR_CODES.length);
  });

  it.each([
    ['sequence.findFeatures', true],
    ['sequence.findFeatures_v2', true],
    ['sequence.findFeatures_v22', true],
    ['design.addRegion', true],
    ['structure.selectResidues_v10', true],
    ['sequence.PCRAmplify', false],
    ['sequence.FindFeatures', false],
    ['sequence.findFeatures_v1', false],
    ['sequence.find_features', false],
    ['Sequence.findFeatures', false],
  ])('actionName regex agrees with @waypoint/agent-tools for %s', async (name, expected) => {
    const { isValidActionName } = await import('@waypoint/agent-tools');
    const descriptorAccepts = ActionEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'action',
      description: 'x',
      actionName: name,
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      input: {},
      assertions: { success: {} },
    }).success;
    expect(descriptorAccepts).toBe(expected);
    expect(isValidActionName(name)).toBe(expected);
  });

  it('failure.retriable accepts both true and false; rejects non-boolean', () => {
    for (const r of [true, false]) {
      const ok = ActionEvalDescriptorSchema.safeParse({
        id: 'x',
        kind: 'action',
        description: 'x',
        actionName: 'sequence.rename',
        runtime: 'renderer',
        effects: ['mutating'],
        actionClass: 'modify',
        input: {},
        assertions: { failure: { code: 'STALE_STATE', retriable: r } },
      });
      expect(ok.success).toBe(true);
    }
    const bad = ActionEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'action',
      description: 'x',
      actionName: 'sequence.rename',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      input: {},
      assertions: { failure: { code: 'STALE_STATE', retriable: 'yes' as unknown as boolean } },
    });
    expect(bad.success).toBe(false);
  });

  it('failure.messageContains rejects non-string', () => {
    const bad = ActionEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'action',
      description: 'x',
      actionName: 'sequence.rename',
      runtime: 'renderer',
      effects: ['mutating'],
      actionClass: 'modify',
      input: {},
      assertions: { failure: { code: 'BAD_INPUT', messageContains: 42 as unknown as string } },
    });
    expect(bad.success).toBe(false);
  });

  it('ticket field enforces PROJECT-NNN pattern', () => {
    const bad = AuditEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'audit',
      description: 'x',
      actionName: 'sequence.rename',
      ticket: 'INVALID-TICKET',
      input: {},
      expectedAudit: { actionName: 'sequence.rename', status: 'ok' },
    });
    expect(bad.success).toBe(false);
    const ok = AuditEvalDescriptorSchema.safeParse({
      id: 'x',
      kind: 'audit',
      description: 'x',
      actionName: 'sequence.rename',
      ticket: 'EXAMPLE-1',
      input: {},
      expectedAudit: { actionName: 'sequence.rename', status: 'ok' },
    });
    expect(ok.success).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';

describe('review outcome egress boundaries', () => {
  it('keeps bounded Save facts and rejects private or malformed outcome values', () => {
    expect(
      sanitizeClosedBetaProperties({
        workflow: 'content',
        workflow_action: 'undo',
        outcome_kind: 'unchanged',
        attempt_count: 0,
        wrote: false,
        dirty: true,
        state_revision: 2,
      })
    ).toEqual({
      workflow: 'content',
      workflow_action: 'undo',
      outcome_kind: 'unchanged',
      attempt_count: 0,
      wrote: false,
      dirty: true,
      state_revision: 2,
    });
    expect(
      sanitizeClosedBetaProperties({
        outcome_kind: '/private/source.gb',
        attempt_count: '/private/source.gb',
        wrote: 'private-bases',
        dirty: 'customer-name',
        sourcePath: '/private/source.gb',
        contentSha256: 'a'.repeat(64),
        revisionId: 'private-revision',
      })
    ).toEqual({});
  });
  it('preserves exact opaque action and mutation correlation, never paths', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(
      sanitizeClosedBetaProperties({
        operation_id: id,
        native_action_id: id,
        artifact_correlation_id: id,
        outcome_kind: 'display_pending',
      })
    ).toEqual({
      operation_id: id,
      native_action_id: id,
      artifact_correlation_id: id,
      outcome_kind: 'display_pending',
    });
    expect(
      sanitizeClosedBetaProperties({
        operation_id: '/private/customer/document.gb',
        native_action_id: 'private-record-key',
        artifact_correlation_id: 'waypoint://document/private-ref',
        outcome_kind: 'customer-sequence-name',
      })
    ).toEqual({});
  });

  it('accepts closed search episode joins and rejects query text and invented roles', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(
      sanitizeClosedBetaProperties({
        search_episode_id: id,
        search_query_revision: 2,
        search_activity_role: 'continuation',
      })
    ).toEqual({
      search_episode_id: id,
      search_query_revision: 2,
      search_activity_role: 'continuation',
    });
    expect(
      sanitizeClosedBetaProperties({
        search_episode_id: '/private/query',
        search_query_revision: -1,
        search_activity_role: 'private search',
        query: 'private name',
      })
    ).toEqual({});
  });

  it('drops private first-launch categories while allowing only declared scopes', () => {
    expect(
      sanitizeClosedBetaProperties({
        lifecycle_scope: 'local_profile',
        workspace_source: 'automatic_sample',
      })
    ).toEqual({ lifecycle_scope: 'local_profile', workspace_source: 'automatic_sample' });
    expect(
      sanitizeClosedBetaProperties({
        lifecycle_scope: '/private/profile',
        workspace_source: 'Customer project name',
      })
    ).toEqual({});
  });

  it('allows exact main/renderer turn action joins without exporting content', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    expect(
      sanitizeClosedBetaProperties({
        action_id: id,
        prompt: 'private science',
        answer: 'private response',
      })
    ).toEqual({ action_id: id });
    expect(
      sanitizeClosedBetaProperties({
        action_id: 'private-document-name',
      })
    ).toEqual({});
  });
});

describe('project lifecycle closed egress', () => {
  it('retains every declared phase field and refuses private values in bounded fields', () => {
    const payload = {
      operation_id: '550e8400-e29b-41d4-a716-446655440000',
      occurred_at_ms: 1792018800000,
      feature_area: 'workspace',
      workspace_source: 'recent',
      project_phase: 'tree_partial',
      project_stage: 'tree',
      project_source: 'local',
      project_open_mode: 'add',
      project_authority: 'reference',
    };
    expect(sanitizeClosedBetaProperties(payload)).toEqual(payload);
    expect(
      sanitizeClosedBetaProperties({
        project_phase: 'Private fixture title',
        project_stage: '/fixture/path',
        project_source: 'https://fixture.invalid/private',
        project_open_mode: 'private instructions',
        project_authority: 'private configuration',
        operation_id: '/fixture/project',
      })
    ).toEqual({});
  });
});

describe('digest closed egress', () => {
  it('accepts only declared topology, trigger, readiness and bounded integer counts', () => {
    const safe = {
      workflow: 'digest',
      workflow_action: 'compute',
      outcome_kind: 'digest_no_cuts',
      digest_topology: 'linear',
      digest_trigger: 'activation',
      digest_readiness: 'not_applicable',
      digest_cut_count: 0,
      digest_enzyme_count: 2,
    };
    expect(sanitizeClosedBetaProperties(safe)).toEqual(safe);
    expect(
      sanitizeClosedBetaProperties({
        digest_topology: 'Private sample',
        digest_trigger: '/private/path',
        digest_readiness: 'GGTCTC',
        digest_cut_count: -1,
        digest_enzyme_count: 1_000_001,
        sequence: 'AAAAGAATTC',
        enzymes: ['EcoRI'],
        fragment: { start: 1, end: 7 },
        source_id: 'private-id',
        annotations: [{ name: 'Private feature' }],
        clipboard: 'private material',
        filename: 'private.gb',
      })
    ).toEqual({});
    for (const count of [NaN, Infinity, 1.5, '2', null]) {
      expect(
        sanitizeClosedBetaProperties({ digest_cut_count: count, digest_enzyme_count: count })
      ).toEqual({});
    }
  });
});

describe('sequence Save receipt egress', () => {
  it('retains explicitly unconfirmed Git and projection outcomes separately from written data', () => {
    const payload = {
      record_write_status: 'written',
      record_history_status: 'unconfirmed',
      record_projection_status: 'unconfirmed',
      state_revision: 7,
    };
    expect(sanitizeClosedBetaProperties(payload)).toEqual(payload);
    expect(
      sanitizeClosedBetaProperties({
        record_history_status: '/private/sequence.gb',
        record_projection_status: 'private annotation value',
        record_write_status: 'ATGCATGC',
        state_revision: -1,
      })
    ).toEqual({});
  });
});

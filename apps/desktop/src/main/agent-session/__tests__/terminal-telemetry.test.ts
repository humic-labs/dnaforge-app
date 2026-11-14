import { describe, expect, it } from 'vitest';
import { buildLocalAiTurnFinished, localAiTurnFinishedEventId } from '../terminal-telemetry';

const base = {
  sessionId: 'session-1',
  provider: 'codex-sdk' as const,
  durationMs: 7_000,
  visibleAssistantText: '',
  toolCallCount: 0,
  completedWorkspaceToolCount: 0,
  hadWorkspaceContext: false,
  continuation: false,
};

describe('local AI terminal telemetry', () => {
  it('projects a successful Codex answer without including content', () => {
    const event = buildLocalAiTurnFinished({
      ...base,
      status: 'completed',
      visibleAssistantText: 'private scientific answer',
    });
    expect(event).toEqual({
      route: 'local_codex',
      outcome: 'completed',
      value_delivered: true,
      qualification_basis: 'completed_response',
      initiated_by: 'provider',
      stage: 'finalization',
      reason_code: 'completed',
      failure_class: 'none',
      effect_state: 'none',
      trace_state: 'not_applicable',
      settlement_state: 'not_applicable',
      duration_bucket: '5_30s',
      provider_attempt_count_bucket: 'not_applicable',
      tool_call_count_bucket: 'zero',
      workspace_tool_count_bucket: 'zero',
      had_workspace_context: false,
      continuation: false,
      $insert_id: localAiTurnFinishedEventId('session-1'),
    });
    expect(event.$insert_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(JSON.stringify(event)).not.toContain('private scientific answer');
  });

  it('does not label an unconfirmed Stop as acknowledged or qualify partial output', () => {
    expect(
      buildLocalAiTurnFinished({
        ...base,
        provider: 'claude-agent-sdk',
        status: 'stop_unconfirmed',
        visibleAssistantText: 'useful partial answer',
        toolCallCount: 3,
        completedWorkspaceToolCount: 1,
        hadWorkspaceContext: true,
        continuation: true,
      })
    ).toMatchObject({
      route: 'local_claude',
      outcome: 'interrupted',
      value_delivered: false,
      qualification_basis: 'none',
      initiated_by: 'user',
      reason_code: 'stop_unconfirmed',
      tool_call_count_bucket: 'two_to_five',
      workspace_tool_count_bucket: 'one',
      effect_state: 'unknown',
    });
  });

  it('correlates only a real opaque chat turn and does not qualify failed or cancelled prose', () => {
    const actionId = '11111111-1111-4111-8111-111111111111';
    expect(buildLocalAiTurnFinished({ ...base, status: 'completed', actionId })).toHaveProperty(
      'action_id',
      actionId
    );
    expect(
      buildLocalAiTurnFinished({ ...base, status: 'completed', actionId: 'private-path-or-name' })
    ).not.toHaveProperty('action_id');
    for (const status of ['failed', 'cancelled', 'interrupted'] as const) {
      expect(
        buildLocalAiTurnFinished({ ...base, status, visibleAssistantText: 'partial failed prose' })
      ).toMatchObject({ value_delivered: false, qualification_basis: 'none' });
    }
  });

  it('recovers a durable stop intent as interrupted and unconfirmed', () => {
    expect(
      buildLocalAiTurnFinished({
        ...base,
        status: 'stop_unconfirmed',
        recovered: true,
        durationMs: 45_000,
      })
    ).toMatchObject({
      outcome: 'interrupted',
      initiated_by: 'user',
      stage: 'recovery',
      reason_code: 'stop_unconfirmed',
      failure_class: 'interruption',
      value_delivered: false,
    });
  });

  it('fails closed on unclassified provider errors and never emits raw error text', () => {
    const event = buildLocalAiTurnFinished({ ...base, status: 'failed' });
    expect(event).toMatchObject({
      outcome: 'failed',
      reason_code: 'provider_error',
      failure_class: 'provider',
    });
    expect(event).not.toHaveProperty('error');
    expect(event).not.toHaveProperty('prompt');
    expect(event).not.toHaveProperty('response');
  });
});

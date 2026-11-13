import { describe, expect, it } from 'vitest';
import {
  aiTurnCountBucket,
  aiTurnDurationBucket,
  hasQualifyingAssistantContent,
} from './ai-turn-telemetry';
import { sanitizeClosedBetaProperties } from './analytics-allowlist';
import { hostedCodexStoppedAnswer } from './hosted-codex-stopped-answer';

describe('AI turn terminal telemetry contract', () => {
  it('does not treat the persisted Pause status marker as assistant value', () => {
    expect(hasQualifyingAssistantContent(' *[Paused]* ')).toBe(false);
    expect(hasQualifyingAssistantContent('Useful partial answer\n\n*[Paused]*')).toBe(true);
  });
  it('does not treat the Stop notice as assistant value', () => {
    expect(hasQualifyingAssistantContent(hostedCodexStoppedAnswer(''))).toBe(false);
    expect(hasQualifyingAssistantContent(hostedCodexStoppedAnswer('Useful partial answer'))).toBe(
      true
    );
  });
  it('uses closed duration buckets at every boundary', () => {
    expect([-1, Number.NaN].map(aiTurnDurationBucket)).toEqual(['unknown', 'unknown']);
    expect(
      [0, 999, 1_000, 4_999, 5_000, 29_999, 30_000, 119_999, 120_000, 599_999, 600_000].map(
        aiTurnDurationBucket
      )
    ).toEqual([
      'lt_1s',
      'lt_1s',
      '1_5s',
      '1_5s',
      '5_30s',
      '5_30s',
      '30_120s',
      '30_120s',
      '2_10m',
      '2_10m',
      '10m_plus',
    ]);
  });

  it('distinguishes unavailable counts from zero and rejects invalid values', () => {
    expect([null, -1, 0, 1, 2, 5, 6, 20, 21].map(aiTurnCountBucket)).toEqual([
      'not_applicable',
      'unknown',
      'zero',
      'one',
      'two_to_five',
      'two_to_five',
      'six_to_twenty',
      'six_to_twenty',
      'twenty_one_plus',
    ]);
  });

  it('keeps every bounded terminal property and drops content', () => {
    expect(
      sanitizeClosedBetaProperties({
        route: 'local_codex',
        outcome: 'interrupted',
        value_delivered: false,
        qualification_basis: 'none',
        initiated_by: 'user',
        stage: 'recovery',
        reason_code: 'stop_unconfirmed',
        failure_class: 'interruption',
        effect_state: 'unknown',
        trace_state: 'not_applicable',
        settlement_state: 'not_applicable',
        duration_bucket: '30_120s',
        provider_attempt_count_bucket: 'not_applicable',
        tool_call_count_bucket: 'two_to_five',
        workspace_tool_count_bucket: 'one',
        had_workspace_context: true,
        continuation: false,
        $insert_id: '11111111-1111-4111-8111-111111111111',
        prompt: 'must not leave',
      })
    ).toEqual({
      route: 'local_codex',
      outcome: 'interrupted',
      value_delivered: false,
      qualification_basis: 'none',
      initiated_by: 'user',
      stage: 'recovery',
      reason_code: 'stop_unconfirmed',
      failure_class: 'interruption',
      effect_state: 'unknown',
      trace_state: 'not_applicable',
      settlement_state: 'not_applicable',
      duration_bucket: '30_120s',
      provider_attempt_count_bucket: 'not_applicable',
      tool_call_count_bucket: 'two_to_five',
      workspace_tool_count_bucket: 'one',
      had_workspace_context: true,
      continuation: false,
      $insert_id: '11111111-1111-4111-8111-111111111111',
    });
  });
});
